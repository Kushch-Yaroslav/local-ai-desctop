import type { ChatMode, Conversation, ReasoningMode } from './types';
import { resolveReasoningSelection, type ReasoningCapability, type ReasoningEffort } from './reasoning-controls';

export type ConversationPatch = Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'llamaKvCacheType' | 'llamaKvOffload' | 'reasoningMode' | 'thinkingEnabled' | 'reasoningEffort' | 'webMode'>>;

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

export type EffectiveModeState = { reasoningMode: 'fast' | 'deep'; mode: ChatMode; thinkingEnabled?: boolean | null; reasoningEffort?: ReasoningEffort | null };
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

/**
 * A conversation that never chose thinking/effort derived them from the strategy. Changing the strategy must not move
 * them, so the values it was effectively using are written down together with the first strategy change.
 */
export function pinLegacyReasoning(chat: Pick<Conversation, 'reasoningMode' | 'thinkingEnabled' | 'reasoningEffort'>, capability: ReasoningCapability | null | undefined, patch: ConversationPatch): ConversationPatch {
  if (!capability || patch.reasoningMode === undefined || patch.reasoningMode === chat.reasoningMode) return patch;
  const legacy = resolveReasoningSelection(capability, chat.reasoningMode, chat);
  return {
    ...(chat.thinkingEnabled === null && patch.thinkingEnabled === undefined && legacy.thinking !== null ? { thinkingEnabled: legacy.thinking } : {}),
    ...(chat.reasoningEffort === null && patch.reasoningEffort === undefined && legacy.effort !== null ? { reasoningEffort: legacy.effort } : {}),
    ...patch,
  };
}

export interface EffectiveReasoning {
  /** false when the selected model has no configurable reasoning at all. */
  supported: boolean;
  /** null = the model has no thinking switch. */
  thinking: boolean | null;
  /** null = the model has no effort levels. */
  effort: ReasoningEffort | null;
  /** Effort is meaningless while thinking is off. */
  effortApplies: boolean;
  pendingThinking: boolean | null;
  pendingEffort: ReasoningEffort | null;
}

/** Thinking and effort as the next request will really use them, with an unconfirmed selection reported as pending only. */
export function effectiveReasoning(chat: Pick<Conversation, 'reasoningMode' | 'thinkingEnabled' | 'reasoningEffort'>, capability: ReasoningCapability | null | undefined, transition?: ModeTransition | null): EffectiveReasoning {
  if (!capability) return { supported: false, thinking: null, effort: null, effortApplies: false, pendingThinking: null, pendingEffort: null };
  const confirmedRaw = transition ? transition.effective : { reasoningMode: normalizeReasoning(chat.reasoningMode), thinkingEnabled: chat.thinkingEnabled, reasoningEffort: chat.reasoningEffort };
  const confirmed = resolveReasoningSelection(capability, confirmedRaw.reasoningMode, { thinkingEnabled: confirmedRaw.thinkingEnabled ?? null, reasoningEffort: confirmedRaw.reasoningEffort ?? null });
  const desired = transition?.desired;
  const wanted = desired ? resolveReasoningSelection(capability, confirmedRaw.reasoningMode, {
    thinkingEnabled: desired.thinkingEnabled !== undefined ? desired.thinkingEnabled : confirmed.thinking,
    reasoningEffort: desired.reasoningEffort !== undefined ? desired.reasoningEffort : confirmed.effort,
  }) : confirmed;
  return {
    supported: true,
    thinking: confirmed.thinking,
    effort: confirmed.effort,
    effortApplies: confirmed.effort !== null && confirmed.thinking !== false,
    pendingThinking: wanted.thinking !== confirmed.thinking ? wanted.thinking : null,
    pendingEffort: wanted.effort !== confirmed.effort ? wanted.effort : null,
  };
}
