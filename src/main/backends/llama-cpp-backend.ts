import type { AnalysisDepth, ChatMessage, FinishReason, ModelInfo, StreamEvent } from '../../shared/types';
import type { InferenceDiagnostics, LlmBackend, ToolCallingBackend, ToolMessage } from './types';
import { contextPresetsFor, getModelProfile, modelInfo, requestedMaxOutputTokens } from '../models/model-registry';
import type { ContextWindow } from './ollama-backend';
import { log } from '../services/logger';

type Choice = { finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }; delta?: { content?: string | null } };
type ChatResponse = { choices?: Choice[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; timings?: { prompt_ms?: number; predicted_ms?: number; prompt_per_second?: number; predicted_per_second?: number } };
type ModelsResponse = { data?: Array<{ meta?: { n_ctx?: number; size?: number } }> };
type InputTokenResponse = { input_tokens?: unknown };
const qwenModel = 'qwen3.8:27b-q4_K_M';
const contextSafetyMarginTokens = 512;
// Qwen3.8's bundled llama.cpp chat template accepts low, medium and xhigh.
const reasoningEffort: Record<AnalysisDepth, string> = { fast: 'low', normal: 'medium', enhanced: 'xhigh', deep: 'xhigh' };
type RequestDiagnostics = { endpoint: string; status: number; serverError?: string; userMessage?: string; backend: 'llama-cpp'; model: string; contextSize: number; requestedMaxOutput: number; effectiveMaxOutput: number; messageCount: number; toolCount: number; hasImages: boolean; estimatedPromptTokens: number; exactPromptTokens?: number; contextClassification: 'backend_context_rejected' | 'http_error' };
type ContextAccounting = {
  messageCount: number; contentChars: number; systemChars: number; persistedUserChars: number; runtimeContextChars: number; assistantChars: number; assistantToolCallCharsExcluded: number;
  toolResultChars: number; fileReadToolResultChars: number; terminalToolResultChars: number; progressToolResultChars: number; otherToolResultChars: number;
  messageOverheadTokens: number; fixedOverheadTokens: number; toolSchemaCharsExcluded: number; estimatedPromptTokens: number; exactPromptTokens?: number;
};
type Budget = { inputTokens: number; maxTokens: number; requestedMaxTokens: number; source: 'exact' | 'estimate'; outputClamped: boolean; remainingContext?: number; accounting: ContextAccounting };

export class LlamaCppRequestError extends Error {
  constructor(readonly request: RequestDiagnostics) { super(`llama.cpp отклонил запрос (HTTP ${request.status})${request.userMessage ? `: ${request.userMessage}` : ''}`); this.name = 'LlamaCppRequestError'; }
}

/** A local rejection is allowed only after llama.cpp tokenized the exact serialized request. */
export class LlamaCppContextExhaustedError extends Error {
  readonly kind = 'context_exhausted_confirmed';
  constructor(readonly budget: Budget, readonly contextLimit: number) {
    super('Контекстное окно заполнено. Уменьшите историю или выберите меньший объём данных.');
    this.name = 'LlamaCppContextExhaustedError';
  }
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
  private lastActualPromptTokens: number | undefined;
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
  private estimate(messages: Array<ChatMessage | ToolMessage>, tools?: unknown[]): ContextAccounting {
    const accounting: ContextAccounting = { messageCount: messages.length, contentChars: 0, systemChars: 0, persistedUserChars: 0, runtimeContextChars: 0, assistantChars: 0, assistantToolCallCharsExcluded: 0, toolResultChars: 0, fileReadToolResultChars: 0, terminalToolResultChars: 0, progressToolResultChars: 0, otherToolResultChars: 0, messageOverheadTokens: messages.length * 24, fixedOverheadTokens: 256, toolSchemaCharsExcluded: tools ? JSON.stringify(tools).length : 0, estimatedPromptTokens: 0 };
    for (const message of messages) {
      const chars = message.content.length; accounting.contentChars += chars;
      if (message.role === 'system') accounting.systemChars += chars;
      else if (message.role === 'user') { if (message.content.startsWith('<runtime_context')) accounting.runtimeContextChars += chars; else accounting.persistedUserChars += chars; }
      else if (message.role === 'assistant') { accounting.assistantChars += chars; accounting.assistantToolCallCharsExcluded += JSON.stringify((message as ToolMessage).tool_calls ?? []).length; }
      else if (message.role === 'tool') { accounting.toolResultChars += chars; const name = (message as ToolMessage).tool_name; if (name === 'read_file' || name === 'inspect_package_json') accounting.fileReadToolResultChars += chars; else if (name === 'run_terminal') accounting.terminalToolResultChars += chars; else if (name === 'report_progress') accounting.progressToolResultChars += chars; else accounting.otherToolResultChars += chars; }
    }
    accounting.estimatedPromptTokens = Math.ceil(accounting.contentChars / 2) + accounting.messageOverheadTokens + accounting.fixedOverheadTokens;
    return accounting;
  }
  private messages(messages: Array<ChatMessage | ToolMessage>): unknown[] {
    return messages.map((message) => {
      const tool = message as ToolMessage;
      if (tool.images?.length) return { role: message.role, content: [{ type: 'text', text: message.content }, ...tool.images.map((image) => ({ type: 'image_url', image_url: { url: image.startsWith('data:') ? image : `data:image/png;base64,${image}` } }))] };
      return { role: message.role, content: message.content, ...(tool.tool_calls ? { tool_calls: tool.tool_calls.map((call) => ({ type: 'function', ...call })) } : {}), ...(tool.tool_name ? { name: tool.tool_name } : {}) };
    });
  }
  private payload(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, depth: AnalysisDepth, maxTokens?: number, stream?: boolean): Record<string, unknown> {
    return { model, messages: this.messages(messages), ...(tools ? { tools, tool_choice: 'auto' } : {}), ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }), reasoning_effort: reasoningEffort[depth], ...(stream === undefined ? {} : { stream }) };
  }
  /** Uses llama.cpp's own OpenAI parser, chat template and tokenizer. Older servers fall back without a local rejection. */
  private async exactInputTokens(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, depth: AnalysisDepth, signal: AbortSignal): Promise<number | undefined> {
    const endpoint = '/v1/chat/completions/input_tokens';
    try {
      const response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.payload(model, messages, tools, depth)) });
      if (!response.ok) { log('llama-cpp.context.token-count-unavailable', { backend: 'llama-cpp', endpoint, status: response.status }); return undefined; }
      const data = await response.json().catch(() => null) as InputTokenResponse | null;
      if (typeof data?.input_tokens !== 'number' || !Number.isFinite(data.input_tokens) || data.input_tokens < 0) { log('llama-cpp.context.token-count-unavailable', { backend: 'llama-cpp', endpoint, reason: 'invalid_response' }); return undefined; }
      return data.input_tokens;
    } catch (error) {
      if (signal.aborted) throw error;
      log('llama-cpp.context.token-count-unavailable', { backend: 'llama-cpp', endpoint, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
  private async budget(model: string, messages: Array<ChatMessage | ToolMessage>, contextWindow: number, depth: AnalysisDepth, tools: unknown[] | undefined, signal: AbortSignal): Promise<Budget> {
    const accounting = this.estimate(messages, tools); const requestedMaxTokens = requestedMaxOutputTokens(depth);
    const exactPromptTokens = await this.exactInputTokens(model, messages, tools, depth, signal);
    if (exactPromptTokens !== undefined) {
      accounting.exactPromptTokens = exactPromptTokens;
      const remainingContext = contextWindow - exactPromptTokens;
      const maxTokens = Math.min(requestedMaxTokens, Math.max(0, remainingContext - contextSafetyMarginTokens));
      const budget: Budget = { inputTokens: exactPromptTokens, maxTokens, requestedMaxTokens, source: 'exact', outputClamped: maxTokens < requestedMaxTokens, remainingContext, accounting };
      const payload = { backend: 'llama-cpp', contextLimit: contextWindow, requestedMaxOutput: requestedMaxTokens, effectiveMaxOutput: maxTokens, safetyMarginTokens: contextSafetyMarginTokens, remainingContext, cachedRawReadsIncludedInPrompt: false, ...accounting };
      if (maxTokens < 1) { log('llama-cpp.preflight.context-exhausted-confirmed', payload); throw new LlamaCppContextExhaustedError(budget, contextWindow); }
      log(budget.outputClamped ? 'llama-cpp.preflight.context-output-clamped' : 'llama-cpp.preflight.context-exact', payload);
      return budget;
    }
    const estimatedPressure = accounting.estimatedPromptTokens + requestedMaxTokens + contextSafetyMarginTokens > contextWindow;
    const budget: Budget = { inputTokens: accounting.estimatedPromptTokens, maxTokens: requestedMaxTokens, requestedMaxTokens, source: 'estimate', outputClamped: false, accounting };
    if (estimatedPressure) log('llama-cpp.preflight.context-estimate-warning', { backend: 'llama-cpp', contextLimit: contextWindow, requestedMaxOutput: requestedMaxTokens, effectiveMaxOutput: requestedMaxTokens, lastActualPromptTokens: this.lastActualPromptTokens, cachedRawReadsIncludedInPrompt: false, ...accounting });
    return budget;
  }
  private requestDiagnostics(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, depth: AnalysisDepth, budget: Budget, status: number, endpoint: string, serverError?: string): RequestDiagnostics {
    const userMessage = serverError?.match(/Error:\s*(?:Jinja Exception:\s*)?([^\n]+)/)?.[1]?.slice(0, 240) || serverError?.slice(0, 240);
    const contextClassification = /context|n_ctx|prompt.*token|slot.*full|exceed/i.test(serverError ?? '') ? 'backend_context_rejected' : 'http_error';
    return { endpoint, status, ...(serverError ? { serverError } : {}), ...(userMessage ? { userMessage } : {}), backend: 'llama-cpp', model, contextSize: contextWindow, requestedMaxOutput: requestedMaxOutputTokens(depth), effectiveMaxOutput: budget.maxTokens, messageCount: messages.length, toolCount: tools?.length ?? 0, hasImages: messages.some((message) => Boolean(message.images?.length)), estimatedPromptTokens: budget.accounting.estimatedPromptTokens, ...(budget.accounting.exactPromptTokens === undefined ? {} : { exactPromptTokens: budget.accounting.exactPromptTokens }), contextClassification };
  }
  private async failedRequest(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, depth: AnalysisDepth, budget: Budget, response: Response, endpoint: string): Promise<never> {
    const body = await response.text().catch(() => ''); let serverError = '';
    try { const parsed = JSON.parse(body) as { error?: { message?: unknown } }; serverError = typeof parsed.error?.message === 'string' ? parsed.error.message : body; } catch { serverError = body; }
    serverError = serverError.replace(/\s+/g, ' ').trim().slice(0, 500);
    const request = this.requestDiagnostics(model, messages, tools, contextWindow, depth, budget, response.status, endpoint, serverError || undefined);
    log('llama-cpp.request.failed', request); throw new LlamaCppRequestError(request);
  }
  private diagnostics(depth: AnalysisDepth, contextLimit: number, budget: Budget, data?: ChatResponse): InferenceDiagnostics {
    const t = data?.timings;
    return { reasoningPreset: depth, requestedMaxOutputTokens: budget.requestedMaxTokens, effectiveMaxOutputTokens: budget.maxTokens, contextLimit, inputTokens: data?.usage?.prompt_tokens ?? budget.inputTokens, ...(data?.usage?.prompt_tokens !== undefined ? { promptEvalCount: data.usage.prompt_tokens } : {}), ...(t?.prompt_ms !== undefined ? { promptEvalDuration: t.prompt_ms * 1_000_000 } : {}), ...(data?.usage?.completion_tokens !== undefined ? { evalCount: data.usage.completion_tokens } : {}), ...(t?.predicted_ms !== undefined ? { evalDuration: t.predicted_ms * 1_000_000 } : {}), ...(t?.predicted_per_second !== undefined ? { tokensPerSecond: t.predicted_per_second } : {}), ...(t?.prompt_per_second !== undefined ? { promptTokensPerSecond: t.prompt_per_second } : {}) };
  }
  private recordCalibration(budget: Budget, contextLimit: number, data: ChatResponse | null): void {
    const actualPromptEvalCount = data?.usage?.prompt_tokens;
    if (typeof actualPromptEvalCount !== 'number') return;
    this.lastActualPromptTokens = actualPromptEvalCount;
    log('llama-cpp.context.calibration', { backend: 'llama-cpp', estimatedPromptTokens: budget.accounting.estimatedPromptTokens, ...(budget.accounting.exactPromptTokens === undefined ? {} : { exactPromptTokens: budget.accounting.exactPromptTokens }), actualPromptEvalCount, estimationErrorRatio: actualPromptEvalCount > 0 ? budget.accounting.estimatedPromptTokens / actualPromptEvalCount : undefined, contextLimit, remainingContext: contextLimit - actualPromptEvalCount, requestedOutput: budget.requestedMaxTokens, effectiveOutput: budget.maxTokens, outputClamped: budget.outputClamped, tokenCountSource: budget.source });
  }
  async chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, depth: AnalysisDepth): Promise<ToolMessage> {
    await this.ensureModelAvailable(model);
    const sequenceError = validateLlamaMessageSequence(messages);
    if (sequenceError) { log('llama-cpp.request.invalid', { backend: 'llama-cpp', model, endpoint: '/v1/chat/completions', sequenceError, messages: messages.map((message, index) => ({ index, role: message.role, toolName: message.tool_name, toolCallCount: message.tool_calls?.length ?? 0 })) }); throw new Error(`Некорректная последовательность Agent сообщений: ${sequenceError}`); }
    const budget = await this.budget(model, messages, contextWindow, depth, tools, signal);
    let response: Response; const endpoint = '/v1/chat/completions';
    try { response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.payload(model, messages, tools, depth, budget.maxTokens, false)) }); }
    catch (error) { throw new Error(`llama.cpp inference connection failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) return this.failedRequest(model, messages, tools, contextWindow, depth, budget, response, endpoint);
    const data = await response.json().catch(() => null) as ChatResponse | null;
    if (!data) throw new Error('llama.cpp вернул некорректный JSON-ответ');
    const choice = data.choices?.[0]; if (!choice?.message) throw new Error('llama.cpp вернул ответ без assistant message');
    this.recordCalibration(budget, contextWindow, data);
    return { role: 'assistant', content: choice.message.content ?? '', thinking: choice.message.reasoning_content ?? undefined, tool_calls: (choice.message.tool_calls ?? []).flatMap((call) => call.function?.name ? [{ function: { name: call.function.name, arguments: call.function.arguments ?? '{}' } }] : []), finish_reason: finishReason(choice.finish_reason), prompt_eval_count: data.usage?.prompt_tokens, inference: this.diagnostics(depth, contextWindow, budget, data) };
  }
  async *streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow = 32_768, depth: AnalysisDepth = 'normal'): AsyncIterable<StreamEvent> {
    try {
      await this.ensureModelAvailable(model); const budget = await this.budget(model, messages, contextWindow, depth, undefined, signal);
      const endpoint = '/v1/chat/completions'; const response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...this.payload(model, messages, undefined, depth, budget.maxTokens, true), stream_options: { include_usage: true } }) });
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
            if (choice?.finish_reason) { this.recordCalibration(budget, contextWindow, data); yield { type: 'diagnostics', diagnostics: { ...this.diagnostics(depth, contextWindow, budget, data), agentStepCount: 0, finishReason: finishReason(choice.finish_reason) } }; yield { type: 'done', finishReason: finishReason(choice.finish_reason) }; return; }
          }
          if (done) break;
        }
        if (!signal.aborted) yield { type: 'error', message: 'Поток llama.cpp завершился без итогового сообщения' };
      } finally { reader.releaseLock(); }
    } catch (error) { if (!signal.aborted) yield { type: 'error', message: 'Генерация llama.cpp прервана', details: error instanceof Error ? error.message : String(error) }; }
  }
}
function finishReason(reason: string | null | undefined): FinishReason { return reason === 'length' ? 'length' : 'stop'; }
