import type { ChatMessage, ModelInfo, StreamEvent } from '../../shared/types';
import type { LlmBackend, ToolCallingBackend, ToolMessage } from './types';

type OllamaTags = { models?: Array<{ name: string; size: number }> };
type OllamaChunk = { message?: { content?: string }; done?: boolean; error?: string };

type OllamaToolResponse = { message?: ToolMessage; error?: string };
type OllamaShowResponse = { model_info?: Record<string, unknown>; parameters?: string };

export type ContextWindow = { requested: number; active: number; supported?: number };

export class OllamaBackend implements LlmBackend, ToolCallingBackend {
  constructor(private readonly baseUrl = 'http://127.0.0.1:11434') {}

  async getModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Ollama вернул HTTP ${response.status}`);
    const data = await response.json() as OllamaTags;
    return (data.models ?? []).map((model) => ({ id: model.name, name: model.name, size: model.size, backend: 'ollama' }));
  }

  async getStatus(): Promise<{ available: boolean; message?: string }> {
    try { await this.getModels(); return { available: true }; }
    catch (error) { return { available: false, message: error instanceof Error ? error.message : String(error) }; }
  }

  async resolveContextWindow(model: string, requested: number, signal: AbortSignal): Promise<ContextWindow> {
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
      });
      if (!response.ok) return { requested, active: requested };
      const data = await response.json() as OllamaShowResponse;
      const modelLimit = Object.entries(data.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
      const parameterLimit = data.parameters?.match(/^num_ctx\s+(\d+)$/m)?.[1];
      const supported = Number(modelLimit ?? parameterLimit);
      if (!Number.isFinite(supported) || supported <= 0) return { requested, active: requested };
      return { requested, active: Math.min(requested, supported), supported };
    } catch {
      return { requested, active: requested };
    }
  }

  async chatWithTools(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number): Promise<ToolMessage> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages, ...(tools ? { tools } : {}), options: { num_ctx: contextWindow } }),
      });
    } catch (error) { throw new Error(`Не удалось подключиться к Ollama: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw new Error(`Ollama вернул HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json() as OllamaToolResponse;
    if (data.error) throw new Error(data.error);
    if (!data.message) throw new Error('Ollama вернул пустой ответ');
    return data.message;
  }

  async *streamChat(model: string, messages: ChatMessage[], signal: AbortSignal, contextWindow = 32_768): AsyncIterable<StreamEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: messages.map(({ role, content }) => ({ role, content })), options: { num_ctx: contextWindow } }),
      });
    } catch (error) {
      if (signal.aborted) return;
      yield { type: 'error', message: 'Не удалось подключиться к Ollama', details: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', message: 'Ollama не смог начать генерацию', details: `HTTP ${response.status}` };
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
          if (item.message?.content) yield { type: 'token', content: item.message.content };
          if (item.done) { yield { type: 'done' }; return; }
        }
        if (done) break;
      }
    } catch (error) {
      if (!signal.aborted) yield { type: 'error', message: 'Генерация прервана из-за ошибки', details: error instanceof Error ? error.message : String(error) };
    } finally { reader.releaseLock(); }
  }
}
