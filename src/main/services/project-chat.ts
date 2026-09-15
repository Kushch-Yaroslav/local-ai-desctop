import { randomUUID } from 'node:crypto';
import type { AnalysisDepth, ChatMessage, FinishReason, StreamEvent, ToolActivity, WebMode } from '../../shared/types';
import type { InferenceDiagnostics, ToolCall, ToolCallingBackend, ToolMessage } from '../backends/types';
import { AnalysisEngine } from './analysis-engine';
import { log } from './logger';
import { ReadonlyProjectTools, activityForTool, projectToolDefinitions, type ConfirmAction, type ProjectToolCall } from '../tools/project-tools';
import { capabilitySystemContext } from './capabilities';
import { WebBrowserService, type WebBrowserSession, activityForWebTool, webToolDefinitions } from '../web/web-tools';
import { AgentToolContext, type ReadDiagnostic, type ToolContextStats } from './agent-tool-context';
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
function resultObject(raw: string): Record<string, unknown> { try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
function lineRange(value: Record<string, unknown>): string | undefined {
  if (typeof value.start_line === 'number') return typeof value.end_line === 'number' && value.end_line !== value.start_line ? `строки ${value.start_line}–${value.end_line}` : `строка ${value.start_line}`;
  if (typeof value.byte_start === 'number') return typeof value.byte_end === 'number' ? `байты ${value.byte_start}–${value.byte_end}` : `с байта ${value.byte_start}`;
  return undefined;
}
type StagnationStats = {
  explorationActions: number; broadExplorationActions: number; targetedExplorationActions: number; repeatedExplorationActions: number; mutationActions: number; verificationActions: number;
  exactDuplicateReads: number; coveredReads: number; overlappingReads: number; newInformationReads: number; stepsSinceLastNewInformation: number; stepsSinceLastMutation: number; stagnationSuspected: boolean;
};
class AgentStagnation {
  private readonly stats: StagnationStats = { explorationActions: 0, broadExplorationActions: 0, targetedExplorationActions: 0, repeatedExplorationActions: 0, mutationActions: 0, verificationActions: 0, exactDuplicateReads: 0, coveredReads: 0, overlappingReads: 0, newInformationReads: 0, stepsSinceLastNewInformation: 0, stepsSinceLastMutation: 0, stagnationSuspected: false };
  record(call: ProjectToolCall, read: ReadDiagnostic | undefined, action: number): StagnationStats {
    const mutation = ['apply_patch', 'write_file', 'create_file', 'delete_file'].includes(call.name);
    const verification = ['git_status', 'git_diff', 'run_terminal'].includes(call.name);
    const exploration = ['read_file', 'inspect_package_json', 'search_text', 'find_files', 'search_files', 'list_directory', 'web_search', 'web_open'].includes(call.name);
    if (mutation) { this.stats.mutationActions += 1; this.stats.stepsSinceLastMutation = 0; } else this.stats.stepsSinceLastMutation += 1;
    if (verification) this.stats.verificationActions += 1;
    if (exploration) {
      this.stats.explorationActions += 1;
      if (read?.relationship === 'exact_duplicate') { this.stats.exactDuplicateReads += 1; this.stats.repeatedExplorationActions += 1; }
      else if (read?.relationship === 'covered') { this.stats.coveredReads += 1; this.stats.repeatedExplorationActions += 1; }
      else if (read?.relationship === 'overlap') { this.stats.overlappingReads += 1; this.stats.repeatedExplorationActions += 1; }
      else if (call.name === 'read_file' || call.name === 'inspect_package_json') {
        this.stats.newInformationReads += 1; this.stats.targetedExplorationActions += 1; this.stats.stepsSinceLastNewInformation = 0;
      } else if (call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files') this.stats.targetedExplorationActions += 1;
      else this.stats.broadExplorationActions += 1;
    }
    if (!read || read.relationship !== 'new') this.stats.stepsSinceLastNewInformation += 1;
    this.stats.stagnationSuspected = this.stats.mutationActions === 0 && this.stats.explorationActions >= 20 && this.stats.stepsSinceLastNewInformation >= 12 && this.stats.stepsSinceLastMutation >= 20;
    return { ...this.stats, stepsSinceLastMutation: this.stats.mutationActions ? this.stats.stepsSinceLastMutation : action };
  }
}
function completedActivity(activity: ToolActivity, call: ProjectToolCall, raw: string, durationMs: number, context?: { read?: ReadDiagnostic }): ToolActivity {
  const value = resultObject(raw); const error = typeof value.error === 'string';
  const metadata: Record<string, string | number | boolean | null> = { duration_ms: durationMs };
  let detail = activity.detail;
  if (call.name === 'read_file' || call.name === 'inspect_package_json') {
    const path = typeof value.path === 'string' ? value.path : typeof call.arguments.path === 'string' ? call.arguments.path : 'package.json';
    const range = lineRange(value);
    detail = range ? `${path} · ${range}` : `${path} · весь файл`;
    for (const key of ['fingerprint', 'status', 'readCount', 'sameContentAlreadyRead', 'previousResultActive', 'previousResultCompacted', 'previousResultInvalidated', 'previousInvalidationReason', 'relationship', 'coveredByRange', 'pinned', 'repeatedReadLoopSuspected'] as const) {
      if (key === 'status') { if (typeof value.status === 'string') metadata.status = value.status; continue; }
      const field = value[key] ?? context?.read?.[key];
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') metadata[key] = field;
    }
    if (range) metadata.actual_range = range;
  } else if (call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files') {
    const count = Array.isArray(value.matches) ? value.matches.length : 0;
    detail = `${activity.detail ?? ''} · ${count} ${count === 1 ? 'совпадение' : count < 5 ? 'совпадения' : 'совпадений'}`.trim(); metadata.matches = count;
  } else if (call.name === 'list_directory') {
    const count = Array.isArray(value.entries) ? value.entries.length : 0; detail = `${typeof value.root === 'string' ? value.root : activity.detail ?? '.'} · ${count} элементов`; metadata.entries = count;
  } else if (call.name === 'run_terminal') {
    const exit = typeof value.exit_code === 'number' ? value.exit_code : null; detail = `${activity.detail ?? ''} · ${exit === null ? 'завершено' : `exit ${exit}`} · ${(durationMs / 1000).toFixed(1)}s`; metadata.exit_code = exit;
    if (typeof value.cwd === 'string') metadata.cwd = value.cwd;
  } else if (call.name === 'apply_patch' || call.name === 'write_file' || call.name === 'create_file' || call.name === 'delete_file') {
    const paths = Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === 'string') : typeof value.path === 'string' ? [value.path] : [];
    if (paths.length) detail = paths.join(' · ');
  }
  const output = call.name === 'run_terminal' ? [typeof value.stdout === 'string' ? value.stdout : '', typeof value.stderr === 'string' ? value.stderr : ''].filter(Boolean).join('\n').slice(0, 12_000)
    : call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files' || call.name === 'list_directory' ? JSON.stringify(value.matches ?? value.entries ?? [], null, 2).slice(0, 12_000)
      : call.name === 'git_status' || call.name === 'git_diff' ? String(value.status ?? value.diff ?? '').slice(0, 12_000)
        : error ? String(value.error).slice(0, 2_000) : undefined;
  return { ...activity, detail, state: error || (call.name === 'run_terminal' && value.exit_code !== 0) ? 'error' : 'completed', metadata, output };
}
const runtimeNotice = (kind: string, content: string): ToolMessage => ({ role: 'user', content: `<runtime_context kind="${kind}">${content}</runtime_context>` });
const agentHistory = (history: ChatMessage[]): ToolMessage[] => history.map(({ role, content, images }) => role === 'system' ? runtimeNotice('history', content) : ({ role, content, ...(images?.length ? { images } : {}) }));
const messageMetadata = (messages: ToolMessage[]): Array<Record<string, unknown>> => messages.map((message, index) => {
  let contentKind: string | undefined;
  try { const value = JSON.parse(message.content) as { context_compacted?: boolean; cached_read?: boolean; status?: unknown }; if (value.context_compacted) contentKind = 'compacted_tool_result'; else if (value.cached_read || value.status === 'unchanged') contentKind = 'cached_read'; } catch { /* Do not log content. */ }
  if (message.content.startsWith('<runtime_context')) contentKind = 'runtime_context';
  return { index, role: message.role, toolName: message.tool_name, toolCallCount: message.tool_calls?.length ?? 0, contentKind };
});

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
    const messages: ToolMessage[] = [{ role: 'system', content: `${capabilitySystemContext({ webAvailable: Boolean(webSession), projectRoot: root, projectWriteAvailable: true, terminalAvailable: true })} Не предполагай тип, технологию или предметную область проекта. ${engine.strategy()} Результаты инструментов могут быть детерминированно сокращены ради контекстного бюджета; для полного содержания файла снова вызови read_file с конкретным диапазоном.` }, ...agentHistory(history)];
    const toolContext = new AgentToolContext(contextWindow);
    let actions = 0; let progressReports = 0; let repeats = 0; let lowInfo = 0; let warningSent = false; let researchFinished = false;
    const progressMessages = new Set<string>();
    const completed = new Set<string>();
    const stagnation = new AgentStagnation();
    if (engine.isDeep) { log('deep.lifecycle', { phase: 'research.started', model, contextWindow }); yield { type: 'analysis', progress: { stage: 'reconnaissance', status: 'active' } }; }
    try { while (!signal.aborted) {
      const remaining = engine.budget - actions;
      if (remaining <= 0) { yield* this.synthesize(model, messages, engine, signal, contextWindow, '', actions, toolContext.stats(), runtime); return; }
      if (remaining <= finalizationThreshold && !warningSent) { messages.push(runtimeNotice('action_budget', 'Осталось мало вызовов. Закрой только наиболее важные пробелы и заверши исследование.')); warningSent = true; }
      const response = await this.inference(model, messages, toolDefinitions, signal, contextWindow, depth, actions, toolContext.stats(), runtime);
      const calls = response.tool_calls?.length ? response.tool_calls.map(parseCall) : parseInlineToolCalls(response.content ?? '');
      messages.push({ role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls });
      if (calls.length === 0) {
        researchFinished = true;
        if (engine.isDeep) log('deep.lifecycle', { phase: 'research.finished', actions });
        yield* this.synthesize(model, messages, engine, signal, contextWindow, response.content ?? '', actions, toolContext.stats(), runtime);
        return;
      }
      let lowInformationNotice = false;
      for (const call of calls) {
        if (signal.aborted || actions >= engine.budget) break;
        if (call.name === 'report_progress') {
          const message = typeof call.arguments.message === 'string' ? call.arguments.message.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
          const accepted = message.length >= 3 && progressReports < 12 && !progressMessages.has(message);
          const actionId = randomUUID();
          if (accepted) {
            progressReports += 1; progressMessages.add(message);
            yield { type: 'tool', activity: { id: actionId, ...activityForTool({ ...call, arguments: { message } }), metadata: { progress_index: progressReports } } };
          }
          messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(accepted ? { reported: true } : { reported: false, reason: 'Progress updates are limited; continue with the task.' }) });
          continue;
        }
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
        const activity: ToolActivity = { id: actionId, ...(isWebTool ? { ...activityForWebTool(call), kind: 'web' as const, state: 'running' as const } : activityForTool(call)) };
        yield { type: 'tool', activity };
        const startedAt = Date.now();
        const result = isWebTool && webSession ? await webSession.execute(call) : await tools.execute(call, signal, actionId); engine.record(call.name, result);
        const toolMessage: ToolMessage = { role: 'tool', tool_name: call.name, content: result };
        messages.push(toolMessage);
        if (lowInformation(result)) { lowInfo += 1; if (lowInfo === 3) lowInformationNotice = true; } else lowInfo = 0;
        const contextUpdate = toolContext.add(call.name, call.arguments, toolMessage, actions);
        const stats = contextUpdate.stats;
        if (contextUpdate.read) log('agent.read.diagnostics', { ...runtime, agentStep: actions, normalizedPath: contextUpdate.read.path, requestedRange: contextUpdate.read.range, fileFingerprint: contextUpdate.read.fingerprint, readCount: contextUpdate.read.readCount, sameContentAlreadyRead: contextUpdate.read.sameContentAlreadyRead, relationship: contextUpdate.read.relationship, coveredByRange: contextUpdate.read.coveredByRange, previousResultActive: contextUpdate.read.previousResultActive, previousResultCompacted: contextUpdate.read.previousResultCompacted, previousCompactionReason: contextUpdate.read.previousCompactionReason, previousResultInvalidated: contextUpdate.read.previousResultInvalidated, previousInvalidationReason: contextUpdate.read.previousInvalidationReason, repeatedReadLoopSuspected: contextUpdate.read.repeatedReadLoopSuspected, pinned: contextUpdate.read.pinned, activeToolResultContextSize: stats.size, contextBudget: stats.budget, peakActiveToolResultContextSize: stats.peakSize });
        if (contextUpdate.invalidation) log('agent.read.cache.invalidated', { ...runtime, agentStep: actions, tool: call.name, ...contextUpdate.invalidation, totalInvalidatedReads: stats.invalidatedReads });
        log('agent.stagnation.diagnostics', { ...runtime, agentStep: actions, ...stagnation.record(call, contextUpdate.read, actions) });
        if (stats.compacted) log('agent.context.compacted', { ...runtime, agentStep: actions, tool: call.name, toolResultContextSize: stats.size, toolResultContextBudget: stats.budget, compactedResults: stats.compacted });
        const finishedActivity = completedActivity(activity, call, result, Date.now() - startedAt, contextUpdate);
        const contextResult = resultObject(toolMessage.content);
        if (typeof contextResult.status === 'string') finishedActivity.metadata = { ...finishedActivity.metadata, status: contextResult.status };
        yield { type: 'tool', activity: finishedActivity };
      }
      if (lowInformationNotice) messages.push(runtimeNotice('low_information', 'Последние действия дали мало новой информации. Сузь исследование или заверши ответ.'));
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
    messages.push(runtimeNotice('evidence_map', evidence), runtimeNotice('finalization', 'Исследование завершено. Сформируй один итоговый ответ на исходный вопрос пользователя, опираясь на evidence map и релевантные доступные результаты инструментов. Не вызывай инструменты.'));
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
        log('agent.message.sequence', { ...runtime, agentStep, messages: messageMetadata(messages) });
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
