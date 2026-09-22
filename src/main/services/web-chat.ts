import { randomUUID } from 'node:crypto';
import type { ChatMessage, ReasoningMode, StreamEvent } from '../../shared/types';
import type { LlmBackend, ToolCall, ToolCallingBackend, ToolMessage } from '../backends/types';
import { capabilitySystemContext, chatCompletionGuidance, chatMessagesWithSystemPrefix, chatSystemContext } from './capabilities';
import { WebBrowserService, activityForWebTool, webToolDefinitions } from '../web/web-tools';
import type { ProjectToolCall } from '../tools/project-tools';

const maxWebActions = 10;

function parseCall(call: ToolCall): ProjectToolCall {
  const raw = call.function.arguments; let argumentsObject: Record<string, unknown> = {};
  if (typeof raw === 'string') { try { argumentsObject = JSON.parse(raw) as Record<string, unknown>; } catch { argumentsObject = {}; } } else if (raw && typeof raw === 'object') argumentsObject = raw;
  return { name: call.function.name, arguments: argumentsObject };
}
function parseInlineToolCalls(content: string): ProjectToolCall[] {
  const calls: ProjectToolCall[] = [];
  for (const match of content.matchAll(/<function=([a-z_]+)>([\s\S]*?)<\/function>/g)) {
    const argumentsObject: Record<string, unknown> = {};
    for (const parameter of match[2].matchAll(/<parameter=([a-z_]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) argumentsObject[parameter[1]] = /^\d+$/.test(parameter[2].trim()) ? Number(parameter[2].trim()) : parameter[2].trim();
    calls.push({ name: match[1], arguments: argumentsObject });
  }
  return calls;
}
const webDecisionInstruction = 'Сначала реши только, нужны ли для ответа live web-инструменты. Если нужны, вызови нужный инструмент. Если не нужны, ответь ровно NO_WEB. Не пиши итоговый ответ на этом шаге.';

/** Tool loop for ordinary Chat mode when an isolated web capability is enabled. */
export class WebChatService {
  constructor(private readonly backend: ToolCallingBackend & LlmBackend, private readonly web: WebBrowserService) {}

  private async *finalStream(model: string, history: ChatMessage[], toolResults: ToolMessage[], signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode): AsyncIterable<StreamEvent> {
    const results = toolResults.filter((message) => message.role === 'tool').map((message) => `Инструмент ${message.tool_name ?? 'web'} вернул:\n${message.content}`).join('\n\n');
    const finalMessages = chatMessagesWithSystemPrefix(history, [
      chatCompletionGuidance(reasoningMode === 'deep' ? 'deep' : 'fast'),
      ...(results ? [`Доступны следующие результаты web-инструментов. Используй их как evidence и сформулируй итоговый ответ без новых вызовов инструментов:\n\n${results}`] : []),
    ], history[0]?.conversationId ?? 'web-final', randomUUID());
    yield* this.backend.streamChat(model, finalMessages, signal, contextWindow, reasoningMode);
  }

  async *stream(model: string, history: ChatMessage[], signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode): AsyncIterable<StreamEvent> {
    let session;
    try { session = await this.web.openSession(); }
    catch {
      yield* this.backend.streamChat(model, chatMessagesWithSystemPrefix(history, [chatSystemContext({ webAvailable: false }, reasoningMode === 'deep' ? 'deep' : 'fast')], history[0]?.conversationId ?? 'web-unavailable', randomUUID()), signal, contextWindow, reasoningMode);
      return;
    }
    const closeOnAbort = () => { void session.close(); };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    // This is a narrow routing step. Keep it out of the user-visible reasoning
    // and avoid spending the selected final-answer reasoning budget deciding
    // whether a web lookup is needed.
    const messages: ToolMessage[] = chatMessagesWithSystemPrefix(history, [`${capabilitySystemContext({ webAvailable: true })}\n${webDecisionInstruction}`], history[0]?.conversationId ?? 'web-routing', randomUUID()).map(({ role, content, images }) => ({ role, content, ...(images?.length ? { images } : {}) }));
    try {
      for (let actionCount = 0; !signal.aborted && actionCount < maxWebActions; actionCount += 1) {
        const response = await this.backend.chatWithTools(model, messages, webToolDefinitions, signal, contextWindow, 'fast');
        const calls = response.tool_calls?.length ? response.tool_calls.map(parseCall) : parseInlineToolCalls(response.content ?? '');
        messages.push({ role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls });
        if (calls.length === 0) {
          yield* this.finalStream(model, history, messages, signal, contextWindow, reasoningMode); return;
        }
        for (const call of calls) {
          if (signal.aborted) return;
          if (!webToolDefinitions.some((definition) => definition.function.name === call.name)) {
            messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify({ error: 'Этот инструмент недоступен в Chat mode.' }) });
            continue;
          }
          yield { type: 'tool', activity: { id: randomUUID(), ...activityForWebTool(call) } };
          messages.push({ role: 'tool', tool_name: call.name, content: await session.execute(call) });
        }
      }
      yield* this.finalStream(model, history, messages, signal, contextWindow, reasoningMode);
    } catch (error) {
      if (!signal.aborted) yield { type: 'error', message: 'Не удалось выполнить web-запрос', details: error instanceof Error ? error.message : String(error) };
    } finally { signal.removeEventListener('abort', closeOnAbort); await session.close(); }
  }
}
