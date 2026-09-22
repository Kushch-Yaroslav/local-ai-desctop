import type { ChatMessage, FinishReason, GenerationDiagnostics, ModelInfo, ReasoningMode, StreamEvent } from '../../shared/types';

/** OpenAI-compatible call identity is retained so every tool result can be
 * matched to the exact assistant call, including sibling calls with one name. */
export type ToolCall = { id?: string; type?: 'function'; function: { name: string; arguments: Record<string, unknown> | string } };
export type InferenceDiagnostics = Omit<GenerationDiagnostics, 'generationId' | 'conversationId' | 'createdAt' | 'agentStepCount' | 'finishReason'>;
/** Ephemeral metadata for safe request diagnostics. Never serialized as model input. */
export type ToolInferenceRequestContext = {
  generationId?: string;
  conversationId?: string;
  agentStep?: number;
  phase?: 'initial' | 'post_tool' | 'recovery' | 'final';
};

/** SQLite diagnostics columns use INTEGER nanoseconds, so backend timing values are canonicalized here. */
export function wholeNanoseconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}
export type ToolMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_name?: string; tool_call_id?: string;
  /** Ephemeral base64 image inputs for Ollama; never a persisted chat field. */
  images?: string[];
  prompt_eval_count?: number; finish_reason?: FinishReason; inference?: InferenceDiagnostics; thinking?: string;
};

/** Contract shared by Ollama now and llama.cpp when its server adapter is added. */
export interface ToolCallingBackend {
  chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, requestContext?: ToolInferenceRequestContext): Promise<ToolMessage>;
  /** Same tokenizer/chat-template accounting used by the runtime request. */
  countInputTokens?(model: string, messages: ToolMessage[], tools: unknown[] | undefined, contextWindow: number, reasoningMode: ReasoningMode, signal: AbortSignal): Promise<number>;
}

export interface LlmBackend {
  getModels(): Promise<ModelInfo[]>;
  streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow?: number, reasoningMode?: ReasoningMode): AsyncIterable<StreamEvent>;
  getStatus(): Promise<{ available: boolean; message?: string }>;
}
