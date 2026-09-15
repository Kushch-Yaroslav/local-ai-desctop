import { randomUUID } from 'node:crypto';
import type { AnalysisDepth, ChatMessage, FinishReason, StreamEvent, WebMode } from '../../shared/types';
import type { InferenceDiagnostics, ToolCall, ToolCallingBackend, ToolMessage } from '../backends/types';
import { AnalysisEngine } from './analysis-engine';
import { log } from './logger';
import { ReadonlyProjectTools, activityForTool, projectToolDefinitions, type ConfirmAction, type ProjectToolCall } from '../tools/project-tools';
import { capabilitySystemContext } from './capabilities';
import { WebBrowserService, type WebBrowserSession, activityForWebTool, webToolDefinitions } from '../web/web-tools';
import { AgentToolContext, type ToolContextStats } from './agent-tool-context';
import { OllamaRequestError, ollamaErrorDiagnostics } from '../backends/ollama-errors';

const finalizationThreshold = 5;
const finalSynthesisTimeoutMs = 120_000;
const maxInferenceAttempts = 3;
const retryDelayMs = (attempt: number): number => 150 * 2 ** (attempt - 1);
type AgentRuntimeContext = { generationId: string; conversationId: string };

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

  async *stream(model: string, history: ChatMessage[], root: string, signal: AbortSignal, contextWindow: number, depth: AnalysisDepth, webMode: WebMode, confirm: ConfirmAction, runtime?: AgentRuntimeContext): AsyncIterable<StreamEvent> {
    const engine = new AnalysisEngine(depth); const tools = await ReadonlyProjectTools.open(root, confirm);
    let webSession: WebBrowserSession | null = null;
    if (webMode === 'auto') {
      try { webSession = await this.web.openSession(); }
      catch (error) { log('web.session.unavailable', { message: error instanceof Error ? error.message : String(error) }); }
    }
    const closeWebOnAbort = () => { void webSession?.close(); };
    signal.addEventListener('abort', closeWebOnAbort, { once: true });
    const toolDefinitions = [...projectToolDefinitions, ...(webSession ? webToolDefinitions : [])];
    const messages: ToolMessage[] = [{ role: 'system', content: `${capabilitySystemContext({ webAvailable: Boolean(webSession), projectRoot: root, projectWriteAvailable: true, terminalAvailable: true })} Не предполагай тип, технологию или предметную область проекта. ${engine.strategy()} Результаты инструментов могут быть детерминированно сокращены ради контекстного бюджета; для полного содержания файла снова вызови read_file с конкретным диапазоном.` }, ...history.map(({ role, content, images }) => ({ role, content, ...(images?.length ? { images } : {}) }))];
    const toolContext = new AgentToolContext(contextWindow);
    let actions = 0; let repeats = 0; let lowInfo = 0; let warningSent = false; let researchFinished = false;
    const completed = new Set<string>();
    if (engine.isDeep) { log('deep.lifecycle', { phase: 'research.started', model, contextWindow }); yield { type: 'analysis', progress: { stage: 'reconnaissance', status: 'active' } }; }
    try { while (!signal.aborted) {
      const remaining = engine.budget - actions;
      if (remaining <= 0) { yield* this.synthesize(model, messages, engine, signal, contextWindow, '', actions, toolContext.stats(), runtime); return; }
      if (remaining <= finalizationThreshold && !warningSent) { messages.push({ role: 'system', content: 'Осталось мало вызовов. Закрой только наиболее важные пробелы и заверши исследование.' }); warningSent = true; }
      const response = await this.inference(model, messages, toolDefinitions, signal, contextWindow, depth, actions, toolContext.stats(), runtime);
      const calls = response.tool_calls?.length ? response.tool_calls.map(parseCall) : parseInlineToolCalls(response.content ?? '');
      messages.push({ role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls });
      if (calls.length === 0) {
        researchFinished = true;
        if (engine.isDeep) log('deep.lifecycle', { phase: 'research.finished', actions });
        yield* this.synthesize(model, messages, engine, signal, contextWindow, response.content ?? '', actions, toolContext.stats(), runtime);
        return;
      }
      for (const call of calls) {
        if (signal.aborted || actions >= engine.budget) break;
        const key = signature(call);
        // Re-reading is valid after mutations, for another range, and for verification.
        // The context manager deduplicates unchanged same-range reads without hiding content.
        if (completed.has(key) && call.name !== 'read_file') {
          repeats += 1; messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify({ warning: 'Идентичный вызов уже выполнен. Смени стратегию или заверши исследование.' }) });
          if (repeats >= 3) { researchFinished = true; yield* this.synthesize(model, messages, engine, signal, contextWindow, '', actions, toolContext.stats(), runtime); return; }
          continue;
        }
        completed.add(key); actions += 1;
        const isWebTool = webToolDefinitions.some((definition) => definition.function.name === call.name);
        const actionId = randomUUID();
        yield { type: 'tool', activity: { id: actionId, ...(isWebTool ? activityForWebTool(call) : activityForTool(call)) } };
        const result = isWebTool && webSession ? await webSession.execute(call) : await tools.execute(call, signal, actionId); engine.record(call.name, result);
        if (lowInformation(result)) { lowInfo += 1; if (lowInfo === 3) messages.push({ role: 'system', content: 'Последние действия дали мало новой информации. Сузь исследование или заверши ответ.' }); } else lowInfo = 0;
        const toolMessage: ToolMessage = { role: 'tool', tool_name: call.name, content: result };
        messages.push(toolMessage);
        const contextUpdate = toolContext.add(call.name, call.arguments, toolMessage, actions);
        const stats = contextUpdate.stats;
        if (contextUpdate.read) log('agent.read.diagnostics', { ...runtime, agentStep: actions, normalizedPath: contextUpdate.read.path, requestedRange: contextUpdate.read.range, fileFingerprint: contextUpdate.read.fingerprint, readCount: contextUpdate.read.readCount, sameContentAlreadyRead: contextUpdate.read.sameContentAlreadyRead, previousResultActive: contextUpdate.read.previousResultActive, previousResultCompacted: contextUpdate.read.previousResultCompacted, previousCompactionReason: contextUpdate.read.previousCompactionReason, repeatedReadLoopSuspected: contextUpdate.read.repeatedReadLoopSuspected, pinned: contextUpdate.read.pinned, activeToolResultContextSize: stats.size, contextBudget: stats.budget, peakActiveToolResultContextSize: stats.peakSize });
        if (stats.compacted) log('agent.context.compacted', { ...runtime, agentStep: actions, tool: call.name, toolResultContextSize: stats.size, toolResultContextBudget: stats.budget, compactedResults: stats.compacted });
      }
    } } catch (error) {
      if (signal.aborted) return;
      const details = error instanceof Error ? error.message : String(error);
      log('agent.inference.failed', { ...runtime, phase: researchFinished ? 'final-synthesis.error' : 'research.error', actions, model, contextWindow, toolResultContext: toolContext.stats(), ...ollamaErrorDiagnostics(error) });
      yield { type: 'error', message: 'Анализ не завершился', details };
    } finally { signal.removeEventListener('abort', closeWebOnAbort); await webSession?.close(); if (engine.isDeep) log('deep.lifecycle', { phase: 'request.finalized', actions, aborted: signal.aborted }); }
  }

  private async *synthesize(model: string, messages: ToolMessage[], engine: AnalysisEngine, signal: AbortSignal, contextWindow: number, fallback: string, actions: number, toolContext: ToolContextStats, runtime?: AgentRuntimeContext): AsyncIterable<StreamEvent> {
    const evidence = engine.prompt();
    if (engine.isDeep) { log('deep.lifecycle', { phase: 'evidence-map.created', actions }); log('deep.lifecycle', { phase: 'final-synthesis.started', actions }); yield { type: 'analysis', progress: { stage: 'synthesis', status: 'active' } }; }
    messages.push({ role: 'system', content: evidence }, { role: 'system', content: 'Исследование завершено. Сформируй один итоговый ответ на исходный вопрос пользователя, опираясь на evidence map и релевантные доступные результаты инструментов. Не вызывай инструменты.' });
    try {
      const response = await this.finalRequest(model, messages, signal, contextWindow, engine.depth, actions, toolContext, runtime);
      if (response.finish_reason === 'length') throw new OllamaRequestError('output_limit', 'Итоговый ответ Ollama был остановлен по лимиту длины', { causeDetail: 'done_reason=length' });
      if (response.tool_calls?.length) throw new OllamaRequestError('malformed_response', 'Ollama вернул tool call вместо итогового ответа', { causeDetail: 'final request did not allow tools' });
      const content = response.content?.trim() || fallback;
      if (!content) {
        const reason = response.thinking?.trim() ? 'Ollama вернул reasoning без итогового текста' : 'Ollama вернул корректный ответ без итогового текста';
        throw new OllamaRequestError('empty_response', reason, { causeDetail: JSON.stringify({ finish_reason: response.finish_reason, has_thinking: Boolean(response.thinking?.trim()) }) });
      }
      if (engine.isDeep) log('deep.lifecycle', { phase: 'final-synthesis.finished', responseChars: content.length });
      if (typeof response.prompt_eval_count === 'number') yield { type: 'context-usage', used: response.prompt_eval_count, maximum: contextWindow };
      yield* this.emit(content, engine, signal, response.inference ? { ...response.inference, toolResultContextSize: toolContext.size, toolResultContextBudget: toolContext.budget, toolResultCompacted: toolContext.compacted } : undefined, actions, response.finish_reason);
    } catch (error) {
      if (signal.aborted) return;
      const details = error instanceof Error ? error.message : String(error);
      const timedOut = details.includes('timed out');
      log('agent.final.failed', { ...runtime, phase: timedOut ? 'final-synthesis.timeout' : 'final-synthesis.error', model, actions, contextWindow, fallback: Boolean(fallback), ...ollamaErrorDiagnostics(error) });
      if (fallback.trim()) { yield* this.emit(fallback, engine, signal, undefined, actions, 'stop'); return; }
      yield { type: 'error', message: 'Не удалось сформировать итоговый ответ', details };
    }
  }

  private async finalRequest(model: string, messages: ToolMessage[], signal: AbortSignal, contextWindow: number, depth: AnalysisDepth, actions: number, toolContext: ToolContextStats, runtime?: AgentRuntimeContext): Promise<ToolMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), finalSynthesisTimeoutMs);
    let rejectTimeout: ReturnType<typeof setTimeout> | null = null;
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      return await Promise.race([
        this.inference(model, messages, undefined, combined, contextWindow, depth, actions, toolContext, runtime),
        new Promise<never>((_resolve, reject) => { rejectTimeout = setTimeout(() => reject(new Error('final synthesis timed out')), finalSynthesisTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); if (rejectTimeout) clearTimeout(rejectTimeout); }
  }

  /** Retries only an inference boundary. Tool execution occurs after this returns. */
  private async inference(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, depth: AnalysisDepth, agentStep: number, toolContext: ToolContextStats | undefined, runtime?: AgentRuntimeContext): Promise<ToolMessage> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxInferenceAttempts; attempt += 1) {
      if (signal.aborted) throw new OllamaRequestError('cancelled', 'Запрос к Ollama отменён');
      try {
        log('agent.inference.attempt', { ...runtime, model, agentStep, attempt, retryCount: attempt - 1, contextLimit: contextWindow, toolResultContextSize: toolContext?.size, toolResultContextBudget: toolContext?.budget, toolResultCompacted: toolContext?.compacted });
        const response = await this.backend.chatWithTools(model, messages, tools, signal, contextWindow, depth);
        log('agent.inference.success', { ...runtime, model, agentStep, attempt, retryCount: attempt - 1, promptEvalCount: response.prompt_eval_count, finishReason: response.finish_reason });
        if (response.inference) {
          response.inference = { ...response.inference, ollamaRequestAttempt: attempt, ollamaRetryCount: attempt - 1, toolResultContextSize: toolContext?.size, toolResultContextBudget: toolContext?.budget, toolResultCompacted: toolContext?.compacted };
        }
        return response;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof OllamaRequestError && error.retryable;
        log('agent.inference.failure', { ...runtime, model, agentStep, attempt, retryCount: attempt - 1, contextLimit: contextWindow, willRetry: retryable && attempt < maxInferenceAttempts && !signal.aborted, ...ollamaErrorDiagnostics(error) });
        if (!retryable || attempt === maxInferenceAttempts || signal.aborted) throw error;
        await this.waitForRetry(retryDelayMs(attempt), signal);
      }
    }
    throw lastError;
  }

  private async waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new OllamaRequestError('cancelled', 'Запрос к Ollama отменён');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delay);
      const abort = () => { clearTimeout(timer); done(); };
      function done(): void { signal.removeEventListener('abort', abort); resolve(); }
      signal.addEventListener('abort', abort, { once: true });
    });
    if (signal.aborted) throw new OllamaRequestError('cancelled', 'Запрос к Ollama отменён');
  }

  private async *emit(content: string, engine: AnalysisEngine, signal: AbortSignal, inference: InferenceDiagnostics | undefined, actions: number, finishReason: FinishReason | undefined): AsyncIterable<StreamEvent> {
    if (engine.isDeep) log('deep.lifecycle', { phase: 'response.emitted', responseChars: content.length });
    for (const token of chunkText(content)) { if (signal.aborted) return; yield { type: 'token', content: token }; }
    if (inference) yield { type: 'diagnostics', diagnostics: { ...inference, agentStepCount: actions, finishReason: finishReason ?? 'stop' } };
    yield { type: 'done', finishReason: finishReason ?? 'stop' };
  }
}
