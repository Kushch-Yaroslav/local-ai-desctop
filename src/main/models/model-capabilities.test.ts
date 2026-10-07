import assert from 'node:assert/strict';
import { launchProfileEnvironment } from './llama-launch-config';
import { modelRegistry } from './model-registry';
import { agentReasoningOptions, llamaReasoningForInput, llamaRuntimeProfile, llamaRuntimeProfiles, reasoningCapability } from './llama-runtime-policy';
import { reasoningPatchError, resolveReasoningSelection } from '../../shared/reasoning-controls';

const qwen = 'qwen3.8:27b-q4_K_M';
const coderNext = 'qwen3-coder-next:80b-a3b-q4_k_m';
const huihui = 'huihui-qwen3.8:27b-ud-dw-q4_k_m';
const devstral = 'devstral-small-2:24b-q4_k_m';
const gemma = 'gemma4:31b-it-q4_k_m';
const ids = [qwen, coderNext, huihui];
assert.deepEqual(modelRegistry.map((profile) => profile.id), ids);
assert.deepEqual(llamaRuntimeProfiles.map((profile) => profile.id), ids);
assert.notEqual(llamaRuntimeProfile(qwen)?.modelPath, llamaRuntimeProfile(huihui)?.modelPath);
assert.equal(llamaRuntimeProfile(qwen)?.reasoning, llamaRuntimeProfile(huihui)?.reasoning, 'reuse verified family capabilities');
const coderProfile = llamaRuntimeProfile(coderNext);
assert(coderProfile);
assert.equal(coderProfile.maxContext, 262_144);
assert.equal(coderProfile.vision, false);
assert.equal(coderProfile.speculative, 'none', 'this GGUF has no compatible MTP heads');
assert.equal(coderProfile.reasoning, undefined, 'do not invent reasoning controls for a non-thinking checkpoint');
assert.deepEqual(coderProfile.normalContext, { initialContextWindow: 65_536, kvCacheType: 'q8_0' });
assert.deepEqual(coderProfile.placement, { cpuMoeLayers: 28, threads: 8, threadsBatch: 8, batchSize: 1024, ubatchSize: 128, loadMode: 'none' });
assert(coderProfile.hostResidentBudgetBytes! >= 25 * 1024 ** 3, 'CPU-resident weights must be covered by the startup RAM guard');
assert.equal(modelRegistry.find((profile) => profile.id === coderNext)?.supportsTools, true);
assert.equal(modelRegistry.find((profile) => profile.id === coderNext)?.supportsReasoning, false);
assert.deepEqual(reasoningCapability(coderProfile), undefined);
assert.deepEqual(llamaReasoningForInput(coderNext, 'deep'), {}, 'unsupported reasoning strategy must not reach llama.cpp');
assert.equal(launchProfileEnvironment(coderProfile).match(/PROFILE_SERVER_ARGS=.*/)?.[0], "PROFILE_SERVER_ARGS=('--fit' 'off' '--n-cpu-moe' '28' '--threads' '8' '--threads-batch' '8' '--batch-size' '1024' '--ubatch-size' '128' '--load-mode' 'none')");
assert(launchProfileEnvironment(coderProfile).includes("SPECULATIVE_MODE='none'"));
assert(launchProfileEnvironment(coderProfile).includes("DEFAULT_LLAMA_CONTEXT='65536'"));
assert(launchProfileEnvironment(coderProfile).includes("MMPROJ=''"));
for (const obsolete of ['gpt-oss:20b', 'glm-4.7-flash:q4_k']) {
  assert(!ids.includes(obsolete));
  assert.equal(llamaRuntimeProfile(obsolete)?.modelPath, undefined, 'generic support must not pin deleted local files');
  assert(reasoningCapability(llamaRuntimeProfile(obsolete)), 'keep generic family reasoning support');
}
for (const id of [qwen, huihui]) {
  const capability = reasoningCapability(llamaRuntimeProfile(id));
  assert.deepEqual(capability, { thinkingToggle: true, efforts: ['low', 'medium', 'max'] });
  for (const mode of ['fast', 'deep'] as const) {
    assert.deepEqual(llamaReasoningForInput(id, { mode, selection: { thinking: true, effort: 'medium' } }), { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } });
    assert.deepEqual(llamaReasoningForInput(id, { mode, selection: { thinking: true, effort: 'max' } }), { reasoning_effort: 'xhigh', chat_template_kwargs: { enable_thinking: true } });
    assert.deepEqual(llamaReasoningForInput(id, { mode, selection: { thinking: false, effort: 'medium' } }), { chat_template_kwargs: { enable_thinking: false } });
  }
  assert(reasoningPatchError({ reasoningEffort: 'high' }, capability), 'do not invent an extra level');
  assert.deepEqual(agentReasoningOptions(id, { thinking: true, effort: 'medium' })?.main, { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } });
}
// Capability shapes remain generic even after the corresponding local models are removed.
const toggleOnly = reasoningCapability({ id: 'future-toggle-only', maxContext: 262_144, speculative: 'none', vision: false, reasoning: { thinkingKwarg: 'enable_thinking', efforts: {}, final: {} } });
assert.deepEqual(toggleOnly, { thinkingToggle: true, efforts: [] });
assert(reasoningPatchError({ reasoningEffort: 'medium' }, toggleOnly));
assert(reasoningPatchError({ thinkingEnabled: true }, undefined));
for (const mode of ['fast', 'deep'] as const) {
  assert.deepEqual(resolveReasoningSelection(toggleOnly, mode, { thinkingEnabled: false, reasoningEffort: 'max' }), { thinking: false, effort: null });
  assert.deepEqual(llamaReasoningForInput('future-without-reasoning', { mode, selection: { thinking: true, effort: 'max' } }), {});
}
for (const removed of [devstral, gemma]) {
  assert.equal(llamaRuntimeProfile(removed), undefined, 'removed local runtime must not retain deleted paths/capability controls');
  assert(!modelRegistry.some((profile) => profile.id === removed));
}
assert.equal(llamaRuntimeProfile(huihui)?.speculative, 'mtp');
for (const profile of llamaRuntimeProfiles) {
  assert.equal(profile.maxContext, 262_144);
  const launch = launchProfileEnvironment(profile);
  assert(launch.includes(profile.modelPath!));
  if (profile.mmprojPath) assert(launch.includes(profile.mmprojPath));
}
console.log('model capability regression passed (3 local profiles; native controls and strategy independence)');
