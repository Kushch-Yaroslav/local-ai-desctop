import assert from 'node:assert/strict';
import { useAppStore } from '../renderer/store/app-store';
import { runTurnId, withRunHistory } from './run-history';
import { steeringMessageIds, thinkingTimeline } from './thinking-timeline';
import type { AnalysisRun, ChatMessage, ChatRequest, Conversation, StreamEvent, ThinkingTimelineEvent } from './types';
import type {} from '../renderer/env';

/** Renderer lifecycle: the post-Stop view, a chat switch and a fresh load from
 * persisted state all show the same history, and Continue appends after it. */
async function run(): Promise<void> {
  const chat = (id: string): Conversation => ({ id, title: id, modelId: 'model', mode: 'agent', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 16384, thinkingEnabled: null, reasoningEffort: null, reasoningMode: 'fast', contextTokens: null, contextModelId: null, webMode: 'off', createdAt: '', updatedAt: '' });
  const base = Date.now();
  const at = (second: number) => new Date(base + second * 1000).toISOString();
  // The persisted state a restart reads; the fake main process writes it like register-ipc does.
  const persistedMessages: ChatMessage[] = [];
  const persistedRuns: AnalysisRun[] = [];
  const sent: ChatRequest[] = [];
  let release!: () => void;
  const frames: Array<() => void> = [];
  const steering: ChatMessage = { id: 'steer-1', conversationId: 'A', role: 'user', content: 'Focus on captures', createdAt: at(30) };
  const timeline: ThinkingTimelineEvent[] = [
    { id: 'r1', kind: 'reasoning', content: 'Inspect first.', position: 1, startedAt: at(11), completedAt: at(12) },
    { id: 'a1', kind: 'activity', activityId: 'read-1', position: 2 },
    { id: 'a2', kind: 'activity', activityId: 'term-1', position: 3 },
    { id: 'steering-steer-1', kind: 'steering', messageId: steering.id, position: 4, status: 'applied' },
    { id: 'r2', kind: 'reasoning', content: 'After steering.', position: 5, startedAt: at(31), completedAt: at(40) },
  ];
  const stoppedRun: AnalysisRun = { id: 'run-1', conversationId: 'A', assistantMessageId: null, reasoningMode: 'fast', status: 'cancelled', actionCount: 2, createdAt: at(10), completedAt: at(40), timeline, partialOutput: 'Partial analysis',
    actions: [{ id: 'read-1', label: 'read', kind: 'file_read', state: 'completed', timelinePosition: 2 }, { id: 'term-1', label: 'terminal', kind: 'terminal', state: 'error', timelinePosition: 3 }] };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return 1; }, cancelAnimationFrame: () => {},
    localAi: { agentPlans: { get: async () => null },
      messages: { list: async (id: string) => persistedMessages.filter((message) => message.conversationId === id).map((message) => ({ ...message })) },
      analysis: { list: async (id: string) => persistedRuns.filter((entry) => entry.conversationId === id).map((entry) => structuredClone(entry)) },
      conversations: { create: async () => chat('C'), update: async (id: string) => chat(id) },
      chat: {
        send: async (request: ChatRequest) => { sent.push(request); persistedMessages.push({ ...request.messages.at(-1)!, createdAt: request.messages.at(-1)!.id === 'u1' ? at(5) : at(50) }); await new Promise<void>((resolve) => { release = resolve; }); },
        // Main finalizes the run, emits it, then reports the cancellation — before `chat:stop` resolves.
        stop: async (conversationId: string, generationId: string) => {
          persistedRuns.splice(0, persistedRuns.length, stoppedRun);
          useAppStore.getState().handleStream({ type: 'analysis-run', conversationId, generationId, run: structuredClone(stoppedRun) });
          useAppStore.getState().handleStream({ type: 'cancelled', conversationId, generationId });
          release();
        },
      },
    },
  } });
  const rendered = () => withRunHistory(useAppStore.getState().messages, useAppStore.getState().analysisRuns);
  const visibleIds = () => { const items = rendered(); const hidden = steeringMessageIds(items); return items.filter((message) => !hidden.has(message.id)).map((message) => message.id); };
  useAppStore.setState({ conversations: [chat('A'), chat('B')], activeId: 'A', messages: [], analysisRuns: [], settings: { llamaServerPath: null, modelsPath: '', llamaRuntime: { status: 'ready', modelId: 'model', contextWindow: 16_384 } } });

  const realUuid = crypto.randomUUID.bind(crypto); let ids = 0;
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => (++ids === 1 ? 'u1' : ids === 2 ? 'g1' : realUuid()) });
  const running = useAppStore.getState().sendMessage('Analyse the bot');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const generationId = useAppStore.getState().generationId!;
  const emit = (event: Partial<StreamEvent> & { type: string }) => useAppStore.getState().handleStream({ conversationId: 'A', generationId, ...event } as never);
  emit({ type: 'analysis-run', run: { ...stoppedRun, status: 'running', completedAt: null, timeline: undefined, partialOutput: undefined, actions: [] } });
  emit({ type: 'thinking', content: 'Inspect first.', timelinePosition: 1 });
  emit({ type: 'tool', activity: { id: 'read-1', label: 'read', kind: 'file_read', state: 'completed', timelinePosition: 2 } });
  emit({ type: 'tool', activity: { id: 'term-1', label: 'terminal', kind: 'terminal', state: 'error', timelinePosition: 3 } });
  persistedMessages.push(steering);
  emit({ type: 'steering', userMessage: steering, status: 'applied', timelinePosition: 4 });
  emit({ type: 'thinking', content: 'After steering.', timelinePosition: 5 });
  emit({ type: 'token', content: 'Partial analysis' });
  while (frames.length) frames.shift()!();
  const before = useAppStore.getState().messages.find((message) => message.id === `stream-${generationId}`)!;
  assert.deepEqual(visibleIds(), ['u1', before.id], 'live view: the steering message is embedded, not a bubble');
  const liveActivities = useAppStore.getState().toolActivities; const liveMessages = useAppStore.getState().messages;

  // Stalled generation → Stop
  await useAppStore.getState().stop();
  await running;
  assert.equal(useAppStore.getState().isGenerating, false);
  assert.equal(useAppStore.getState().generationConversationId, null, 'Stop releases ownership');
  const afterStop = rendered();
  assert.deepEqual(visibleIds(), ['u1', runTurnId('run-1')], 'the stopped run replaces the live turn instead of vanishing');
  const turn = afterStop.find((message) => message.id === runTurnId('run-1'))!;
  assert.equal(turn.agentCancelled, true);
  assert.equal(turn.content, 'Partial analysis');
  const items = thinkingTimeline(turn.thinking, stoppedRun.actions, false, turn.thinkingTimeline, afterStop);
  assert.deepEqual(items.map((item) => item.kind), ['reasoning', 'activity', 'activity', 'steering', 'reasoning'], 'every committed event remains after Stop');
  assert.deepEqual(thinkingTimeline(before.thinking, liveActivities, false, before.thinkingTimeline, liveMessages).map((item) => item.kind), items.map((item) => item.kind), 'the timeline before and after Stop has the same structure');

  // Switch chats and back, then a cold load (restart) from persisted state.
  await useAppStore.getState().selectConversation('B');
  await useAppStore.getState().selectConversation('A');
  assert.deepEqual(rendered(), afterStop, 'chat switch shows the same history');
  useAppStore.setState({ activeId: 'B', messages: [], analysisRuns: [] });
  const cold = withRunHistory(await window.localAi.messages.list('A'), await window.localAi.analysis.list('A'));
  assert.deepEqual(cold.map((message) => message.id), afterStop.map((message) => message.id), 'restart reconstructs the same turns');
  assert.deepEqual(cold.find((message) => message.id === runTurnId('run-1'))?.thinkingTimeline, turn.thinkingTimeline);
  assert.deepEqual([...steeringMessageIds(cold)], [steering.id], 'steering keeps its semantic type after restart');
  await useAppStore.getState().selectConversation('A');

  // Continue: the request carries only real messages; new events append after the preserved history.
  const continuing = useAppStore.getState().sendMessage('Continue');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert(!sent.at(-1)!.messages.some((message) => message.id.startsWith('run-') || message.id.startsWith('stream-')), 'synthetic history never reaches the model');
  const next = useAppStore.getState().generationId!;
  const assistant: ChatMessage = { id: 'a2', conversationId: 'A', role: 'assistant', content: 'Done', createdAt: at(60) };
  persistedMessages.push(assistant);
  useAppStore.getState().handleStream({ type: 'done', conversationId: 'A', generationId: next, assistant });
  release(); await continuing;
  const final = rendered();
  const hidden = steeringMessageIds(final);
  assert.deepEqual(final.filter((message) => !hidden.has(message.id)).map((message) => message.id).filter((id) => id !== sent.at(-1)!.messages.at(-1)!.id), ['u1', runTurnId('run-1'), 'a2']);
  assert.equal(final.at(-1)?.id, 'a2', 'new events append after the stopped run');
  assert.equal(new Set(final.map((message) => message.id)).size, final.length, 'no duplicated turns');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: realUuid });
  console.log('renderer Stop → switch → restart → Continue keeps the persisted Agent history');
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
