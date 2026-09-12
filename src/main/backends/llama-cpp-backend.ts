import type { ModelInfo, StreamEvent } from '../../shared/types';
import type { LlmBackend } from './types';

/** Reserved adapter. A managed llama-server process is added in phase 2. */
export class LlamaCppBackend implements LlmBackend {
  async getModels(): Promise<ModelInfo[]> { return []; }
  async getStatus(): Promise<{ available: boolean; message?: string }> {
    return { available: false, message: 'Поддержка llama.cpp будет добавлена в следующем этапе' };
  }
  async *streamChat(): AsyncIterable<StreamEvent> {
    yield { type: 'error', message: 'llama.cpp ещё не настроен' };
  }
}
