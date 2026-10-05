import type { ReasoningMode } from './types';

/**
 * Model-independent effort levels. Each model declares the subset it supports and maps them to its own native values
 * in the main process; the renderer only ever sees these ids.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';
export const reasoningEffortOrder: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (reasoningEffortOrder as readonly string[]).includes(value);
}

/** What a model lets the user control. An empty `efforts` list means the effort is not configurable. */
export interface ReasoningCapability {
  thinkingToggle: boolean;
  efforts: ReasoningEffort[];
}

/** `null` means the control does not exist for the model, not that it is off. */
export interface ReasoningSelection {
  thinking: boolean | null;
  effort: ReasoningEffort | null;
}

export interface StoredReasoningControls {
  thinkingEnabled: boolean | null;
  reasoningEffort: ReasoningEffort | null;
}

/** Strategy-only requests (Auto, or a caller that has no per-conversation choice) never carry an explicit selection. */
export type ReasoningInput = ReasoningMode | { mode: ReasoningMode; selection: ReasoningSelection };

export function reasoningModeOf(input: ReasoningInput): ReasoningMode {
  return typeof input === 'string' ? input : input.mode;
}

export function sameReasoningInput(left: ReasoningInput, right: ReasoningInput): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return left.mode === right.mode && left.selection.thinking === right.selection.thinking && left.selection.effort === right.selection.effort;
}

function nearestEffort(efforts: ReasoningEffort[], wanted: ReasoningEffort): ReasoningEffort {
  const rank = (effort: ReasoningEffort) => reasoningEffortOrder.indexOf(effort);
  // Ties go to the lower level: an unsupported level must never silently cost more than the user asked for.
  return efforts.reduce((best, effort) => Math.abs(rank(effort) - rank(wanted)) < Math.abs(rank(best) - rank(wanted)) ? effort : best);
}

/**
 * The selection an old conversation had implicitly: thinking stayed on, Fast used the lowest effort the model offers
 * and Deep the highest it supports (never a level the model lacks).
 */
export function legacyReasoningSelection(capability: ReasoningCapability, strategy: 'fast' | 'deep'): ReasoningSelection {
  return {
    thinking: capability.thinkingToggle ? true : null,
    effort: capability.efforts.length ? (strategy === 'deep' ? capability.efforts[capability.efforts.length - 1]! : capability.efforts[0]!) : null,
  };
}

/** Resolves stored (possibly absent or no longer supported) values against what the selected model really offers. */
export function resolveReasoningSelection(capability: ReasoningCapability | null | undefined, strategy: ReasoningMode, stored: Partial<StoredReasoningControls> = {}): ReasoningSelection {
  if (!capability) return { thinking: null, effort: null };
  const legacy = legacyReasoningSelection(capability, strategy === 'deep' ? 'deep' : 'fast');
  return {
    thinking: capability.thinkingToggle ? stored.thinkingEnabled ?? legacy.thinking : null,
    effort: capability.efforts.length ? (isReasoningEffort(stored.reasoningEffort) ? nearestEffort(capability.efforts, stored.reasoningEffort) : legacy.effort) : null,
  };
}

/** Effort only has an effect while the model thinks. */
export function effortApplies(selection: ReasoningSelection): boolean {
  return selection.effort !== null && selection.thinking !== false;
}

/** A Russian refusal for a patch the selected model cannot honour, or null when it is acceptable. */
export function reasoningPatchError(patch: { thinkingEnabled?: unknown; reasoningEffort?: unknown }, capability: ReasoningCapability | null | undefined): string | null {
  if (patch.thinkingEnabled !== undefined) {
    if (patch.thinkingEnabled !== null && typeof patch.thinkingEnabled !== 'boolean') return 'Некорректное значение параметра «Размышления».';
    if (patch.thinkingEnabled !== null && !capability?.thinkingToggle) return 'Выбранная модель не позволяет включать или отключать размышления.';
  }
  if (patch.reasoningEffort !== undefined && patch.reasoningEffort !== null) {
    if (!isReasoningEffort(patch.reasoningEffort)) return 'Некорректное значение параметра «Глубина рассуждений».';
    if (!capability?.efforts.includes(patch.reasoningEffort)) return 'Выбранная модель не поддерживает этот уровень глубины рассуждений.';
  }
  return null;
}
