import assert from 'node:assert/strict';
import { appendPausedMarker, appendReasoningFragments, applySteeringEvent, pendingTimelineActivities, steeringMessageIds, thinkingTimeline } from './thinking-timeline';
import type { ChatMessage, ThinkingTimelineEvent } from './types';

export function runThinkingTimelineRegression(): void {
  const items = thinkingTimeline('First reasoning phase.\nStill the same phase.\n\nSecond reasoning phase.', [{ id: 'plan', label: 'Task Plan updated', kind: 'planning', state: 'completed' }], true);
  assert.deepEqual(items.map((item) => item.kind), ['activity', 'reasoning', 'reasoning'], 'timeline did not keep Agent activity followed by paragraph-level reasoning');
  assert.equal(items[1]?.kind === 'reasoning' && items[1].content, 'First reasoning phase.\nStill the same phase.', 'a single reasoning phase was split too eagerly');
  assert.equal(items[2]?.kind === 'reasoning' && items[2].live, true, 'only the current reasoning phase should be live');
  const chronological = thinkingTimeline(undefined, [
    { id: 'terminal', label: 'Terminal', kind: 'terminal', state: 'completed' },
    { id: 'plan', label: 'Plan', kind: 'planning', state: 'completed' },
    { id: 'approval', label: 'Apply patch', kind: 'mutation', approval: { approvalId: 'approval-1', category: 'system_command', status: 'pending' } },
  ], true, [
    { id: 'r1', kind: 'reasoning', content: 'First phase.', position: 1 },
    { id: 'a1', kind: 'activity', activityId: 'terminal', position: 2 },
    { id: 'a1-complete', kind: 'activity', activityId: 'terminal', position: 2.5 },
    { id: 'r2', kind: 'reasoning', content: 'Second phase.\n\nCurrent phase.', position: 3 },
    { id: 'a2', kind: 'activity', activityId: 'plan', position: 4 },
    { id: 'a3', kind: 'activity', activityId: 'approval', position: 5 },
  ]);
  assert.deepEqual(chronological.map((item) => item.kind === 'reasoning' ? item.content : item.kind === 'activity' ? item.activity.id : item.kind === 'steering' ? item.message.content : item.kind), ['First phase.', 'terminal', 'Second phase.', 'Current phase.', 'plan', 'approval'], 'recorded reasoning and Agent events were not interleaved by position');
  assert.equal(chronological[3]?.kind === 'reasoning' && chronological[3].live, false, 'reasoning before a later activity must be finalized');
  assert.deepEqual(pendingTimelineActivities(chronological).map((item) => item.activity.id), ['approval'], 'pending approval selection did not use the chronological timeline');

  const first: ChatMessage = { id: 'steering-1', conversationId: 'chat', role: 'user', content: 'Поправка, напиши ещё плюсы и минусы.', createdAt: '' };
  const second: ChatMessage = { ...first, id: 'steering-2' };
  const steered = thinkingTimeline(undefined, [{ id: 'after-steering', label: 'Continue', kind: 'progress', state: 'completed' }], false, [
    { id: 'r1', kind: 'reasoning', content: 'Initial thought.', position: 1 },
    { id: 's1', kind: 'steering', messageId: first.id, position: 2, status: 'applied' },
    { id: 's2', kind: 'steering', messageId: second.id, position: 3, status: 'accepted' },
    { id: 's1-duplicate', kind: 'steering', messageId: first.id, position: 4, status: 'applied' },
    { id: 'a1', kind: 'activity', activityId: 'after-steering', position: 5 },
  ], [first, second]);
  assert.deepEqual(steered.map((item) => item.kind === 'reasoning' ? item.content : item.kind === 'steering' ? `${item.status}:${item.message.id}` : item.kind === 'activity' ? item.activity.id : item.kind), [
    'Initial thought.', 'applied:steering-1', 'accepted:steering-2', 'after-steering',
  ], 'steering messages were not deduplicated or retained in timeline order');
  assert.deepEqual(steered.filter((item) => item.kind === 'steering').map((item) => item.message.content), [first.content, second.content], 'canonical steering message text changed in presentation');
  const unrelated: ChatMessage = { ...first, id: 'ordinary-followup', content: 'A later regular user message' };
  const transcript = [first, second, unrelated, { id: 'assistant', conversationId: 'chat', role: 'assistant' as const, content: 'Done', createdAt: '', thinkingTimeline: [
    { id: 's1', kind: 'steering' as const, messageId: first.id, position: 1, status: 'applied' as const },
    { id: 's2', kind: 'steering' as const, messageId: second.id, position: 2, status: 'accepted' as const },
    { id: 'bad', kind: 'steering' as const, messageId: 'missing-user', position: 3, status: 'accepted' as const },
  ] }];
  assert.deepEqual([...steeringMessageIds(transcript)], [first.id, second.id], 'only canonical messages explicitly referenced by this run should be embedded');


// A1: a steering message that is accepted while the model is still reasoning stays pending until the runtime applies it.
{
  const message: ChatMessage = { id: 'clarify', conversationId: 'chat', role: 'user', content: 'Уточнение', createdAt: '' };
  let events: ThinkingTimelineEvent[] = appendReasoningFragments([], [{ content: 'Начало размышления. ', timelinePosition: 1 }]);
  events = applySteeringEvent(events, message.id, 'accepted');
  events = appendReasoningFragments(events, [{ content: 'Продолжение того же размышления.', timelinePosition: 1 }]);
  assert.equal(events.filter((event) => event.kind === 'reasoning').length, 1, 'reasoning after an accepted clarification must continue the same entry');
  const pending = thinkingTimeline(undefined, [], true, events, [message]);
  assert.deepEqual(pending.map((item) => item.kind), ['reasoning', 'steering'], 'pending clarification must sort after the reasoning it did not interrupt');
  assert.equal(pending[0]?.kind === 'reasoning' && pending[0].live, true, 'a pending clarification must not make the active reasoning look finished');
  assert.equal(pending[1]?.kind === 'steering' && pending[1].status, 'accepted');
  assert.strictEqual(applySteeringEvent(events, message.id, 'accepted'), events, 'repeating accepted must be a no-op');
  assert.strictEqual(applySteeringEvent(events, 'unknown', 'applied'), events, 'applied without a position or a pending entry must be ignored');

  events = applySteeringEvent(events, message.id, 'applied', 2);
  events = appendReasoningFragments(events, [{ content: 'Размышление после уточнения.', timelinePosition: 3 }]);
  const applied = thinkingTimeline(undefined, [], true, events, [message]);
  assert.deepEqual(applied.map((item) => item.kind), ['reasoning', 'steering', 'reasoning'], 'applied clarification must sit between the reasoning that preceded and followed it');
  assert.equal(applied[1]?.kind === 'steering' && applied[1].status, 'applied');
  assert.equal(applied[1]?.id, 'steering-clarify', 'the entry id must be stable across accepted → applied');
  assert.equal(applied[2]?.kind === 'reasoning' && applied[2].live, true);

  const withPause = appendPausedMarker(events, 4);
  assert.deepEqual(thinkingTimeline(undefined, [], false, withPause, [message]).map((item) => item.kind), ['reasoning', 'steering', 'reasoning', 'paused']);
  assert.strictEqual(appendPausedMarker(withPause, 5), withPause, 'a run records at most one pause marker');
}

}

if (require.main === module) runThinkingTimelineRegression();
