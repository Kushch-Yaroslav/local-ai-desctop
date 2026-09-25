import type { ChatMessage, FinishReason, ModelInfo, ReasoningMode, StreamEvent } from '../../shared/types';
import { createHash } from 'node:crypto';
import { wholeNanoseconds, type InferenceDiagnostics, type LlmBackend, type ToolCallingBackend, type ToolInferenceRequestContext, type ToolInferenceStreamEvent, type ToolMessage } from './types';
import { contextPresetsFor, getModelProfile, maxOutputTokens, modelInfo, outputBudget, outputSafetyReserveTokens } from '../models/model-registry';
import type { ContextWindow } from './ollama-backend';
import { log } from '../services/logger';

type NativeToolCall = { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } };
type Choice = { finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: NativeToolCall[] }; delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: NativeToolCall[] } };
type ChatResponse = { choices?: Choice[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; timings?: { prompt_ms?: number; predicted_ms?: number; prompt_per_second?: number; predicted_per_second?: number } };
type ModelsResponse = { data?: Array<{ meta?: { n_ctx?: number; size?: number } }> };
type InputTokenResponse = { input_tokens?: unknown };
const qwenModel = 'qwen3.8:27b-q4_K_M';
const glmFlashModel = 'glm-4.7-flash:q4_k';
// Qwen3.8's template supports a native think switch.  A mechanical Agent
// continuation needs a direct tool decision, not another hidden design essay;
// Deep is still enabled for planning, investigation and synthesis.
function llamaCppReasoning(model: string, mode: ReasoningMode): Record<string, unknown> {
  if (mode === 'auto') return {};
  if (model === qwenModel) return mode === 'fast'
    ? { reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } }
    : { reasoning_effort: 'xhigh', chat_template_kwargs: { enable_thinking: true } };
  if (model === glmFlashModel) return { reasoning_effort: mode === 'fast' ? 'none' : 'xhigh', chat_template_kwargs: { enable_thinking: mode !== 'fast' } };
  return {};
}
type RequestDiagnostics = { endpoint: string; status: number; serverError?: string; userMessage?: string; backend: 'llama-cpp'; model: string; contextSize: number; requestedMaxOutput: number; effectiveMaxOutput: number; messageCount: number; toolCount: number; hasImages: boolean; estimatedPromptTokens: number; exactPromptTokens?: number; contextClassification: 'backend_context_rejected' | 'http_error' };
type ContextAccounting = {
  messageCount: number; contentChars: number; systemChars: number; persistedUserChars: number; runtimeContextChars: number; assistantChars: number; assistantToolCallCharsExcluded: number;
  toolResultChars: number; fileReadToolResultChars: number; terminalToolResultChars: number; progressToolResultChars: number; otherToolResultChars: number;
  messageOverheadTokens: number; fixedOverheadTokens: number; toolSchemaCharsExcluded: number; estimatedPromptTokens: number; exactPromptTokens?: number;
};
type Budget = { inputTokens: number; maxTokens: number; requestedMaxTokens: number; source: 'exact' | 'estimate'; outputClamped: boolean; remainingContext?: number; accounting: ContextAccounting };

function errorSummary(error: unknown): { error: string; errorCode?: string } {
  const messages: string[] = []; let code: string | undefined; let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) { messages.push(current.message); current = (current as Error & { cause?: unknown }).cause; continue; }
    if (typeof current === 'object') {
      const value = current as { message?: unknown; code?: unknown; cause?: unknown };
      if (typeof value.message === 'string') messages.push(value.message);
      if (typeof value.code === 'string') code ??= value.code;
      current = value.cause; continue;
    }
    messages.push(String(current)); break;
  }
  return { error: messages.filter(Boolean).join(' <- ') || String(error), ...(code ? { errorCode: code } : {}) };
}
function responseTextShape(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return { present: value !== undefined && value !== null, type: typeof value };
  const tags = value.match(/<\/?(?:tool_call|function|parameter|[a-z][\w-]*)(?:=[^>]+)?>/gi)?.slice(0, 12) ?? [];
  return {
    present: true,
    length: value.length,
    sha256: createHash('sha256').update(value).digest('hex'),
    leadingWhitespaceLength: value.length - value.trimStart().length,
    trailingWhitespaceLength: value.length - value.trimEnd().length,
    hasToolCallTag: /<tool_call>/i.test(value),
    hasCreateFileFunctionTag: /<function=create_file>/i.test(value),
    hasPathParameterTag: /<parameter=path>/i.test(value),
    tagSequence: tags,
  };
}

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
  let seenNonSystem = false; const pendingTools: Array<{ id: string; name: string }> = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') { if (seenNonSystem) return `system message at index ${index} follows conversation history`; continue; }
    seenNonSystem = true;
    if (message.role === 'tool') {
      const toolIndex = message.tool_call_id
        ? pendingTools.findIndex((call) => call.id === message.tool_call_id)
        : pendingTools.findIndex((call) => call.name === message.tool_name);
      if (toolIndex < 0) return `tool result at index ${index} has no preceding matching tool call${message.tool_call_id ? ` (${message.tool_call_id})` : ''}`;
      pendingTools.splice(toolIndex, 1); continue;
    }
    if (pendingTools.length) return `message at index ${index} appears before ${pendingTools.length} tool result(s)`;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const id = call.id ?? `legacy:${call.function.name}:${callIndex}`;
        if (pendingTools.some((pending) => pending.id === id)) return `assistant tool call at index ${index} has duplicate id ${id}`;
        // Older llama.cpp responses can omit IDs. Give these legacy calls a
        // local unique key; name-based result matching remains only a fallback.
        pendingTools.push({ id, name: call.function.name });
      }
    }
  }
  return pendingTools.length ? `${pendingTools.length} tool call(s) lack a result` : undefined;
}

/** Adapter for the launcher-managed, OpenAI-compatible llama-server. */
export class LlamaCppBackend implements LlmBackend, ToolCallingBackend {
  private lastActualPromptTokens: number | undefined;
  /** Avoid a second input_tokens request after context management just counted it. */
  private readonly preparedInputTokens = new WeakMap<object, { tools: unknown[] | undefined; reasoningMode: ReasoningMode; tokens: number }>();
  constructor(private readonly baseUrl = 'http://127.0.0.1:8081', private readonly contextLimit = 65_536, private readonly visionEnabled = true, private readonly runtimeModelId = qwenModel) {}
  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, '')}${path}`; }

  async getModels(): Promise<ModelInfo[]> {
    const response = await fetch(this.url('/v1/models'));
    if (!response.ok) throw new Error(`llama.cpp вернул HTTP ${response.status}`);
    const data = await response.json() as ModelsResponse;
    const runtimeContext = Math.min(this.contextLimit, data.data?.[0]?.meta?.n_ctx ?? this.contextLimit);
    const profile = getModelProfile(this.runtimeModelId);
    if (!profile) throw new Error(`llama.cpp запущен с неизвестной моделью: ${this.runtimeModelId}`);
    const info = modelInfo(profile, (data.data ?? []).length > 0, data.data?.[0]?.meta?.size, runtimeContext, this.runtimeModelId === qwenModel || this.runtimeModelId === glmFlashModel);
    return [{ ...info, backend: 'llama-cpp', supportedContextPresets: contextPresetsFor(runtimeContext) }];
  }

  async getStatus(): Promise<{ available: boolean; message?: string }> {
    try { const response = await fetch(this.url('/health')); return response.ok ? { available: true } : { available: false, message: `llama.cpp вернул HTTP ${response.status}` }; }
    catch (error) { return { available: false, message: error instanceof Error ? error.message : String(error) }; }
  }
  async supportsVision(model: string): Promise<boolean> { return model === qwenModel && this.runtimeModelId === qwenModel && this.visionEnabled; }
  async resolveContextWindow(model: string, requested: number): Promise<ContextWindow> {
    if (model !== this.runtimeModelId) throw new Error(`llama.cpp launcher запущен с моделью ${this.runtimeModelId}`);
    return { requested, active: Math.min(requested, this.contextLimit), supported: this.contextLimit };
  }
  async ensureModelAvailable(model: string): Promise<void> {
    if (model !== this.runtimeModelId) throw new Error(`llama.cpp launcher запущен с моделью ${this.runtimeModelId}`);
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
      return { role: message.role, content: message.content, ...(tool.tool_calls ? { tool_calls: tool.tool_calls.map((call) => ({ type: 'function', ...call, function: { ...call.function, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments) } })) } : {}), ...(tool.tool_name ? { name: tool.tool_name } : {}), ...(tool.tool_call_id ? { tool_call_id: tool.tool_call_id } : {}) };
    });
  }
  private payload(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, reasoningMode: ReasoningMode, maxTokens?: number, stream?: boolean): Record<string, unknown> {
    return { model, messages: this.messages(messages), ...(tools ? { tools, tool_choice: 'auto' } : {}), ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }), ...llamaCppReasoning(model, reasoningMode), ...(stream === undefined ? {} : { stream }) };
  }
  /** Uses llama.cpp's own OpenAI parser, chat template and tokenizer. Older servers fall back without a local rejection. */
  private async exactInputTokens(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, reasoningMode: ReasoningMode, signal: AbortSignal): Promise<number | undefined> {
    const endpoint = '/v1/chat/completions/input_tokens';
    try {
      const response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.payload(model, messages, tools, reasoningMode)) });
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
  private async budget(model: string, messages: Array<ChatMessage | ToolMessage>, contextWindow: number, reasoningMode: ReasoningMode, tools: unknown[] | undefined, signal: AbortSignal): Promise<Budget> {
    const requestedMaxTokens = maxOutputTokens;
    const accounting = this.estimate(messages, tools);
    const prepared = this.preparedInputTokens.get(messages);
    const exactPromptTokens = prepared && prepared.tools === tools && prepared.reasoningMode === reasoningMode ? prepared.tokens : await this.exactInputTokens(model, messages, tools, reasoningMode, signal);
    this.preparedInputTokens.delete(messages);
    if (exactPromptTokens !== undefined) {
      accounting.exactPromptTokens = exactPromptTokens;
      const remainingContext = contextWindow - exactPromptTokens;
      const maxTokens = outputBudget(contextWindow, exactPromptTokens);
      const budget: Budget = { inputTokens: exactPromptTokens, maxTokens, requestedMaxTokens, source: 'exact', outputClamped: maxTokens < requestedMaxTokens, remainingContext, accounting };
      const payload = { backend: 'llama-cpp', contextLimit: contextWindow, requestedMaxOutput: requestedMaxTokens, effectiveMaxOutput: maxTokens, safetyMarginTokens: outputSafetyReserveTokens, remainingContext, cachedRawReadsIncludedInPrompt: false, ...accounting };
      if (maxTokens < 1) { log('llama-cpp.preflight.context-exhausted-confirmed', payload); throw new LlamaCppContextExhaustedError(budget, contextWindow); }
      log(budget.outputClamped ? 'llama-cpp.preflight.context-output-clamped' : 'llama-cpp.preflight.context-exact', payload);
      return budget;
    }
    const maxTokens = outputBudget(contextWindow, accounting.estimatedPromptTokens);
    const budget: Budget = { inputTokens: accounting.estimatedPromptTokens, maxTokens, requestedMaxTokens, source: 'estimate', outputClamped: maxTokens < requestedMaxTokens, accounting };
    if (budget.outputClamped) log('llama-cpp.preflight.context-estimate-output-clamped', { backend: 'llama-cpp', contextLimit: contextWindow, requestedMaxOutput: requestedMaxTokens, effectiveMaxOutput: maxTokens, safetyMarginTokens: outputSafetyReserveTokens, lastActualPromptTokens: this.lastActualPromptTokens, cachedRawReadsIncludedInPrompt: false, ...accounting });
    return budget;
  }

  async countInputTokens(model: string, messages: ToolMessage[], tools: unknown[] | undefined, _contextWindow: number, reasoningMode: ReasoningMode, signal: AbortSignal): Promise<number> {
    const tokens = (await this.exactInputTokens(model, messages, tools, reasoningMode, signal)) ?? this.estimate(messages, tools).estimatedPromptTokens;
    this.preparedInputTokens.set(messages, { tools, reasoningMode, tokens });
    return tokens;
  }
  private requestDiagnostics(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, budget: Budget, status: number, endpoint: string, serverError?: string): RequestDiagnostics {
    const userMessage = serverError?.match(/Error:\s*(?:Jinja Exception:\s*)?([^\n]+)/)?.[1]?.slice(0, 240) || serverError?.slice(0, 240);
    const contextClassification = /context|n_ctx|prompt.*token|slot.*full|exceed/i.test(serverError ?? '') ? 'backend_context_rejected' : 'http_error';
    return { endpoint, status, ...(serverError ? { serverError } : {}), ...(userMessage ? { userMessage } : {}), backend: 'llama-cpp', model, contextSize: contextWindow, requestedMaxOutput: budget.requestedMaxTokens, effectiveMaxOutput: budget.maxTokens, messageCount: messages.length, toolCount: tools?.length ?? 0, hasImages: messages.some((message) => Boolean(message.images?.length)), estimatedPromptTokens: budget.accounting.estimatedPromptTokens, ...(budget.accounting.exactPromptTokens === undefined ? {} : { exactPromptTokens: budget.accounting.exactPromptTokens }), contextClassification };
  }
  private async failedRequest(model: string, messages: Array<ChatMessage | ToolMessage>, tools: unknown[] | undefined, contextWindow: number, budget: Budget, response: Response, endpoint: string): Promise<never> {
    const body = await response.text().catch(() => ''); let serverError = '';
    try { const parsed = JSON.parse(body) as { error?: { message?: unknown } }; serverError = typeof parsed.error?.message === 'string' ? parsed.error.message : body; } catch { serverError = body; }
    serverError = serverError.replace(/\s+/g, ' ').trim().slice(0, 500);
    const request = this.requestDiagnostics(model, messages, tools, contextWindow, budget, response.status, endpoint, serverError || undefined);
    log('llama-cpp.request.failed', request); throw new LlamaCppRequestError(request);
  }
  private diagnostics(reasoningMode: ReasoningMode, contextLimit: number, budget: Budget, data?: ChatResponse): InferenceDiagnostics {
    const t = data?.timings;
    const promptEvalDuration = wholeNanoseconds(t?.prompt_ms === undefined ? undefined : t.prompt_ms * 1_000_000);
    const evalDuration = wholeNanoseconds(t?.predicted_ms === undefined ? undefined : t.predicted_ms * 1_000_000);
    return { reasoningMode, requestedMaxOutputTokens: budget.requestedMaxTokens, effectiveMaxOutputTokens: budget.maxTokens, contextLimit, inputTokens: data?.usage?.prompt_tokens ?? budget.inputTokens, ...(data?.usage?.prompt_tokens !== undefined ? { promptEvalCount: data.usage.prompt_tokens } : {}), ...(promptEvalDuration !== undefined ? { promptEvalDuration } : {}), ...(data?.usage?.completion_tokens !== undefined ? { evalCount: data.usage.completion_tokens } : {}), ...(evalDuration !== undefined ? { evalDuration } : {}), ...(t?.predicted_per_second !== undefined ? { tokensPerSecond: t.predicted_per_second } : {}), ...(t?.prompt_per_second !== undefined ? { promptTokensPerSecond: t.prompt_per_second } : {}) };
  }
  private recordCalibration(budget: Budget, contextLimit: number, data: ChatResponse | null): void {
    const actualPromptEvalCount = data?.usage?.prompt_tokens;
    if (typeof actualPromptEvalCount !== 'number') return;
    this.lastActualPromptTokens = actualPromptEvalCount;
    log('llama-cpp.context.calibration', { backend: 'llama-cpp', estimatedPromptTokens: budget.accounting.estimatedPromptTokens, ...(budget.accounting.exactPromptTokens === undefined ? {} : { exactPromptTokens: budget.accounting.exactPromptTokens }), actualPromptEvalCount, estimationErrorRatio: actualPromptEvalCount > 0 ? budget.accounting.estimatedPromptTokens / actualPromptEvalCount : undefined, contextLimit, remainingContext: contextLimit - actualPromptEvalCount, requestedOutput: budget.requestedMaxTokens, effectiveOutput: budget.maxTokens, outputClamped: budget.outputClamped, tokenCountSource: budget.source });
  }
  async chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, requestContext?: ToolInferenceRequestContext): Promise<ToolMessage> {
    const startedAt = Date.now(); const endpoint = '/v1/chat/completions';
    let connectionError: unknown;
    const agentDiagnostics = requestContext ? { generationId: requestContext.generationId, conversationId: requestContext.conversationId, agentStep: requestContext.agentStep, phase: requestContext.phase, messageCount: messages.length, toolResultCount: messages.filter((message) => message.role === 'tool').length, assistantToolCallCount: messages.reduce((count, message) => count + (message.tool_calls?.length ?? 0), 0), contextWindow, signalAborted: signal.aborted } : undefined;
    if (agentDiagnostics) log('llama-cpp.agent.inference.started', { ...agentDiagnostics, startedAt: new Date(startedAt).toISOString() });
    try {
      await this.ensureModelAvailable(model);
      const sequenceError = validateLlamaMessageSequence(messages);
      if (sequenceError) { log('llama-cpp.request.invalid', { backend: 'llama-cpp', model, endpoint, sequenceError, messages: messages.map((message, index) => ({ index, role: message.role, toolName: message.tool_name, toolCallId: message.tool_call_id, toolCallCount: message.tool_calls?.length ?? 0, toolCallIds: message.tool_calls?.map((call) => call.id) })) }); throw new Error(`Некорректная последовательность Agent сообщений: ${sequenceError}`); }
      const budget = await this.budget(model, messages, contextWindow, reasoningMode, tools, signal);
      const dispatchedAt = Date.now();
      if (agentDiagnostics) log('llama-cpp.agent.inference.dispatched', { ...agentDiagnostics, dispatchedAt: new Date(dispatchedAt).toISOString(), preparationElapsedMs: dispatchedAt - startedAt, requestedMaxTokens: budget.requestedMaxTokens, maxTokens: budget.maxTokens, estimatedPromptTokens: budget.accounting.estimatedPromptTokens, exactPromptTokens: budget.accounting.exactPromptTokens });
      let response: Response;
      try { response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.payload(model, messages, tools, reasoningMode, budget.maxTokens, false)) }); }
      catch (error) { connectionError = error; throw error; }
      const completedAt = Date.now();
      if (agentDiagnostics) log('llama-cpp.agent.inference.response', { ...agentDiagnostics, completedAt: new Date(completedAt).toISOString(), elapsedMs: completedAt - startedAt, fetchElapsedMs: completedAt - dispatchedAt, status: response.status, signalAborted: signal.aborted });
      if (!response.ok) return this.failedRequest(model, messages, tools, contextWindow, budget, response, endpoint);
      const data = await response.json().catch(() => null) as ChatResponse | null;
      if (!data) throw new Error('llama.cpp вернул некорректный JSON-ответ');
      const choice = data.choices?.[0]; if (!choice?.message) throw new Error('llama.cpp вернул ответ без assistant message');
      if (agentDiagnostics) {
        const rawMessage = choice.message as Record<string, unknown>;
        const rawToolCalls = rawMessage.tool_calls;
        log('llama-cpp.agent.inference.raw-response', {
          ...agentDiagnostics,
          responseMessageKeys: Object.keys(rawMessage),
          nativeToolCallsPresent: Array.isArray(rawToolCalls),
          nativeToolCallCount: Array.isArray(rawToolCalls) ? rawToolCalls.length : 0,
          nativeToolNames: Array.isArray(rawToolCalls) ? rawToolCalls.flatMap((call) => call && typeof call === 'object' && typeof (call as { function?: { name?: unknown } }).function?.name === 'string' ? [(call as { function: { name: string } }).function.name] : []) : [],
          nativeToolCalls: Array.isArray(rawToolCalls) ? rawToolCalls.map((call) => {
            const functionCall = call && typeof call === 'object' ? (call as { function?: Record<string, unknown> }).function : undefined;
            return { keys: call && typeof call === 'object' ? Object.keys(call as Record<string, unknown>) : [], id: call && typeof call === 'object' && typeof (call as { id?: unknown }).id === 'string' ? (call as { id: string }).id : undefined, functionKeys: functionCall ? Object.keys(functionCall) : [], name: functionCall?.name, arguments: responseTextShape(functionCall?.arguments) };
          }) : [],
          content: responseTextShape(rawMessage.content),
          reasoning: responseTextShape(rawMessage.reasoning_content),
        });
      }
      this.recordCalibration(budget, contextWindow, data);
      return { role: 'assistant', content: choice.message.content ?? '', thinking: choice.message.reasoning_content ?? undefined, tool_calls: (choice.message.tool_calls ?? []).flatMap((call) => call.function?.name ? [{ ...(call.id ? { id: call.id } : {}), ...(call.type === 'function' ? { type: 'function' as const } : {}), function: { name: call.function.name, arguments: call.function.arguments ?? '{}' } }] : []), finish_reason: finishReason(choice.finish_reason), prompt_eval_count: data.usage?.prompt_tokens, inference: this.diagnostics(reasoningMode, contextWindow, budget, data) };
    } catch (error) {
      const failedAt = Date.now(); const summary = errorSummary(error);
      if (agentDiagnostics) {
        const health = connectionError ? await this.probeHealth() : undefined;
        log('llama-cpp.agent.inference.failed', { ...agentDiagnostics, failedAt: new Date(failedAt).toISOString(), elapsedMs: failedAt - startedAt, signalAborted: signal.aborted, ...summary, health });
      }
      if (connectionError && !signal.aborted) throw new Error(`llama.cpp inference connection failed: ${summary.error}`, { cause: error });
      throw error;
    }
  }
  /** Streaming counterpart of chatWithTools. The response is assembled only at
   * [DONE], so callers retain the same strict validation boundary as the
   * non-streaming protocol. */
  async *streamWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, requestContext?: ToolInferenceRequestContext): AsyncIterable<ToolInferenceStreamEvent> {
    const startedAt = Date.now(); const endpoint = '/v1/chat/completions';
    const diagnostics = requestContext ? { generationId: requestContext.generationId, conversationId: requestContext.conversationId, agentStep: requestContext.agentStep, phase: requestContext.phase, messageCount: messages.length, toolResultCount: messages.filter((message) => message.role === 'tool').length, assistantToolCallCount: messages.reduce((count, message) => count + (message.tool_calls?.length ?? 0), 0), contextWindow } : undefined;
    const first: Record<string, number | undefined> = { event: undefined, reasoning: undefined, content: undefined, tool: undefined };
    const assembled = new Map<number, { id?: string; type?: string; name?: string; arguments: string }>();
    let text = ''; let thinking = ''; let finalData: ChatResponse | undefined; let finalReason: FinishReason | undefined;
    try {
      await this.ensureModelAvailable(model);
      const sequenceError = validateLlamaMessageSequence(messages); if (sequenceError) throw new Error(`Некорректная последовательность Agent сообщений: ${sequenceError}`);
      const budget = await this.budget(model, messages, contextWindow, reasoningMode, tools, signal);
      if (diagnostics) log('llama-cpp.agent.stream.started', { ...diagnostics, startedAt: new Date(startedAt).toISOString(), requestedMaxTokens: budget.requestedMaxTokens, maxTokens: budget.maxTokens, exactPromptTokens: budget.accounting.exactPromptTokens });
      const response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...this.payload(model, messages, tools, reasoningMode, budget.maxTokens, true), stream_options: { include_usage: true } }) });
      first.event = Date.now();
      if (diagnostics) log('llama-cpp.agent.stream.headers', { ...diagnostics, latencyMs: first.event - startedAt, status: response.status });
      if (!response.ok) { await this.failedRequest(model, messages, tools, contextWindow, budget, response, endpoint); return; }
      if (!response.body) throw new Error('llama.cpp не вернул stream body для Agent turn');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          const blocks = buffer.split('\n\n'); buffer = blocks.pop() ?? '';
          for (const raw of blocks) {
            if (!raw.startsWith('data: ')) continue;
            const item = raw.slice(6).trim();
            if (item === '[DONE]') {
              finalReason ??= 'stop';
              const calls = [...assembled.entries()].sort(([a], [b]) => a - b).flatMap(([, call]) => call.name ? [{ ...(call.id ? { id: call.id } : {}), ...(call.type === 'function' ? { type: 'function' as const } : {}), function: { name: call.name, arguments: call.arguments } }] : []);
              this.recordCalibration(budget, contextWindow, finalData ?? null);
              const inference = this.diagnostics(reasoningMode, contextWindow, budget, finalData);
              if (diagnostics) log('llama-cpp.agent.stream.finished', { ...diagnostics, generationDurationMs: Date.now() - startedAt, finishReason: finalReason, firstEventMs: first.event === undefined ? undefined : first.event - startedAt, firstReasoningMs: first.reasoning === undefined ? undefined : first.reasoning - startedAt, firstContentMs: first.content === undefined ? undefined : first.content - startedAt, firstToolCallMs: first.tool === undefined ? undefined : first.tool - startedAt, reasoningChars: thinking.length, contentChars: text.length, toolCallsDetected: calls.length, completionTokens: inference.evalCount });
              yield { type: 'response', response: { role: 'assistant', content: text, ...(thinking ? { thinking } : {}), tool_calls: calls, finish_reason: finalReason, prompt_eval_count: finalData?.usage?.prompt_tokens, inference } };
              return;
            }
            const data = JSON.parse(item) as ChatResponse; const choice = data.choices?.[0];
            if (data.usage || data.timings) finalData = { ...finalData, ...data, usage: data.usage ?? finalData?.usage, timings: data.timings ?? finalData?.timings };
            const delta = choice?.delta;
            if (delta?.reasoning_content) { first.reasoning ??= Date.now(); thinking += delta.reasoning_content; yield { type: 'thinking', content: delta.reasoning_content }; }
            if (delta?.content) { first.content ??= Date.now(); text += delta.content; yield { type: 'token', content: delta.content }; }
            for (const rawCall of delta?.tool_calls ?? []) {
              first.tool ??= Date.now(); const index = rawCall.index ?? assembled.size; const current = assembled.get(index) ?? { arguments: '' };
              if (rawCall.id) current.id = rawCall.id; if (rawCall.type) current.type = rawCall.type; if (rawCall.function?.name) current.name = rawCall.function.name;
              const argumentsDelta = rawCall.function?.arguments; if (argumentsDelta) current.arguments += argumentsDelta;
              assembled.set(index, current);
              yield { type: 'tool_call_delta', index, ...(rawCall.id ? { id: rawCall.id } : {}), ...(rawCall.function?.name ? { name: rawCall.function.name } : {}), ...(argumentsDelta ? { argumentsDelta } : {}) };
            }
            if (choice?.finish_reason) finalReason = finishReason(choice.finish_reason);
          }
          if (done) break;
        }
      } finally { reader.releaseLock(); }
      if (signal.aborted) return;
      throw new Error('Agent stream завершился без [DONE]');
    } catch (error) {
      if (diagnostics) log('llama-cpp.agent.stream.failed', { ...diagnostics, elapsedMs: Date.now() - startedAt, signalAborted: signal.aborted, ...errorSummary(error) });
      throw error;
    }
  }
  private async probeHealth(): Promise<{ available: boolean; elapsedMs: number; status?: number; error?: string }> {
    const startedAt = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2_000);
    try { const response = await fetch(this.url('/health'), { signal: controller.signal }); return { available: response.ok, elapsedMs: Date.now() - startedAt, status: response.status }; }
    catch (error) { return { available: false, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }; }
    finally { clearTimeout(timer); }
  }
  async *streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow = 32_768, reasoningMode: ReasoningMode = 'auto'): AsyncIterable<StreamEvent> {
    try {
      await this.ensureModelAvailable(model); const sequenceError = validateLlamaMessageSequence(messages); if (sequenceError) throw new Error(`Некорректная последовательность Chat сообщений: ${sequenceError}`); const budget = await this.budget(model, messages, contextWindow, reasoningMode, undefined, signal);
      const endpoint = '/v1/chat/completions'; const response = await fetch(this.url(endpoint), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...this.payload(model, messages, undefined, reasoningMode, budget.maxTokens, true), stream_options: { include_usage: true } }) });
      if (!response.ok) await this.failedRequest(model, messages, undefined, contextWindow, budget, response, endpoint);
      if (!response.body) { yield { type: 'error', message: 'llama.cpp не смог начать генерацию', details: 'llama.cpp не вернул тело stream-ответа' }; return; }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let finalData: ChatResponse | undefined; let finalReason: FinishReason | undefined; let diagnosticsEmitted = false;
      const emitDiagnostics = function* (self: LlamaCppBackend): Generator<StreamEvent> {
        if (diagnosticsEmitted || !finalReason) return;
        diagnosticsEmitted = true; self.recordCalibration(budget, contextWindow, finalData ?? null);
        yield { type: 'diagnostics', diagnostics: { ...self.diagnostics(reasoningMode, contextWindow, budget, finalData), agentStepCount: 0, finishReason: finalReason } };
      };
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          const blocks = buffer.split('\n\n'); buffer = blocks.pop() ?? '';
          for (const raw of blocks) {
            if (!raw.startsWith('data: ')) continue; const valueText = raw.slice(6).trim();
            if (valueText === '[DONE]') { if (!finalReason) finalReason = 'stop'; yield* emitDiagnostics(this); yield { type: 'done', finishReason: finalReason }; return; }
            const data = JSON.parse(valueText) as ChatResponse; const choice = data.choices?.[0];
            if (data.usage || data.timings) finalData = { ...finalData, ...data, usage: data.usage ?? finalData?.usage, timings: data.timings ?? finalData?.timings };
            if (choice?.delta?.reasoning_content) yield { type: 'thinking', content: choice.delta.reasoning_content };
            if (choice?.delta?.content) yield { type: 'token', content: choice.delta.content };
            if (choice?.finish_reason) finalReason = finishReason(choice.finish_reason);
          }
          if (done) break;
        }
        if (!signal.aborted && finalReason) { yield* emitDiagnostics(this); yield { type: 'done', finishReason: finalReason }; return; }
        if (!signal.aborted) yield { type: 'error', message: 'Поток llama.cpp завершился без итогового сообщения' };
      } finally { reader.releaseLock(); }
    } catch (error) { if (!signal.aborted) yield { type: 'error', message: 'Генерация llama.cpp прервана', details: error instanceof Error ? error.message : String(error) }; }
  }
}
function finishReason(reason: string | null | undefined): FinishReason { return reason === 'length' ? 'length' : 'stop'; }
