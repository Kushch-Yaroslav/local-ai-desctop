import assert from 'node:assert/strict';
import { effectiveReasoning, pinLegacyReasoning } from './conversation-settings';
import { effortApplies, legacyReasoningSelection, reasoningPatchError, resolveReasoningSelection, sameReasoningInput, type ReasoningCapability } from './reasoning-controls';
import { reasoningCapability, llamaRuntimeProfile, agentReasoningOptions, llamaReasoningFragment } from '../main/models/llama-runtime-policy';
import type { Conversation } from './types';

const qwen: ReasoningCapability = { thinkingToggle: true, efforts: ['low', 'medium', 'max'] };
const glm: ReasoningCapability = { thinkingToggle: true, efforts: ['low', 'max'] };
const gptOss: ReasoningCapability = { thinkingToggle: false, efforts: ['low', 'medium', 'high'] };
const stored = (overrides: Partial<Conversation> = {}) => ({ reasoningMode: 'fast' as const, thinkingEnabled: null, reasoningEffort: null, ...overrides });

export function runReasoningControlsRegression(): void {
  // The three controls are independent: strategy never moves thinking or effort once they are chosen.
  assert.deepEqual(resolveReasoningSelection(qwen, 'deep', { thinkingEnabled: true, reasoningEffort: 'medium' }), { thinking: true, effort: 'medium' });
  assert.deepEqual(resolveReasoningSelection(qwen, 'fast', { thinkingEnabled: true, reasoningEffort: 'medium' }), { thinking: true, effort: 'medium' });
  assert.deepEqual(resolveReasoningSelection(qwen, 'deep', { thinkingEnabled: true, reasoningEffort: 'low' }), { thinking: true, effort: 'low' });
  assert.deepEqual(resolveReasoningSelection(qwen, 'fast', { thinkingEnabled: false, reasoningEffort: 'max' }), { thinking: false, effort: 'max' });

  // Legacy conversations (nothing stored) keep their old meaning: thinking on, Fast = lowest, Deep = highest supported.
  assert.deepEqual(resolveReasoningSelection(qwen, 'fast'), { thinking: true, effort: 'low' });
  assert.deepEqual(resolveReasoningSelection(qwen, 'deep'), { thinking: true, effort: 'max' });
  assert.deepEqual(resolveReasoningSelection(gptOss, 'deep'), { thinking: null, effort: 'high' }, 'Deep must not select a level the model lacks');
  assert.deepEqual(legacyReasoningSelection(glm, 'deep'), { thinking: true, effort: 'max' });

  // Controls a model lacks are reported as absent, never as off, and stored values for them are ignored.
  assert.deepEqual(resolveReasoningSelection(gptOss, 'fast', { thinkingEnabled: false, reasoningEffort: 'medium' }), { thinking: null, effort: 'medium' });
  assert.deepEqual(resolveReasoningSelection({ thinkingToggle: false, efforts: [] }, 'deep', { thinkingEnabled: true, reasoningEffort: 'high' }), { thinking: null, effort: null });
  assert.deepEqual(resolveReasoningSelection(undefined, 'deep'), { thinking: null, effort: null });

  // Switching models: an effort the new model lacks is clamped to the nearest level, ties going lower.
  assert.equal(resolveReasoningSelection(glm, 'fast', { thinkingEnabled: true, reasoningEffort: 'medium' }).effort, 'low');
  assert.equal(resolveReasoningSelection(glm, 'fast', { thinkingEnabled: true, reasoningEffort: 'high' }).effort, 'max');
  assert.equal(resolveReasoningSelection(gptOss, 'fast', { thinkingEnabled: true, reasoningEffort: 'max' }).effort, 'high');
  assert.equal(effortApplies({ thinking: false, effort: 'max' }), false, 'effort has no effect while thinking is off');
  assert.equal(effortApplies({ thinking: null, effort: 'high' }), true);

  // Patch validation is capability-aware and in Russian.
  assert.equal(reasoningPatchError({ thinkingEnabled: false, reasoningEffort: 'medium' }, qwen), null);
  assert.match(reasoningPatchError({ thinkingEnabled: false }, gptOss) ?? '', /не позволяет/);
  assert.match(reasoningPatchError({ reasoningEffort: 'high' }, qwen) ?? '', /не поддерживает/);
  assert.match(reasoningPatchError({ reasoningEffort: 'turbo' }, qwen) ?? '', /Некорректное/);
  assert.match(reasoningPatchError({ thinkingEnabled: 'yes' }, qwen) ?? '', /Некорректное/);
  assert.equal(reasoningPatchError({ thinkingEnabled: null, reasoningEffort: null }, gptOss), null, 'resetting to legacy is always allowed');

  // The first strategy change pins the legacy-derived values so the strategy cannot silently move them.
  assert.deepEqual(pinLegacyReasoning(stored(), qwen, { reasoningMode: 'deep' }), { thinkingEnabled: true, reasoningEffort: 'low', reasoningMode: 'deep' });
  assert.deepEqual(pinLegacyReasoning(stored({ reasoningMode: 'deep' }), qwen, { reasoningMode: 'fast' }), { thinkingEnabled: true, reasoningEffort: 'max', reasoningMode: 'fast' });
  assert.deepEqual(pinLegacyReasoning(stored({ thinkingEnabled: false, reasoningEffort: 'medium' }), qwen, { reasoningMode: 'deep' }), { reasoningMode: 'deep' }, 'explicit choices are never overwritten');
  assert.deepEqual(pinLegacyReasoning(stored(), qwen, { reasoningEffort: 'medium', reasoningMode: 'deep' }), { thinkingEnabled: true, reasoningEffort: 'medium', reasoningMode: 'deep' });
  assert.deepEqual(pinLegacyReasoning(stored(), gptOss, { reasoningMode: 'deep' }), { reasoningEffort: 'low', reasoningMode: 'deep' });
  assert.deepEqual(pinLegacyReasoning(stored(), undefined, { reasoningMode: 'deep' }), { reasoningMode: 'deep' });

  // The Context panel reports confirmed values and a pending target separately.
  const confirmed = { reasoningMode: 'fast' as const, mode: 'agent' as const, thinkingEnabled: true, reasoningEffort: 'low' as const };
  assert.deepEqual(effectiveReasoning(stored(confirmed), qwen), { supported: true, thinking: true, effort: 'low', effortApplies: true, pendingThinking: null, pendingEffort: null });
  assert.deepEqual(effectiveReasoning(stored({ ...confirmed, reasoningEffort: 'max' }), qwen, { effective: confirmed, desired: { reasoningEffort: 'max' } }), { supported: true, thinking: true, effort: 'low', effortApplies: true, pendingThinking: null, pendingEffort: 'max' });
  assert.equal(effectiveReasoning(stored({ thinkingEnabled: false, reasoningEffort: 'medium' }), qwen).effortApplies, false);
  assert.equal(effectiveReasoning(stored(), undefined).supported, false);

  assert.equal(sameReasoningInput('deep', 'deep'), true);
  assert.equal(sameReasoningInput('deep', { mode: 'deep', selection: { thinking: true, effort: 'low' } }), false);
  assert.equal(sameReasoningInput({ mode: 'deep', selection: { thinking: true, effort: 'low' } }, { mode: 'deep', selection: { thinking: true, effort: 'low' } }), true);
  assert.equal(sameReasoningInput({ mode: 'deep', selection: { thinking: true, effort: 'low' } }, { mode: 'deep', selection: { thinking: true, effort: 'medium' } }), false, 'a changed effort must invalidate a prepared prompt');

  // Capabilities come from the model profile; native values stay in the main process.
  assert.deepEqual(reasoningCapability(llamaRuntimeProfile('qwen3.8:27b-q4_K_M')), { thinkingToggle: true, efforts: ['low', 'medium', 'max'] });
  assert.deepEqual(reasoningCapability(llamaRuntimeProfile('gpt-oss:20b')), { thinkingToggle: false, efforts: ['low', 'medium', 'high'] });
  assert.equal(reasoningCapability(undefined), undefined);
  assert.deepEqual(llamaReasoningFragment('qwen3.8:27b-q4_K_M', { thinking: true, effort: 'medium' }), { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(llamaReasoningFragment('qwen3.8:27b-q4_K_M', { thinking: false, effort: 'medium' }), { chat_template_kwargs: { enable_thinking: false } });
  const options = agentReasoningOptions('qwen3.8:27b-q4_K_M', { thinking: true, effort: 'medium' });
  assert.deepEqual(options?.main, { reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } }, 'the Agent main turn must carry the explicit selection');
  assert.ok(options?.final, 'the finalizing turn keeps its own profile');
  assert.equal(agentReasoningOptions('unknown-model', { thinking: true, effort: 'low' }), undefined);
}

if (require.main === module) { try { runReasoningControlsRegression(); } catch (error) { console.error(error); process.exitCode = 1; } }
