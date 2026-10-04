import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database } from './database';
import { buildContextDiscoveryIdentity, contextDiscoveryKey, mergeSavedDiscoveryOptions, stableRuntimeArguments } from './context-discovery-persistence';
import { findFreshContextDiscoveryOption, type ContextDiscoveryOption } from '../../shared/context-estimator';
import { createVramBudget, vramBudgetStillFits } from '../../shared/vram-budget';
import { parseNvidiaGpuIdentity } from './hardware';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const baseArguments = ['/opt/llama-server', '-m', '/models/qwen.gguf', '--host', '127.0.0.1', '--port', '8081', '--ctx-size', '81920', '--gpu-layers', '999',
  '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--kv-offload', '--parallel', '1'];
const identity = (overrides: Partial<Parameters<typeof buildContextDiscoveryIdentity>[0]> = {}) => buildContextDiscoveryIdentity({
  modelId: 'qwen3.8:27b-q4_K_M', modelFingerprint: '16000000000:1700000000000.5', projectorFingerprint: '900000000:1700000000001', runtimeFingerprint: '/opt/llama-server:5000000:1710000000000',
  arguments: baseArguments, speculative: 'mtp', hardLimit: 262_144, gpu: { name: 'NVIDIA GeForce RTX 3090', vramTotalBytes: 24576 * MiB }, hostReserveBytes: 8 * GiB, ...overrides,
});
const key = (overrides?: Parameters<typeof identity>[0]) => contextDiscoveryKey(identity(overrides)).key;

function option(contextWindow: number, kvCacheType: 'f16' | 'q8_0', modelId = 'qwen3.8:27b-q4_K_M', discoveredAt = new Date().toISOString()): ContextDiscoveryOption {
  return { modelId, contextWindow, kvCacheType, kvOffload: true, discoveredAt, memoryBaseline: { hostAvailableBytes: 40 * GiB, deviceAvailableBytes: 3 * GiB },
    measuredHeadroom: { hostBytes: 30 * GiB, deviceBytes: GiB }, boundaryTokens: contextWindow, boundaryReason: 'bounded-search',
    vramBudget: createVramBudget(24 * GiB, 22 * GiB, 2 * GiB, 20 * GiB) };
}
const summary = (options: readonly ContextDiscoveryOption[]) => options.map((item) => `${item.kvCacheType}:${item.contextWindow}`).sort();

export async function runContextDiscoveryPersistenceRegression() {
  const directory = await mkdtemp(join(tmpdir(), 'lad-max-context-'));
  const file = join(directory, 'app.db');
  try {
    const kA = contextDiscoveryKey(identity());
    const model = 'qwen3.8:27b-q4_K_M';

    // Nothing is fabricated when nothing was discovered.
    let database = new Database(file);
    assert.deepEqual(database.loadContextDiscoveryOptions(kA.key, model), []);

    // 1-2. FP16 discovery is saved and restored after a restart without any probing.
    assert.equal(database.saveContextDiscoveryOptions(kA.key, kA.serialized, [option(90_112, 'f16')]), 1);
    database = new Database(file);
    assert.deepEqual(summary(database.loadContextDiscoveryOptions(kA.key, model)), ['f16:90112']);
    assert(database.loadContextDiscoveryOptions(kA.key, model).every((item) => item.restored === true), 'loaded options are marked as restored');

    // 3-4. Q8 is independent and both modes restore their own value after another restart.
    database.saveContextDiscoveryOptions(kA.key, kA.serialized, [option(135_168, 'q8_0')]);
    database = new Database(file);
    assert.deepEqual(summary(database.loadContextDiscoveryOptions(kA.key, model)), ['f16:90112', 'q8_0:135168']);

    // 5. A manual rerun replaces only the mode it established.
    database.saveContextDiscoveryOptions(kA.key, kA.serialized, [option(98_304, 'f16')]);
    database = new Database(file);
    assert.deepEqual(summary(database.loadContextDiscoveryOptions(kA.key, model)), ['f16:98304', 'q8_0:135168']);

    // 6. Failed, empty, partial and garbage results never touch a valid saved value.
    assert.equal(database.saveContextDiscoveryOptions(kA.key, kA.serialized, []), 0);
    const garbage = [{ ...option(0, 'f16') }, { ...option(Number.NaN, 'f16') }, { ...option(8_192, 'f16') }, { ...option(100_001, 'f16') },
      { ...option(65_536, 'f16'), memoryBaseline: { hostAvailableBytes: Number.NaN, deviceAvailableBytes: 0 } }, { ...option(65_536, 'f16'), kvCacheType: 'f32' as 'f16' },
      { ...option(65_536, 'f16'), discoveredAt: 'not a date' }, { ...option(65_536, 'f16'), vramBudget: { totalBytes: -1 } as never }];
    assert.equal(database.saveContextDiscoveryOptions(kA.key, kA.serialized, garbage), 0);
    assert.deepEqual(summary(database.loadContextDiscoveryOptions(kA.key, model)), ['f16:98304', 'q8_0:135168']);
    // A write that fails midway rolls back entirely.
    const poisoned = [option(114_688, 'f16'), { ...option(122_880, 'q8_0'), toJSON() { throw new Error('serialization failed'); } } as ContextDiscoveryOption];
    assert.throws(() => database.saveContextDiscoveryOptions(kA.key, kA.serialized, poisoned), /serialization failed/);
    assert.deepEqual(summary(database.loadContextDiscoveryOptions(kA.key, model)), ['f16:98304', 'q8_0:135168'], 'partial write must roll back');
    // The database stays usable after the rollback.
    assert.equal(database.saveContextDiscoveryOptions(kA.key, kA.serialized, [option(98_304, 'f16')]), 1);

    // Corrupted or inconsistent stored rows are ignored, not trusted and not thrown.
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE context_discoveries SET option='{broken' WHERE kv_cache_type='q8_0'").run();
    assert.deepEqual(summary(new Database(file).loadContextDiscoveryOptions(kA.key, model)), ['f16:98304']);
    raw.prepare("UPDATE context_discoveries SET option=? WHERE kv_cache_type='q8_0'").run(JSON.stringify(option(65_536, 'f16')));
    assert.deepEqual(summary(new Database(file).loadContextDiscoveryOptions(kA.key, model)), ['f16:98304'], 'row/kv mismatch is rejected');
    raw.close();
    database.saveContextDiscoveryOptions(kA.key, kA.serialized, [option(135_168, 'q8_0')]);

    // A tightened model/runtime limit rejects saved values above it.
    assert.deepEqual(summary(database.loadContextDiscoveryOptions(kA.key, model, 100_000)), ['f16:98304']);

    // 7. A different model does not inherit the value.
    const glm = contextDiscoveryKey(identity({ modelId: 'glm-4.7-flash:q4_k', modelFingerprint: '18000000000:1' }));
    assert.notEqual(glm.key, kA.key);
    assert.deepEqual(database.loadContextDiscoveryOptions(glm.key, 'glm-4.7-flash:q4_k'), []);
    assert.deepEqual(database.loadContextDiscoveryOptions(kA.key, 'glm-4.7-flash:q4_k'), [], 'model id is part of the lookup');

    // 8. Material hardware/runtime/model/policy changes yield a different key; restart-stable and KV/port changes do not.
    assert.equal(key(), kA.key);
    assert.equal(key({ arguments: baseArguments.map((value) => value === '81920' ? '131072' : value === 'f16' ? 'q8_0' : value).filter((value) => value !== '--kv-offload') }), kA.key, 'context, KV type and offload select the option, not the configuration');
    assert.equal(key({ arguments: baseArguments.map((value) => value === '8081' ? '9090' : value) }), kA.key, 'listen port is not a calibration input');
    const changed = [
      { gpu: { name: 'NVIDIA GeForce RTX 4090', vramTotalBytes: 24576 * MiB } },
      { gpu: { name: 'NVIDIA GeForce RTX 3090', vramTotalBytes: 16384 * MiB } },
      { runtimeFingerprint: '/opt/llama-server:5000000:1720000000000' },
      { runtimeFingerprint: '/opt/other/llama-server:5000000:1710000000000' },
      { modelFingerprint: '16000000001:1700000000000.5' },
      { modelFingerprint: '16000000000:1800000000000' },
      { projectorFingerprint: null },
      { arguments: [...baseArguments, '--no-mmap'] },
      { arguments: baseArguments.map((value) => value === '1' ? '2' : value) },
      { speculative: 'none' },
      { hardLimit: 131_072 },
      { hostReserveBytes: 12 * GiB },
    ];
    for (const change of changed) assert.notEqual(key(change as never), kA.key, `identity change must not reuse the calibration: ${JSON.stringify(change)}`);
    for (const change of changed) assert.deepEqual(database.loadContextDiscoveryOptions(key(change as never), model), []);
    assert.deepEqual(stableRuntimeArguments(baseArguments), ['/opt/llama-server', '-m', '/models/qwen.gguf', '--gpu-layers', '999', '--parallel', '1']);

    // Merge: the fresh result wins per mode, unestablished modes keep their saved value.
    const saved = database.loadContextDiscoveryOptions(kA.key, model);
    assert.deepEqual(summary(mergeSavedDiscoveryOptions([option(106_496, 'f16')], saved)), ['f16:106496', 'q8_0:135168']);
    assert.deepEqual(summary(mergeSavedDiscoveryOptions([], saved)), ['f16:98304', 'q8_0:135168']);

    // 9. Existing safety still decides on live state; a saved option is not exempt.
    const stale = new Date(Date.now() - 6 * 3600_000).toISOString();
    const fresh = option(98_304, 'f16', model, stale);
    assert.equal(findFreshContextDiscoveryOption([fresh], { modelId: model, contextWindow: 98_304, kvCacheType: 'f16', kvOffload: true }), null, 'a measured result still expires');
    const restored = database.loadContextDiscoveryOptions(kA.key, model).find((item) => item.kvCacheType === 'f16')!;
    assert(findFreshContextDiscoveryOption([restored], { modelId: model, contextWindow: 98_304, kvCacheType: 'f16', kvOffload: true }), 'a saved option is selectable after a restart');
    assert.equal(findFreshContextDiscoveryOption([restored], { modelId: model, contextWindow: 106_496, kvCacheType: 'f16', kvOffload: true }), null, 'never above the saved Max');
    assert.equal(findFreshContextDiscoveryOption([restored], { modelId: model, contextWindow: 65_536, kvCacheType: 'q8_0', kvOffload: true }), null, 'other KV mode needs its own result');
    assert.equal(findFreshContextDiscoveryOption([restored], { modelId: 'other', contextWindow: 65_536, kvCacheType: 'f16', kvOffload: true }), null);
    const budget = restored.vramBudget!;
    assert.equal(vramBudgetStillFits(budget, createVramBudget(24 * GiB, 22 * GiB, 2 * GiB, 20 * GiB)), true);
    assert.equal(vramBudgetStillFits(budget, createVramBudget(24 * GiB, 23 * GiB, 0.5 * GiB, 20 * GiB)), false, 'a new non-LLM VRAM consumer still invalidates a saved option');
    assert.equal(vramBudgetStillFits(budget, createVramBudget(16 * GiB, 14 * GiB, 1 * GiB, 12 * GiB)), false, 'a different GPU size still invalidates');

    // GPU identity parsing keeps names containing commas and rejects multi-GPU hosts.
    assert.deepEqual(parseNvidiaGpuIdentity('NVIDIA GeForce RTX 3090, 24576\n'), { name: 'NVIDIA GeForce RTX 3090', vramTotalBytes: 24576 * MiB });
    assert.equal(parseNvidiaGpuIdentity('A, 1\nB, 2'), null);
    assert.equal(parseNvidiaGpuIdentity(''), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) void runContextDiscoveryPersistenceRegression().catch((error) => { console.error(error); process.exitCode = 1; });
