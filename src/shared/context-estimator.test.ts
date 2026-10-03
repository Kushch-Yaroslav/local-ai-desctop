import assert from 'node:assert/strict';
import { discoveryHasReserveHeadroom, estimateHardwareSafeContext, findFreshContextDiscoveryOption, memoryBaselineWithinTolerance, type ContextDiscoveryOption, type ContextEstimatorInput } from './context-estimator';

const completeInput: ContextEstimatorInput = {
  configuredMaxTokens: 131_072,
  contextPresets: [16_384, 32_768, 65_536, 131_072, 262_144],
  hostAvailableBytes: 16 * 1024 ** 3,
  deviceAvailableBytes: 12 * 1024 ** 3,
  hostReserveBytes: 2 * 1024 ** 3,
  deviceReserveBytes: 1 * 1024 ** 3,
  hostWeightBytes: 0,
  deviceWeightBytes: 4 * 1024 ** 3,
  hostKvBytesPerToken: 0,
  deviceKvBytesPerToken: 64 * 1024,
  speculativeHostKvBytesPerToken: 0,
  speculativeDeviceKvBytesPerToken: 0,
  sequenceSlots: 1,
  speculativeMode: 'mtp',
  speculativeHostWeightBytes: 0,
  speculativeDeviceWeightBytes: 512 * 1024 ** 2,
  speculativeHostBufferBytesPerSlot: 0,
  speculativeDeviceBufferBytesPerSlot: 64 * 1024 ** 2,
  speculativeSlots: 1,
};

export function runContextEstimatorRegression(): void {
  const result = estimateHardwareSafeContext(completeInput);
  assert.equal(result.configuredMaxTokens, 131_072, 'configured maximum was not preserved separately');
  assert.equal(result.hardwareSafeTokens, 65_536, 'KV residency, MTP overhead, or reserve was not included');
  assert.deepEqual(result.unknownReasons, []);

  const multiSlot = estimateHardwareSafeContext({ ...completeInput, sequenceSlots: 2 });
  assert.equal(multiSlot.hardwareSafeTokens, 32_768, 'sequence slots were not included in KV-cache allocation');

  const hostOffloadedKv = estimateHardwareSafeContext({
    ...completeInput,
    hostAvailableBytes: 6 * 1024 ** 3,
    hostWeightBytes: 1 * 1024 ** 3,
    hostKvBytesPerToken: 32 * 1024,
    deviceKvBytesPerToken: 0,
    speculativeHostKvBytesPerToken: 0,
    speculativeDeviceKvBytesPerToken: 0,
    speculativeMode: 'none',
    speculativeDeviceWeightBytes: 0,
    speculativeDeviceBufferBytesPerSlot: 0,
    speculativeSlots: 0,
  });
  assert.equal(hostOffloadedKv.hardwareSafeTokens, 65_536, 'host-offloaded weights and KV-cache were not budgeted independently');

  const insufficient = estimateHardwareSafeContext({ ...completeInput, deviceAvailableBytes: 5 * 1024 ** 3 });
  assert.equal(insufficient.hardwareSafeTokens, 0, 'known memory pressure must not be presented as a safe preset');

  const unknown = estimateHardwareSafeContext({
    ...completeInput,
    deviceKvBytesPerToken: null,
    speculativeMode: 'unknown',
    speculativeSlots: null,
  });
  assert.equal(unknown.hardwareSafeTokens, null, 'missing runtime metadata must produce an unknown estimate');
  assert(unknown.unknownReasons.some((reason) => reason.includes('KV-cache')));
  assert(unknown.unknownReasons.some((reason) => reason.includes('speculative')));

  const discoveredAt = new Date(1_000).toISOString();
  const discovered: ContextDiscoveryOption[] = [
    { modelId: 'model-a', contextWindow: 73_728, kvCacheType: 'f16', kvOffload: true, discoveredAt, memoryBaseline: { hostAvailableBytes: 20, deviceAvailableBytes: 20 }, measuredHeadroom: { hostBytes: 12, deviceBytes: 4 } },
    { modelId: 'model-a', contextWindow: 118_784, kvCacheType: 'q8_0', kvOffload: true, discoveredAt, memoryBaseline: { hostAvailableBytes: 20, deviceAvailableBytes: 20 }, measuredHeadroom: { hostBytes: 12, deviceBytes: 4 } },
  ];
  const q8Option = findFreshContextDiscoveryOption(discovered, { modelId: 'model-a', contextWindow: 100_000, kvCacheType: 'q8_0', kvOffload: true }, 2_000);
  assert.equal(q8Option?.contextWindow, 118_784, 'selection must resolve to the validated matching-mode ceiling');
  assert.equal(findFreshContextDiscoveryOption(discovered, { modelId: 'model-a', contextWindow: 73_728, kvCacheType: 'q8_0', kvOffload: false }, 2_000), null, 'an offload mode without its own probe must not be exposed');
  assert.equal(findFreshContextDiscoveryOption(discovered, { modelId: 'model-b', contextWindow: 73_728, kvCacheType: 'f16', kvOffload: true }, 2_000), null, 'model-specific evidence must not be reused');
  assert.equal(findFreshContextDiscoveryOption(discovered, { modelId: 'model-a', contextWindow: 73_728, kvCacheType: 'f16', kvOffload: true }, 2_000_000), null, 'stale discovery must not validate a context selection');
  assert.equal(memoryBaselineWithinTolerance({ hostAvailableBytes: 100, deviceAvailableBytes: 100 }, { hostAvailableBytes: 110, deviceAvailableBytes: 105 }, 10, 5), true);
  assert.equal(memoryBaselineWithinTolerance({ hostAvailableBytes: 100, deviceAvailableBytes: 100 }, { hostAvailableBytes: 110, deviceAvailableBytes: 106 }, 10, 5), false, 'memory changes outside the discovery tolerance must invalidate a choice');
  assert.equal(memoryBaselineWithinTolerance({ hostAvailableBytes: Number.NaN, deviceAvailableBytes: 1 }, { hostAvailableBytes: 1, deviceAvailableBytes: 1 }, 10, 10), false);
  assert.equal(discoveryHasReserveHeadroom(discovered[1], { hostAvailableBytes: 20, deviceAvailableBytes: 19 }, 10, 3), true);
  assert.equal(discoveryHasReserveHeadroom(discovered[1], { hostAvailableBytes: 20, deviceAvailableBytes: 18 }, 10, 3), false,
    'a memory change within freshness tolerance must still preserve final reserves');
}

if (require.main === module) runContextEstimatorRegression();
