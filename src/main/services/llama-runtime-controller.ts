import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { llamaRuntimeProfile } from '../models/llama-runtime-policy';
import type { LlamaKvCacheType } from '../../shared/types';
import { llamaCapabilityLimit } from './gguf-context';

/**
 * What the launcher says is running. `modelId`/`contextWindow` describe the
 * server that answers on the port right now, never a requested value.
 */
export type LlamaRuntimeState = {
  status: 'starting' | 'ready' | 'switching' | 'offline' | 'stopped';
  modelId: string | null;
  contextWindow: number | null;
  kvCacheType?: LlamaKvCacheType;
  kvOffload?: boolean;
  speculativeMode?: 'mtp' | 'eagle3' | 'none';
  error?: string;
  requestId?: string;
  /** The requested runtime failed to start and the previous one was restored. */
  rolledBack?: boolean;
  /** The launcher that wrote this state; a state whose launcher is gone describes nothing. */
  launcherPid?: number;
  serverPid?: number;
};

export type LlamaSwitchResult =
  | { ok: true; state: LlamaRuntimeState }
  | { ok: false; state: LlamaRuntimeState; error: string };

export type LlamaRuntimeFiles = {
  stateFile: string;
  requestFile: string;
  launcherPidFile: string;
};

type Deps = {
  readText: (path: string) => Promise<string>;
  signal: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  capabilityLimit: (modelId: string) => Promise<number>;
};

const defaultDeps: Deps = {
  readText: (path) => readFile(path, 'utf8'),
  signal: (pid) => { process.kill(pid, 'SIGUSR1'); },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  capabilityLimit: llamaCapabilityLimit,
};

/** Error text of a state with no live launcher; callers fall back to the startup environment. */
export const LAUNCHER_ABSENT = 'Launcher llama.cpp не запущен';

/** Parses the launcher's state document defensively: it is another process's output. */
export function parseLlamaRuntimeState(raw: string): LlamaRuntimeState | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const status = value.status;
    if (status !== 'starting' && status !== 'ready' && status !== 'switching' && status !== 'offline' && status !== 'stopped') return null;
    const modelId = typeof value.modelId === 'string' && value.modelId ? value.modelId : null;
    const contextWindow = typeof value.contextWindow === 'number' && value.contextWindow > 0 ? value.contextWindow : null;
    return {
      status, modelId, contextWindow,
      ...(value.kvCacheType === 'f16' || value.kvCacheType === 'q8_0' ? { kvCacheType: value.kvCacheType } : {}),
      ...(typeof value.kvOffload === 'boolean' ? { kvOffload: value.kvOffload } : {}),
      ...(value.speculativeMode === 'mtp' || value.speculativeMode === 'eagle3' || value.speculativeMode === 'none' ? { speculativeMode: value.speculativeMode } : {}),
      ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
      ...(typeof value.requestId === 'string' && value.requestId ? { requestId: value.requestId } : {}),
      ...(value.rolledBack === true ? { rolledBack: true } : {}),
      ...(typeof value.launcherPid === 'number' && value.launcherPid > 0 ? { launcherPid: value.launcherPid } : {}),
      ...(typeof value.serverPid === 'number' && value.serverPid > 0 ? { serverPid: value.serverPid } : {}),
    };
  } catch { return null; }
}

/**
 * Model and context changes for the launcher-managed llama-server as one
 * transaction. The caller persists a selection only after `ok: true`, so the
 * stored conversation, the UI and the actual server cannot disagree.
 */
export class LlamaRuntimeController {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: Deps;

  constructor(private readonly files: LlamaRuntimeFiles, private readonly timeoutMs = 240_000, deps: Partial<Deps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async state(): Promise<LlamaRuntimeState> {
    const gone: LlamaRuntimeState = { status: 'offline', modelId: null, contextWindow: null, error: LAUNCHER_ABSENT };
    let parsed: LlamaRuntimeState | null;
    try {
      parsed = parseLlamaRuntimeState(await this.deps.readText(this.files.stateFile));
    } catch { return gone; }
    if (!parsed) return { status: 'offline', modelId: null, contextWindow: null, error: 'Состояние llama.cpp не читается' };
    // A state file outlives its launcher; only a live launcher can vouch for it.
    if (parsed.launcherPid !== undefined && !(await this.deps.readText(`/proc/${parsed.launcherPid}/cmdline`).then((text) => text.includes('run-local-ai-desktop-llama-cpp-mtp.sh'), () => false))) return gone;
    return parsed;
  }

  /** Switches are serialized: two concurrent requests would otherwise race on one request file. */
  switchTo(modelId: string, contextWindow: number, kvCacheType: LlamaKvCacheType = 'f16', kvOffload = true): Promise<LlamaSwitchResult> {
    const run = this.chain.then(() => this.perform(modelId, contextWindow, kvCacheType, kvOffload));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async perform(modelId: string, contextWindow: number, kvCacheType: LlamaKvCacheType, kvOffload: boolean): Promise<LlamaSwitchResult> {
    const profile = llamaRuntimeProfile(modelId);
    if (!profile) return { ok: false, state: await this.state(), error: `Модель ${modelId} не поддерживается llama.cpp runtime` };
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 4_096 || contextWindow > await this.deps.capabilityLimit(modelId) || contextWindow % 4_096 !== 0) return { ok: false, state: await this.state(), error: `Контекст ${contextWindow} не поддерживается для ${modelId}` };

    const launcherPid = Number((await this.deps.readText(this.files.launcherPidFile).catch(() => '')).trim());
    if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0) return { ok: false, state: await this.state(), error: 'Launcher llama.cpp не запущен: перезапуск модели невозможен без него.' };
    const commandLine = await this.deps.readText(`/proc/${launcherPid}/cmdline`).catch(() => '');
    if (!commandLine.includes('run-local-ai-desktop-llama-cpp-mtp.sh')) return { ok: false, state: await this.state(), error: 'PID launcher не принадлежит Local AI Desktop.' };

    const requestId = randomUUID();
    await mkdir(dirname(this.files.requestFile), { recursive: true });
    const temporary = `${this.files.requestFile}.${process.pid}.tmp`;
    await writeFile(temporary, `REQUEST_ID=${requestId}\nMODEL_ID=${modelId}\nCONTEXT=${contextWindow}\nKV_TYPE=${kvCacheType}\nKV_OFFLOAD=${kvOffload ? 1 : 0}\n`, 'utf8');
    await rename(temporary, this.files.requestFile);
    try { this.deps.signal(launcherPid); }
    catch (error) {
      await rm(this.files.requestFile, { force: true });
      return { ok: false, state: await this.state(), error: `Не удалось передать запрос launcher: ${error instanceof Error ? error.message : String(error)}` };
    }

    const deadline = this.deps.now() + this.timeoutMs;
    while (this.deps.now() < deadline) {
      const state = await this.state();
      if (state.requestId === requestId && (state.status === 'ready' || state.status === 'offline')) {
        if (state.status === 'ready' && !state.error && state.modelId === modelId && state.contextWindow === contextWindow && state.kvCacheType === kvCacheType && state.kvOffload === kvOffload) return { ok: true, state };
        return { ok: false, state, error: state.error ?? 'llama.cpp не подтвердил запрошенную модель' };
      }
      await this.deps.sleep(500);
    }
    return { ok: false, state: await this.state(), error: 'Launcher llama.cpp не ответил на запрос смены модели вовремя' };
  }
}
