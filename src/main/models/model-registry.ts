import type { ModelInfo } from '../../shared/types';
import { builtinModelCatalog, contextPresets } from './model-catalog';
import { effectiveRuntimeConfiguration } from '../services/runtime-settings';

export { contextPresets } from './model-catalog';
export type ModelProfile = Omit<(typeof builtinModelCatalog)[number], 'modelPath' | 'mmprojPath'>;

/** Stable built-in profiles retain the verified capabilities used by old chats. */
export const modelRegistry: readonly ModelProfile[] = builtinModelCatalog.map((profile) => ({
  id: profile.id, displayName: profile.displayName, shortName: profile.shortName, quantization: profile.quantization,
  maxContext: profile.maxContext, supportsTools: profile.supportsTools, supportsReasoning: profile.supportsReasoning,
}));

/** The persisted settings file is the one live registry, including user-added GGUFs. */
export function registeredModelProfiles(config = effectiveRuntimeConfiguration()): ModelProfile[] {
  const known = new Map(modelRegistry.map((profile) => [profile.id, profile]));
  return config.models.map((configured) => {
    const builtin = known.get(configured.id);
    if (builtin) return { ...builtin, displayName: configured.displayName, shortName: configured.displayName };
    return { id: configured.id, displayName: configured.displayName, shortName: configured.displayName,
      quantization: 'GGUF', maxContext: 32_768, supportsTools: configured.supportsTools, supportsReasoning: false };
  });
}

/** External generic API model metadata retained for non-local adapters. */
const genericModelProfiles: readonly ModelProfile[] = [
  { id: 'gpt-oss:20b', displayName: 'gpt-oss-20b', shortName: 'GPT-OSS', quantization: 'MXFP4 / BF16', maxContext: 131_072, supportsTools: true, supportsReasoning: true },
  { id: 'glm-4.7-flash:q4_k', displayName: 'GLM-4.7-Flash', shortName: 'GLM-4.7-Flash', quantization: 'Q4_K', maxContext: 131_072, supportsTools: true, supportsReasoning: true },
];

export function getModelProfile(id: string, config?: ReturnType<typeof effectiveRuntimeConfiguration>): ModelProfile | undefined {
  return registeredModelProfiles(config).find((model) => model.id === id) ?? genericModelProfiles.find((model) => model.id === id);
}

export function contextPresetsFor(maxContext: number): number[] {
  return contextPresets.filter((preset) => preset <= maxContext);
}

export function modelInfo(profile: ModelProfile, installed: boolean, size?: number, maxContext = profile.maxContext, supportsReasoning = profile.supportsReasoning): ModelInfo {
  const supportedMaxContext = Math.min(profile.maxContext, maxContext);
  return { id: profile.id, name: profile.displayName, size, backend: 'llama-cpp', installed,
    quantization: profile.quantization, maxContext: supportedMaxContext, supportedContextPresets: contextPresetsFor(supportedMaxContext),
    supportsTools: profile.supportsTools, supportsReasoning, shortName: profile.shortName };
}

export const maxOutputTokens = 32_768;
export const outputSafetyReserveTokens = 512;
export function outputBudget(contextWindow: number, inputTokens: number): number {
  return Math.min(maxOutputTokens, Math.max(0, contextWindow - inputTokens - outputSafetyReserveTokens));
}
