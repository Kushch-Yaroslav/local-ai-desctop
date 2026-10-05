import { existsSync } from 'node:fs';
import { contextPresetsFor } from './model-registry';
import { legacyReasoningSelection, reasoningEffortOrder, resolveReasoningSelection, type ReasoningCapability, type ReasoningEffort, type ReasoningInput, type ReasoningSelection } from '../../shared/reasoning-controls';

export type LlamaSpeculativeMode = 'mtp' | 'eagle3' | 'none';
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
  vision: boolean;
  reasoning?: LlamaReasoningProfile;
};

/** Model capability is separate from the currently loaded server context. */
export const llamaRuntimeProfiles: readonly LlamaRuntimeProfile[] = [
  { id: 'qwen3.8:27b-q4_K_M', maxContext: 262_144, modelPath: '/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf', mmprojPath: '/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf', speculative: 'mtp', vision: true, reasoning: { thinkingKwarg: 'enable_thinking', efforts: { low: 'low', medium: 'medium', max: 'xhigh' }, final: { chat_template_kwargs: { enable_thinking: false } } } },
  // The installed DeepSeek2 GGUF has no MTP layers. It must not be presented
  // as MTP until a compatible MTP/draft artifact is installed.
  { id: 'glm-4.7-flash:q4_k', maxContext: 131_072, modelPath: '/media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf', speculative: 'none', vision: false, reasoning: { thinkingKwarg: 'enable_thinking', efforts: { low: 'low', max: 'xhigh' }, final: { chat_template_kwargs: { enable_thinking: false } } } },
  { id: 'gpt-oss:20b', maxContext: 131_072, modelPath: '/media/yaroslav/DATA/llama-models/gpt-oss-20b-MXFP4.gguf', speculative: 'none', vision: false, reasoning: { efforts: { low: 'low', medium: 'medium', high: 'high' }, final: { reasoning_effort: 'low' } } },
];

export function llamaRuntimeProfile(id: string): LlamaRuntimeProfile | undefined { return llamaRuntimeProfiles.find((profile) => profile.id === id); }
export function llamaRuntimeInstalled(profile: LlamaRuntimeProfile): boolean { return Boolean(profile.modelPath && existsSync(profile.modelPath)); }
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
