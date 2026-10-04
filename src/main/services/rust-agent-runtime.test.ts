import assert from 'node:assert/strict';
import type { ChatMessage } from '../../shared/types';
import { runtimeTextEvent, splitAgentRunHistory, taskPlan } from './rust-agent-runtime';
import { deliverablesChecklist, displayToolResult, toolResultSummary } from '../../renderer/components/AgentTimeline';

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
  const knowledgeActivity = { id: 'knowledge', label: 'Project knowledge', detail: 'project_knowledge_read', kind: 'file_read' as const, state: 'completed' as const, output: JSON.stringify({ entries: [{ status: 'ok', path: 'sources/App.tsx', content: 'large cached body' }, { status: 'missing', path: 'tasks/audit.md', message: 'not materialized' }] }) };
  assert.equal(displayToolResult(knowledgeActivity), 'sources/App.tsx\ntasks/audit.md · missing · not materialized', 'structured knowledge entries must not render as object coercions or cached bodies');
  assert.match(toolResultSummary(knowledgeActivity) ?? '', /^2 записи знаний/);
  const partialTerminal = { ...knowledgeActivity, kind: 'terminal' as const, output: JSON.stringify({ command: 'rg api src | head -n 1', exit_code: 141, status: 'partial_success', stdout: 'src/App.tsx:1: api' }) };
  assert.match(displayToolResult(partialTerminal) ?? '', /частичный результат поиска/);
  const deliverables = { id: 'd', label: 'Требуемый результат', detail: 'deliverables', kind: 'planning' as const, state: 'completed' as const, output: JSON.stringify({ updated: true, deliverables: { items: [
    { id: 'd-001', text: 'режим «с ботом» выбирается в интерфейсе', status: 'done', task: 'бот' },
    { id: 'd-002', text: 'переключатель темы', status: 'pending' },
    { id: 'd-003', text: 'тема из чужого проекта', status: 'blocked', reason: 'папка недоступна' },
    { id: 'd-004', text: 'снято пользователем', status: 'dropped', reason: 'пользователь отказался' },
  ] } }) };
  assert.equal(toolResultSummary(deliverables), 'выполнено 1 из 3 · осталось 1', 'the deliverables row must summarize progress');
  assert.equal(displayToolResult(deliverables), '✓ режим «с ботом» выбирается в интерфейсе\n○ переключатель темы\n⊘ тема из чужого проекта — не выполнено: папка недоступна', 'deliverables must render as a checklist and hide dropped items');
  assert.equal(deliverablesChecklist('not json'), undefined);
  assert.equal(deliverablesChecklist(JSON.stringify({ other: 1 })), undefined);
  const legacy = taskPlan({ steps: [{ id: 'legacy-task', label: 'Old item', status: 'completed' }] });
  assert.equal(legacy.milestones?.[0]?.workPlan.tasks[0]?.id, 'legacy-task');

  const statusAndFinal = [
    runtimeTextEvent({ type: 'agent_status', content: 'Planning the audit' }, 'run', 1),
    runtimeTextEvent({ type: 'agent_status', content: 'Continuing source inspection' }, 'run', 2),
    runtimeTextEvent({ type: 'content_delta', content: 'Accepted final answer' }, 'run', 2),
  ];
  assert.deepEqual(statusAndFinal.map((event) => event?.type), ['tool', 'tool', 'token']);
  assert.equal(statusAndFinal.filter((event) => event?.type === 'token').map((event) => event?.type === 'token' ? event.content : '').join(''), 'Accepted final answer');
  assert.equal(statusAndFinal[0]?.type === 'tool' && statusAndFinal[0].activity.kind, 'progress');
  assert.equal(statusAndFinal[1]?.type === 'tool' && statusAndFinal[1].activity.output, 'Continuing source inspection');
  assert.equal(runtimeTextEvent({ type: 'withheld_draft', content: 'Rejected answer' }, 'run', 2), null);

}

if (require.main === module) runRustAgentRuntimeRegression();
