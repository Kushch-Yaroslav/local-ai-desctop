import assert from 'node:assert/strict';
import { estimateHardwareSafeContext, type ContextEstimatorInput } from './context-estimator';

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
}

if (require.main === module) runContextEstimatorRegression();
