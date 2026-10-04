import assert from 'node:assert/strict';
import { parseNvidiaMemorySnapshot } from './hardware';

export function runHardwareMemoryRegression() {
  const parsed = parseNvidiaMemorySnapshot('19446, 24576, 4674, 0');
  assert.equal(parsed?.vramAvailableBytes, 4674 * 1024 ** 2);
  assert(parsed!.vramAvailableBytes < parsed!.vramTotalBytes - parsed!.vramUsedBytes, 'reserved driver memory must not be counted as free');
  for (const text of ['', '19446, 24576, N/A, 0', '19446, 24576, , 0', '19446, 24576, 6000, 0', '1, 24, 22, 0\n2, 24, 21, 0']) {
    assert.equal(parseNvidiaMemorySnapshot(text), null, 'unverified per-device telemetry must not establish discovery headroom');
  }
}

if (require.main === module) runHardwareMemoryRegression();
