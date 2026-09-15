import type { AnalysisDepth, ChatMessage, FinishReason, ModelInfo, StreamEvent } from '../../shared/types';
import type { InferenceDiagnostics, LlmBackend, ToolCallingBackend, ToolMessage } from './types';
import { contextPresetsFor, getModelProfile, modelInfo, requestedMaxOutputTokens } from '../models/model-registry';
import type { ContextWindow } from './ollama-backend';
import { log } from '../services/logger';

type Choice = { finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }; delta?: { content?: string | null } };
type ChatResponse = { choices?: Choice[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; timings?: { prompt_ms?: number; predicted_ms?: number; prompt_per_second?: number; predicted_per_second?: number } };
type ModelsResponse = { data?: Array<{ meta?: { n_ctx?: number; size?: number } }> };
const qwenModel = 'qwen3.8:27b-q4_K_M';
// Qwen3.8's bundled llama.cpp chat template accepts low, medium and xhigh.
const reasoningEffort: Record<AnalysisDepth, string> = { fast: 'low', normal: 'medium', enhanced: 'xhigh', deep: 'xhigh' };
type RequestDiagnostics = { endpoint: string; status: number; serverError?: string; userMessage?: string; backend: 'llama-cpp'; model: string; contextSize: number; requestedMaxOutput: number; effectiveMaxOutput: number; messageCount: number; toolCount: number; hasImages: boolean; estimatedPromptTokens: number };

export class LlamaCppRequestError extends Error {
  constructor(readonly request: RequestDiagnostics) { super(`llama.cpp отклонил запрос (HTTP ${request.status})${request.userMessage ? `: ${request.userMessage}` : ''}`); this.name = 'LlamaCppRequestError'; }
}

/** Validates chronological OpenAI tool history without reordering it for a chat template. */
export function validateLlamaMessageSequence(messages: ToolMessage[]): string | undefined {
  let seenNonSystem = false; const pendingTools: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') { if (seenNonSystem) return `system message at index ${index} follows conversation history`; continue; }
    seenNonSystem = true;
    if (message.role === 'tool') {
      const toolIndex = pendingTools.indexOf(message.tool_name ?? '');
      if (toolIndex < 0) return `tool result at index ${index} has no preceding matching tool call`;
      pendingTools.splice(toolIndex, 1); continue;
    }
    if (pendingTools.length) return `message at index ${index} appears before ${pendingTools.length} tool result(s)`;
    if (message.role === 'assistant' && message.tool_calls?.length) pendingTools.push(...message.tool_calls.map((call) => call.function.name));
  }
  return pendingTools.length ? `${pendingTools.length} tool call(s) lack a result` : undefined;
}

/** Adapter for the launcher-managed, OpenAI-compatible llama-server. */
export class LlamaCppBackend implements LlmBackend, ToolCallingBackend {
  constructor(private readonly baseUrl = 'http://127.0.0.1:8081', private readonly contextLimit = 65_536, private readonly visionEnabled = true) {}
  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, '')}${path}`; }

  async getModels(): Promise<ModelInfo[]> {
    const response = await fetch(this.url('/v1/models'));
    if (!response.ok) throw new Error(`llama.cpp вернул HTTP ${response.status}`);
    const data = await response.json() as ModelsResponse;
    const runtimeContext = Math.min(this.contextLimit, data.data?.[0]?.meta?.n_ctx ?? this.contextLimit);
    const profile = getModelProfile(qwenModel)!;
    const info = modelInfo(profile, (data.data ?? []).length > 0, data.data?.[0]?.meta?.size, runtimeContext);
    return [{ ...info, backend: 'llama-cpp', supportedContextPresets: contextPresetsFor(runtimeContext) }];
  }

  async getStatus(): Promise<{ available: boolean; message?: string }> {
    try { const response = await fetch(this.url('/health')); return response.ok ? { available: true } : { available: false, message: `llama.cpp вернул HTTP ${response.status}` }; }
    catch (error) { return { available: false, message: error instanceof Error ? error.message : String(error) }; }
  }
  async supportsVision(model: string): Promise<boolean> { return model === qwenModel && this.visionEnabled; }
  async resolveContextWindow(model: string, requested: number): Promise<ContextWindow> {
    if (model !== qwenModel) throw new Error('llama.cpp MTP launcher поддерживает только Qwen3.8-27B');
    return { requested, active: Math.min(requested, this.contextLimit), supported: this.contextLimit };
  }
  async ensureModelAvailable(model: string): Promise<void> {
    if (model !== qwenModel) throw new Error('llama.cpp MTP launcher поддерживает только Qwen3.8-27B');
    const status = await this.getStatus(); if (!status.available) throw new Error(`llama.cpp server недоступен: ${status.message ?? 'health check failed'}`);
  }
  private budget(messages: Array<ChatMessage | ToolMessage>, contextWindow: number, depth: AnalysisDepth): { inputTokens: number; maxTokens: number } {
    const inputTokens = Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 2) + messages.length * 24 + 256;
    const maxTokens = Math.min(requestedMaxOutputTokens(depth), Math.max(0, contextWindow - inputTokens));
    if (maxTokens < 1) throw new Error('Контекстное окно заполнено. Уменьшите историю или выберите меньший объём данных.');
    return { inputTokens, maxTokens };
  }
  private messages(messages: Array<ChatMessage | ToolMessage>): unknown[] {
    return messages.map((message) => {
      const tool = message as ToolMessage;
      if (tool.images?.length) return { role: message.role, content: [{ type: 'text', text: message.content }, ...tool.images.map((image) => ({ type: 'image_url', image_url: { url: image.startsWith('data:') ? image : `data:image/png;base64,${image}` } }))] };
      return { role: message.role, content: message.content, ...(tool.tool_calls ? { tool_calls: tool.tool_calls.map((call) => ({ type: 'function', ...call })) } : {}), ...(tool.tool_name ? { name: tool.tool_name } : {}) };
    });
  }
  private requestDiagnostics(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, depth: AnalysisDepth, budget: { inputTokens: number; maxTokens: number }, status: number, endpoint: string, serverError?: string): RequestDiagnostics {
    const userMessage = serverError?.match(/Error:\s*(?:Jinja Exception:\s*)?([^\n]+)/)?.[1]?.slice(0, 240) || serverError?.slice(0, 240);
    return { endpoint, status, ...(serverError ? { serverError } : {}), ...(userMessage ? { userMessage } : {}), backend: 'llama-cpp', model, contextSize: contextWindow, requestedMaxOutput: requestedMaxOutputTokens(depth), effectiveMaxOutput: budget.maxTokens, messageCount: messages.length, toolCount: tools?.length ?? 0, hasImages: messages.some((message) => Boolean(message.images?.length)), estimatedPromptTokens: budget.inputTokens };
  }
  private async failedRequest(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, depth: AnalysisDepth, budget: { inputTokens: number; maxTokens: number }, response: Response, endpoint: string): Promise<never> {
    const body = await response.text().catch(() => ''); let serverError = '';
    try { const parsed = JSON.parse(body) as { error?: { message?: unknown } }; serverError = typeof parsed.error?.message === 'string' ? parsed.error.message : body; } catch { serverError = body; }
    serverError = serverError.replace(/\s+/g, ' ').trim().slice(0, 500);
    const request = this.requestDiagnostics(model, messages, tools, contextWindow, depth, budget, response.status, endpoint, serverError || undefined);
    log('llama-cpp.request.failed', request); throw new LlamaCppRequestError(request);
  }
  private diagnostics(depth: AnalysisDepth, contextLimit: number, inputTokens: number, data?: ChatResponse): InferenceDiagnostics {
    const t = data?.timings;
    return { reasoningPreset: depth, requestedMaxOutputTokens: requestedMaxOutputTokens(depth), effectiveMaxOutputTokens: Math.min(requestedMaxOutputTokens(depth), Math.max(0, contextLimit - inputTokens)), contextLimit, inputTokens: data?.usage?.prompt_tokens ?? inputTokens, ...(data?.usage?.prompt_tokens !== undefined ? { promptEvalCount: data.usage.prompt_tokens } : {}), ...(t?.prompt_ms !== undefined ? { promptEvalDuration: t.prompt_ms * 1_000_000 } : {}), ...(data?.usage?.completion_tokens !== undefined ? { evalCount: data.usage.completion_tokens } : {}), ...(t?.predicted_ms !== undefined ? { evalDuration: t.predicted_ms * 1_000_000 } : {}), ...(t?.predicted_per_second !== undefined ? { tokensPerSecond: t.predicted_per_second } : {}), ...(t?.prompt_per_second !== undefined ? { promptTokensPerSecond: t.prompt_per_second } : {}) };
  }
  async chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, depth: AnalysisDepth): Promise<ToolMessage> {
    await this.ensureModelAvailable(model); const budget = this.budget(messages, contextWindow, depth);
    const sequenceError = validateLlamaMessageSequence(messages);
    if (sequenceError) { log('llama-cpp.request.invalid', { backend: 'llama-cpp', model, endpoint: '/v1/chat/completions', sequenceError, messages: messages.map((message, index) => ({ index, role: message.role, toolName: message.tool_name, toolCallCount: message.tool_calls?.length ?? 0 })) }); throw new Error(`Некорректная последовательность Agent сообщений: ${sequenceError}`); }
    let response: Response;
    const endpoint = '/v1/chat/completions';
    try { response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: this.messages(messages), ...(tools ? { tools, tool_choice: 'auto' } : {}), max_tokens: budget.maxTokens, reasoning_effort: reasoningEffort[depth], stream: false }) }); }
    catch (error) { throw new Error(`llama.cpp inference connection failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) return this.failedRequest(model, messages, tools, contextWindow, depth, budget, response, endpoint);
    const data = await response.json().catch(() => null) as ChatResponse | null;
    if (!data) throw new Error('llama.cpp вернул некорректный JSON-ответ');
    const choice = data.choices?.[0]; if (!choice?.message) throw new Error('llama.cpp вернул ответ без assistant message');
    return { role: 'assistant', content: choice.message.content ?? '', thinking: choice.message.reasoning_content ?? undefined, tool_calls: (choice.message.tool_calls ?? []).flatMap((call) => call.function?.name ? [{ function: { name: call.function.name, arguments: call.function.arguments ?? '{}' } }] : []), finish_reason: finishReason(choice.finish_reason), prompt_eval_count: data.usage?.prompt_tokens, inference: this.diagnostics(depth, contextWindow, budget.inputTokens, data) };
  }
  async *streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow = 32_768, depth: AnalysisDepth = 'normal'): AsyncIterable<StreamEvent> {
    try {
      await this.ensureModelAvailable(model); const budget = this.budget(messages, contextWindow, depth);
      const endpoint = '/v1/chat/completions'; const response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: this.messages(messages), max_tokens: budget.maxTokens, reasoning_effort: reasoningEffort[depth], stream: true, stream_options: { include_usage: true } }) });
      if (!response.ok) await this.failedRequest(model, messages, undefined, contextWindow, depth, budget, response, endpoint);
      if (!response.body) { yield { type: 'error', message: 'llama.cpp не смог начать генерацию', details: 'llama.cpp не вернул тело stream-ответа' }; return; }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          const blocks = buffer.split('\n\n'); buffer = blocks.pop() ?? '';
          for (const raw of blocks) {
            if (!raw.startsWith('data: ')) continue; const valueText = raw.slice(6).trim();
            if (valueText === '[DONE]') { yield { type: 'done', finishReason: 'stop' }; return; }
            const data = JSON.parse(valueText) as ChatResponse; const choice = data.choices?.[0];
            if (choice?.delta?.content) yield { type: 'token', content: choice.delta.content };
            if (choice?.finish_reason) { yield { type: 'diagnostics', diagnostics: { ...this.diagnostics(depth, contextWindow, budget.inputTokens, data), agentStepCount: 0, finishReason: finishReason(choice.finish_reason) } }; yield { type: 'done', finishReason: finishReason(choice.finish_reason) }; return; }
          }
          if (done) break;
        }
        if (!signal.aborted) yield { type: 'error', message: 'Поток llama.cpp завершился без итогового сообщения' };
      } finally { reader.releaseLock(); }
    } catch (error) { if (!signal.aborted) yield { type: 'error', message: 'Генерация llama.cpp прервана', details: error instanceof Error ? error.message : String(error) }; }
  }
}
function finishReason(reason: string | null | undefined): FinishReason { return reason === 'length' ? 'length' : 'stop'; }
