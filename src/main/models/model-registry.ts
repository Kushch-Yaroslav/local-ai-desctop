import type { ModelInfo } from '../../shared/types';

export const contextPresets = [16_384, 32_768, 65_536, 131_072, 262_144] as const;

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
  { id: 'qwen3-coder-next:80b-a3b-q4_k_m', displayName: 'Qwen3-Coder-Next 80B-A3B', shortName: 'Qwen3 Coder Next', quantization: 'Q4_K_M', maxContext: 262_144, supportsTools: true, supportsReasoning: false },
  { id: 'huihui-qwen3.8:27b-ud-dw-q4_k_m', displayName: 'Huihui Qwen3.8-27B (abliterated)', shortName: 'Huihui Qwen3.8', quantization: 'UD-DW-Q4_K_M', maxContext: 262_144, supportsTools: true, supportsReasoning: true },
];

/** Generic family support retained for externally configured runtimes; these are not local installed entries. */
const genericModelProfiles: readonly ModelProfile[] = [
  // The official gpt-oss build keeps its native MXFP4 MoE weights and BF16 tensors; it is not a re-quantized Q4 build.
  { id: 'gpt-oss:20b', displayName: 'gpt-oss-20b', shortName: 'GPT-OSS', quantization: 'MXFP4 / BF16', maxContext: 131_072, supportsTools: true, supportsReasoning: true },
  { id: 'glm-4.7-flash:q4_k', displayName: 'GLM-4.7-Flash', shortName: 'GLM-4.7-Flash', quantization: 'Q4_K', maxContext: 131_072, supportsTools: true, supportsReasoning: true },
];

export function getModelProfile(id: string): ModelProfile | undefined {
  return [...modelRegistry, ...genericModelProfiles].find((model) => model.id === id);
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
    backend: 'llama-cpp',
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
