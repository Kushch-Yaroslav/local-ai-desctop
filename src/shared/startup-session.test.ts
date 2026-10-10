import assert from 'node:assert/strict';
import { useAppStore } from '../renderer/store/app-store';
import { activeConversationModel } from './model-selection';
import type { Conversation } from './types';
import type {} from '../renderer/env';
import { getModelProfile, modelInfo } from '../main/models/model-registry';

async function run() {
  const saved: Conversation = { id: 'saved', title: 'Saved Qwen', modelId: 'qwen3.8:27b-q4_K_M', mode: 'chat', workingDirectory: null, secondaryWorkingDirectory: null, primaryProjectId: null, secondaryProjectId: null, contextWindow: 81_920, llamaKvCacheType: 'q8_0', llamaKvOffload: true, thinkingEnabled: null, reasoningEffort: null, reasoningMode: 'fast', contextTokens: null, contextModelId: null, webMode: 'off', createdAt: '', updatedAt: '' };
  const other = { ...saved, id: 'other', modelId: 'huihui-qwen3.8:27b-ud-dw-q4_k_m' };
  let mutations = 0, sends = 0, modelOnCreate: unknown = 'not-called';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localAi: { agentPlans: { get: async () => null },
    conversations: { list: async () => [saved, other], create: async (modelId?: string) => { modelOnCreate = modelId; return { ...saved, id: 'new', modelId: null }; }, update: async () => { mutations++; throw new Error('Unexpected startup mutation'); } },
    messages: { list: async () => [], regenerate: async () => { mutations++; return []; }, edit: async () => { mutations++; return []; } },
    analysis: { list: async () => [] },
    models: { list: async () => [modelInfo(getModelProfile(saved.modelId!)!, true)] },
    settings: { get: async () => ({ llamaRuntime: { status: 'idle', modelId: null, contextWindow: null } }) },
    hardware: { get: async () => null },
    chat: { send: async () => { sends++; } },
  } } });
  await useAppStore.getState().initialize();
  assert.equal(useAppStore.getState().activeId, saved.id, 'history still opens');
  assert.equal(useAppStore.getState().activeContextWindow, null, 'saved context is not an active allocation');
  assert.equal(activeConversationModel(saved, useAppStore.getState().settings?.llamaRuntime), null);
  await useAppStore.getState().sendMessage('must wait for selection');
  const message = { id: 'history-user', conversationId: saved.id, role: 'user' as const, content: 'Saved question', createdAt: '' };
  assert.equal(await useAppStore.getState().regenerateMessage(message), false);
  assert.equal(await useAppStore.getState().editMessage(message, 'Edited question'), false);
  assert.equal(sends, 0); assert.equal(mutations, 0, 'idle send/edit/regenerate must neither start inference nor truncate history');
  await useAppStore.getState().selectConversation(other.id);
  assert.equal(activeConversationModel(other, useAppStore.getState().settings?.llamaRuntime), null);
  assert.equal(mutations, 0, 'opening a different saved model is passive');
  await useAppStore.getState().createConversation();
  assert.equal(modelOnCreate, undefined, 'new chat must not substitute the first installed/last-used model');
  assert.equal(saved.contextWindow, 81_920, 'startup keeps historical configuration');
  await useAppStore.getState().initialize();
  assert.equal(activeConversationModel(saved, useAppStore.getState().settings?.llamaRuntime), null);
  assert.equal(sends, 0); assert.equal(mutations, 0);
  console.log('real renderer store startup/history/large context/generation guard/new chat/reinitialize regressions passed');
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
