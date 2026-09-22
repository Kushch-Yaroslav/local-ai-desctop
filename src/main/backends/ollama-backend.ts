import type { ChatMessage, FinishReason, ModelInfo, ReasoningMode, StreamEvent } from '../../shared/types';
import { wholeNanoseconds, type InferenceDiagnostics, type LlmBackend, type ToolCallingBackend, type ToolInferenceRequestContext, type ToolMessage } from './types';
import { getModelProfile, maxOutputTokens, modelInfo, modelRegistry, ollamaReasoning, outputBudget, supportsOllamaReasoning } from '../models/model-registry';
import { log } from '../services/logger';
import { OllamaRequestError, classifyOllamaError, ollamaErrorDiagnostics } from './ollama-errors';

type OllamaTags = { models?: Array<{ name: string; model?: string; size: number; capabilities?: string[]; details?: { family?: string; families?: string[] } }> };
type OllamaMetrics = { prompt_eval_count?: number; prompt_eval_duration?: number; eval_count?: number; eval_duration?: number };
type OllamaChunk = { message?: { content?: string; thinking?: string }; done?: boolean; done_reason?: string; error?: string } & OllamaMetrics;

type OllamaToolResponse = { message?: ToolMessage; error?: string; done_reason?: string } & OllamaMetrics;
type OllamaShowResponse = { model_info?: Record<string, unknown>; parameters?: string };
type OllamaRunningModels = { models?: Array<{ name: string; model?: string }> };

export type ContextWindow = { requested: number; active: number; supported?: number };

/** A token-count probe emits one completion token. Do not include tools there:
 * Ollama may attempt to parse that intentionally incomplete tool call. */
const toolSchemaTokenAllowance = (tools: unknown[] | undefined): number => tools?.length ? Math.ceil(JSON.stringify(tools).length / 2) : 0;

export class OllamaBackend implements LlmBackend, ToolCallingBackend {
  /** Models requested by this Desktop process, released explicitly on exit. */
  private readonly usedModels = new Set<string>();
  /** A context-manager probe is immediately reused by the matching request. */
  private readonly preparedInputTokens = new WeakMap<object, { tools: unknown[] | undefined; contextWindow: number; tokens: number }>();
  constructor(private readonly baseUrl = 'http://127.0.0.1:11434') {}

  /** Ollama identifies tool results by tool_name. Keep OpenAI call IDs inside
   * the Agent state machine, but do not send an unsupported extra field here. */
  private toolMessages(messages: ToolMessage[]): Array<Record<string, unknown>> {
    return messages.map((message) => {
      const tool = message as ToolMessage;
      const toolCalls = tool.tool_calls?.map((call) => {
        const raw = call.function.arguments;
        let argumentsObject: Record<string, unknown> = {};
        if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) argumentsObject = parsed as Record<string, unknown>;
          } catch { /* A malformed historic call is represented as an empty object, never as invalid Ollama tool JSON. */ }
        } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) argumentsObject = raw;
        return { ...call, function: { ...call.function, arguments: argumentsObject } };
      });
      return { role: message.role, content: message.content, ...(tool.images?.length ? { images: tool.images } : {}), ...(toolCalls?.length ? { tool_calls: toolCalls } : {}), ...(tool.tool_name ? { tool_name: tool.tool_name } : {}) };
    });
  }

  async getModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Ollama вернул HTTP ${response.status}`);
    const data = await response.json() as OllamaTags;
    const installed = new Map((data.models ?? []).map((model) => [model.name, model]));
    return Promise.all(modelRegistry.map(async (profile) => {
      const model = installed.get(profile.id);
      if (!model) return modelInfo(profile, false);
      return modelInfo(profile, true, model.size, await this.modelContextLimit(profile.id, profile.maxContext), supportsOllamaReasoning(profile));
    }));
  }

  private async modelContextLimit(model: string, fallback: number): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
      if (!response.ok) return fallback;
      const data = await response.json() as OllamaShowResponse;
      const limit = Object.entries(data.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
      const parsed = Number(limit);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    } catch { return fallback; }
  }

  async getStatus(): Promise<{ available: boolean; message?: string }> {
    try { await this.getModels(); return { available: true }; }
    catch (error) { return { available: false, message: error instanceof Error ? error.message : String(error) }; }
  }

  /** Uses the runtime's advertised capability, never a model-name heuristic. */
  async supportsVision(model: string, signal?: AbortSignal): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!response.ok) throw new Error(`Ollama вернул HTTP ${response.status}`);
    const data = await response.json() as OllamaTags;
    const installed = (data.models ?? []).find((candidate) => candidate.name === model || candidate.model === model);
    return installed?.capabilities?.includes('vision') === true;
  }

  async resolveContextWindow(model: string, requested: number, signal: AbortSignal): Promise<ContextWindow> {
    const profile = getModelProfile(model);
    if (!profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
      });
      if (!response.ok) return { requested, active: Math.min(requested, profile.maxContext), supported: profile.maxContext };
      const data = await response.json() as OllamaShowResponse;
      const modelLimit = Object.entries(data.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
      const parameterLimit = data.parameters?.match(/^num_ctx\s+(\d+)$/m)?.[1];
      const supported = Number(modelLimit ?? parameterLimit);
      const maximum = Number.isFinite(supported) && supported > 0 ? Math.min(supported, profile.maxContext) : profile.maxContext;
      return { requested, active: Math.min(requested, maximum), supported: maximum };
    } catch (error) {
      if (signal.aborted) throw error;
      return { requested, active: Math.min(requested, profile.maxContext), supported: profile.maxContext };
    }
  }

  async ensureModelAvailable(model: string): Promise<void> {
    const profile = getModelProfile(model);
    if (!profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const models = await this.getModels();
    if (!models.find((candidate) => candidate.id === model)?.installed) throw new Error(`Модель ${profile.displayName} не установлена. Проверьте DATA-диск и загрузите её через Ollama.`);
  }

  async isModelLoaded(model: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/ps`);
      if (!response.ok) return false;
      const data = await response.json() as OllamaRunningModels;
      return (data.models ?? []).some((candidate) => candidate.name === model || candidate.model === model);
    } catch { return false; }
  }

  async unloadModel(model: string): Promise<void> {
    this.usedModels.delete(model);
    await this.releaseModel(model, 'model_changed');
  }

  /** Best-effort release of only models this Desktop process actually used. */
  async unloadTrackedModels(): Promise<void> {
    const models = [...this.usedModels];
    this.usedModels.clear();
    if (!models.length) return;
    log('ollama.unload-on-exit.started', { models });
    const results = await Promise.allSettled(models.map((model) => this.releaseModel(model, 'application_exit')));
    log('ollama.unload-on-exit.finished', {
      models,
      released: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length,
    });
  }

  private async releaseModel(model: string, reason: 'model_changed' | 'application_exit'): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      log('ollama.model.unloaded', { model, reason });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestOptions(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, reasoningMode: ReasoningMode, signal: AbortSignal): Promise<{ think?: boolean | string; options: Record<string, number>; diagnostics: InferenceDiagnostics }> {
    const profile = getModelProfile(model);
    if (!profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const prepared = this.preparedInputTokens.get(messages);
    const inputTokens = prepared && prepared.tools === tools && prepared.contextWindow === contextWindow ? prepared.tokens : await this.inputTokens(model, messages, tools, contextWindow, signal);
    this.preparedInputTokens.delete(messages);
    const requested = maxOutputTokens;
    const effective = outputBudget(contextWindow, inputTokens);
    if (effective < 1) throw new OllamaRequestError('context_exhausted', 'Контекстное окно заполнено. Уменьшите историю или выберите больший контекст, затем продолжите ответ.', { causeDetail: `input_tokens=${inputTokens}; context_limit=${contextWindow}` });
    const diagnostics: InferenceDiagnostics = { reasoningMode, requestedMaxOutputTokens: requested, effectiveMaxOutputTokens: effective, contextLimit: contextWindow, inputTokens };
    log('inference.options', diagnostics);
    const think = ollamaReasoning(reasoningMode, profile);
    return { ...(think === undefined ? {} : { think }), options: { num_ctx: Math.min(contextWindow, profile.maxContext), num_predict: effective }, diagnostics };
  }

  /** A one-token preflight gives the same chat-template/token count that Ollama will use for the actual request. */
  private async inputTokens(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, signal: AbortSignal): Promise<number> {
    const ollamaMessages = this.toolMessages(messages);
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        // Suppressing tools here prevents an incomplete `num_predict: 1`
        // completion from entering Ollama's tool-argument parser. Account for
        // their prompt footprint below with a deliberately conservative bound.
        body: JSON.stringify({ model, stream: false, messages: ollamaMessages, think: false, options: { num_ctx: contextWindow, num_predict: 1 } }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as OllamaToolResponse;
      if (typeof data.prompt_eval_count !== 'number') throw new Error('Ollama did not return prompt_eval_count');
      const allowance = toolSchemaTokenAllowance(tools);
      if (allowance) log('inference.preflight.tools-suppressed', { model, toolCount: tools?.length ?? 0, promptEvalCount: data.prompt_eval_count, toolSchemaTokenAllowance: allowance });
      return data.prompt_eval_count + allowance;
    } catch (error) {
      if (signal.aborted) throw classifyOllamaError(error, signal);
      const prompt = ollamaMessages.map((message) => `<|${message.role}|>\n${message.content}\n`).join('');
      // Older runtimes may reject the preflight; use a deliberately high estimate rather than overflow the context.
      const conservative = Math.ceil(prompt.length / 2) + 256 + messages.length * 16 + toolSchemaTokenAllowance(tools);
      log('inference.preflight.fallback', { model, message: error instanceof Error ? error.message : String(error), inputTokens: conservative });
      return conservative;
    }
  }

  async countInputTokens(model: string, messages: ToolMessage[], tools: unknown[] | undefined, contextWindow: number, _reasoningMode: ReasoningMode, signal: AbortSignal): Promise<number> {
    const tokens = await this.inputTokens(model, messages, tools, contextWindow, signal);
    this.preparedInputTokens.set(messages, { tools, contextWindow, tokens });
    return tokens;
  }

  private finishReason(reason: string | undefined): FinishReason { return reason === 'length' ? 'length' : 'stop'; }

  private withPerformance(diagnostics: InferenceDiagnostics, metrics: OllamaMetrics, timeToFirstTokenMs?: number): InferenceDiagnostics {
    const promptEvalDuration = wholeNanoseconds(metrics.prompt_eval_duration);
    const evalDuration = wholeNanoseconds(metrics.eval_duration);
    const rate = (count: number | undefined, duration: number | undefined): number | undefined => count !== undefined && duration !== undefined && duration > 0 ? count / (duration / 1_000_000_000) : undefined;
    return {
      ...diagnostics,
      inputTokens: metrics.prompt_eval_count ?? diagnostics.inputTokens,
      ...(metrics.prompt_eval_count !== undefined ? { promptEvalCount: metrics.prompt_eval_count } : {}),
      ...(promptEvalDuration !== undefined ? { promptEvalDuration } : {}),
      ...(metrics.eval_count !== undefined ? { evalCount: metrics.eval_count } : {}),
      ...(evalDuration !== undefined ? { evalDuration } : {}),
      ...(rate(metrics.eval_count, evalDuration) !== undefined ? { tokensPerSecond: rate(metrics.eval_count, evalDuration) } : {}),
      ...(rate(metrics.prompt_eval_count, promptEvalDuration) !== undefined ? { promptTokensPerSecond: rate(metrics.prompt_eval_count, promptEvalDuration) } : {}),
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
    };
  }

  private readableError(error: unknown, signal?: AbortSignal): OllamaRequestError {
    const classified = classifyOllamaError(error, signal);
    if (classified.kind !== 'internal') return classified;
    const detail = classified.message;
    const lower = detail.toLowerCase();
    if (lower.includes('not found')) return new OllamaRequestError('process_failure', 'Модель не найдена. Проверьте, что DATA-диск подключён и модель полностью установлена.', { causeDetail: detail });
    if (lower.includes('cuda') && (lower.includes('memory') || lower.includes('oom'))) return new OllamaRequestError('process_failure', 'Недостаточно VRAM для выбранного контекста. Выберите меньший размер контекста или дождитесь выгрузки предыдущей модели.', { causeDetail: detail });
    if (lower.includes('context') || lower.includes('num_ctx')) return new OllamaRequestError('context_exhausted', 'Выбранный размер контекста не поддерживается этой моделью.', { causeDetail: detail });
    return classified;
  }

  async chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, _requestContext?: ToolInferenceRequestContext): Promise<ToolMessage> {
    void _requestContext;
    this.usedModels.add(model);
    let response: Response;
    try {
      const settings = await this.requestOptions(model, messages, tools, contextWindow, reasoningMode, signal);
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: this.toolMessages(messages), ...(tools ? { tools } : {}), ...(settings.think === undefined ? {} : { think: settings.think }), options: settings.options }),
      });
      let data: OllamaToolResponse;
      try { data = await response.json() as OllamaToolResponse; }
      catch (error) { throw new OllamaRequestError('malformed_response', 'Ollama вернул неполный или некорректный JSON-ответ', { retryable: true, status: response.status, causeDetail: error instanceof Error ? error.message : String(error) }); }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new OllamaRequestError(response.status >= 500 ? 'process_failure' : 'http_error', `Ollama вернул HTTP ${response.status}: ${data.error ?? ''}`.trim(), { retryable, status: response.status, causeDetail: data.error });
      }
      if (data.error) throw this.readableError(data.error, signal);
      if (!data.message) throw new OllamaRequestError('empty_response', 'Ollama вернул ответ без поля message', { causeDetail: JSON.stringify({ done_reason: data.done_reason, prompt_eval_count: data.prompt_eval_count }) });
      return { ...data.message, prompt_eval_count: data.prompt_eval_count, finish_reason: this.finishReason(data.done_reason), inference: this.withPerformance(settings.diagnostics, data) };
    } catch (error) {
      const classified = this.readableError(error, signal);
      log('ollama.chat.failed', { model, contextWindow, ...ollamaErrorDiagnostics(classified) });
      throw classified;
    }
  }

  async *streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow = 32_768, reasoningMode: ReasoningMode = 'auto'): AsyncIterable<StreamEvent> {
    this.usedModels.add(model);
    let response: Response;
    let diagnostics: InferenceDiagnostics;
    let inferenceStartedAt = 0;
    let timeToFirstTokenMs: number | undefined;
    try {
      const settings = await this.requestOptions(model, messages, undefined, contextWindow, reasoningMode, signal);
      diagnostics = settings.diagnostics;
      inferenceStartedAt = performance.now();
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: messages.map(({ role, content, images }) => ({ role, content, ...(images?.length ? { images } : {}) })), ...(settings.think === undefined ? {} : { think: settings.think }), options: settings.options }),
      });
    } catch (error) {
      if (signal.aborted) return;
      const classified = this.readableError(error, signal);
      log('ollama.stream.start.failed', { model, contextWindow, ...ollamaErrorDiagnostics(classified) });
      yield { type: 'error', message: 'Не удалось подключиться к Ollama', details: classified.message };
      return;
    }
    if (!response.ok || !response.body) {
      const classified = this.readableError(`HTTP ${response.status}: ${await response.text()}`, signal);
      log('ollama.stream.http.failed', { model, contextWindow, ...ollamaErrorDiagnostics(classified) });
      yield { type: 'error', message: 'Ollama не смог начать генерацию', details: classified.message };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    let completed = false;
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const item = JSON.parse(line) as OllamaChunk;
          if (item.error) { yield { type: 'error', message: 'Ошибка Ollama', details: item.error }; return; }
          if (item.message?.content) {
            if (timeToFirstTokenMs === undefined) timeToFirstTokenMs = performance.now() - inferenceStartedAt;
            yield { type: 'token', content: item.message.content };
          }
          if (item.done) {
            completed = true;
            if (typeof item.prompt_eval_count === 'number') yield { type: 'context-usage', used: item.prompt_eval_count, maximum: contextWindow };
            yield { type: 'diagnostics', diagnostics: { ...this.withPerformance(diagnostics, item, timeToFirstTokenMs), agentStepCount: 0, finishReason: this.finishReason(item.done_reason) } };
            yield { type: 'done', finishReason: this.finishReason(item.done_reason) }; return;
          }
        }
        if (done) break;
      }
      if (!signal.aborted && !completed) {
        const error = new OllamaRequestError('stream_interrupted', 'Поток Ollama завершился без итогового сообщения', { retryable: true, causeDetail: 'response body ended before done=true' });
        log('ollama.stream.incomplete', { model, contextWindow, ...ollamaErrorDiagnostics(error) });
        yield { type: 'error', message: 'Генерация прервана из-за ошибки', details: error.message };
      }
    } catch (error) {
      if (!signal.aborted) {
        const classified = this.readableError(error, signal);
        log('ollama.stream.failed', { model, contextWindow, ...ollamaErrorDiagnostics(classified) });
        yield { type: 'error', message: 'Генерация прервана из-за ошибки', details: classified.message };
      }
    } finally { reader.releaseLock(); }
  }
}
