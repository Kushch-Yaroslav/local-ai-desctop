import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { resolveLlamaExecutable as resolve, validateLlamaExecutable } from './llama-executable';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'llama smart path '));
  const create = async (path: string, source = '#!/bin/sh\necho "--model --ctx-size --port"\n') => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); await chmod(path, 0o755); return path;
  };
  try {
    assert.equal((await resolve('')).status, 'not-configured');
    assert.equal((await resolve(join(root, 'absent'))).status, 'missing');
    const file = await create(join(root, 'exact', 'llama-server'));
    assert.equal((await resolve(file)).path, file);
    assert.equal((await resolve(dirname(file))).path, file);
    await chmod(file, 0o644); assert.equal((await resolve(file)).status, 'not-executable'); await chmod(file, 0o755);
    const unsupported = await create(join(root, 'unsupported'), '#!/bin/sh\necho unrelated\n');
    assert.equal((await resolve(unsupported)).status, 'unsupported');
    assert.equal((await validateLlamaExecutable('bad\npath')).status, 'unsupported');
    const empty = join(root, 'empty'); await mkdir(empty); assert.equal((await resolve(empty)).status, 'not-found');
    const ancestor = join(root, 'ancestor');
    const first = await create(join(ancestor, 'llama.cpp', 'build-cuda', 'bin', 'llama-server'));
    assert.equal((await resolve(ancestor)).path, first);
    const second = await create(join(ancestor, 'another build', 'bin', 'llama-server'));
    assert.deepEqual((await resolve(ancestor)).candidates, [second, first].sort());
    assert.equal((await resolve(ancestor)).status, 'multiple');
    assert.equal((await resolve(ancestor, second)).path, second);
    const candidateLimited = await resolve(ancestor, undefined, { maxCandidates: 1 });
    assert.equal(candidateLimited.status, 'multiple'); assert(candidateLimited.incomplete, 'incomplete search with a candidate requires explicit selection');
    await rm(second);
    const replaced = await resolve(ancestor, second);
    assert.equal(replaced.status, 'multiple'); assert.equal(replaced.selectedMissing, true);
    assert.equal((await resolve(ancestor, file)).status, 'multiple', 'outside selection must not be used');
    const limited = await resolve(ancestor, undefined, { maxEntries: 1 }); assert(limited.incomplete);
    const deep = join(root, 'deep'); await create(join(deep, 'a/b/c/d/llama-server'));
    assert.equal((await resolve(deep, undefined, { maxDepth: 1 })).status, 'incomplete');
    const loop = join(root, 'loop'); await mkdir(loop); await symlink(loop, join(loop, 'self'));
    assert.equal((await resolve(loop)).status, 'incomplete');
    const denied = join(root, 'denied'); await mkdir(denied); await chmod(denied, 0);
    const deniedResult = await resolve(denied);
    if (process.getuid?.() !== 0) assert(deniedResult.reasons?.includes('permissions'));
    else console.log('Permission-denied fixture NOT TESTED: process is root');
    await chmod(denied, 0o700);
    const slow = await create(join(root, 'slow', 'llama-server'), '#!/bin/sh\nexec sleep 5\n');
    assert.equal((await resolve(dirname(slow), undefined, { timeoutMs: 80 })).status, 'incomplete');
    const controller = new AbortController(); const pending = resolve(dirname(slow), undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 80); assert.equal((await pending).status, 'cancelled');
    assert.equal((await resolve(file, undefined, { signal: controller.signal })).status, 'cancelled');
    console.log('Smart executable resolution passed: files, immediate/ancestor folders, zero/multiple, explicit selection/recovery, missing/non-executable/unsupported, limits, permissions, symlink loop, timeout and cancellation.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
