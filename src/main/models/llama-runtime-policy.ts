import { existsSync } from 'node:fs';
import { contextPresetsFor } from './model-registry';

export type LlamaSpeculativeMode = 'mtp' | 'eagle3' | 'none';

export type LlamaRuntimeProfile = {
  id: string;
  maxContext: number;
  modelPath?: string;
  mmprojPath?: string;
  speculative: LlamaSpeculativeMode;
  vision: boolean;
  missingArtifact?: string;
};

/** Model capability is separate from the currently loaded server context. */
export const llamaRuntimeProfiles: readonly LlamaRuntimeProfile[] = [
  { id: 'qwen3.8:27b-q4_K_M', maxContext: 262_144, modelPath: '/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf', mmprojPath: '/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf', speculative: 'mtp', vision: true },
  // The installed DeepSeek2 GGUF has no MTP layers. It must not be presented
  // as MTP until a compatible MTP/draft artifact is installed.
  { id: 'glm-4.7-flash:q4_k', maxContext: 131_072, modelPath: '/media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf', speculative: 'none', vision: false, missingArtifact: 'a GLM-4.7-Flash GGUF with MTP layers or a compatible llama.cpp draft model' },
  { id: 'gpt-oss:20b', maxContext: 131_072, speculative: 'eagle3', vision: false, missingArtifact: 'ggml-org/gpt-oss-20b-GGUF and a GGUF conversion of RedHatAI/gpt-oss-20b-speculator.eagle3' },
];

export function llamaRuntimeProfile(id: string): LlamaRuntimeProfile | undefined { return llamaRuntimeProfiles.find((profile) => profile.id === id); }
export function llamaRuntimeInstalled(profile: LlamaRuntimeProfile): boolean { return Boolean(profile.modelPath && existsSync(profile.modelPath)); }
export function llamaContextPresets(id: string, trainedContext?: number): number[] {
  const profile = llamaRuntimeProfile(id);
  return profile ? contextPresetsFor(Math.min(profile.maxContext, trainedContext ?? profile.maxContext)) : [];
}
