import type { ContextDiscoveryOption } from './context-estimator';
import type { LlamaKvCacheType } from './types';

export const defaultLlamaKv = { llamaKvCacheType: 'f16' as const, llamaKvOffload: true };

export type ContextChoice = {
  contextWindow: number;
  kvCacheType: LlamaKvCacheType;
  kvOffload: boolean;
  label: string;
};

export const contextChoiceId = (option: Pick<ContextChoice, 'contextWindow' | 'kvCacheType' | 'kvOffload'>) =>
  `${option.contextWindow}:${option.kvCacheType}:${option.kvOffload ? 'gpu' : 'ram'}`;

export const cacheModeLabel = (type: LlamaKvCacheType) => type === 'f16' ? 'FP16' : 'Q8';

/** Hardware evidence annotates/adds choices; it never filters model capability presets. */
export function buildContextChoices(
  modelId: string,
  normalPresets: readonly number[],
  hardLimit: number,
  discovered: readonly ContextDiscoveryOption[],
): ContextChoice[] {
  const options: ContextChoice[] = [...new Set(normalPresets)]
    .filter((contextWindow) => contextWindow > 0 && contextWindow <= hardLimit)
    .map((contextWindow) => ({ contextWindow, kvCacheType: 'f16', kvOffload: true, label: `${contextWindow / 1024}K` }));
  for (const candidate of discovered) {
    if (candidate.modelId !== modelId || candidate.contextWindow > hardLimit) continue;
    const existing = options.find((option) => contextChoiceId(option) === contextChoiceId(candidate));
    const label = `${candidate.contextWindow / 1024}K (${cacheModeLabel(candidate.kvCacheType)})`;
    if (existing) existing.label = label;
    else options.push({ ...candidate, label });
  }
  return options.sort((left, right) => left.contextWindow - right.contextWindow || left.kvCacheType.localeCompare(right.kvCacheType));
}

export function normalContextPatch(contextWindow: number) {
  return { contextWindow, ...defaultLlamaKv };
}

export function normalContextForModel(contextWindow: number, presets: readonly number[]): number {
  const sorted = [...presets].sort((left, right) => left - right);
  return sorted.filter((preset) => preset <= contextWindow).at(-1) ?? sorted[0] ?? contextWindow;
}

export function resolveLlamaKvSelection(
  current: { llamaKvCacheType?: LlamaKvCacheType; llamaKvOffload?: boolean },
  patch: { contextWindow?: number; llamaKvCacheType?: LlamaKvCacheType; llamaKvOffload?: boolean },
  modelChanged: boolean,
) {
  const normalRequest = patch.contextWindow !== undefined && patch.llamaKvCacheType === undefined && patch.llamaKvOffload === undefined;
  return {
    llamaKvCacheType: patch.llamaKvCacheType ?? (modelChanged || normalRequest ? defaultLlamaKv.llamaKvCacheType : current.llamaKvCacheType ?? defaultLlamaKv.llamaKvCacheType),
    llamaKvOffload: patch.llamaKvOffload ?? (modelChanged || normalRequest ? defaultLlamaKv.llamaKvOffload : current.llamaKvOffload ?? defaultLlamaKv.llamaKvOffload),
  };
}
