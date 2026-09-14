import type { AnalysisDepth, ChatMessage, FinishReason, ModelInfo, StreamEvent } from '../../shared/types';
import type { InferenceDiagnostics, LlmBackend, ToolCallingBackend, ToolMessage } from './types';
import { getModelProfile, inferenceSettings, modelInfo, modelRegistry, requestedMaxOutputTokens } from '../models/model-registry';
import { log } from '../services/logger';

type OllamaTags = { models?: Array<{ name: string; size: number }> };
type OllamaMetrics = { prompt_eval_count?: number; prompt_eval_duration?: number; eval_count?: number; eval_duration?: number };
type OllamaChunk = { message?: { content?: string }; done?: boolean; done_reason?: string; error?: string } & OllamaMetrics;

type OllamaToolResponse = { message?: ToolMessage; error?: string; done_reason?: string } & OllamaMetrics;
type OllamaShowResponse = { model_info?: Record<string, unknown>; parameters?: string };

export type ContextWindow = { requested: number; active: number; supported?: number };

export class OllamaBackend implements LlmBackend, ToolCallingBackend {
  constructor(private readonly baseUrl = 'http://127.0.0.1:11434') {}

  async getModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Ollama вернул HTTP ${response.status}`);
    const data = await response.json() as OllamaTags;
    const installed = new Map((data.models ?? []).map((model) => [model.name, model]));
    return Promise.all(modelRegistry.map(async (profile) => {
      const model = installed.get(profile.id);
      if (!model) return modelInfo(profile, false);
      return modelInfo(profile, true, model.size, await this.modelContextLimit(profile.id, profile.maxContext));
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

  async unloadModel(model: string): Promise<void> {
    if (!getModelProfile(model)) return;
    try {
      await fetch(`${this.baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) });
    } catch { /* The next inference will still let Ollama reclaim memory when necessary. */ }
  }

  private async requestOptions(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, depth: AnalysisDepth, signal: AbortSignal): Promise<{ think: boolean | string; options: Record<string, number>; diagnostics: InferenceDiagnostics }> {
    const profile = getModelProfile(model);
    if (!profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const inputTokens = await this.inputTokens(model, messages, tools, contextWindow, signal);
    const requested = requestedMaxOutputTokens(depth);
    const effective = Math.min(requested, Math.max(0, contextWindow - inputTokens));
    if (effective < 1) throw new Error('Контекстное окно заполнено. Уменьшите историю или выберите больший контекст, затем продолжите ответ.');
    const diagnostics: InferenceDiagnostics = { reasoningPreset: depth, requestedMaxOutputTokens: requested, effectiveMaxOutputTokens: effective, contextLimit: contextWindow, inputTokens };
    log('inference.options', diagnostics);
    return { ...inferenceSettings(profile, { contextWindow, depth }, effective), diagnostics };
  }

  /** A one-token preflight gives the same chat-template/token count that Ollama will use for the actual request. */
  private async inputTokens(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, signal: AbortSignal): Promise<number> {
    const ollamaMessages = messages.map((message) => {
      const tool = message as ToolMessage;
      return { role: message.role, content: message.content, ...(tool.tool_calls ? { tool_calls: tool.tool_calls } : {}), ...(tool.tool_name ? { tool_name: tool.tool_name } : {}) };
    });
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: ollamaMessages, ...(tools ? { tools } : {}), think: false, options: { num_ctx: contextWindow, num_predict: 1 } }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as OllamaToolResponse;
      if (typeof data.prompt_eval_count !== 'number') throw new Error('Ollama did not return prompt_eval_count');
      return data.prompt_eval_count;
    } catch (error) {
      if (signal.aborted) throw error;
      const prompt = ollamaMessages.map((message) => `<|${message.role}|>\n${message.content}\n`).join('');
      // Older runtimes may reject the preflight; use a deliberately high estimate rather than overflow the context.
      const conservative = Math.ceil(prompt.length / 2) + 256 + messages.length * 16;
      log('inference.preflight.fallback', { model, message: error instanceof Error ? error.message : String(error), inputTokens: conservative });
      return conservative;
    }
  }

  private finishReason(reason: string | undefined): FinishReason { return reason === 'length' ? 'length' : 'stop'; }

  private withPerformance(diagnostics: InferenceDiagnostics, metrics: OllamaMetrics, timeToFirstTokenMs?: number): InferenceDiagnostics {
    const rate = (count: number | undefined, duration: number | undefined): number | undefined => count !== undefined && duration !== undefined && duration > 0 ? count / (duration / 1_000_000_000) : undefined;
    return {
      ...diagnostics,
      inputTokens: metrics.prompt_eval_count ?? diagnostics.inputTokens,
      ...(metrics.prompt_eval_count !== undefined ? { promptEvalCount: metrics.prompt_eval_count } : {}),
      ...(metrics.prompt_eval_duration !== undefined ? { promptEvalDuration: metrics.prompt_eval_duration } : {}),
      ...(metrics.eval_count !== undefined ? { evalCount: metrics.eval_count } : {}),
      ...(metrics.eval_duration !== undefined ? { evalDuration: metrics.eval_duration } : {}),
      ...(rate(metrics.eval_count, metrics.eval_duration) !== undefined ? { tokensPerSecond: rate(metrics.eval_count, metrics.eval_duration) } : {}),
      ...(rate(metrics.prompt_eval_count, metrics.prompt_eval_duration) !== undefined ? { promptTokensPerSecond: rate(metrics.prompt_eval_count, metrics.prompt_eval_duration) } : {}),
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
    };
  }

  private readableError(error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    const lower = detail.toLowerCase();
    if (lower.includes('контекстное окно заполнено')) return new Error(detail);
    if (lower.includes('not found')) return new Error('Модель не найдена. Проверьте, что DATA-диск подключён и модель полностью установлена.');
    if (lower.includes('cuda') && (lower.includes('memory') || lower.includes('oom'))) return new Error('Недостаточно VRAM для выбранного контекста. Выберите меньший размер контекста или дождитесь выгрузки предыдущей модели.');
    if (lower.includes('context') || lower.includes('num_ctx')) return new Error('Выбранный размер контекста не поддерживается этой моделью.');
    return new Error(detail);
  }

  async chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, depth: AnalysisDepth): Promise<ToolMessage> {
    let response: Response;
    try {
      const settings = await this.requestOptions(model, messages, tools, contextWindow, depth, signal);
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages, ...(tools ? { tools } : {}), think: settings.think, options: settings.options }),
      });
      const data = await response.json() as OllamaToolResponse;
      if (!response.ok) throw this.readableError(`Ollama вернул HTTP ${response.status}: ${data.error ?? ''}`);
      if (data.error) throw new Error(data.error);
      if (!data.message) throw new Error('Ollama вернул пустой ответ');
      return { ...data.message, prompt_eval_count: data.prompt_eval_count, finish_reason: this.finishReason(data.done_reason), inference: this.withPerformance(settings.diagnostics, data) };
    } catch (error) { throw this.readableError(error); }
  }

  async *streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow = 32_768, depth: AnalysisDepth = 'normal'): AsyncIterable<StreamEvent> {
    let response: Response;
    let diagnostics: InferenceDiagnostics;
    let inferenceStartedAt = 0;
    let timeToFirstTokenMs: number | undefined;
    try {
      const settings = await this.requestOptions(model, messages, undefined, contextWindow, depth, signal);
      diagnostics = settings.diagnostics;
      inferenceStartedAt = performance.now();
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: messages.map(({ role, content }) => ({ role, content })), think: settings.think, options: settings.options }),
      });
    } catch (error) {
      if (signal.aborted) return;
      yield { type: 'error', message: 'Не удалось подключиться к Ollama', details: this.readableError(error).message };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', message: 'Ollama не смог начать генерацию', details: this.readableError(`HTTP ${response.status}: ${await response.text()}`).message };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
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
            if (typeof item.prompt_eval_count === 'number') yield { type: 'context-usage', used: item.prompt_eval_count, maximum: contextWindow };
            yield { type: 'diagnostics', diagnostics: { ...this.withPerformance(diagnostics, item, timeToFirstTokenMs), agentStepCount: 0, finishReason: this.finishReason(item.done_reason) } };
            yield { type: 'done', finishReason: this.finishReason(item.done_reason) }; return;
          }
        }
        if (done) break;
      }
    } catch (error) {
      if (!signal.aborted) yield { type: 'error', message: 'Генерация прервана из-за ошибки', details: error instanceof Error ? error.message : String(error) };
    } finally { reader.releaseLock(); }
  }
}
