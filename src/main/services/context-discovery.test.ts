import assert from 'node:assert/strict';
import { discoverContextBoundary, predictContextHeadroom, type DiscoveryProbe } from './context-discovery';
import type { RuntimeContextEstimate } from '../../shared/context-estimator';

const GiB = 1024 ** 3;
function fixture(context: number, mode: 'f16' | 'q8_0', phase: 'base' | 'search' | 'final'): DiscoveryProbe {
  const kv = context * (mode === 'f16' ? 64 * 1024 : 34 * 1024);
  const headroom = { hostBytes: 40 * GiB, deviceBytes: 7 * GiB - kv };
  const estimate: RuntimeContextEstimate = {
    backend: 'llama-cpp', modelId: 'model', configuredMaxTokens: 262144, modelTrainContextTokens: 262144,
    observedContextTokens: context, modelFileSizeBytes: 10 * GiB, observedResidentBytes: null, observedDeviceResidentBytes: null,
    hardwareSafeTokens: 262144, activeKvCacheType: mode, activeKvOffload: true, memoryBaseline: { hostAvailableBytes: 50 * GiB, deviceAvailableBytes: 24 * GiB },
    memoryHeadroom: headroom, status: 'estimated', source: 'startup-log', unknownReasons: [], estimator: null,
    allocationEvidence: { contextTokens: context, sequenceSlots: 1, speculativeSlots: 1, speculativeMode: 'mtp',
      kvTypeK: mode, kvTypeV: mode, speculativeKvTypeK: mode, speculativeKvTypeV: mode, unknownReasons: [],
      allocations: { weights: { device: 10 * GiB }, compute: { device: 0 }, output: { device: 0 }, kv: { device: kv }, speculativeWeights: { device: 0 }, speculativeCompute: { device: 0 }, speculativeKv: { device: 0 }, ssm: { device: 0 } } },
  };
  return { estimate, record: { contextWindow: context, kvCacheType: mode, phase, startup: true, health: true, inference: true, fits: false, headroom, memoryBaseline: estimate.memoryBaseline, elapsedMs: 1 } };
}

export async function runContextDiscoveryRegression() {
  let restored = 0;
  const result = await discoverContextBoundary({ modelId: 'model', hardLimit: 262144, kvOffload: true, hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
    probe: async (context, mode, phase) => fixture(context, mode, phase), restore: async () => { restored += 1; }, progress: () => undefined });
  assert.equal(restored, 1);
  assert.equal(result.restored, true);
  assert(result.options[0].contextWindow >= 65536, 'search regressed to an arbitrary conservative 32K result');
  assert(result.options[1].contextWindow >= result.options[0].contextWindow + 8192);
  for (const option of result.options) {
    const record = result.probes!.find((probe) => probe.contextWindow === option.contextWindow && probe.kvCacheType === option.kvCacheType && probe.inference);
    assert(record, 'offered maximum was never inferred at the exact candidate context');
    assert(option.measuredHeadroom.deviceBytes >= 2 * GiB);
    assert(result.probes!.filter((probe) => probe.kvCacheType === option.kvCacheType && probe.startup).length <= 9, 'discovery exceeded its bounded startup budget');
  }
  assert(result.probes!.some((probe) => !probe.startup && probe.reason?.includes('Skipped')), 'predicted unsafe candidates must be rejected without startup');
  await assert.rejects(discoverContextBoundary({ modelId: 'model', hardLimit: 131072, kvOffload: true, hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
    probe: async () => { throw new Error('fatal probe'); }, restore: async () => { restored += 1; }, progress: () => undefined }), /fatal probe/);
  assert.equal(restored, 2, 'fatal discovery must still restore');
  await assert.rejects(discoverContextBoundary({ modelId: 'model', hardLimit: 131072, kvOffload: true, hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
    probe: async (context, mode, phase) => fixture(context, mode, phase), restore: async () => { throw new Error('restore failed'); }, progress: () => undefined }), /restore failed/, 'no partial options may escape a failed restore');
  const failed = await discoverContextBoundary({ modelId: 'model', hardLimit: 131072, kvOffload: true, hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
    probe: async (context, mode, phase) => { const probe = fixture(context, mode, phase); probe.record.inference = false; return probe; },
    restore: async () => undefined, progress: () => undefined });
  assert.equal(failed.options.length, 0, 'reasoning-only/failed inference must not establish mode support');
  const mismatch = await discoverContextBoundary({ modelId: 'model', hardLimit: 131072, kvOffload: true, hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
    probe: async (context, mode, phase) => { const probe = fixture(context, mode, phase); probe.estimate!.observedContextTokens = 4096; return probe; },
    restore: async () => undefined, progress: () => undefined });
  assert.equal(mismatch.options.length, 0, 'a different effective n_ctx must not establish a maximum');
  const first = fixture(16384, 'f16', 'base').estimate!;
  const second = fixture(32768, 'f16', 'search').estimate!;
  first.allocationEvidence!.allocations.ssm.device = GiB;
  second.allocationEvidence!.allocations.ssm.device = 2 * GiB;
  const predicted = predictContextHeadroom([first, second], 49152)!;
  assert.equal(predicted.deviceBytes, second.memoryHeadroom!.deviceBytes - GiB - 16384 * 64 * 1024,
    'context-dependent recurrent state growth must remain in the forecast');
  const unimproved = await discoverContextBoundary({ modelId: 'model', hardLimit: 131072, kvOffload: true, hostReserveBytes: 8 * GiB, deviceReserveBytes: 2 * GiB,
    probe: async (context, mode, phase) => { const probe = fixture(context, 'f16', phase); probe.record.kvCacheType = mode; probe.estimate!.activeKvCacheType = mode; return probe; },
    restore: async () => undefined, progress: () => undefined });
  assert.deepEqual(unimproved.options.map((option) => option.kvCacheType), ['f16'], 'Q8 must not be offered without a meaningful verified improvement');
}

if (require.main === module) void runContextDiscoveryRegression().catch((error) => { console.error(error); process.exitCode = 1; });
