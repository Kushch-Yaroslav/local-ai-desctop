import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths';
import { log } from './logger';

let owned: ChildProcess | undefined;
export async function startRuntimeSupervisor(): Promise<void> {
  // Packaged/direct development launches own the supervisor; the external
  // source launcher retains ownership of its server and Electron process.
  if (process.env.LOCAL_AI_LAUNCHER_MANAGED === '1') return;
  const stateFile = join(paths.dataRoot, 'llama-cpp-runtime-state.json');
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (Number.isSafeInteger(state.launcherPid) && (await readFile(`/proc/${state.launcherPid}/cmdline`, 'utf8')).includes('run-local-ai-desktop-llama-cpp-mtp.sh')) return;
  } catch { /* No current supervisor. */ }
  owned = spawn('bash', [join(paths.root, 'run-local-ai-desktop-llama-cpp-mtp.sh')], { env: { ...process.env,
    LOCAL_AI_APP_DIR: paths.root, LOCAL_AI_ELECTRON_BIN: process.execPath,
    LOCAL_AI_LAUNCHER_HEADLESS: '1', LOCAL_AI_PARENT_PID: String(process.pid),
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  owned.stderr?.on('data', (data: Buffer) => log('runtime.supervisor.stderr', data.toString()));
  owned.on('error', (error) => log('runtime.supervisor.error', error.message));
  owned.on('exit', (code) => log('runtime.supervisor.exit', { code }));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (owned.exitCode !== null) return;
    try { if (JSON.parse(await readFile(stateFile, 'utf8')).launcherPid === owned.pid) return; } catch { /* Wait for atomic state write. */ }
    await new Promise((done) => setTimeout(done, 50));
  }
}

export async function stopRuntimeSupervisor(): Promise<void> {
  if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
  const child = owned;
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 12_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.kill('SIGTERM');
  });
  owned = undefined;
}
