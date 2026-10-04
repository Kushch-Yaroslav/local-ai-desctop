import assert from 'node:assert/strict';
import { pendingTimelineActivities, steeringMessageIds, thinkingTimeline } from './thinking-timeline';
import type { ChatMessage } from './types';

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
  assert.deepEqual(chronological.map((item) => item.kind === 'reasoning' ? item.content : item.kind === 'activity' ? item.activity.id : item.message.content), ['First phase.', 'terminal', 'Second phase.', 'Current phase.', 'plan', 'approval'], 'recorded reasoning and Agent events were not interleaved by position');
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
  assert.deepEqual(steered.map((item) => item.kind === 'reasoning' ? item.content : item.kind === 'steering' ? `${item.status}:${item.message.id}` : item.activity.id), [
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
}

if (require.main === module) runThinkingTimelineRegression();
