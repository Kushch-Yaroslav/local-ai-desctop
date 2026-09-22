import type { ModelInfo, ReasoningMode } from '../../shared/types';

export const contextPresets = [16_384, 32_768, 65_536, 131_072, 262_144] as const;
export const ollamaModelsPath = '/media/yaroslav/DATA/ollama';

export type ModelProfile = {
  id: string;
  displayName: string;
  quantization: string;
  maxContext: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  shortName: string;
};

/** The only local models exposed by the desktop client. Tags are pinned to the requested precisions. */
export const modelRegistry: readonly ModelProfile[] = [
  { id: 'qwen3.8:27b-q4_K_M', displayName: 'Qwen3.8-27B', shortName: 'Qwen3.8', quantization: 'Q4_K_M', maxContext: 262_144, supportsTools: true, supportsReasoning: true },
  // The official gpt-oss build keeps its native MXFP4 MoE weights and BF16 tensors; it is not a re-quantized Q4 build.
  { id: 'gpt-oss:20b', displayName: 'gpt-oss-20b', shortName: 'GPT-OSS', quantization: 'MXFP4 / BF16', maxContext: 131_072, supportsTools: true, supportsReasoning: true },
  { id: 'glm-4.7-flash:q4_k', displayName: 'GLM-4.7-Flash', shortName: 'GLM-4.7-Flash', quantization: 'Q4_K', maxContext: 65_536, supportsTools: true, supportsReasoning: true },
];

export function getModelProfile(id: string): ModelProfile | undefined {
  return modelRegistry.find((model) => model.id === id);
}

export function contextPresetsFor(maxContext: number): number[] {
  return contextPresets.filter((preset) => preset <= maxContext);
}

export function modelInfo(profile: ModelProfile, installed: boolean, size?: number, maxContext = profile.maxContext, supportsReasoning = profile.supportsReasoning): ModelInfo {
  const supportedMaxContext = Math.min(profile.maxContext, maxContext);
  return {
    id: profile.id,
    name: profile.displayName,
    size,
    backend: 'ollama',
    installed,
    quantization: profile.quantization,
    maxContext: supportedMaxContext,
    supportedContextPresets: contextPresetsFor(supportedMaxContext),
    supportsTools: profile.supportsTools,
    supportsReasoning,
    shortName: profile.shortName,
  };
}

/** A single output ceiling for every model and reasoning mode. */
export const maxOutputTokens = 32_768;
export const outputSafetyReserveTokens = 512;

export function outputBudget(contextWindow: number, inputTokens: number): number {
  return Math.min(maxOutputTokens, Math.max(0, contextWindow - inputTokens - outputSafetyReserveTokens));
}

/** Ollama's native `think` values exist only for these model families. */
export function supportsOllamaReasoning(profile: ModelProfile): boolean {
  return profile.id.startsWith('qwen3.8:') || profile.id.startsWith('gpt-oss:');
}

/** Maps the UI control to Ollama's documented native `think` parameter. */
export function ollamaReasoning(mode: ReasoningMode, profile: ModelProfile): boolean | string | undefined {
  if (!supportsOllamaReasoning(profile) || mode === 'auto') return undefined;
  return mode === 'fast' ? 'low' : 'high';
}
