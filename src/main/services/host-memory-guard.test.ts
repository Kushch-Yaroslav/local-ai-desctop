import assert from 'node:assert/strict';
import { validateHostMemory } from './host-memory-guard';

const GiB = 1024 ** 3;
validateHostMemory(40 * GiB, 32 * GiB, 8 * GiB);
validateHostMemory(48 * GiB, 32 * GiB, 12 * GiB);
assert.throws(() => validateHostMemory(39 * GiB, 32 * GiB, 8 * GiB), /Недостаточно.*доступно 39.0.*требуется 40.0/);
assert.throws(() => validateHostMemory(40 * GiB, 32 * GiB, 12 * GiB), /Недостаточно/);
assert.throws(() => validateHostMemory(null, 32 * GiB, 8 * GiB), /проверить/);
assert.throws(() => validateHostMemory(NaN, 32 * GiB, 8 * GiB), /проверить/);
assert.throws(() => validateHostMemory(64 * GiB, -1, 8 * GiB), /бюджет/);
assert.throws(() => validateHostMemory(64 * GiB, 32 * GiB, 7 * GiB), /бюджет/);
console.log('CPU-offload host memory guard passed (before load, reserve, insufficient/unknown RAM, invalid budget)');
