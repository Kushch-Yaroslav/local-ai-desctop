import assert from 'node:assert/strict';
import type { ChatMessage } from '../../shared/types';
import { splitAgentRunHistory, taskPlan, taskPlanUpdate } from './rust-agent-runtime';
import { displayToolResult, toolResultSummary } from '../../renderer/components/AgentTimeline';

const message = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: `${role}-${content}`, conversationId: 'test', role, content, createdAt: '2026-01-01T00:00:00.000Z',
});

/** Regression coverage for the Electron→Rust ownership boundary. In each
 * sequence the current prompt must remain a real user node, never an adjacent
 * project/system/assistant record. */
export function runRustAgentRuntimeRegression(): void {
  const scenarios = [
    [message('system', 'Project 1'), message('user', 'first prompt')],
    [message('user', 'old prompt'), message('assistant', 'old answer'), message('user', 'next prompt')],
    [message('system', 'Project 1'), message('user', 'old'), message('assistant', 'answer'), message('system', 'Project 2'), message('user', 'switched project')],
    [message('user', 'regenerated prompt'), message('assistant', 'optimistic placeholder')],
    [message('user', 'completed prompt'), message('assistant', 'completed answer'), message('user', 'next after completion')],
    [message('user', 'old compacted prompt'), message('assistant', 'summary'), message('system', 'compaction context'), message('user', 'next after compaction')],
  ];
  for (const history of scenarios) {
    const split = splitAgentRunHistory(history);
    const expected = history.filter((entry) => entry.role === 'user').at(-1)!;
    assert.equal(split.user, expected.content);
    assert(!split.prior.includes(expected));
  }
  assert.throws(() => splitAgentRunHistory([message('system', 'no prompt')]));
  const plan = taskPlan({ milestones: [{ id: 'goal-1', label: 'Inspect', status: 'in_progress', work_plan: { tasks: [{ id: 'work-1', label: 'Read runtime', status: 'completed' }, { id: 'work-2', label: 'Map IPC', status: 'in_progress' }] } }], active_milestone_id: 'goal-1' });
  assert.equal(plan.activeMilestoneId, 'goal-1');
  assert.equal(plan.milestones?.[0]?.id, 'goal-1');
  assert.equal(plan.milestones?.[0]?.workPlan.tasks[1]?.id, 'work-2');
  const todoPlan = taskPlan({
    milestones: [{ id: 'goal-1', label: 'Inspect', status: 'in_progress', work_plan: { tasks: [{ id: 'work-1', label: 'Read runtime', status: 'in_progress' }] } }],
    model_todo: { phases: [{ name: 'Inspect', items: [{ id: 'todo-1', content: 'Read runtime', status: 'in_progress' }] }], revision: 3 },
  });
  assert.equal(todoPlan.modelTodo?.revision, 3);
  assert.equal(todoPlan.modelTodo?.phases[0]?.items[0]?.content, 'Read runtime');
  assert.deepEqual(todoPlan.modelTodo?.phases.flatMap((phase) => phase.items).map((item) => item.content), ['Read runtime'], 'Task Planning receives canonical Todo items instead of needing projected work-plan tasks');
  const knowledgeActivity = { id: 'knowledge', label: 'Project knowledge', detail: 'project_knowledge_read', kind: 'file_read' as const, state: 'completed' as const, output: JSON.stringify({ entries: [{ status: 'ok', path: 'sources/App.tsx', content: 'large cached body' }, { status: 'missing', path: 'tasks/audit.md', message: 'not materialized' }] }) };
  assert.equal(displayToolResult(knowledgeActivity), 'sources/App.tsx\ntasks/audit.md · missing · not materialized', 'structured knowledge entries must not render as object coercions or cached bodies');
  assert.match(toolResultSummary(knowledgeActivity) ?? '', /^2 knowledge entries/);
  const legacy = taskPlan({ steps: [{ id: 'legacy-task', label: 'Old item', status: 'completed' }] });
  assert.equal(legacy.milestones?.[0]?.workPlan.tasks[0]?.id, 'legacy-task');

  const snapshot = (tasks: Array<'pending' | 'in_progress' | 'completed'>) => ({
    milestones: Array.from({ length: 6 }, (_, index) => ({
      id: `milestone-${index + 1}`,
      label: `Milestone ${index + 1}`,
      status: index === 0 ? 'in_progress' : 'pending',
      work_plan: { tasks: index === 0 ? tasks.map((status, taskIndex) => ({ id: `task-${taskIndex + 1}`, label: `Task ${taskIndex + 1}`, status })) : [] },
    })),
    active_milestone_id: 'milestone-1',
  });
  let uiPlan = taskPlanUpdate({ type: 'plan_update', plan: snapshot([]) })!;
  assert.equal(uiPlan.milestones?.length, 6);
  assert.equal(uiPlan.activeMilestoneId, 'milestone-1');

  uiPlan = taskPlanUpdate({ type: 'plan_update', plan: snapshot(['in_progress', 'pending', 'pending']) })!;
  assert.equal(uiPlan.milestones?.[0]?.workPlan.tasks.length, 3);
  uiPlan = taskPlanUpdate({ type: 'plan_update', plan: snapshot(['completed', 'in_progress', 'pending']) })!;
  assert.equal(uiPlan.milestones?.[0]?.workPlan.tasks.filter((task) => task.status === 'completed').length, 1);
  uiPlan = taskPlanUpdate({ type: 'plan_update', plan: snapshot(['completed', 'completed', 'in_progress']) })!;
  assert.equal(uiPlan.milestones?.[0]?.workPlan.tasks.filter((task) => task.status === 'completed').length, 2);
  assert.equal(uiPlan.milestones?.[0]?.workPlan.tasks[2]?.status, 'in_progress');

  // Context events, including the new telemetry, carry no plan and must leave
  // the last UI-facing canonical snapshot untouched.
  for (const type of ['context_optimized', 'compaction_diagnostics', 'unknown_diagnostic']) {
    assert.equal(taskPlanUpdate({ type }), undefined);
  }
  assert.equal(taskPlanUpdate({ type: 'plan_update', plan: { milestones: [] } }), undefined);
  assert.equal(uiPlan.milestones?.length, 6);
  assert.equal(uiPlan.milestones?.[0]?.workPlan.tasks[2]?.status, 'in_progress');

  const resumed = taskPlan(uiPlan);
  assert.equal(resumed.milestones?.length, 6);
  assert.equal(resumed.milestones?.[0]?.workPlan.tasks.length, 3);
  assert.equal(resumed.milestones?.[0]?.workPlan.tasks[2]?.status, 'in_progress');
}

if (require.main === module) runRustAgentRuntimeRegression();
