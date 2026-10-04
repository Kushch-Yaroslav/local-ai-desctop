import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RustAgentRuntime } from './rust-agent-runtime';
import type { ChatMessage } from '../../shared/types';
import { explicitWorkspaceRoots, extractAbsolutePaths, isGrantablePath, maxWorkspaceRoots } from './agent-workspace';

export async function runAgentWorkspaceRegression(): Promise<void> {
  assert.deepEqual(extractAbsolutePaths('В папке /media/yaroslav/DATA/Projects создай папку Шашки.'), ['/media/yaroslav/DATA/Projects']);
  assert.deepEqual(extractAbsolutePaths('look at "/srv/my project/a b" and (/opt/x/y), also ~/work/z.'), ['/srv/my project/a b', '/opt/x/y', '~/work/z']);
  assert.deepEqual(extractAbsolutePaths('see https://example.com/a/b and 3/4 and a/b/c'), [], 'URLs, fractions and relative paths are not paths');

  const home = '/home/someone';
  for (const denied of ['/', '/etc', '/etc/ssh', '/usr/local', '/var/lib', '/proc/1', '/boot', '/home', '/home/someone', '/home/other', '/media', '/media/someone', '/tmp', '/home/someone/.ssh', '/home/someone/.ssh/keys']) assert.equal(isGrantablePath(denied, home), false, denied);
  for (const allowed of ['/home/someone/Projects', '/media/someone/DATA', '/media/someone/DATA/Projects', '/tmp/x', '/mnt/data', '/opt/app']) assert.equal(isGrantablePath(allowed, home), true, allowed);

  const base = await mkdtemp(join(tmpdir(), 'agent-workspace-'));
  try {
    const projects = join(base, 'Projects');
    const secret = join(base, 'secret');
    await mkdir(projects, { recursive: true });
    await mkdir(secret);
    await writeFile(join(projects, 'file.txt'), 'x');
    await symlink(secret, join(projects, 'link'));
    const roots = (texts: string[]) => explicitWorkspaceRoots(texts, '/nonexistent-home');

    assert.deepEqual(await roots([`в папке ${projects} создай папку Шашки`]), [projects], 'an existing named directory was not granted');
    assert.deepEqual(await roots([`создай ${join(projects, 'NewFolder')}`]), [projects], 'a not-yet-created path should grant the directory that will contain it');
    assert.deepEqual(await roots([`открой ${join(projects, 'file.txt')}`]), [projects], 'a file grants its directory');
    assert.deepEqual(await roots([`${join(projects, 'link')}`]), [secret], 'a symlink grants its real target, never the link');
    assert.deepEqual(await roots([`создай ${join(base, 'missing', 'deeper', 'x')}`]), [], 'a path whose parent does not exist grants nothing');
    assert.deepEqual(await roots(['создай папку /etc/evil', 'и /usr/local/x']), [], 'system directories are never granted');
    assert.deepEqual(await roots(['создай папку Шашки в Projects']), [], 'text without an absolute path grants nothing');
    assert.deepEqual(await roots([`первый ${projects}`, `второй ${secret}`]), [secret, projects], 'the most recent mention comes first (terminal cwd)');
    const many: string[] = [];
    for (let index = 0; index < maxWorkspaceRoots + 3; index += 1) { const dir = join(base, `d${index}`); await mkdir(dir); many.push(dir); }
    assert.equal((await roots([many.join(' ')])).length, maxWorkspaceRoots, 'the number of granted directories is bounded');

    // The Electron→runtime boundary forwards named directories, with and without a project.
    const fake = join(base, 'fake-runtime.js');
    await writeFile(fake, `#!/usr/bin/env node
process.stdin.once('data', (chunk) => {
  const request = JSON.parse(String(chunk).split('\\n')[0]);
  console.log(JSON.stringify({ run_id: request.run_id, type: 'content_delta', content: JSON.stringify({ project_root: request.project_root ?? null, workspace_roots: request.workspace_roots ?? null, system: request.system }) }));
  console.log(JSON.stringify({ run_id: request.run_id, type: 'final', complete: true, continuation_count: 0, chars: 1, finish_reason: 'stop' }));
});
`);
    await chmod(fake, 0o755);
    const runtime = new RustAgentRuntime('http://127.0.0.1:1/v1/chat/completions', fake);
    const history: ChatMessage[] = [{ id: 'u', conversationId: 'c', role: 'user', content: 'create a folder', createdAt: '' }];
    const sent = async (projects: Parameters<RustAgentRuntime['stream']>[2], workspace: string[]) => {
      let text = '';
      for await (const event of runtime.stream('m', history, projects, new AbortController().signal, 8192, 'fast', 'off', 'run', undefined, undefined, true, undefined, workspace)) if (event.type === 'token') text += event.content;
      return JSON.parse(text) as { project_root: string | null; workspace_roots: string[] | null; system: string };
    };
    assert.deepEqual(await sent([], [projects]), { project_root: null, workspace_roots: [projects], system: (await sent([], [projects])).system });
    const withProject = await sent([{ id: 'p', slot: 1, root: base, label: 'Project 1 — x' }], [projects]);
    assert.equal(withProject.project_root, base);
    assert.deepEqual(withProject.workspace_roots, [projects]);
    assert.equal((await sent([], [])).workspace_roots, null);
  } finally { await rm(base, { recursive: true, force: true }); }
}

if (require.main === module) void runAgentWorkspaceRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
