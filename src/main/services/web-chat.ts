import { randomUUID } from 'node:crypto';
import type { AnalysisDepth, ChatMessage, StreamEvent } from '../../shared/types';
import type { LlmBackend, ToolCall, ToolCallingBackend, ToolMessage } from '../backends/types';
import { capabilitySystemContext } from './capabilities';
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
const chunks = (content: string): string[] => content.match(/[\s\S]{1,96}/g) ?? [];

/** Tool loop for ordinary Chat mode when an isolated web capability is enabled. */
export class WebChatService {
  constructor(private readonly backend: ToolCallingBackend & LlmBackend, private readonly web: WebBrowserService) {}

  async *stream(model: string, history: ChatMessage[], signal: AbortSignal, contextWindow: number, depth: AnalysisDepth): AsyncIterable<StreamEvent> {
    let session;
    try { session = await this.web.openSession(); }
    catch {
      const unavailable: ChatMessage = { id: randomUUID(), conversationId: history[0]?.conversationId ?? 'web-unavailable', role: 'system', content: capabilitySystemContext({ webAvailable: false }), createdAt: new Date().toISOString() };
      yield* this.backend.streamChat(model, [unavailable, ...history], signal, contextWindow, depth);
      return;
    }
    const closeOnAbort = () => { void session.close(); };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    const messages: ToolMessage[] = [{ role: 'system', content: capabilitySystemContext({ webAvailable: true }) }, ...history.map(({ role, content }) => ({ role, content }))];
    try {
      for (let actionCount = 0; !signal.aborted && actionCount < maxWebActions; actionCount += 1) {
        const response = await this.backend.chatWithTools(model, messages, webToolDefinitions, signal, contextWindow, depth);
        const calls = response.tool_calls?.length ? response.tool_calls.map(parseCall) : parseInlineToolCalls(response.content ?? '');
        messages.push({ role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls });
        if (calls.length === 0) {
          if (typeof response.prompt_eval_count === 'number') yield { type: 'context-usage', used: response.prompt_eval_count, maximum: contextWindow };
          for (const token of chunks(response.content ?? '')) { if (signal.aborted) return; yield { type: 'token', content: token }; }
          if (response.inference) yield { type: 'diagnostics', diagnostics: { ...response.inference, agentStepCount: 0, finishReason: response.finish_reason ?? 'stop' } };
          yield { type: 'done', finishReason: response.finish_reason ?? 'stop' }; return;
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
      messages.push({ role: 'system', content: 'Лимит web-действий в этом ответе исчерпан. Сформулируй итог по уже полученным источникам, не вызывая инструменты.' });
      const response = await this.backend.chatWithTools(model, messages, undefined, signal, contextWindow, depth);
      if (typeof response.prompt_eval_count === 'number') yield { type: 'context-usage', used: response.prompt_eval_count, maximum: contextWindow };
      for (const token of chunks(response.content ?? '')) { if (signal.aborted) return; yield { type: 'token', content: token }; }
      if (response.inference) yield { type: 'diagnostics', diagnostics: { ...response.inference, agentStepCount: 0, finishReason: response.finish_reason ?? 'stop' } };
      yield { type: 'done', finishReason: response.finish_reason ?? 'stop' };
    } catch (error) {
      if (!signal.aborted) yield { type: 'error', message: 'Не удалось выполнить web-запрос', details: error instanceof Error ? error.message : String(error) };
    } finally { signal.removeEventListener('abort', closeOnAbort); await session.close(); }
  }
}
