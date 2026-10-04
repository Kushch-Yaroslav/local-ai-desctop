import type { ChatMode, Conversation, ReasoningMode } from './types';

export type ConversationPatch = Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'llamaKvCacheType' | 'llamaKvOffload' | 'reasoningMode' | 'webMode'>>;

const runtimeKeys = ['modelId', 'contextWindow', 'llamaKvCacheType', 'llamaKvOffload'] as const;

/** Only these settings require llama.cpp to be (re)started; everything else is applied per request. */
export function touchesRuntime(patch: ConversationPatch): boolean {
  return runtimeKeys.some((key) => patch[key] !== undefined);
}

/**
 * Undo only the keys of a refused patch. Restoring a whole earlier snapshot would also
 * discard unrelated changes made while the refused request was in flight.
 */
export function revertRefusedPatch(current: Conversation, before: Conversation, patch: ConversationPatch): Conversation {
  const next: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch) as Array<keyof ConversationPatch>) {
    if (current[key] === patch[key]) next[key] = before[key];
  }
  return next as unknown as Conversation;
}

export type EffectiveModeState = { reasoningMode: 'fast' | 'deep'; mode: ChatMode };
export type ModeTransition = { desired: Partial<EffectiveModeState>; effective: EffectiveModeState };

export interface EffectiveModes {
  /** null when the selected model has no configurable reasoning. */
  reasoning: 'fast' | 'deep' | null;
  mode: ChatMode;
  pendingReasoning: 'fast' | 'deep' | null;
  pendingMode: ChatMode | null;
}

const normalizeReasoning = (value: ReasoningMode): 'fast' | 'deep' => (value === 'deep' ? 'deep' : 'fast');

/**
 * The effective state is what the next request will really use: the last value the main
 * process confirmed. A selection still in flight is reported separately as pending and is
 * never shown as active.
 */
export function effectiveModes(chat: Pick<Conversation, 'reasoningMode' | 'mode'>, supportsReasoning: boolean, transition?: ModeTransition | null): EffectiveModes {
  const confirmed: EffectiveModeState = transition ? transition.effective : { reasoningMode: normalizeReasoning(chat.reasoningMode), mode: chat.mode };
  const pendingReasoning = transition?.desired.reasoningMode && transition.desired.reasoningMode !== confirmed.reasoningMode ? transition.desired.reasoningMode : null;
  const pendingMode = transition?.desired.mode && transition.desired.mode !== confirmed.mode ? transition.desired.mode : null;
  return { reasoning: supportsReasoning ? confirmed.reasoningMode : null, mode: confirmed.mode, pendingReasoning: supportsReasoning ? pendingReasoning : null, pendingMode };
}
