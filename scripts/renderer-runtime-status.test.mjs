import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'runtime-status-test-'));
const bundle = join(directory, 'app-store.cjs');
try {
  await build({ entryPoints: ['src/renderer/store/app-store.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
  const { useAppStore } = createRequire(import.meta.url)(bundle);
  const initialSettings = { llamaServerPath: null, modelsPath: '/models', llamaRuntime: { status: 'idle', modelId: null, contextWindow: null } };
  let runtimeState = initialSettings.llamaRuntime;
  let settingsReads = 0;
  let modelReads = 0;
  globalThis.window = { localAi: {
    runtime: { state: async () => runtimeState },
    settings: { get: async () => { settingsReads += 1; return initialSettings; } },
    models: { list: async () => { modelReads += 1; return []; } },
  } };
  useAppStore.setState({ settings: initialSettings });
  let updates = 0;
  const unsubscribe = useAppStore.subscribe(() => { updates += 1; });

  await useAppStore.getState().refreshRuntimeStatus();
  await useAppStore.getState().refreshRuntimeStatus();
  assert.equal(updates, 0, 'unchanged health polls do not trigger renderer/store updates');
  assert.equal(settingsReads, 0, 'health polling does not re-read setup or model settings');
  assert.equal(modelReads, 0, 'health polling does not revalidate the model registry');

  runtimeState = { status: 'ready', modelId: 'custom:fixture', contextWindow: 32_768 };
  await useAppStore.getState().refreshRuntimeStatus();
  assert.equal(updates, 1, 'a real runtime transition is published once');
  assert.equal(useAppStore.getState().settings?.llamaRuntime?.status, 'ready');
  assert.equal(settingsReads, 0);
  assert.equal(modelReads, 0);
  const conversation = { id: 'fixture-chat', mode: 'agent', workingDirectory: '/fixture/project', secondaryWorkingDirectory: '/fixture/secondary', modelId: 'custom:fixture' };
  const messages = [{ id: 'assistant', thinking: 'Actual reasoning', attachments: [{ id: 'image' }] }];
  const agentPlan = { workBudget: { used: 140, limit: 160, maximum: 256, extensions: 1 }, taskMemory: { entries: [], deliverables: { items: [{ id: '1', status: 'implemented' }] } } };
  useAppStore.setState({ activeId: conversation.id, conversations: [conversation], messages, agentPlan });
  runtimeState = { status: 'switching', modelId: 'custom:fixture', contextWindow: 32768, pendingProjectorDevice: 'gpu' };
  await useAppStore.getState().refreshRuntimeStatus();
  assert.strictEqual(useAppStore.getState().messages, messages);
  assert.strictEqual(useAppStore.getState().agentPlan, agentPlan);
  assert.strictEqual(useAppStore.getState().conversations[0], conversation);
  assert.equal(useAppStore.getState().activeId, conversation.id);
  runtimeState = { status: 'ready', modelId: 'custom:fixture', contextWindow: 32768, projectorDevice: 'gpu' };
  await useAppStore.getState().refreshRuntimeStatus();
  assert.strictEqual(useAppStore.getState().messages, messages);
  assert.strictEqual(useAppStore.getState().agentPlan, agentPlan);
  assert.strictEqual(useAppStore.getState().conversations[0], conversation);
  assert.equal(settingsReads, 0); assert.equal(modelReads, 0);
  unsubscribe();
  console.log('Runtime health polling: no model/settings IPC or store update when unchanged; real runtime changes publish once; device restart preserves conversation, images/reasoning, projects and Agent state');
} finally {
  await rm(directory, { recursive: true, force: true });
}
