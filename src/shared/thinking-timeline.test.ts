import assert from 'node:assert/strict';
import { pendingTimelineActivities, thinkingTimeline } from './thinking-timeline';

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
  assert.deepEqual(chronological.map((item) => item.kind === 'reasoning' ? item.content : item.activity.id), ['First phase.', 'terminal', 'Second phase.', 'Current phase.', 'plan', 'approval'], 'recorded reasoning and Agent events were not interleaved by position');
  assert.equal(chronological[3]?.kind === 'reasoning' && chronological[3].live, false, 'reasoning before a later activity must be finalized');
  assert.deepEqual(pendingTimelineActivities(chronological).map((item) => item.activity.id), ['approval'], 'pending approval selection did not use the chronological timeline');
}

if (require.main === module) runThinkingTimelineRegression();
