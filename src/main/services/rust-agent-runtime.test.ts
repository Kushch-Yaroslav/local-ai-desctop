import { setLanguage } from '../../shared/locale';
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
  const budget = { used: 140, limit: 160, maximum: 256, extensions: 1, decision: 'extended', reason: 'changed_code_check_passed' };
  assert.deepEqual(taskPlan({ milestones: [], workBudget: budget }).workBudget, budget, 'saved budget projection must survive normalization');
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
  if (request.type === 'run') {
    out({ type: 'work_budget', budget: { used: 140, limit: 160, maximum: 256, extensions: 1, decision: 'extended', reason: 'changed_code_check_passed' } });
    out({ type: 'thinking_delta', content: 'думаю' });
  }
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
      if (event.type === 'work-budget') assert.equal(event.budget.limit, 160);
      if (event.type === 'thinking') void runtime.steer('run-1', 'Пауза', 'pause');
    }
    assert.deepEqual(events.filter((type) => type !== 'token'), ['work-budget', 'thinking', 'steering', 'paused', 'done']);
    const requests = JSON.parse(readFileSync(received, 'utf8')) as Array<{ type: string; intent?: string }>;
    assert.equal(requests.find((request) => request.type === 'steer')?.intent, 'pause', 'the pause intent was not forwarded to the runtime');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function runFatalBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-fatal-bridge-'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const script = join(dir, 'fake-runtime.js');
    writeFileSync(script, `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line', () => {
 process.stdout.write(JSON.stringify({type:'agent_error',message:'model HTTP status: HTTP/1.1 500 Internal Server Error'}) + '\\n');
});
`);
    chmodSync(script, 0o755);
    const events = [];
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script);
    for await (const event of runtime.stream('model', [message('user', 'task')], [], controller.signal, 4096, 'fast', 'off', 'failed-run', undefined, 'conversation')) events.push(event);
    assert.equal(controller.signal.aborted, false, 'fatal runtime events must end the stream without waiting for supervisor EOF');
    assert.deepEqual(events.map((event) => event.type), ['error']);
    await assert.rejects(runtime.steer('failed-run', 'continue'), /заверш|актив/i);
  } finally { clearTimeout(timeout); rmSync(dir, {recursive:true, force:true}); }
}
export async function runWorkerExitRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-worker-exit-'));
  try {
    for (const [name, body, executable, expected] of [
      ['unexecutable', '', false, 'error'],
      ['process-death', "process.stderr.write('worker died');process.exit(9)", true, 'error'],
      ['empty-stream', 'process.exit(0)', true, 'error'],
      ['stopped', "process.stdout.write(JSON.stringify({type:'agent_stopped'})+'\\n')", true, 'cancelled'],
    ] as const) {
      const script = join(dir, name + '.js');
      writeFileSync(script, `#!/usr/bin/env node\nrequire('node:readline').createInterface({input:process.stdin}).on('line',()=>{${body}});\n`);
      chmodSync(script, executable ? 0o755 : 0o600);
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const events = [];
        for await (const event of new RustAgentRuntime('http://127.0.0.1:1', script).stream('model', [message('user', 'task')], [], controller.signal, 4096, 'fast', 'off', name)) events.push(event);
        assert.equal(controller.signal.aborted, false, `${name}: terminal stream did not close`);
        assert.deepEqual(events.map(event => event.type), [expected], name);
        if (name === 'unexecutable') assert(events.some(event => event.type === 'error' && event.details?.includes('EACCES')));
      } finally { clearTimeout(timeout); }
    }
  } finally { rmSync(dir, { recursive:true, force:true }); }
}
if (require.main === module) {
  runRustAgentRuntimeRegression();
  void (async () => { await runSteeringBridgeRegression(); await runFatalBridgeRegression(); await runWorkerExitRegression(); })().catch((error: unknown) => {console.error(error); process.exitCode = 1;});
}

export async function runWebImageBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-web-images-'));
  try {
    for (const mode of ['auto', 'off'] as const) {
      setLanguage(mode === 'auto' ? 'en' : 'ru');
      const script = join(dir, `${mode}.js`), received = join(dir, `${mode}.json`);
      writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs'); let run;
const out = event => process.stdout.write(JSON.stringify(event)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.type === 'run') { run = request; out({type:'host_tool_call', id:'web-1', name:'web_open', arguments:{url:'https://example.com'}}); }
 if(request.type === 'host_tool_result') { fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify({run,result:request})); out({type:'final',content:'done'}); }
});`);
      chmodSync(script, 0o755);
      let opened = 0, closed = 0;
      const web = { openSession: async () => { opened++; return { execute: async (call: { name: string; arguments: unknown }) => { assert.equal(call.name, 'web_open'); assert.deepEqual(call.arguments, { url: 'https://example.com' }); return JSON.stringify({ title: 'Example', content: 'Public page', links: [] }); }, close: async () => { closed++; } }; } };
      const runtime = new RustAgentRuntime('http://127.0.0.1:1', script, web as unknown as import('../web/web-tools').WebBrowserService);
      const images = ['data:image/png;base64,iVBORw==', 'data:image/jpeg;base64,/9j/', 'data:image/webp;base64,UklGRg=='];
      const old = { ...message('user', 'old image'), images: [images[0]] };
      const current: ChatMessage = { ...message('user', 'new image'), images, attachments: images.map((_url, index) => ({
        id: `current-image-${index}`, messageId: 'current', index, kind: 'image', mimeType: 'image/png', filename: `${index}.png`, size: 4, storageRef: '/fixture', status: 'ready', createdAt: '', updatedAt: '',
      })) };
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
      try { for await (const _event of runtime.stream('model', [old, message('assistant', 'prior answer'), current], [], controller.signal, 32768, 'fast', mode, `web-${mode}`, undefined, undefined, true, { main: { chat_template_kwargs: { enable_thinking: mode === 'off' } } })) { assert.notEqual(_event.type, 'error'); } }
      finally { clearTimeout(timeout); }
      const request = JSON.parse(readFileSync(received, 'utf8'));
      assert.deepEqual(request.run.user_images, images); assert.deepEqual(request.run.user_image_refs, ['current-image-0', 'current-image-1', 'current-image-2']); assert.deepEqual(request.run.history[0].images, [images[0]]);
      assert.deepEqual(request.run.reasoning_options, { main: { chat_template_kwargs: { enable_thinking: mode === 'off' } } });
      assert.equal(request.run.supports_reasoning, true);
      assert.equal(request.run.ui_language, mode === 'auto' ? 'en' : 'ru');
      assert.match(request.run.system, mode === 'auto' ? /Interface language: English/ : /Язык интерфейса: русский/);
      assert.equal(request.run.web_tools.length, mode === 'auto' ? 5 : 0);
      assert.equal(opened, mode === 'auto' ? 1 : 0); assert.equal(closed, opened);
      if (mode === 'auto') assert.equal(request.result.result.content, 'Public page');
      else assert.match(request.result.result.error, /unavailable/);
    }
  } finally { setLanguage('ru'); rmSync(dir, { recursive: true, force: true }); }
}
if (require.main === module) void runWebImageBridgeRegression().catch(error => { console.error(error); process.exitCode = 1; });

export async function runWebCancellationRegression() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-web-cancel-'));
  try {
    const script = join(dir, 'worker.js');
    writeFileSync(script, `#!/usr/bin/env node
const out = event => process.stdout.write(JSON.stringify(event)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.type === 'run') out({type:'host_tool_call',id:'cancel-web',name:'web_read',arguments:{}});
 if(request.type === 'cancel') out({type:'agent_stopped'});
});`); chmodSync(script, 0o755);
    const controller = new AbortController(); let closed = 0;
    let fail: (error: Error) => void = () => {};
    const web = { openSession: async () => ({
      execute: async () => new Promise<string>((_resolve, reject) => { fail = reject; controller.abort(); }),
      close: async () => { closed++; fail(new Error('Browser cancelled')); },
    }) };
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script, web as unknown as import('../web/web-tools').WebBrowserService);
    const events: string[] = []; const timeout = setTimeout(() => controller.abort(), 3000);
    try { for await (const event of runtime.stream('model', [message('user', 'task')], [], controller.signal, 32768, 'fast', 'auto', 'cancel-web')) events.push(event.type); }
    finally { clearTimeout(timeout); }
    assert(closed > 0, 'Stop did not close the browser session'); assert(events.includes('cancelled'));
    const alreadyStopped = new AbortController(); alreadyStopped.abort();
    const early = [];
    for await (const event of new RustAgentRuntime('', '/does-not-exist').stream('model', [message('user', 'task')], [], alreadyStopped.signal, 32768, 'fast', 'auto', 'early')) early.push(event.type);
    assert.deepEqual(early, ['cancelled']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (require.main === module) void runWebCancellationRegression().catch(error => { console.error(error); process.exitCode = 1; });
