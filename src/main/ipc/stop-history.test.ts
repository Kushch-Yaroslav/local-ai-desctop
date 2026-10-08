import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisRun, ChatMessage, ChatRequest, Conversation, StreamEvent, ThinkingTimelineEvent } from '../../shared/types';
import type { LlamaRuntimeState } from '../services/llama-runtime-controller';

type Sent = StreamEvent & { conversationId: string; generationId?: string };
type Script = (signal: AbortSignal) => AsyncIterable<StreamEvent>;

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error(`timed out waiting for ${label}`);
};
const kinds = (timeline: readonly ThinkingTimelineEvent[] | undefined) => (timeline ?? []).map((entry) => entry.kind === 'activity' ? `activity:${entry.activityId}` : entry.kind);

/** Production IPC + real SQLite: a stalled Agent run is stopped, and every
 * committed timeline event survives Stop, a restart and a later Continue. */
async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lad-stop-history-'));
  process.env.LOCAL_AI_RUNTIME_ROOT = root;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, ...args) => name === 'electron' ? { ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } } : originalLoad(name, ...args);
  const { ensureAppDirectories } = await import('../services/paths'); ensureAppDirectories();
  const { Database } = await import('../services/database');
  const { LlamaRuntimeController } = await import('../services/llama-runtime-controller');
  const { LlamaCppBackend } = await import('../backends/llama-cpp-backend');
  const { RustAgentRuntime } = await import('../services/rust-agent-runtime');
  const { withRunHistory, runTurnId } = await import('../../shared/run-history');
  const { steeringMessageIds, thinkingTimeline } = await import('../../shared/thinking-timeline');
  let runtime: LlamaRuntimeState = { status: 'idle', modelId: null, contextWindow: null };
  LlamaRuntimeController.prototype.state = async () => runtime;
  LlamaRuntimeController.prototype.switchTo = async (modelId, contextWindow) => { runtime = { status: 'ready', modelId, contextWindow }; return { ok: true, state: runtime }; };
  LlamaCppBackend.prototype.ensureModelAvailable = async () => {};
  LlamaCppBackend.prototype.resolveContextWindow = async (_model, requested) => ({ requested, active: requested, supported: requested });
  let script: Script = async function* () { /* replaced per run */ };
  let steered!: () => void;
  RustAgentRuntime.prototype.stream = function (...args: unknown[]) { return script(args[3] as AbortSignal); } as typeof RustAgentRuntime.prototype.stream;
  RustAgentRuntime.prototype.steer = async () => { steered(); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const events: Sent[] = [];
  const invoke = async <T>(channel: string, ...args: unknown[]) => await handlers.get(channel)!({ sender: { send: (_channel: string, event: Sent) => events.push(event) } }, ...args) as T;
  const tool = (id: string, extra: Record<string, unknown>): StreamEvent => ({ type: 'tool', activity: { id, label: id, ...extra } } as StreamEvent);
  const db = new Database();
  try {
    const { registerIpc } = await import('./register-ipc'); registerIpc();
    const model = 'qwen3.8:27b-q4_K_M';
    const chat = await invoke<Conversation>('conversations:create');
    mkdirSync(join(root, 'project'));
    await invoke('conversations:update', chat.id, { modelId: model, mode: 'agent', webMode: 'off', workingDirectory: join(root, 'project') });
    const request = (generationId: string, history: ChatMessage[], content: string): ChatRequest => ({ conversationId: chat.id, generationId, model, persistUserMessage: true, messages: [...history, { id: `${generationId}-user`, conversationId: chat.id, role: 'user', content, createdAt: new Date().toISOString() }] });
    const runsOf = (generationId: string) => events.filter((event) => event.generationId === generationId && event.type === 'analysis-run').map((event) => (event as { run: AnalysisRun }).run);

    // start Agent → progress/tool events → terminal fails → steering → more events → stalled generation
    script = async function* (signal) {
      yield { type: 'work-budget', budget: { used: 140, limit: 160, maximum: 256, extensions: 1, decision: 'extended', reason: 'changed_code_check_passed' } };
      yield { type: 'task-memory', memory: { entries: [] } };
      yield { type: 'thinking', content: 'Inspect the project first.' };
      yield tool('read-1', { kind: 'file_read', state: 'running' });
      yield tool('read-1', { kind: 'file_read', state: 'completed', output: 'board.js' });
      yield tool('progress-1', { kind: 'progress', state: 'completed', detail: 'Found the move generator' });
      yield tool('term-1', { kind: 'terminal', state: 'running', terminal: { command: 'node test.js', startedAt: new Date().toISOString(), status: 'running' } });
      yield tool('term-1', { kind: 'terminal', state: 'error', terminal: { command: 'node test.js', exitCode: 1, finishedAt: new Date().toISOString(), status: 'error', stderr: 'AssertionError' } });
      yield { type: 'paused' };
      await new Promise<void>((resolve) => { steered = resolve; });
      yield { type: 'steering', userMessage: { id: 'runtime', conversationId: chat.id, role: 'user', content: 'Focus on captures', createdAt: '' }, status: 'applied' };
      yield { type: 'thinking', content: 'Re-reading the capture rules.' };
      yield tool('read-2', { kind: 'file_read', state: 'completed', output: 'rules.js' });
      yield tool('term-2', { kind: 'terminal', state: 'running', terminal: { command: 'node bench.js', status: 'running' } });
      yield { type: 'thinking', content: 'The loop is in' };
      yield { type: 'token', content: 'Partial analysis: the capture loop' };
      // Stalled: nothing more arrives until the run is aborted.
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    const first = invoke('chat:send', request('stalled', [], 'Analyse the checkers bot'));
    await waitUntil(() => events.some((event) => event.type === 'tool' && event.activity.id === 'term-1' && event.activity.state === 'error'), 'terminal failure');
    const steering = await invoke<ChatMessage>('chat:steer', chat.id, 'stalled', 'Focus on captures');
    await waitUntil(() => events.some((event) => event.generationId === 'stalled' && event.type === 'token'), 'stalled stream');
    const liveTimeline = kinds(runsOf('stalled').length ? db.listAnalysisRuns(chat.id)[0].timeline : undefined);
    assert.deepEqual(liveTimeline, ['reasoning', 'activity:read-1', 'activity:progress-1', 'activity:term-1', 'paused', 'steering', 'reasoning', 'activity:read-2', 'activity:term-2'], 'committed events must be checkpointed before any Stop');
    await invoke('chat:stop', chat.id, 'stalled');
    await first;

    // Stop releases ownership and finalizes the durable history before it is announced.
    const stoppedIndex = events.findIndex((event) => event.generationId === 'stalled' && event.type === 'cancelled');
    const finalIndex = events.findIndex((event) => event.generationId === 'stalled' && event.type === 'analysis-run' && (event as { run: AnalysisRun }).run.status === 'cancelled');
    assert(finalIndex >= 0 && stoppedIndex > finalIndex, 'the finalized run must reach the renderer before the cancellation');
    const expected = ['reasoning', 'activity:read-1', 'activity:progress-1', 'activity:term-1', 'paused', 'steering', 'reasoning', 'activity:read-2', 'activity:term-2', 'reasoning'];
    const verify = (database: InstanceType<typeof Database>, label: string) => {
      const [stopped] = database.listAnalysisRuns(chat.id);
      assert.equal(stopped.status, 'cancelled', label);
      assert.deepEqual(kinds(stopped.timeline), expected, `${label}: timeline`);
      assert.equal(stopped.timeline?.filter((entry) => entry.kind === 'reasoning').at(-1)?.kind === 'reasoning' && stopped.timeline?.filter((entry) => entry.kind === 'reasoning').at(-1)?.content, 'The loop is in', `${label}: interrupted reasoning text`);
      assert.equal(stopped.partialOutput, 'Partial analysis: the capture loop', `${label}: partial output`);
      assert.deepEqual(stopped.actions.map((action) => action.id), ['read-1', 'progress-1', 'term-1', 'read-2', 'term-2'], `${label}: actions`);
      assert(!stopped.actions.some((action) => action.state === 'running'), `${label}: no action may stay running after Stop`);
      assert.equal(stopped.actions.find((action) => action.id === 'term-1')?.terminal?.stderr, 'AssertionError', `${label}: terminal failure`);
      const messages = database.listMessages(chat.id);
      const rendered = withRunHistory(messages, database.listAnalysisRuns(chat.id));
      assert.deepEqual(rendered.map((message) => message.id), ['stalled-user', runTurnId(stopped.id), steering.id], `${label}: reconstructed turn order`);
      assert.deepEqual([...steeringMessageIds(rendered)], [steering.id], `${label}: steering keeps its semantic type`);
      const turn = rendered[1];
      assert.equal(turn.agentCancelled, true, `${label}: stopped marker`);
      const items = thinkingTimeline(turn.thinking, stopped.actions, false, turn.thinkingTimeline, rendered);
      assert.equal(items.filter((item) => item.kind === 'steering').length, 1, `${label}: steering rendered once inside the timeline`);
      return stopped;
    };
    const stopped = verify(db, 'after Stop');
    // A restart opens the same SQLite file through a new connection and recovers it.
    const restarted = new Database();
    restarted.recoverInterruptedRuns();
    verify(restarted, 'after restart');

    // Continue appends after the preserved history.
    script = async function* () {
      yield { type: 'thinking', content: 'Continuing.' };
      yield tool('read-3', { kind: 'file_read', state: 'completed' });
      yield { type: 'token', content: 'Fixed.' };
      yield { type: 'done' };
    };
    await invoke('chat:send', request('continue', [...db.listMessages(chat.id)], 'Continue'));
    assert.equal(restarted.getAgentPlan(chat.id)?.workBudget?.used, 140, 'budget projection survives Stop/restart/Continue and memory updates');
    const [afterStop, continued] = restarted.listAnalysisRuns(chat.id);
    assert.deepEqual(afterStop, stopped, 'Continue must not alter the stopped run');
    assert.equal(continued.status, 'completed');
    const assistant = restarted.listMessages(chat.id).at(-1)!;
    assert.equal(continued.assistantMessageId, assistant.id);
    assert.deepEqual(kinds(assistant.thinkingTimeline), ['reasoning', 'activity:read-3'], 'normal completion stores its timeline once');
    const rendered = withRunHistory(restarted.listMessages(chat.id), restarted.listAnalysisRuns(chat.id));
    assert.deepEqual(rendered.map((message) => message.id), ['stalled-user', runTurnId(stopped.id), steering.id, 'continue-user', assistant.id], 'completed runs are not duplicated as history turns');
    assert.equal(new Set(rendered.map((message) => message.id)).size, rendered.length);

    // Failure keeps its history and reports the error after finalization, once.
    script = async function* () {
      yield { type: 'thinking', content: 'Trying again.' };
      yield tool('term-3', { kind: 'terminal', state: 'running', terminal: { command: 'npm test', status: 'running' } });
      yield { type: 'error', message: 'Rust Agent Runtime V2 error', details: 'repetition_loop' };
    };
    await invoke('chat:send', request('failed', [...db.listMessages(chat.id)], 'Once more'));
    const failedEvents = events.filter((event) => event.generationId === 'failed');
    assert.equal(failedEvents.filter((event) => event.type === 'error').length, 1, 'exactly one error event');
    assert(failedEvents.findIndex((event) => event.type === 'analysis-run' && (event as { run: AnalysisRun }).run.status === 'error') < failedEvents.findIndex((event) => event.type === 'error'), 'failure is announced after its run is final');
    const failed = restarted.listAnalysisRuns(chat.id).at(-1)!;
    assert.equal(failed.status, 'error');
    assert.equal(failed.error, 'Rust Agent Runtime V2 error: repetition_loop');
    assert.deepEqual(kinds(failed.timeline), ['reasoning', 'activity:term-3']);
    assert.equal(failed.actions[0].state, 'error', 'a running terminal is closed on failure');
    const afterFailure = withRunHistory(restarted.listMessages(chat.id), restarted.listAnalysisRuns(chat.id));
    assert.deepEqual(afterFailure.map((message) => message.id).slice(-2), ['failed-user', runTurnId(failed.id)]);
    assert.equal(afterFailure.at(-1)?.agentError, 'Rust Agent Runtime V2 error: repetition_loop');
    assert.equal(new Set(afterFailure.map((message) => message.id)).size, afterFailure.length, 'no duplicated turns');
    restarted.close();
    console.log('stalled Agent → Stop → restart → Continue keeps the full persisted timeline; completion and failure persist once');
  } finally { globalThis.fetch = originalFetch; loader._load = originalLoad; db.close(); rmSync(root, { recursive: true, force: true }); }
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
