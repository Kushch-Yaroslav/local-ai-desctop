import assert from 'node:assert/strict';
import { buildContextChoices, contextChoiceId, normalContextForModel, normalContextPatch, resolveLlamaKvSelection } from './context-options';
import type { ContextDiscoveryOption } from './context-estimator';
import { llamaContextPresets } from '../main/models/llama-runtime-policy';

const qwen = 'qwen3.8:27b-q4_K_M';
const glm = 'glm-4.7-flash:q4_k';
const option = (modelId: string, contextWindow: number, kvCacheType: 'f16' | 'q8_0'): ContextDiscoveryOption => ({
  modelId, contextWindow, kvCacheType, kvOffload: true, discoveredAt: new Date().toISOString(),
  memoryBaseline: { hostAvailableBytes: 50, deviceAvailableBytes: 24 }, measuredHeadroom: { hostBytes: 10, deviceBytes: 3 },
});

export function runContextOptionsRegression() {
  assert.deepEqual(llamaContextPresets(qwen), [16384, 32768, 65536, 131072, 262144]);
  assert.deepEqual(llamaContextPresets(glm), [16384, 32768, 65536, 131072]);
  assert.deepEqual(llamaContextPresets(qwen, 65536), [16384, 32768, 65536], 'only trained/backend capability may reduce normal presets');
  for (const model of [qwen, glm]) {
    const normal = llamaContextPresets(model);
    const limit = normal.at(-1)!;
    const before = buildContextChoices(model, normal, limit, []);
    const after = buildContextChoices(model, normal, limit, [option(model, 24576, 'f16'), option(model, 57344, 'q8_0')]);
    for (const choice of before) assert(after.some((candidate) => contextChoiceId(candidate) === contextChoiceId(choice)), 'hardware discovery truncated a normal choice');
    assert.equal(after.length, before.length + 2);
    const equal = buildContextChoices(model, normal, limit, [option(model, 65536, 'f16')]);
    assert.equal(equal.length, before.length, 'identical configuration/context must be annotated, not duplicated');
    assert.match(equal.find((candidate) => candidate.contextWindow === 65536)!.label, /FP16/);
    assert.deepEqual(buildContextChoices(model, normal, limit, [option('other-model', 24576, 'q8_0'), option(model, limit + 4096, 'f16')]), before, 'wrong-model and above-capability evidence was reused');
    assert.deepEqual(buildContextChoices(model, normal, limit, []), before, 'failed discovery must preserve all normal options');
  }
  const current = { llamaKvCacheType: 'q8_0' as const, llamaKvOffload: false };
  assert.deepEqual(resolveLlamaKvSelection(current, { contextWindow: 65536 }, false), { llamaKvCacheType: 'f16', llamaKvOffload: true });
  assert.deepEqual(resolveLlamaKvSelection(current, {}, true), { llamaKvCacheType: 'f16', llamaKvOffload: true }, 'model change must discard the previous cache override');
  assert.deepEqual(resolveLlamaKvSelection(current, {}, false), current, 'non-runtime edits must preserve the selected configuration');
  assert.deepEqual(normalContextPatch(65536), { contextWindow: 65536, llamaKvCacheType: 'f16', llamaKvOffload: true });
  assert.equal(normalContextForModel(106496, llamaContextPresets(glm)), 65536, 'model change must replace an unverified custom context with a normal target-model preset');
  assert.equal(normalContextForModel(262144, llamaContextPresets(glm)), 131072, 'model change must respect the new model capability');
  assert.equal(normalContextForModel(16384, llamaContextPresets(qwen)), 16384);
}

if (require.main === module) runContextOptionsRegression();
