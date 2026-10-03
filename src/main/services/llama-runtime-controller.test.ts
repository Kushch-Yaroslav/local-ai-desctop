import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAUNCHER_ABSENT, LlamaRuntimeController, parseLlamaRuntimeState } from './llama-runtime-controller';

const qwen = 'qwen3.8:27b-q4_K_M';
const glm = 'glm-4.7-flash:q4_k';

async function fixture(timeoutMs = 5_000) {
  const dir = await mkdtemp(join(tmpdir(), 'llama-runtime-'));
  const files = { stateFile: join(dir, 'state.json'), requestFile: join(dir, 'request.env'), launcherPidFile: join(dir, 'launcher.pid') };
  await writeFile(files.launcherPidFile, '4242\n');
  const signals: number[] = [];
  let clock = 0;
  return { files, signals, dir, make: (onSignal: (request: Record<string, string>) => Promise<void>) => new LlamaRuntimeController(files, timeoutMs, {
    readText: async (path) => path === '/proc/4242/cmdline' ? '/bin/bash\0/media/yaroslav/DATA/local-ai-desktop/run-local-ai-desktop-llama-cpp-mtp.sh' : readFile(path, 'utf8'),
    signal: (pid) => {
      signals.push(pid);
      void readFile(files.requestFile, 'utf8').then((text) => onSignal(Object.fromEntries(text.trim().split('\n').map((line) => line.split('=') as [string, string]))));
    },
    sleep: async () => { clock += 500; await new Promise((resolve) => setImmediate(resolve)); },
    now: () => clock,
  }) };
}

const state = (fields: Record<string, unknown>) => JSON.stringify({ status: 'ready', requestId: '', modelId: '', contextWindow: 0, kvCacheType: 'f16', kvOffload: true, serverPid: 1, launcherPid: 4242, error: '', rolledBack: false, ...fields });

export async function runLlamaRuntimeControllerRegression(): Promise<void> {
  assert.equal(parseLlamaRuntimeState('not json'), null);
  assert.equal(parseLlamaRuntimeState(state({ status: 'weird' })), null);
  assert.deepEqual(parseLlamaRuntimeState(state({ modelId: qwen, contextWindow: 65_536, kvCacheType: 'f16', kvOffload: true })), { status: 'ready', modelId: qwen, contextWindow: 65_536, kvCacheType: 'f16', kvOffload: true, launcherPid: 4242 });

  {
    const { files, signals, make } = await fixture();
    let captured: Record<string, string> = {};
    const controller = make(async (request) => { captured = request; await writeFile(files.stateFile, state({ status: 'ready', requestId: request.REQUEST_ID, modelId: request.MODEL_ID, contextWindow: Number(request.CONTEXT), kvCacheType: request.KV_TYPE, kvOffload: request.KV_OFFLOAD === '1' })); });
    const result = await controller.switchTo(qwen, 73_728, 'q8_0', false);
    assert.equal(result.ok, true, 'a confirmed switch must succeed');
    if (result.ok) {
      assert.equal(result.state.contextWindow, 73_728);
      assert.equal(result.state.kvCacheType, 'q8_0');
      assert.equal(result.state.kvOffload, false);
    }
    assert.equal(captured.KV_TYPE, 'q8_0');
    assert.equal(captured.KV_OFFLOAD, '0');
    assert.deepEqual(signals, [4242]);
  }
  {
    // The requested runtime failed, the launcher restored the previous one: the switch is a failure and the active model is the previous one.
    const { files, make } = await fixture();
    const controller = make(async (request) => { await writeFile(files.stateFile, state({ status: 'ready', requestId: request.REQUEST_ID, modelId: glm, contextWindow: 65_536, error: 'CUDA out of memory', rolledBack: true })); });
    const result = await controller.switchTo(qwen, 65_536);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /out of memory/);
      assert.equal(result.state.modelId, glm, 'the rolled-back state must name the model that really runs');
      assert.equal(result.state.rolledBack, true);
    }
  }
  {
    const { files, make } = await fixture();
    const controller = make(async (request) => { await writeFile(files.stateFile, state({ status: 'offline', requestId: request.REQUEST_ID, error: 'server exited' })); });
    const result = await controller.switchTo(qwen, 65_536);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.state.status, 'offline'); assert.equal(result.state.modelId, null); }
  }
  {
    // A state left by a previous request must never confirm the current one.
    const { files, make } = await fixture(2_000);
    await writeFile(files.stateFile, state({ status: 'ready', requestId: 'older-request', modelId: qwen, contextWindow: 65_536 }));
    const controller = make(async () => undefined);
    const result = await controller.switchTo(qwen, 65_536);
    assert.equal(result.ok, false, 'a stale ready state confirmed a new request');
    if (!result.ok) assert.match(result.error, /не ответил/);
  }
  {
    // A state file left behind by a launcher that no longer exists describes nothing.
    const { files, make } = await fixture();
    await writeFile(files.stateFile, state({ status: 'ready', modelId: qwen, contextWindow: 65_536, launcherPid: 999_999 }));
    const stale = await make(async () => undefined).state();
    assert.equal(stale.status, 'offline');
    assert.equal(stale.error, LAUNCHER_ABSENT);
    await writeFile(files.stateFile, state({ status: 'ready', modelId: qwen, contextWindow: 65_536, launcherPid: 4242 }));
    assert.equal((await make(async () => undefined).state()).status, 'ready', 'a live launcher vouches for its state');
  }
  {
    const { files, make } = await fixture();
    const controller = make(async () => undefined);
    assert.equal((await controller.switchTo('unknown-model', 65_536)).ok, false);
    assert.equal((await controller.switchTo(qwen, 12_345)).ok, false, 'an unsupported context was sent to the launcher');
    assert.equal((await controller.switchTo(qwen, 131_076)).ok, false, 'unaligned custom context was sent to the launcher');
    assert.equal((await controller.switchTo(qwen, 266_240)).ok, false, 'context above the model limit was sent to the launcher');
    await writeFile(files.launcherPidFile, '');
    assert.equal((await controller.switchTo(qwen, 65_536)).ok, false, 'without a launcher there is nothing to switch');
  }
  {
    // Concurrent switches are serialized: the second request is written only after the first finished.
    const { files, make } = await fixture();
    const seen: string[] = [];
    const controller = make(async (request) => { seen.push(request.MODEL_ID); await writeFile(files.stateFile, state({ status: 'ready', requestId: request.REQUEST_ID, modelId: request.MODEL_ID, contextWindow: Number(request.CONTEXT) })); });
    const [first, second] = await Promise.all([controller.switchTo(qwen, 65_536), controller.switchTo(glm, 32_768)]);
    assert.equal(first.ok && second.ok, true);
    assert.deepEqual(seen, [qwen, glm]);
  }
}

if (require.main === module) void runLlamaRuntimeControllerRegression().then(() => console.log('llama runtime controller regression passed'), (error: unknown) => { console.error(error); process.exitCode = 1; });
