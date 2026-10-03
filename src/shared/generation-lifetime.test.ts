import assert from 'node:assert/strict';
import { useAppStore } from '../renderer/store/app-store';
import { steeringMessageIds, thinkingTimeline } from './thinking-timeline';
import type { ChatMessage, Conversation } from './types';
import type {} from '../renderer/env';

async function run(): Promise<void> {
  const chat = (id: string): Conversation => ({ id, title: id, modelId: 'model', mode: 'agent', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 16384, reasoningMode: 'fast', contextTokens: null, contextModelId: null, webMode: 'off', createdAt: '', updatedAt: '' });
  const persisted = new Map<string, ChatMessage[]>();
  let finish!: () => void;
  let stopped = 0;
  let sends = 0;
  let resolveBranch!: (messages: ChatMessage[]) => void;
  const frames: Array<() => void> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return 1; }, cancelAnimationFrame: () => {},
    localAi: {
      messages: { list: async (id: string) => persisted.get(id) ?? [], regenerate: async () => new Promise<ChatMessage[]>((resolve) => { resolveBranch = resolve; }) },
      analysis: { list: async () => [] },
      conversations: { create: async () => chat('C'), delete: async () => {} },
      chat: { stop: async () => { stopped++; }, send: async () => { sends++; await new Promise<void>((resolve) => { finish = resolve; }); } },
    },
  } });
  useAppStore.setState({ conversations: [chat('A'), chat('B'), chat('D')], activeId: 'A', messages: [] });
  const running = useAppStore.getState().sendMessage('inspect');
  const generationId = useAppStore.getState().generationId!;
  await useAppStore.getState().deleteConversation('D');
  assert.equal(useAppStore.getState().activeId, 'A');
  assert.equal(useAppStore.getState().generationId, generationId);
  const event = (type: string, content?: string) => useAppStore.getState().handleStream({ type, content, conversationId: 'A', generationId });
  event('thinking', 'First thought');
  await useAppStore.getState().selectConversation('B');
  const followup: ChatMessage = { id: 'followup', conversationId: 'A', role: 'user', content: 'additional instruction', createdAt: '' };
  useAppStore.getState().handleStream({ type: 'steering', conversationId: 'A', generationId, userMessage: followup, status: 'accepted', timelinePosition: 2 });
  useAppStore.getState().handleStream({ type: 'steering', conversationId: 'A', generationId, userMessage: followup, status: 'applied', timelinePosition: 2 });
  event('token', 'Background answer');
  while (frames.length) frames.shift()!();
  assert.equal(useAppStore.getState().messages.length, 0);
  await useAppStore.getState().sendMessage('second generation');
  assert.equal(sends, 1);
  await useAppStore.getState().createConversation();
  assert.equal(useAppStore.getState().activeId, 'C');
  assert.equal(stopped, 0);
  assert.equal(useAppStore.getState().generationConversationId, 'A');
  await useAppStore.getState().selectConversation('A');
  assert.equal(useAppStore.getState().isGenerating, true);
  assert.equal(useAppStore.getState().messages.at(-1)?.content, 'Background answer');
  assert.equal(useAppStore.getState().messages.at(-1)?.thinking, 'First thought');
  assert.equal(useAppStore.getState().messages.filter((message) => message.id === followup.id).length, 1);
  assert.equal(useAppStore.getState().steeringStatus, 'applied');
  const liveAssistant = useAppStore.getState().messages.find((message) => message.id === `stream-${generationId}`);
  assert.deepEqual(liveAssistant?.thinkingTimeline, [{ id: 'steering-followup', kind: 'steering', messageId: followup.id, position: 2, status: 'applied' }], 'accepted/applied acknowledgments duplicated or detached the live timeline event');
  const assistant: ChatMessage = { id: 'saved', conversationId: 'A', role: 'assistant', content: 'Background answer', createdAt: '', thinkingTimeline: liveAssistant?.thinkingTimeline };
  const normalFollowup: ChatMessage = { id: 'normal-followup', conversationId: 'A', role: 'user', content: 'A later regular message', createdAt: '' };
  persisted.set('A', [followup, assistant, normalFollowup]);
  useAppStore.getState().handleStream({ type: 'done', conversationId: 'A', generationId, assistant });
  assert.equal(useAppStore.getState().messages.at(-1)?.content, 'Background answer');
  assert.equal(useAppStore.getState().messages.at(-1)?.thinking, undefined);
  finish(); await running;
  await useAppStore.getState().selectConversation('B');
  await useAppStore.getState().selectConversation('A');
  assert(useAppStore.getState().messages.some((message) => message.id === 'saved'), 'completed assistant message was missing after reload');
  assert.equal(useAppStore.getState().messages.at(-1)?.id, normalFollowup.id, 'normal follow-up was lost or retargeted to the prior Agent run');
  assert.equal(useAppStore.getState().messages.filter((message) => message.id === followup.id).length, 1, 'reloading duplicated or dropped the canonical steering message');
  assert.deepEqual([...steeringMessageIds(useAppStore.getState().messages)], [followup.id], 'normal follow-ups were incorrectly attached to the completed Agent run');
  const reloadedAssistant = useAppStore.getState().messages.find((message) => message.id === assistant.id);
  const reloadedTimeline = thinkingTimeline(reloadedAssistant?.thinking, [], false, reloadedAssistant?.thinkingTimeline, useAppStore.getState().messages);
  assert.deepEqual(reloadedTimeline.filter((item) => item.kind === 'steering').map((item) => item.message.id), [followup.id], 'completed steering timeline did not survive reload');
  assert.equal(reloadedTimeline.find((item) => item.kind === 'steering')?.kind === 'steering' && reloadedTimeline.find((item) => item.kind === 'steering')?.status, 'applied', 'applied state did not survive reload');
  assert.equal(useAppStore.getState().generationConversationId, null);
  const user: ChatMessage = { id: 'original-user', conversationId: 'A', role: 'user', content: 'original', createdAt: '' };
  const branch = useAppStore.getState().regenerateMessage(user);
  await useAppStore.getState().selectConversation('B');
  resolveBranch([user]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(useAppStore.getState().activeId, 'B');
  assert.equal(useAppStore.getState().generationConversationId, 'A');
  assert.equal(useAppStore.getState().messages.length, 0);
  await useAppStore.getState().selectConversation('A');
  const regeneratedId = useAppStore.getState().generationId!;
  assert(regeneratedId && regeneratedId !== generationId);
  useAppStore.getState().handleStream({ type: 'done', conversationId: 'A', generationId: regeneratedId, assistant });
  finish(); await branch;
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
