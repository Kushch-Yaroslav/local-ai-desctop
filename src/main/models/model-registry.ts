import type { AnalysisDepth, ModelInfo } from '../../shared/types';

export const contextPresets = [16_384, 32_768, 65_536, 131_072, 262_144] as const;
export const ollamaModelsPath = '/media/yaroslav/DATA/ollama';

export type ModelProfile = {
  id: string;
  displayName: string;
  quantization: string;
  maxContext: number;
  supportsTools: boolean;
  supportsThinking: boolean;
  shortName: string;
};

/** The only local models exposed by the desktop client. Tags are pinned to the requested precisions. */
export const modelRegistry: readonly ModelProfile[] = [
  { id: 'qwen3.8:27b-q4_K_M', displayName: 'Qwen3.8-27B', shortName: 'Qwen3.8', quantization: 'Q4_K_M', maxContext: 262_144, supportsTools: true, supportsThinking: true },
  { id: 'glm-4.7-flash:q4_K_M', displayName: 'GLM-4.7-Flash', shortName: 'GLM-4.7', quantization: 'Q4_K_M', maxContext: 202_752, supportsTools: true, supportsThinking: true },
  // The official gpt-oss build keeps its native MXFP4 MoE weights and BF16 tensors; it is not a re-quantized Q4 build.
  { id: 'gpt-oss:20b', displayName: 'gpt-oss-20b', shortName: 'GPT-OSS', quantization: 'MXFP4 / BF16', maxContext: 131_072, supportsTools: true, supportsThinking: true },
];

export function getModelProfile(id: string): ModelProfile | undefined {
  return modelRegistry.find((model) => model.id === id);
}

export function contextPresetsFor(maxContext: number): number[] {
  return contextPresets.filter((preset) => preset <= maxContext);
}

export function modelInfo(profile: ModelProfile, installed: boolean, size?: number, maxContext = profile.maxContext): ModelInfo {
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
    supportsThinking: profile.supportsThinking,
    shortName: profile.shortName,
  };
}

export type InferenceSettings = {
  contextWindow: number;
  depth: AnalysisDepth;
};

export const outputBudgetByReasoningPreset: Record<AnalysisDepth, number> = {
  fast: 4_096,
  normal: 8_192,
  enhanced: 16_384,
  deep: 32_768,
};

export function requestedMaxOutputTokens(depth: AnalysisDepth): number {
  return outputBudgetByReasoningPreset[depth];
}

/** Maps one UI depth control to the native thinking protocol. Output length is applied separately per request. */
export function inferenceSettings(profile: ModelProfile, settings: InferenceSettings, effectiveMaxOutputTokens = requestedMaxOutputTokens(settings.depth)): { think: boolean | string; options: Record<string, number> } {
  const base = { num_ctx: Math.min(settings.contextWindow, profile.maxContext), num_predict: effectiveMaxOutputTokens };
  if (profile.id.startsWith('qwen3.8:')) {
    if (settings.depth === 'fast') return { think: 'low', options: base };
    if (settings.depth === 'normal') return { think: 'medium', options: base };
    // Qwen exposes three native levels. Both higher UI levels use its high reasoning mode.
    return { think: 'high', options: base };
  }
  if (profile.id.startsWith('gpt-oss:')) {
    if (settings.depth === 'fast') return { think: 'low', options: base };
    if (settings.depth === 'normal') return { think: 'medium', options: base };
    // gpt-oss likewise has low/medium/high rather than four distinct native levels.
    return { think: 'high', options: base };
  }
  // GLM exposes thinking as a boolean. Fast remains off; the other presets retain thinking.
  if (settings.depth === 'fast') return { think: false, options: { ...base, temperature: 0.7 } };
  if (settings.depth === 'normal') return { think: true, options: { ...base, temperature: 1 } };
  return { think: true, options: { ...base, temperature: 0.9 } };
}
