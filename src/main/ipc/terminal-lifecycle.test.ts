import assert from 'node:assert/strict';
import Module from 'node:module';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisRun, ChatMessage, ChatRequest, Conversation, StreamEvent } from '../../shared/types';
import type { LlamaRuntimeState } from '../services/llama-runtime-controller';

type Sent = StreamEvent & { conversationId: string; generationId?: string };

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error(`timed out waiting for ${label}`);
};

/** The worker emits the exact JSON lines of the Rust runtime for one scenario,
 * so the real event mapping, IPC lifecycle and SQLite merge are exercised. A
 * `stall` line waits for Stop; the worker then reports `agent_stopped`. */
const WORKER = `#!/usr/bin/env node
const lines = JSON.parse(require('node:fs').readFileSync(process.env.TERMINAL_LIFECYCLE_SCENARIO, 'utf8'));
let started = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'cancel') { process.stdout.write(JSON.stringify({ type: 'agent_stopped', reason: 'cancelled' }) + '\\n'); return; }
  if (request.type !== 'run' || started) return;
  started = true;
  for (const event of lines) { if (event === 'stall') return; process.stdout.write(JSON.stringify(event) + '\\n'); }
});
`;

const started = (id: string, command: string) => ({ type: 'tool_call_started', id, name: 'run_terminal', arguments: { command } });
const processStarted = (id: string, command: string, pid: number) => ({ type: 'tool_process_started', id, command, cwd: '/project', pid, pgid: pid, session_id: pid, started_at: 1_700_000_000_000 });
const execution = (command: string, pid: number, exitCode: number | null, status: string, stdout: string, stderr = '') => ({ command, cwd: '/project', pid, pgid: pid, session_id: pid, started_at: 1_700_000_000_000, finished_at: 1_700_000_001_000, exit_code: exitCode, timed_out: false, cancelled: false, status, stdout, stderr });
const answer = [{ type: 'content_delta', content: 'Done.' }, { type: 'final', complete: true, continuation_count: 0, chars: 5, finish_reason: 'stop' }];

interface Case {
  name: string;
  events: unknown[];
  status: AnalysisRun['status'];
  /** Expected final state of each terminal card, by stable call ID. */
  cards: Record<string, { command: string; state: 'completed' | 'error'; status: string; pid?: number; exitCode?: number | null; stdout?: string }>;
}

const CASES: Case[] = [
  { name: 'terminal success', status: 'completed', events: [
    started('call-ok', 'node test.js'), processStarted('call-ok', 'node test.js', 101),
    { type: 'tool_output_delta', id: 'call-ok', stream: 'stdout', content: 'ok 1' },
    { type: 'tool_result', id: 'call-ok', name: 'run_terminal', content: JSON.stringify(execution('node test.js', 101, 0, 'completed', 'ok 1\n')), is_error: false, diff: null },
    ...answer,
  ], cards: { 'call-ok': { command: 'node test.js', state: 'completed', status: 'completed', pid: 101, exitCode: 0, stdout: 'ok 1\n' } } },
  { name: 'terminal failure', status: 'completed', events: [
    // The reproduced failure: a composed command is refused before any
    // process starts, and the model's retry is a new call with a new ID.
    started('call-refused', 'cd /project && node test.js'),
    { type: 'tool_error', id: 'call-refused', name: 'run_terminal', message: 'approval required: this command uses shell composition (&&, ||, ;, redirection, substitution, a wrapper) or affects the user session, and it was not run.' },
    started('call-fail', 'node test.js'), processStarted('call-fail', 'node test.js', 202),
    { type: 'tool_output_delta', id: 'call-fail', stream: 'stderr', content: 'AssertionError' },
    { type: 'tool_error', id: 'call-fail', name: 'run_terminal', message: JSON.stringify({ error: 'terminal execution failed', execution: execution('node test.js', 202, 1, 'error', '', 'AssertionError\n') }) },
    started('call-exit', 'node lint.js'), processStarted('call-exit', 'node lint.js', 203),
    { type: 'tool_result', id: 'call-exit', name: 'run_terminal', content: JSON.stringify(execution('node lint.js', 203, 2, 'error', 'lint failed\n')), is_error: true, diff: null },
    ...answer,
  ], cards: {
    'call-refused': { command: 'cd /project && node test.js', state: 'error', status: 'error' },
    'call-fail': { command: 'node test.js', state: 'error', status: 'error', pid: 202, exitCode: 1 },
    'call-exit': { command: 'node lint.js', state: 'error', status: 'error', pid: 203, exitCode: 2, stdout: 'lint failed\n' },
  } },
  { name: 'Stop while terminal is running', status: 'cancelled', events: [
    started('call-stop', 'node bench.js'), processStarted('call-stop', 'node bench.js', 303),
    { type: 'tool_output_delta', id: 'call-stop', stream: 'stdout', content: 'warming up' },
    'stall',
  ], cards: { 'call-stop': { command: 'node bench.js', state: 'error', status: 'cancelled', pid: 303 } } },
  { name: 'Agent failure while terminal is running', status: 'error', events: [
    started('call-crash', 'npm test'), processStarted('call-crash', 'npm test', 404),
    { type: 'agent_error', code: 'repetition_loop', message: 'the model repeated itself' },
  ], cards: { 'call-crash': { command: 'npm test', state: 'error', status: 'error', pid: 404 } } },
];

/** Production IPC + the real Rust event mapping + real SQLite: a terminal call
 * and its result share one stable call ID and render as one finished card. */
async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lad-terminal-lifecycle-'));
  process.env.LOCAL_AI_RUNTIME_ROOT = root;
  const worker = join(root, 'fake-runtime.js');
  writeFileSync(worker, WORKER);
  chmodSync(worker, 0o755);
  process.env.LOCAL_AI_AGENT_RUNTIME = worker;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, ...args) => name === 'electron' ? { ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } } : originalLoad(name, ...args);
  const { ensureAppDirectories } = await import('../services/paths'); ensureAppDirectories();
  const { Database } = await import('../services/database');
  const { LlamaRuntimeController } = await import('../services/llama-runtime-controller');
  const { LlamaCppBackend } = await import('../backends/llama-cpp-backend');
  const { withRunHistory } = await import('../../shared/run-history');
  const { thinkingTimeline } = await import('../../shared/thinking-timeline');
  let runtime: LlamaRuntimeState = { status: 'idle', modelId: null, contextWindow: null };
  LlamaRuntimeController.prototype.state = async () => runtime;
  LlamaRuntimeController.prototype.switchTo = async (modelId, contextWindow) => { runtime = { status: 'ready', modelId, contextWindow }; return { ok: true, state: runtime }; };
  LlamaCppBackend.prototype.ensureModelAvailable = async () => {};
  LlamaCppBackend.prototype.resolveContextWindow = async (_model, requested) => ({ requested, active: requested, supported: requested });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const events: Sent[] = [];
  const invoke = async <T>(channel: string, ...args: unknown[]) => await handlers.get(channel)!({ sender: { send: (_channel: string, event: Sent) => events.push(event) } }, ...args) as T;
  const db = new Database();
  try {
    const { registerIpc } = await import('./register-ipc'); registerIpc();
    const model = 'qwen3.8:27b-q4_K_M';
    mkdirSync(join(root, 'project'));
    for (const [index, scenario] of CASES.entries()) {
      const chat = await invoke<Conversation>('conversations:create');
      await invoke('conversations:update', chat.id, { modelId: model, mode: 'agent', webMode: 'off', workingDirectory: join(root, 'project') });
      const scenarioFile = join(root, `scenario-${index}.json`);
      writeFileSync(scenarioFile, JSON.stringify(scenario.events));
      process.env.TERMINAL_LIFECYCLE_SCENARIO = scenarioFile;
      const generationId = `gen-${index}`;
      const request: ChatRequest = { conversationId: chat.id, generationId, model, persistUserMessage: true, messages: [{ id: `${generationId}-user`, conversationId: chat.id, role: 'user', content: scenario.name, createdAt: new Date().toISOString() } as ChatMessage] };
      const sending = invoke('chat:send', request);
      if (scenario.status === 'cancelled') {
        const [id] = Object.keys(scenario.cards);
        await waitUntil(() => events.some((event) => event.generationId === generationId && event.type === 'tool' && event.activity.id === id && Boolean(event.activity.terminal?.stdout)), `${scenario.name}: running output`);
        await invoke('chat:stop', chat.id, generationId);
      }
      await sending;

      // Live stream: every terminal event of a call carries that call's ID.
      const live = events.filter((event) => event.generationId === generationId && event.type === 'tool').map((event) => (event as { activity: { id: string } }).activity.id);
      assert.deepEqual([...new Set(live)], Object.keys(scenario.cards), `${scenario.name}: live events keep the stable call IDs`);

      const verify = (database: InstanceType<typeof Database>, label: string) => {
        const runs = database.listAnalysisRuns(chat.id);
        assert.equal(runs.length, 1, `${label}: one run`);
        const [finished] = runs;
        assert.equal(finished.status, scenario.status, `${label}: run status`);
        assert.deepEqual(finished.actions.map((action) => action.id), Object.keys(scenario.cards), `${label}: exactly one card per terminal call, no separate result card`);
        assert.equal(finished.actionCount, Object.keys(scenario.cards).length, `${label}: action count`);
        for (const [id, expected] of Object.entries(scenario.cards)) {
          const card = finished.actions.find((action) => action.id === id)!;
          assert.equal(card.kind, 'terminal', `${label} ${id}: kind`);
          assert.equal(card.state, expected.state, `${label} ${id}: lifecycle state`);
          assert.equal(card.detail, expected.command, `${label} ${id}: the result keeps the invoked command`);
          assert.equal(card.terminal?.command, expected.command, `${label} ${id}: terminal command`);
          assert.equal(card.terminal?.status, expected.status, `${label} ${id}: terminal status`);
          assert.notEqual(card.terminal?.status, 'running', `${label} ${id}: no stale running terminal`);
          if (expected.pid !== undefined) assert.equal(card.terminal?.pid, expected.pid, `${label} ${id}: process identity survives the result`);
          if (expected.exitCode !== undefined) assert.equal(card.terminal?.exitCode, expected.exitCode, `${label} ${id}: exit code`);
          if (expected.stdout !== undefined) assert.equal(card.terminal?.stdout, expected.stdout, `${label} ${id}: final output replaces the streamed prefix`);
          assert(card.terminal?.finishedAt, `${label} ${id}: finished`);
        }
        const rendered = withRunHistory(database.listMessages(chat.id), runs);
        const turn = rendered.find((message) => message.role === 'assistant')!;
        const items = thinkingTimeline(turn.thinking, finished.actions, false, turn.thinkingTimeline ?? finished.timeline, rendered);
        const cards = items.filter((item) => item.kind === 'activity').map((item) => (item as { activity: { id: string } }).activity.id);
        assert.deepEqual(cards, Object.keys(scenario.cards), `${label}: rendered timeline has one card per call`);
      };
      verify(db, scenario.name);
      const restarted = new Database();
      restarted.recoverInterruptedRuns();
      verify(restarted, `${scenario.name} after restart`);
      restarted.close();
    }
    console.log('terminal success, failure, Stop and Agent failure each render one finished card per stable call ID, before and after restart');
  } finally { globalThis.fetch = originalFetch; loader._load = originalLoad; db.close(); rmSync(root, { recursive: true, force: true }); }
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
