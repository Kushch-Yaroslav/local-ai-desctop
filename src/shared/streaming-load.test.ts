import assert from 'node:assert/strict';
import { useAppStore } from '../renderer/store/app-store';
import { appendReasoningFragments, thinkingTimeline } from './thinking-timeline';
import type { ChatMessage, Conversation, ThinkingTimelineEvent } from './types';
import type {} from '../renderer/env';

const conversation: Conversation = { id: 'A', title: 'A', modelId: 'model', mode: 'agent', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 16384, thinkingEnabled: null, reasoningEffort: null, reasoningMode: 'deep', contextTokens: null, contextModelId: null, webMode: 'off', createdAt: '', updatedAt: '' };

export async function runStreamingLoadRegression(): Promise<void> {
  // --- The race that fragmented the timeline: the tool event is applied at once, the last reasoning fragments wait for the next frame.
  const first = appendReasoningFragments([], [{ content: 'I should ', timelinePosition: 1 }]);
  const withTool: ThinkingTimelineEvent[] = [...first, { id: 'activity-t', kind: 'activity', activityId: 't', position: 2 }];
  const merged = appendReasoningFragments(withTool, [{ content: 'read it.', timelinePosition: 1 }, { content: ' Then edit.', timelinePosition: 1 }]);
  assert.equal(merged.filter((entry) => entry.kind === 'reasoning').length, 1, 'a late fragment created a second entry for the same position');
  assert.equal(new Set(merged.map((entry) => entry.id)).size, merged.length, 'timeline ids must be unique (React keys)');
  const thought = merged.find((entry) => entry.kind === 'reasoning');
  assert.equal(thought?.kind === 'reasoning' && thought.content, 'I should read it. Then edit.', 'one thought was broken into separate pieces');
  assert.equal(merged[1], withTool[1], 'an entry that did not change lost its identity');
  assert.equal(appendReasoningFragments(withTool, []), withTool, 'an empty batch must not copy the timeline');
  assert.deepEqual(appendReasoningFragments(withTool, [{ content: 'ignored without a position' }]).length, withTool.length, 'a fragment without a position must not create an entry');

  // --- A long Agent run through the real store: 40 000 reasoning fragments, 600 tool events with terminal output lines.
  const frames: Array<() => void> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; }, cancelAnimationFrame: () => {},
    localAi: { messages: { list: async () => [] as ChatMessage[] }, analysis: { list: async () => [] }, conversations: { create: async () => conversation, delete: async () => {} }, chat: { send: () => new Promise<void>(() => {}), stop: async () => {} } },
  } });
  useAppStore.setState({ conversations: [conversation], activeId: 'A', messages: [] });
  void useAppStore.getState().sendMessage('long task');
  const generationId = useAppStore.getState().generationId!;
  const emit = (event: Record<string, unknown>) => useAppStore.getState().handleStream({ conversationId: 'A', generationId, ...event } as Parameters<ReturnType<typeof useAppStore.getState>['handleStream']>[0]);
  const drain = () => { while (frames.length) frames.shift()!(); };
  let notifications = 0;
  const unsubscribe = useAppStore.subscribe(() => { notifications += 1; });

  const turns = 600; const fragmentsPerTurn = 66; let position = 0; const spans: number[] = []; let events = 0;
  const started = performance.now();
  for (let turn = 0; turn < turns; turn += 1) {
    const reasoningPosition = ++position;
    const turnStart = performance.now();
    for (let piece = 0; piece < fragmentsPerTurn; piece += 1) {
      emit({ type: 'thinking', content: piece % 20 === 19 ? 'a sentence ends.\n\n' : 'word ', timelinePosition: reasoningPosition }); events += 1;
      if (piece % 11 === 10) drain(); // the animation frame lands in the middle of the turn
    }
    const actionPosition = ++position;
    emit({ type: 'tool', activity: { id: `a${turn}`, label: 'Запуск terminal', kind: 'terminal', state: 'running', timelinePosition: actionPosition } }); events += 1;
    for (let line = 0; line < 3; line += 1) { emit({ type: 'tool', activity: { id: `a${turn}`, label: 'Запуск terminal', kind: 'terminal', state: 'running', terminal: { stdout: `line ${line}\n` }, timelinePosition: actionPosition } }); events += 1; }
    emit({ type: 'tool', activity: { id: `a${turn}`, label: 'Запуск terminal', kind: 'terminal', state: 'completed', timelinePosition: actionPosition } }); events += 1;
    drain(); // the final fragments of this turn are still pending when its tool event has already been applied
    spans.push(performance.now() - turnStart);
  }
  const elapsed = performance.now() - started;
  unsubscribe();

  const message = useAppStore.getState().messages.find((entry) => entry.id.startsWith('stream-'))!;
  const timeline = message.thinkingTimeline!;
  assert.equal(timeline.length, turns * 2, 'every turn must yield exactly one reasoning entry and one activity entry');
  assert.equal(new Set(timeline.map((entry) => entry.id)).size, timeline.length, 'duplicate timeline ids over a long run');
  const reasoning = timeline.filter((entry): entry is Extract<ThinkingTimelineEvent, { kind: 'reasoning' }> => entry.kind === 'reasoning');
  assert.ok(reasoning.every((entry) => entry.content.split('word ').length - 1 + entry.content.split('a sentence ends.').length - 1 === fragmentsPerTurn), 'reasoning text was lost or split across entries');
  assert.equal(message.thinking!.length, reasoning.reduce((sum, entry) => sum + entry.content.length, 0), 'aggregate thinking and timeline diverged');

  // Rendering model: finished thoughts are split once and their items are reused, so a frame does not re-split the history.
  const activities = useAppStore.getState().toolActivities;
  const render1 = thinkingTimeline(message.thinking, activities, true, timeline, []);
  const render2 = thinkingTimeline(message.thinking, activities, true, timeline, []);
  const reused = render1.filter((item, index) => item.kind === 'reasoning' && !item.live && item === render2[index]).length;
  const finished = render1.filter((item) => item.kind === 'reasoning' && !item.live).length;
  assert.ok(finished >= turns * 3 && reused === finished, `finished paragraphs are rebuilt on every render (${reused}/${finished} reused)`);
  assert.equal(render1.filter((item) => item.kind === 'reasoning' && item.live).length, 0, 'nothing is live once an action follows the last thought');

  // Store notifications track what changed, not how many fragments arrived (one per frame/tool event, never one per token).
  assert.ok(notifications < events * 0.4, `${notifications} store notifications for ${events} events: per-token updates are back`);
  // Work per turn stays flat as the run grows (generous, to stay stable on slow machines): the last tenth costs no more than ~4x the first tenth.
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const early = average(spans.slice(0, turns / 10)); const late = average(spans.slice(-turns / 10));
  assert.ok(late < Math.max(early * 4, 2), `per-turn work grew with history: early ${early.toFixed(3)} ms, late ${late.toFixed(3)} ms`);
  assert.ok(elapsed < 8_000, `a ${turns}-turn run took ${Math.round(elapsed)} ms to process`);
}

if (require.main === module) void runStreamingLoadRegression().then(() => process.exit(0)).catch((error: unknown) => { console.error(error); process.exit(1); });
