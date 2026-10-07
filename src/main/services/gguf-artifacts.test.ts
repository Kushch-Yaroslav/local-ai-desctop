import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ggufArtifactFingerprint, ggufArtifactPaths, verifyGgufArtifacts } from './gguf-artifacts';
import { buildContextDiscoveryIdentity, contextDiscoveryKey } from './context-discovery-persistence';

const root = mkdtempSync(join(tmpdir(), 'lad-split-gguf-'));
try {
  const single = join(root, 'single.gguf');
  writeFileSync(single, 'stand-in for model identity');
  const file = statSync(single);
  assert.equal(ggufArtifactFingerprint(single), `${file.size}:${file.mtimeMs}`, 'existing single-GGUF cache keys must remain unchanged');
  assert.equal(ggufArtifactFingerprint(single, true), `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`);
  verifyGgufArtifacts(single);
  const first = join(root, 'future-00001-of-00003.gguf');
  const paths = ggufArtifactPaths(first);
  assert.deepEqual(paths, [first, join(root, 'future-00002-of-00003.gguf'), join(root, 'future-00003-of-00003.gguf')]);
  paths.forEach((path) => writeFileSync(path, 'weights'));
  verifyGgufArtifacts(first);
  const identity = (model: string, args: string[] = ['llama-server', '--n-cpu-moe', '28']) => contextDiscoveryKey(buildContextDiscoveryIdentity({
    modelId: 'future-split', modelFingerprint: model, projectorFingerprint: null, runtimeFingerprint: 'runtime', arguments: args,
    speculative: 'none', hardLimit: 262_144, gpu: { name: 'RTX 3090', vramTotalBytes: 24 * 1024 ** 3 }, hostReserveBytes: 8 * 1024 ** 3,
  })).key;
  const original = ggufArtifactFingerprint(first);
  assert.equal(identity(original), identity(ggufArtifactFingerprint(first)));
  assert.notEqual(identity(original), identity(original, ['llama-server', '--n-cpu-moe', '32']), 'expert placement materially changes the cache key');
  writeFileSync(paths[2], 'changed final shard');
  assert.notEqual(identity(original), identity(ggufArtifactFingerprint(first)), 'non-first shard changes must invalidate Max Context');
  rmSync(paths[1]);
  assert.throws(() => verifyGgufArtifacts(first), /ENOENT/);
  assert.throws(() => ggufArtifactFingerprint(first), /ENOENT/);
  mkdirSync(paths[1]);
  assert.throws(() => verifyGgufArtifacts(first), /не является файлом/);
  assert.throws(() => ggufArtifactPaths(paths[2]), /первый файл/);
  assert.throws(() => ggufArtifactPaths(join(root, 'invalid-00001-of-99999.gguf')), /первый файл/);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('split GGUF regression passed (all shards, startup readability, stable single keys, changed/missing shard, placement identity)');
