import { existsSync } from 'node:fs';
import { modelPaths } from '../services/runtime-settings';
import { ggufArtifactPaths } from '../services/gguf-artifacts';
import type { ModelInfo } from '../../shared/types';
import { contextPresetsFor } from './model-registry';
import { legacyReasoningSelection, reasoningEffortOrder, resolveReasoningSelection, type ReasoningCapability, type ReasoningEffort, type ReasoningInput, type ReasoningSelection } from '../../shared/reasoning-controls';

export type LlamaSpeculativeMode = 'mtp' | 'eagle3' | 'none';
/** An authoritative external assistant, pinned independently of the main GGUF. */
export type LlamaDraftProfile = {
  path: string;
  sizeBytes: number;
  sha256: string;
  architecture: string;
  targetArchitecture: string;
  targetEmbeddingLength: number;
  kvCache: 'shared' | 'independent';
  maxDraftTokens: number;
};
/**
 * How a model exposes reasoning to llama.cpp. `thinkingKwarg` is the chat-template switch that turns thinking on or off
 * (absent when the model cannot be told not to think); `efforts` maps normalized levels to native `reasoning_effort`
 * values and its keys are exactly the levels the model supports. `final` is used for the tool-free closing turn.
 */
export type LlamaReasoningProfile = {
  thinkingKwarg?: 'enable_thinking';
  efforts: Partial<Record<ReasoningEffort, string>>;
  final: Record<string, unknown>;
};

export type LlamaRuntimeProfile = {
  id: string;
  maxContext: number;
  modelPath?: string;
  mmprojPath?: string;
  speculative: LlamaSpeculativeMode;
  /** Maximum tokens proposed per step by an embedded MTP head. */
  speculativeDraftTokens?: number;
  /** Whether this runtime can load its vision projector while MTP is active. */
  visionWithMtp?: boolean;
  draft?: LlamaDraftProfile;
  vision: boolean;
  reasoning?: LlamaReasoningProfile;
  /** Measured per-runtime placement; absent keeps the existing fully offloaded launch unchanged. */
  placement?: {
    cpuMoeLayers: number;
    threads: number;
    threadsBatch: number;
    batchSize: number;
    ubatchSize: number;
    loadMode: 'auto' | 'mmap' | 'none';
  };
  /** Conservative host allocation envelope, excluding the existing discovery host reserve. */
  hostResidentBudgetBytes?: number;
  normalContext?: ModelInfo['normalContext'];
};

/** Verified in both embedded Qwen templates: the Huihui high alias adds no separate effort level. */
const qwen38Reasoning: LlamaReasoningProfile = { thinkingKwarg: 'enable_thinking', efforts: { low: 'low', medium: 'medium', max: 'xhigh' }, final: { chat_template_kwargs: { enable_thinking: false } } };

/** Model capability is separate from the currently loaded server context. */
export const llamaRuntimeProfiles: readonly LlamaRuntimeProfile[] = [
  { id: 'qwen3.8:27b-q4_K_M', maxContext: 262_144, get modelPath() { return modelPaths(this.id).modelPath; }, get mmprojPath() { return modelPaths(this.id).mmprojPath; }, speculative: 'mtp', vision: true, visionWithMtp: true, reasoning: qwen38Reasoning },
  {
    id: 'qwen3.6:35b-a3b-ud-q4_k_m',
    maxContext: 262_144,
    get modelPath() { return modelPaths(this.id).modelPath; },
    get mmprojPath() { return modelPaths(this.id).mmprojPath; },
    speculative: 'mtp',
    speculativeDraftTokens: 2,
    vision: true,
    visionWithMtp: false,
    reasoning: { thinkingKwarg: 'enable_thinking', efforts: {}, final: { chat_template_kwargs: { enable_thinking: false } } },
    placement: { cpuMoeLayers: 4, threads: 8, threadsBatch: 8, batchSize: 1024, ubatchSize: 128, loadMode: 'none' },
    hostResidentBudgetBytes: 8 * 1024 ** 3,
    normalContext: { initialContextWindow: 65_536, kvCacheType: 'q8_0' },
  },
  { id: 'huihui-qwen3.8:27b-ud-dw-q4_k_m', maxContext: 262_144, get modelPath() { return modelPaths(this.id).modelPath; }, get mmprojPath() { return modelPaths(this.id).mmprojPath; }, speculative: 'mtp', vision: true, visionWithMtp: true, reasoning: qwen38Reasoning },

];

/** Generic families have no pinned local files after removal. */
const genericRuntimeProfiles: readonly LlamaRuntimeProfile[] = [
  // Generic GLM support does not assume an installed MTP/draft artifact.
  { id: 'glm-4.7-flash:q4_k', maxContext: 131_072, speculative: 'none', vision: false, reasoning: { thinkingKwarg: 'enable_thinking', efforts: { low: 'low', max: 'xhigh' }, final: { chat_template_kwargs: { enable_thinking: false } } } },
  { id: 'gpt-oss:20b', maxContext: 131_072, speculative: 'none', vision: false, reasoning: { efforts: { low: 'low', medium: 'medium', high: 'high' }, final: { reasoning_effort: 'low' } } },
];

export function llamaRuntimeProfile(id: string): LlamaRuntimeProfile | undefined { return [...llamaRuntimeProfiles, ...genericRuntimeProfiles].find((profile) => profile.id === id); }
export function llamaRuntimeInstalled(profile: LlamaRuntimeProfile): boolean { return Boolean(profile.modelPath && ggufArtifactPaths(profile.modelPath).every((path) => existsSync(path))); }
export function llamaContextPresets(id: string, trainedContext?: number): number[] {
  const profile = llamaRuntimeProfile(id);
  return profile ? contextPresetsFor(Math.min(profile.maxContext, trainedContext ?? profile.maxContext)) : [];
}

export function reasoningCapability(profile: LlamaRuntimeProfile | undefined): ReasoningCapability | undefined {
  const reasoning = profile?.reasoning;
  if (!reasoning) return undefined;
  return { thinkingToggle: reasoning.thinkingKwarg !== undefined, efforts: reasoningEffortOrder.filter((effort) => reasoning.efforts[effort] !== undefined) };
}

/**
 * The request fragment for a resolved selection. With thinking off no effort is sent: effort only has meaning while the
 * model thinks. Controls the model lacks contribute nothing, so an unsupported setting can never reach llama.cpp.
 */
export function llamaReasoningFragment(model: string, selection: ReasoningSelection): Record<string, unknown> {
  const reasoning = llamaRuntimeProfile(model)?.reasoning;
  if (!reasoning) return {};
  const toggle = reasoning.thinkingKwarg;
  if (toggle && selection.thinking === false) return { chat_template_kwargs: { [toggle]: false } };
  const native = selection.effort ? reasoning.efforts[selection.effort] : undefined;
  return { ...(native === undefined ? {} : { reasoning_effort: native }), ...(toggle ? { chat_template_kwargs: { [toggle]: true } } : {}) };
}

/** A bare strategy (callers without a per-conversation choice, e.g. Fast/Deep in tests) keeps its historical meaning. */
export function llamaReasoningForInput(model: string, input: ReasoningInput): Record<string, unknown> {
  const profile = llamaRuntimeProfile(model);
  const capability = reasoningCapability(profile);
  if (!capability) return {};
  if (typeof input === 'string') {
    if (input === 'auto') return {};
    return llamaReasoningFragment(model, legacyReasoningSelection(capability, input));
  }
  return llamaReasoningFragment(model, resolveReasoningSelection(capability, input.mode, { thinkingEnabled: input.selection.thinking, reasoningEffort: input.selection.effort }));
}

/** The Agent runtime picks `main` for working turns and `final` for the tool-free closing turn. */
export function agentReasoningOptions(model: string, selection: ReasoningSelection): Record<string, Record<string, unknown>> | undefined {
  const reasoning = llamaRuntimeProfile(model)?.reasoning;
  if (!reasoning) return undefined;
  return { main: llamaReasoningFragment(model, selection), final: reasoning.final };
}
