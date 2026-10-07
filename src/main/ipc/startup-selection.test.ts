import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '../../shared/types';
import type { LlamaRuntimeState } from '../services/llama-runtime-controller';

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lad-startup-ipc-'));
  process.env.LOCAL_AI_RUNTIME_ROOT = root;
  // Even stale environment metadata is not permission to restore a model.
  process.env.LOCAL_AI_LLAMA_MODEL_ID = 'gemma4:31b-it-q4_k_m';
  process.env.LOCAL_AI_LLAMA_CONTEXT = '81920';
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, ...args) => name === 'electron' ? { ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } } : originalLoad(name, ...args);
  const { Database } = await import('../services/database');
  const { LlamaRuntimeController } = await import('../services/llama-runtime-controller');
  const { launchProfileEnvironment } = await import('../models/llama-launch-config');
  const { llamaRuntimeProfile } = await import('../models/llama-runtime-policy');
  const { ensureAppDirectories } = await import('../services/paths');
  ensureAppDirectories();
  const db = new Database();
  const previous = db.createConversation('gemma4:31b-it-q4_k_m');
  db.updateConversation(previous.id, { contextWindow: 81_920, llamaKvCacheType: 'q8_0' });
  let runtime: LlamaRuntimeState = { status: 'idle', modelId: null, contextWindow: null };
  const launches: Array<{ modelId: string; context: number; environment: string }> = [];
  LlamaRuntimeController.prototype.state = async () => runtime;
  LlamaRuntimeController.prototype.switchTo = async (modelId, context, kvCacheType = 'f16', kvOffload = true) => {
    launches.push({ modelId, context, environment: await launchProfileEnvironment(llamaRuntimeProfile(modelId)!) });
    runtime = { status: 'ready', modelId, contextWindow: context, kvCacheType, kvOffload };
    return { ok: true, state: runtime };
  };
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
  try {
    const { registerIpc } = await import('./register-ipc');
    registerIpc();
    const invoke = async <T>(channel: string, ...args: unknown[]) => await handlers.get(channel)!({ sender: { send() {} } }, ...args) as T;
    const settings = await invoke<{ llamaRuntime: LlamaRuntimeState }>('settings:get');
    assert.equal(settings.llamaRuntime.modelId, null);
    await invoke('conversations:list'); await invoke('messages:list', previous.id); await invoke('models:list');
    assert.equal(requests, 0, 'idle initialization must not contact a model server');
    assert.equal(launches.length, 0, 'reading history/settings/catalog cannot load a model');
    runtime = { status: 'ready', modelId: previous.modelId, contextWindow: 81_920 };
    assert.equal((await invoke<{ llamaRuntime: LlamaRuntimeState }>('settings:get')).llamaRuntime.modelId, null, 'a pre-existing launcher state is not selection permission in a fresh Electron process');
    await invoke('models:list');
    assert.equal(requests, 0, 'startup must not adopt/contact another ready runtime');
    await assert.rejects(invoke('context:discover', previous.modelId), /Выберите модель/);
    runtime = { status: 'idle', modelId: null, contextWindow: null };
    assert.equal(db.getConversation(previous.id)?.contextWindow, 81_920, 'startup must retain history configuration');
    await assert.rejects(invoke('conversations:update', previous.id, { contextWindow: 32_768 }), /Выберите модель/);
    const selected = await invoke<Conversation>('conversations:update', previous.id, { modelId: 'qwen3.8:27b-q4_K_M' });
    assert.equal(selected.contextWindow, 32_768, 'first selection cannot replay an old Max window from another MTP configuration');
    assert.equal(selected.llamaKvCacheType, 'f16');
    assert.match(launches[0].environment, /SPECULATIVE_MODE='mtp'/);
    assert.match(launches[0].environment, /DRAFT_MODEL=''/);
    assert.match(launches[0].environment, /MMPROJ='[^']*qwen3.8-27b-mmproj.gguf'/);
    for (const [id, mode, draft] of [['qwen3.8:27b-q4_K_M', 'mtp', '']]) {
      const result = await invoke<Conversation>('conversations:update', previous.id, { modelId: id });
      assert.equal(result.modelId, id); assert.equal(runtime.modelId, id);
      assert.match(launches.at(-1)!.environment, new RegExp(`SPECULATIVE_MODE='${mode}'`));
      assert(launches.at(-1)!.environment.includes(`DRAFT_MODEL='${draft}'`));
    }
    const coder = await invoke<Conversation>('conversations:update', previous.id, { modelId: 'qwen3-coder-next:80b-a3b-q4_k_m' });
    assert.equal(coder.modelId, 'qwen3-coder-next:80b-a3b-q4_k_m');
    assert.equal(coder.contextWindow, 65_536);
    assert.equal(coder.llamaKvCacheType, 'q8_0');
    assert.equal(runtime.contextWindow, 65_536);
    assert.equal(runtime.kvCacheType, 'q8_0');
    assert.match(launches.at(-1)!.environment, /SPECULATIVE_MODE='none'/);
    assert.match(launches.at(-1)!.environment, /PROFILE_SERVER_ARGS=.*--n-cpu-moe.*28.*--ubatch-size.*128.*--load-mode.*none/);
    assert.match(launches.at(-1)!.environment, /DRAFT_MODEL=''/);
    assert.match(launches.at(-1)!.environment, /MMPROJ=''/);
    const huihui = await invoke<Conversation>('conversations:update', previous.id, { modelId: 'huihui-qwen3.8:27b-ud-dw-q4_k_m' });
    assert.equal(huihui.modelId, 'huihui-qwen3.8:27b-ud-dw-q4_k_m');
    assert.equal(huihui.contextWindow, 65_536, 'preserve a supported standard context while resetting the model-specific Q8 setting');
    assert.equal(huihui.llamaKvCacheType, 'f16');
    assert.match(launches.at(-1)!.environment, /SPECULATIVE_MODE='mtp'/);
    assert.match(launches.at(-1)!.environment, /PROFILE_SERVER_ARGS=\(\)/, 'switching away clears model-specific placement');
    const before = launches.length;
    await invoke('conversations:update', previous.id, { title: 'Retained history' });
    assert.equal(launches.length, before, 'unrelated settings must not restart the model');
    runtime = { status: 'idle', modelId: null, contextWindow: null };
    assert.equal((await invoke<{ llamaRuntime: LlamaRuntimeState }>('settings:get')).llamaRuntime.modelId, null);
    await invoke('conversations:list'); await invoke('messages:list', previous.id);
    assert.equal(launches.length, before, 'restart/history reads cannot restore a selection');
    console.log('production IPC startup/explicit selection/switch/restart regressions passed (removed-model history, Qwen, Coder Next, Huihui)');
  } finally { globalThis.fetch = originalFetch; loader._load = originalLoad; db.close(); rmSync(root, { recursive: true, force: true }); }
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
