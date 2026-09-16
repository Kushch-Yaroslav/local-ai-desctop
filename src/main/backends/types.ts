import type { AnalysisDepth, ChatMessage, FinishReason, GenerationDiagnostics, ModelInfo, StreamEvent } from '../../shared/types';

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> | string } };
export type InferenceDiagnostics = Omit<GenerationDiagnostics, 'generationId' | 'conversationId' | 'createdAt' | 'agentStepCount' | 'finishReason'>;

/** SQLite diagnostics columns use INTEGER nanoseconds, so backend timing values are canonicalized here. */
export function wholeNanoseconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}
export type ToolMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_name?: string;
  /** Ephemeral base64 image inputs for Ollama; never a persisted chat field. */
  images?: string[];
  prompt_eval_count?: number; finish_reason?: FinishReason; inference?: InferenceDiagnostics; thinking?: string;
};

/** Contract shared by Ollama now and llama.cpp when its server adapter is added. */
export interface ToolCallingBackend {
  chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, depth: AnalysisDepth): Promise<ToolMessage>;
}

export interface LlmBackend {
  getModels(): Promise<ModelInfo[]>;
  streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow?: number, depth?: AnalysisDepth): AsyncIterable<StreamEvent>;
  getStatus(): Promise<{ available: boolean; message?: string }>;
}
