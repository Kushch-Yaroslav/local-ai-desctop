import type { AppSettings, Conversation } from './types';
import { defaultLlamaKv, normalContextForModel } from './context-options';

/** Saved conversation identity is history, not a process/session selection. */
export function activeConversationModel(chat: Pick<Conversation, 'modelId'> | undefined, runtime: AppSettings['llamaRuntime']): string | null {
  return runtime?.status === 'ready' && runtime.modelId === chat?.modelId ? runtime.modelId : null;
}

/** A fresh explicit selection starts in normal mode, never a historical Max configuration.
 * Max is manual and may only be restored/validated against a running configuration.
 */
export function initialModelContext(presets: readonly number[]) {
  return { contextWindow: normalContextForModel(32_768, presets), ...defaultLlamaKv };
}
