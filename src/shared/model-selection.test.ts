import assert from 'node:assert/strict';
import { activeConversationModel, initialModelContext } from './model-selection';
import { llamaRuntimeProfiles } from '../main/models/llama-runtime-policy';
import { effectiveSpeculativeMode } from '../main/models/llama-launch-config';

for (const profile of llamaRuntimeProfiles) {
  const stored = { modelId: profile.id };
  for (const status of ['idle', 'offline', 'stopped', 'starting', 'switching'] as const) {
    assert.equal(activeConversationModel(stored, { status, modelId: profile.id, contextWindow: 81_920 }), null);
  }
  assert.equal(activeConversationModel(stored, undefined), null, 'history alone must not select a model');
  const selected = { status: 'ready' as const, modelId: profile.id, contextWindow: 32_768 };
  assert.equal(activeConversationModel(stored, selected), profile.id, 'explicit ready selection must work for every registered family');
  assert.equal(activeConversationModel({ modelId: 'another-history-model' }, selected), null, 'opening another history cannot select or switch models');
  assert.equal(activeConversationModel(stored, { status: 'idle', modelId: null, contextWindow: null }), null, 'restart forgets selection, not history');
}
assert.deepEqual(initialModelContext([16_384, 32_768, 65_536, 131_072]), { contextWindow: 32_768, llamaKvCacheType: 'f16', llamaKvOffload: true });
assert.equal(initialModelContext([4_096, 8_192]).contextWindow, 8_192, 'respect a lower model ceiling');
assert.deepEqual(llamaRuntimeProfiles.map((profile) => effectiveSpeculativeMode(profile, undefined)), ['mtp', 'mtp']);
console.log('model startup/history/explicit selection regressions passed (installed models, all non-ready states, restart, ceiling and MTP)');
