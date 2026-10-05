import assert from 'node:assert/strict';
import type { ChatMessage } from '../../shared/types';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RustAgentRuntime, runtimeTextEvent, splitAgentRunHistory, taskPlan } from './rust-agent-runtime';
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
    { id: 'd-001', text: 'режим «с ботом» выбирается в интерфейсе', status: 'verified', task: 'бот', proof: ['ev-002'] },
    { id: 'd-002', text: 'переключатель темы', status: 'pending' },
    { id: 'd-003', text: 'тема из чужого проекта', status: 'blocked', reason: 'папка недоступна' },
    { id: 'd-004', text: 'снято пользователем', status: 'dropped', reason: 'пользователь отказался' },
    { id: 'd-005', text: 'сохранение партии', status: 'implemented', failing: 'node check.js (exit 1)' },
    { id: 'd-006', text: 'старый формат', status: 'done' },
  ] } }) };
  assert.equal(toolResultSummary(deliverables), 'проверено 1 из 5 · реализовано, не проверено 2 · осталось 1', 'only verified items count as checked');
  assert.equal(displayToolResult(deliverables), '✓ режим «с ботом» выбирается в интерфейсе\n○ переключатель темы\n⊘ тема из чужого проекта — не выполнено: папка недоступна\n◐ сохранение партии — реализовано, не проверено; проверка не прошла: node check.js (exit 1)\n◐ старый формат — реализовано, не проверено', 'deliverables must render as a checklist, hide dropped items and never show implemented work as checked');
  const planActivity = { id: 'p', label: 'План выполнения', detail: 'plan', kind: 'planning' as const, state: 'completed' as const, output: JSON.stringify({ updated: true, plan: { steps: [{ id: 's1', text: 'прочитать код', status: 'completed' }, { id: 's2', text: 'добавить бота', status: 'in_progress' }, { id: 's3', text: 'запустить проверку', status: 'blocked', note: 'нет браузера' }] } }) };
  assert.equal(toolResultSummary(planActivity), 'шагов выполнено 1 из 3');
  assert.equal(displayToolResult(planActivity), '✓ прочитать код\n▶ добавить бота\n⊘ запустить проверку — нет браузера');
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

/** A stand-in runtime that speaks the stdin/stdout protocol: it checks that the structured pause intent reaches the
 * runtime and that its `run_paused` event surfaces as a distinct stream event before completion. */
export async function runSteeringBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-'));
  try {
    const script = join(dir, 'fake-runtime.js');
    const received = join(dir, 'received.json');
    writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
const seen = [];
rl.on('line', (line) => {
  const request = JSON.parse(line); seen.push(request);
  if (request.type === 'run') out({ type: 'thinking_delta', content: 'думаю' });
  if (request.type === 'steer') {
    fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify(seen));
    out({ type: 'steering_accepted' }); out({ type: 'steering_applied', content: request.content });
    out({ type: 'pause_started', source: 'user_control' }); out({ type: 'run_paused', checkpoint_turns: 1 });
    out({ type: 'final', content: 'Работа поставлена на паузу.' });
  }
});
`);
    chmodSync(script, 0o755);
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script);
    const controller = new AbortController();
    const events: string[] = [];
    for await (const event of runtime.stream('model', [message('user', 'task')], [], controller.signal, 4096, 'fast', 'off', 'run-1', undefined, 'conversation')) {
      events.push(event.type);
      if (event.type === 'thinking') void runtime.steer('run-1', 'Пауза', 'pause');
    }
    assert.deepEqual(events.filter((type) => type !== 'token'), ['thinking', 'steering', 'paused', 'done']);
    const requests = JSON.parse(readFileSync(received, 'utf8')) as Array<{ type: string; intent?: string }>;
    assert.equal(requests.find((request) => request.type === 'steer')?.intent, 'pause', 'the pause intent was not forwarded to the runtime');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) { runRustAgentRuntimeRegression(); void runSteeringBridgeRegression(); }
