import assert from 'node:assert/strict';
import { launchProfileEnvironment } from './llama-launch-config';
import { modelRegistry } from './model-registry';
import { agentReasoningOptions, llamaReasoningForInput, llamaRuntimeProfile, llamaRuntimeProfiles, reasoningCapability } from './llama-runtime-policy';
import { reasoningPatchError, resolveReasoningSelection } from '../../shared/reasoning-controls';

const qwen = 'qwen3.8:27b-q4_K_M';
const huihui = 'huihui-qwen3.8:27b-ud-dw-q4_k_m';
const devstral = 'devstral-small-2:24b-q4_k_m';
const gemma = 'gemma4:31b-it-q4_k_m';
const ids = [qwen, huihui];
assert.deepEqual(modelRegistry.map((profile) => profile.id), ids);
assert.deepEqual(llamaRuntimeProfiles.map((profile) => profile.id), ids);
assert.notEqual(llamaRuntimeProfile(qwen)?.modelPath, llamaRuntimeProfile(huihui)?.modelPath);
assert.equal(llamaRuntimeProfile(qwen)?.reasoning, llamaRuntimeProfile(huihui)?.reasoning, 'reuse verified family capabilities');
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
  assert(launch.includes(profile.mmprojPath!));
}
console.log('model capability regression passed (2 local profiles; native controls and strategy independence)');
