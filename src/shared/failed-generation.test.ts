import assert from 'node:assert/strict';
import { useAppStore } from '../renderer/store/app-store';
import type { Conversation } from './types';
import type {} from '../renderer/env';

async function run(): Promise<void> {
  const chat = (id: string): Conversation => ({ id, title: id, modelId: 'model', mode: 'agent', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 16384, thinkingEnabled: null, reasoningEffort: null, reasoningMode: 'fast', contextTokens: null, contextModelId: null, webMode: 'off', createdAt: '', updatedAt: '' });
  const finish: Array<() => void> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localAi: { agentPlans: { get: async () => null },
      messages: { list: async () => [] }, analysis: { list: async () => [] },
      chat: { send: async () => new Promise<void>((resolve) => finish.push(resolve)) },
    },
  } });
  useAppStore.setState({ conversations: [chat('A'), chat('B')], activeId: 'A', messages: [], settings: { llamaServerPath: null, modelsPath: '', llamaRuntime: { status: 'ready', modelId: 'model', contextWindow: 16384 } } });
  const first = useAppStore.getState().sendMessage('inspect two projects');
  const firstId = useAppStore.getState().generationId!;
  await useAppStore.getState().selectConversation('B');
  useAppStore.getState().handleStream({ type: 'error', conversationId: 'A', generationId: firstId, message: 'model HTTP status: HTTP/1.1 500 Internal Server Error', details: 'Jinja role alternation' });
  assert.equal(useAppStore.getState().generationConversationId, null, 'terminal background error releases inference ownership before the invoke settles');
  assert.equal(useAppStore.getState().generationOwnerId, null);
  await useAppStore.getState().selectConversation('A');
  assert.equal(useAppStore.getState().isGenerating, false);
  assert.equal(useAppStore.getState().generationId, null);
  assert.match(useAppStore.getState().error ?? '', /500/);
  await useAppStore.getState().selectConversation('B');
  const second = useAppStore.getState().sendMessage('new chat immediately');
  const secondId = useAppStore.getState().generationId!;
  assert.notEqual(secondId, firstId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finish.length, 2, 'new chat can send without Stop or restarting');
  finish[0](); await first;
  assert.equal(useAppStore.getState().generationConversationId, 'B', 'settling the failed invoke cannot release another run');
  assert.equal(useAppStore.getState().generationOwnerId, secondId);
  useAppStore.getState().handleStream({ type: 'error', conversationId: 'A', generationId: firstId, message: 'late error' });
  assert.equal(useAppStore.getState().generationOwnerId, secondId, 'stale terminal events cannot release a new run');
  useAppStore.getState().handleStream({ type: 'cancelled', conversationId: 'B', generationId: secondId });
  assert.equal(useAppStore.getState().isGenerating, false);
  assert.equal(useAppStore.getState().generationOwnerId, null);
  finish[1](); await second;
  console.log('HTTP 500/background/new-chat/late-finally generation ownership regressions passed');
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
