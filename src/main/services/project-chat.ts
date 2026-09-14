import { randomUUID } from 'node:crypto';
import type { AnalysisDepth, ChatMessage, FinishReason, StreamEvent, WebMode } from '../../shared/types';
import type { InferenceDiagnostics, ToolCall, ToolCallingBackend, ToolMessage } from '../backends/types';
import { AnalysisEngine } from './analysis-engine';
import { log } from './logger';
import { ReadonlyProjectTools, activityForTool, projectToolDefinitions, type ConfirmAction, type ProjectToolCall } from '../tools/project-tools';
import { capabilitySystemContext } from './capabilities';
import { WebBrowserService, type WebBrowserSession, activityForWebTool, webToolDefinitions } from '../web/web-tools';

const finalizationThreshold = 5;
const finalSynthesisTimeoutMs = 120_000;

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
const chunkText = (content: string): string[] => content.match(/[\s\S]{1,96}/g) ?? [];
const signature = (call: ProjectToolCall): string => `${call.name}:${JSON.stringify(Object.entries(call.arguments).sort(([a], [b]) => a.localeCompare(b)))}`;
function lowInformation(raw: string): boolean { try { const value = JSON.parse(raw) as Record<string, unknown>; return typeof value.error === 'string' || (Array.isArray(value.entries) && value.entries.length === 0) || (Array.isArray(value.matches) && value.matches.length === 0); } catch { return false; } }

export class ProjectChatService {
  constructor(private readonly backend: ToolCallingBackend, private readonly web: WebBrowserService) {}

  async *stream(model: string, history: ChatMessage[], root: string, signal: AbortSignal, contextWindow: number, depth: AnalysisDepth, webMode: WebMode, confirm: ConfirmAction): AsyncIterable<StreamEvent> {
    const engine = new AnalysisEngine(depth); const tools = await ReadonlyProjectTools.open(root, confirm);
    let webSession: WebBrowserSession | null = null;
    if (webMode === 'auto') {
      try { webSession = await this.web.openSession(); }
      catch (error) { log('web.session.unavailable', { message: error instanceof Error ? error.message : String(error) }); }
    }
    const closeWebOnAbort = () => { void webSession?.close(); };
    signal.addEventListener('abort', closeWebOnAbort, { once: true });
    const toolDefinitions = [...projectToolDefinitions, ...(webSession ? webToolDefinitions : [])];
    const messages: ToolMessage[] = [{ role: 'system', content: `${capabilitySystemContext({ webAvailable: Boolean(webSession), projectRoot: root, projectWriteAvailable: true, terminalAvailable: true })} Не предполагай тип, технологию или предметную область проекта. ${engine.strategy()} Raw tool results являются доказательствами и остаются доступными для итогового ответа.` }, ...history.map(({ role, content }) => ({ role, content }))];
    let actions = 0; let repeats = 0; let lowInfo = 0; let warningSent = false; let researchFinished = false;
    const completed = new Set<string>();
    if (engine.isDeep) { log('deep.lifecycle', { phase: 'research.started', model, contextWindow }); yield { type: 'analysis', progress: { stage: 'reconnaissance', status: 'active' } }; }
    try { while (!signal.aborted) {
      const remaining = engine.budget - actions;
      if (remaining <= 0) { yield* this.synthesize(model, messages, engine, signal, contextWindow, '', actions); return; }
      if (remaining <= finalizationThreshold && !warningSent) { messages.push({ role: 'system', content: 'Осталось мало вызовов. Закрой только наиболее важные пробелы и заверши исследование.' }); warningSent = true; }
      const response = await this.backend.chatWithTools(model, messages, toolDefinitions, signal, contextWindow, depth);
      const calls = response.tool_calls?.length ? response.tool_calls.map(parseCall) : parseInlineToolCalls(response.content ?? '');
      messages.push({ role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls });
      if (calls.length === 0) {
        researchFinished = true;
        if (engine.isDeep) log('deep.lifecycle', { phase: 'research.finished', actions });
        yield* this.synthesize(model, messages, engine, signal, contextWindow, response.content ?? '', actions);
        return;
      }
      for (const call of calls) {
        if (signal.aborted || actions >= engine.budget) break;
        const key = signature(call);
        if (completed.has(key)) {
          repeats += 1; messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify({ warning: 'Идентичный вызов уже выполнен. Смени стратегию или заверши исследование.' }) });
          if (repeats >= 3) { researchFinished = true; yield* this.synthesize(model, messages, engine, signal, contextWindow, '', actions); return; }
          continue;
        }
        completed.add(key); actions += 1;
        const isWebTool = webToolDefinitions.some((definition) => definition.function.name === call.name);
        const actionId = randomUUID();
        yield { type: 'tool', activity: { id: actionId, ...(isWebTool ? activityForWebTool(call) : activityForTool(call)) } };
        const result = isWebTool && webSession ? await webSession.execute(call) : await tools.execute(call, signal, actionId); engine.record(call.name, result);
        if (lowInformation(result)) { lowInfo += 1; if (lowInfo === 3) messages.push({ role: 'system', content: 'Последние действия дали мало новой информации. Сузь исследование или заверши ответ.' }); } else lowInfo = 0;
        messages.push({ role: 'tool', tool_name: call.name, content: result });
      }
    } } catch (error) {
      if (signal.aborted) return;
      log('deep.lifecycle', { phase: researchFinished ? 'final-synthesis.error' : 'research.error', actions, message: error instanceof Error ? error.message : String(error) });
      yield { type: 'error', message: 'Анализ не завершился', details: error instanceof Error ? error.message : String(error) };
    } finally { signal.removeEventListener('abort', closeWebOnAbort); await webSession?.close(); if (engine.isDeep) log('deep.lifecycle', { phase: 'request.finalized', actions, aborted: signal.aborted }); }
  }

  private async *synthesize(model: string, messages: ToolMessage[], engine: AnalysisEngine, signal: AbortSignal, contextWindow: number, fallback: string, actions: number): AsyncIterable<StreamEvent> {
    const evidence = engine.prompt();
    if (engine.isDeep) { log('deep.lifecycle', { phase: 'evidence-map.created', actions }); log('deep.lifecycle', { phase: 'final-synthesis.started', actions }); yield { type: 'analysis', progress: { stage: 'synthesis', status: 'active' } }; }
    messages.push({ role: 'system', content: evidence }, { role: 'system', content: 'Исследование завершено. Сформируй один итоговый ответ на исходный вопрос пользователя, опираясь на evidence map и релевантные raw tool results. Не вызывай инструменты.' });
    try {
      const response = await this.finalRequest(model, messages, signal, contextWindow, engine.depth);
      const content = response.content?.trim() || fallback;
      if (!content) throw new Error('Ollama вернул пустой итоговый ответ');
      if (engine.isDeep) log('deep.lifecycle', { phase: 'final-synthesis.finished', responseChars: content.length });
      if (typeof response.prompt_eval_count === 'number') yield { type: 'context-usage', used: response.prompt_eval_count, maximum: contextWindow };
      yield* this.emit(content, engine, signal, response.inference, actions, response.finish_reason);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const timedOut = details.includes('timed out');
      if (engine.isDeep) log('deep.lifecycle', { phase: timedOut ? 'final-synthesis.timeout' : 'final-synthesis.error', message: details, fallback: Boolean(fallback) });
      if (fallback.trim()) { yield* this.emit(fallback, engine, signal, undefined, actions, 'stop'); return; }
      yield { type: 'error', message: 'Не удалось сформировать итоговый ответ', details };
    }
  }

  private async finalRequest(model: string, messages: ToolMessage[], signal: AbortSignal, contextWindow: number, depth: AnalysisDepth): Promise<ToolMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), finalSynthesisTimeoutMs);
    let rejectTimeout: ReturnType<typeof setTimeout> | null = null;
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      return await Promise.race([
        this.backend.chatWithTools(model, messages, undefined, combined, contextWindow, depth),
        new Promise<never>((_resolve, reject) => { rejectTimeout = setTimeout(() => reject(new Error('final synthesis timed out')), finalSynthesisTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); if (rejectTimeout) clearTimeout(rejectTimeout); }
  }

  private async *emit(content: string, engine: AnalysisEngine, signal: AbortSignal, inference: InferenceDiagnostics | undefined, actions: number, finishReason: FinishReason | undefined): AsyncIterable<StreamEvent> {
    if (engine.isDeep) log('deep.lifecycle', { phase: 'response.emitted', responseChars: content.length });
    for (const token of chunkText(content)) { if (signal.aborted) return; yield { type: 'token', content: token }; }
    if (inference) yield { type: 'diagnostics', diagnostics: { ...inference, agentStepCount: actions, finishReason: finishReason ?? 'stop' } };
    yield { type: 'done', finishReason: finishReason ?? 'stop' };
  }
}
