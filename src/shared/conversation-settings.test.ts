import assert from 'node:assert/strict';
import { useAppStore } from '../renderer/store/app-store';
import { effectiveModes, revertRefusedPatch, touchesRuntime, type ConversationPatch } from './conversation-settings';
import type { Conversation } from './types';
import type {} from '../renderer/env';

const chat = (overrides: Partial<Conversation> = {}): Conversation => ({ id: 'A', title: 'A', modelId: 'm', mode: 'agent', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 16384, reasoningMode: 'fast', contextTokens: null, contextModelId: null, webMode: 'off', createdAt: '', updatedAt: '', ...overrides });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

export async function runConversationSettingsRegression(): Promise<void> {
  assert.equal(touchesRuntime({ reasoningMode: 'deep' }), false);
  assert.equal(touchesRuntime({ mode: 'agent', webMode: 'auto', workingDirectory: '/p', title: 't' }), false);
  for (const patch of [{ modelId: 'x' }, { contextWindow: 8192 }, { llamaKvCacheType: 'q8_0' as const }, { llamaKvOffload: false }]) assert.equal(touchesRuntime(patch), true);

  assert.deepEqual(effectiveModes(chat({ reasoningMode: 'auto' }), true), { reasoning: 'fast', mode: 'agent', pendingReasoning: null, pendingMode: null });
  assert.equal(effectiveModes(chat(), false).reasoning, null, 'a model without configurable reasoning must not report a reasoning mode');
  const transition = { effective: { reasoningMode: 'fast' as const, mode: 'agent' as const }, desired: { reasoningMode: 'deep' as const } };
  assert.deepEqual(effectiveModes(chat({ reasoningMode: 'deep' }), true, transition), { reasoning: 'fast', mode: 'agent', pendingReasoning: 'deep', pendingMode: null }, 'an unconfirmed Deep selection was shown as effective');

  const before = chat();
  const optimistic = chat({ reasoningMode: 'deep', contextWindow: 32768 });
  const reverted = revertRefusedPatch(optimistic, before, { contextWindow: 32768 });
  assert.equal(reverted.contextWindow, 16384);
  assert.equal(reverted.reasoningMode, 'deep', 'rolling back a refused context change discarded an unrelated Deep selection');

  // A fake main process: runtime switches are serialized and slow, settings that do not touch llama.cpp apply immediately.
  const db = { current: chat() };
  const runtimeSwitch = deferred<void>();
  let failRuntime = false;
  const update = async (_id: string, patch: ConversationPatch): Promise<Conversation> => {
    if (touchesRuntime(patch)) {
      await runtimeSwitch.promise;
      if (failRuntime) throw new Error('switch failed');
    }
    db.current = { ...db.current, ...patch };
    return db.current;
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localAi: { conversations: { update }, settings: { get: async () => null }, models: { list: async () => [] } } } });
  const reset = () => { db.current = chat(); useAppStore.setState({ conversations: [chat()], activeId: 'A', messages: [], modeTransitions: {}, error: null }); };
  const state = () => useAppStore.getState();
  const stored = () => state().conversations[0]!;

  // Deep selected while a runtime switch is in flight: it must be applied and survive the switch.
  reset();
  const switching = state().updateConversation('A', { contextWindow: 32768 });
  const selecting = state().updateConversation('A', { reasoningMode: 'deep' });
  assert.equal(stored().reasoningMode, 'deep', 'the intended Deep selection was not retained while the runtime switches');
  assert.deepEqual(effectiveModes(stored(), true, state().modeTransitions.A), { reasoning: 'fast', mode: 'agent', pendingReasoning: 'deep', pendingMode: null }, 'Deep was reported effective before the main process confirmed it');
  await selecting;
  assert.equal(state().modeTransitions.A, undefined, 'the confirmed selection stayed pending');
  assert.equal(effectiveModes(stored(), true, state().modeTransitions.A).reasoning, 'deep');
  runtimeSwitch.resolve();
  await switching;
  assert.equal(stored().reasoningMode, 'deep', 'Deep reverted to Fast after the runtime became ready');
  assert.equal(stored().contextWindow, 32768);

  // A failed runtime switch must undo only the switch.
  reset();
  failRuntime = true;
  const failing = state().updateConversation('A', { contextWindow: 65536 }).catch((error: Error) => error);
  await state().updateConversation('A', { reasoningMode: 'deep' });
  assert.ok(await failing instanceof Error);
  assert.equal(stored().contextWindow, 16384);
  assert.equal(stored().reasoningMode, 'deep', 'a failed runtime switch reverted the unrelated Deep selection to Fast');

  // A genuinely refused selection rolls back, reports the reason and leaves nothing pending.
  reset();
  (window as unknown as { localAi: { conversations: { update: unknown } } }).localAi.conversations.update = async () => { throw new Error('generation active'); };
  await assert.rejects(() => state().updateConversation('A', { reasoningMode: 'deep' }), /generation active/);
  assert.equal(stored().reasoningMode, 'fast');
  assert.equal(state().modeTransitions.A, undefined);
  assert.equal(state().error, 'generation active');
}

if (require.main === module) void runConversationSettingsRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
