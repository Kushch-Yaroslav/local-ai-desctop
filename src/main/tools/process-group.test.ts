import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ownedGroupId, signalOwnedGroup } from './process-group';

const settle = (child: ChildProcess) => new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [path] : []; });

export async function runProcessGroupRegression(): Promise<void> {
  // Invalid or dangerous identifiers are refused before any signal is attempted (fake handles: nothing is signalled).
  const live = { exitCode: null, signalCode: null } as const;
  for (const pid of [undefined, 0, 1, -1, -2, -12345, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000, process.pid, process.ppid]) {
    assert.equal(ownedGroupId({ pid, ...live }), null, `pid ${String(pid)} must be refused`);
    assert.equal(signalOwnedGroup({ pid, ...live }, 'SIGTERM'), false);
  }
  assert.equal(ownedGroupId({ pid: 424242, exitCode: 0, signalCode: null }), null, 'an exited child (reusable PID) must be refused');
  assert.equal(ownedGroupId({ pid: 424242, exitCode: null, signalCode: 'SIGTERM' }), null);
  assert.equal(ownedGroupId({ pid: 424242, ...live }), 424242);

  // Disposable children only: an isolated group, a sibling in our own group, and a second isolated group.
  const sibling = spawn('sleep', ['20.41'], { stdio: 'ignore' });
  const target = spawn('/bin/bash', ['-c', 'sleep 20.42 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const other = spawn('sleep', ['20.43'], { detached: true, stdio: 'ignore' });
  try {
    const descendant = Number(await new Promise<string>((resolve) => target.stdout!.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()))));
    assert.ok(Number.isSafeInteger(descendant) && descendant > 1);
    assert.equal(ownedGroupId(sibling), sibling.pid, 'a live child handle is accepted');
    assert.equal(signalOwnedGroup(target, 'SIGTERM'), true);
    await settle(target);
    assert.equal(sibling.exitCode, null, 'an unrelated sibling was signalled');
    assert.equal(other.exitCode, null, 'another isolated group was signalled');
    assert.equal(signalOwnedGroup(target, 'SIGKILL'), false, 'an exited child was signalled');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(descendant, 0), /ESRCH/, 'the descendant of the terminated group survived');
  } finally {
    for (const child of [sibling, target, other]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all([settle(sibling), settle(target), settle(other)]);
  }

  // No application code may shell out to a kill utility or signal a raw/negative identifier.
  const offenders: string[] = [];
  for (const file of sourceFiles(join(__dirname, '..', '..', '..', 'src'))) {
    if (file.endsWith('process-group.ts')) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/(exec|execFile|spawn)(Sync)?\(\s*['"`](\/usr\/bin\/|\/bin\/)?(kill|pkill|killall)\b/.test(line) || /process\.kill\(\s*-/.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'process signalling must go through process-group.ts');
}

if (require.main === module) void runProcessGroupRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
