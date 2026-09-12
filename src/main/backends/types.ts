import type { ChatMessage, ModelInfo, StreamEvent } from '../../shared/types';

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> | string } };
export type ToolMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_name?: string };

/** Contract shared by Ollama now and llama.cpp when its server adapter is added. */
export interface ToolCallingBackend {
  chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number): Promise<ToolMessage>;
}

export interface LlmBackend {
  getModels(): Promise<ModelInfo[]>;
  streamChat(model: string, messages: ChatMessage[], signal: AbortSignal): AsyncIterable<StreamEvent>;
  getStatus(): Promise<{ available: boolean; message?: string }>;
}
