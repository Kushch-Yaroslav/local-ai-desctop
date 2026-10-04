import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './database';

async function legacyDatabase(path: string): Promise<void> {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE analysis_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, assistant_message_id TEXT,
      depth TEXT NOT NULL, status TEXT NOT NULL, action_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, completed_at TEXT, reasoning_mode TEXT
    ) STRICT;
    CREATE INDEX analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at);
    CREATE TABLE analysis_actions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, label TEXT NOT NULL, detail TEXT,
      data TEXT, position INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO analysis_runs VALUES (?, ?, NULL, ?, ?, 1, ?, NULL, ?)').run('legacy-auto', 'legacy-chat', 'normal', 'completed', now, null);
  db.prepare('INSERT INTO analysis_runs VALUES (?, ?, NULL, ?, ?, 0, ?, NULL, ?)').run('legacy-fast', 'legacy-chat', 'fast', 'completed', now, null);
  db.prepare('INSERT INTO analysis_runs VALUES (?, ?, NULL, ?, ?, 0, ?, NULL, ?)').run('legacy-deep', 'legacy-chat', 'enhanced', 'completed', now, null);
  db.prepare('INSERT INTO analysis_actions VALUES (?, ?, ?, NULL, NULL, 0)').run('legacy-action', 'legacy-auto', 'Old tool');
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run('legacy-message', 'legacy-chat', 'assistant', 'Old answer', now);
  db.close();
}

function schema(path: string): { columns: string[]; runs: Array<{ id: string; reasoning_mode: string }>; actions: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  const columns = (db.prepare('PRAGMA table_info(analysis_runs)').all() as Array<{ name: string }>).map((column) => column.name);
  const runs = (db.prepare('SELECT id, reasoning_mode FROM analysis_runs ORDER BY id').all() as Array<{ id: string; reasoning_mode: string }>).map((run) => ({ id: run.id, reasoning_mode: run.reasoning_mode }));
  const actions = (db.prepare("SELECT count(*) AS count FROM analysis_actions WHERE run_id='legacy-auto'").get() as { count: number }).count;
  db.close();
  return { columns, runs, actions };
}

/** Covers migration from the released four-level analysis_runs table. */
export async function runDatabaseMigrationRegression(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'local-ai-database-migration-'));
  const legacyPath = join(directory, 'legacy.db');
  const freshPath = join(directory, 'fresh.db');
  try {
    await legacyDatabase(legacyPath);
    const database = new Database(legacyPath);
    const migrated = schema(legacyPath);
    assert(!migrated.columns.includes('depth'), 'legacy depth NOT NULL column survived analysis_runs migration');
    assert(migrated.columns.includes('reasoning_mode'), 'analysis_runs migration did not create reasoning_mode');
    assert.deepEqual(migrated.runs, [
      { id: 'legacy-auto', reasoning_mode: 'fast' },
      { id: 'legacy-deep', reasoning_mode: 'deep' },
      { id: 'legacy-fast', reasoning_mode: 'fast' },
    ], 'legacy analysis run reasoning modes were not preserved');
    assert.equal(migrated.actions, 1, 'analysis action belonging to an old run was lost during migration');
    const legacyMessage = database.getMessage('legacy-message');
    assert.equal(legacyMessage?.thinking, undefined, 'old messages unexpectedly gained synthetic Thinking content');
    assert.equal(legacyMessage?.generationStats, undefined, 'old messages unexpectedly gained generation statistics');

    const chat = database.createConversation('qwen3.8:27b-q4_K_M');
    for (const reasoningMode of ['fast', 'deep'] as const) {
      const run = database.createAnalysisRun(chat.id, reasoningMode);
      database.addAnalysisAction(run.id, { id: `${reasoningMode}-first-tool`, label: 'Первый tool call', kind: 'directory', state: 'completed' });
      database.finishAnalysisRun(run.id, 'completed', null);
    }
    database.close();

    const reopened = new Database(legacyPath);
    const afterReopen = schema(legacyPath);
    assert.equal(afterReopen.runs.length, 5, 'migration was not idempotent or new Agent runs were lost after restart');
    assert(!afterReopen.columns.includes('depth'), 'reopening reran an incomplete legacy migration');
    reopened.close();

    const fresh = new Database(freshPath);
    const freshChat = fresh.createConversation('qwen3.8:27b-q4_K_M');
    assert.equal(freshChat.llamaKvCacheType, 'f16');
    assert.equal(freshChat.llamaKvOffload, true);
    const configuredChat = fresh.updateConversation(freshChat.id, { contextWindow: 73_728, llamaKvCacheType: 'q8_0', llamaKvOffload: false });
    assert.equal(configuredChat.contextWindow, 73_728, 'custom 4K context selection was not persisted');
    assert.equal(configuredChat.llamaKvCacheType, 'q8_0', 'KV cache type was not persisted');
    assert.equal(configuredChat.llamaKvOffload, false, 'KV placement was not persisted');
    const persistedSelection = fresh.getConversation(freshChat.id)!;
    assert.deepEqual({ contextWindow: persistedSelection.contextWindow, llamaKvCacheType: persistedSelection.llamaKvCacheType, llamaKvOffload: persistedSelection.llamaKvOffload }, { contextWindow: 73_728, llamaKvCacheType: 'q8_0', llamaKvOffload: false });
    fresh.addMessage(freshChat.id, 'user', 'Поправка, напиши ещё плюсы и минусы.', 'steering-message');
    assert.equal(freshChat.reasoningMode, 'fast', 'new conversations must default to Fast reasoning');
    const response = fresh.addMessage(freshChat.id, 'assistant', 'Measured answer', undefined, [], {
      thinking: 'I checked the backend timing fields first.',
      thinkingTimeline: [{ id: 'reasoning-1', kind: 'reasoning', content: 'I checked the backend timing fields first.', position: 1 }, { id: 'steering-1', kind: 'steering', messageId: 'steering-message', position: 2, status: 'applied' }, { id: 'plan-event', kind: 'activity', activityId: 'plan-update', position: 3 }],
      generationStats: { outputTokens: 4049, tokensPerSecond: 49, generationDurationMs: 82_600, timeToFirstTokenMs: 620, inputTokens: 1_200 },
    });
    const persistedRun = fresh.createAnalysisRun(freshChat.id, 'fast');
    // `analysis_actions.id` is globally unique storage identity. Agent event
    // ids can repeat across runs (for example, a protocol error), while their
    // visible ids must still remain stable after a reopen.
    const firstProtocolRun = fresh.createAnalysisRun(freshChat.id, 'fast');
    const secondProtocolRun = fresh.createAnalysisRun(freshChat.id, 'fast');
    fresh.addAnalysisAction(firstProtocolRun.id, { id: 'protocol', label: 'Protocol error', kind: 'other', state: 'error' });
    fresh.addAnalysisAction(secondProtocolRun.id, { id: 'protocol', label: 'Protocol error', kind: 'other', state: 'error' });
    assert.equal(fresh.listAnalysisRuns(freshChat.id).find((run) => run.id === firstProtocolRun.id)?.actions[0]?.id, 'protocol', 'first run did not retain its Agent event id');
    assert.equal(fresh.listAnalysisRuns(freshChat.id).find((run) => run.id === secondProtocolRun.id)?.actions[0]?.id, 'protocol', 'second run collided with the first run event id');
    // Streaming terminal updates use the same action id. A partial stdout
    // snapshot must append output without losing the immutable execution
    // identity needed after an interrupted Electron/session shutdown.
    fresh.addAnalysisAction(persistedRun.id, { id: 'terminal-interrupted', label: 'Terminal', kind: 'terminal', state: 'running', terminal: { command: 'printf ---AUTHORS---', cwd: '/project', pid: 4812, pgid: 4812, sessionId: 4812, startedAt: '2026-09-24T16:02:00.000Z', status: 'running' } });
    fresh.addAnalysisAction(persistedRun.id, { id: 'terminal-interrupted', label: 'Terminal', kind: 'terminal', state: 'running', terminal: { stdout: '---AUTHORS---\n' } });
    fresh.addAnalysisAction(persistedRun.id, { id: 'terminal-interrupted', label: 'Terminal', kind: 'terminal', state: 'running', terminal: { stdout: 'author@example.test\n' } });
    // A normal completion supplies the runner's full buffer. It replaces the
    // streamed prefix instead of repeating every line in persisted history.
    fresh.addAnalysisAction(persistedRun.id, { id: 'terminal-final', label: 'Terminal', kind: 'terminal', state: 'running', terminal: { command: 'printf done', cwd: '/project', pid: 4813, pgid: 4813, sessionId: 4813, startedAt: '2026-09-24T16:02:01.000Z', status: 'running' } });
    fresh.addAnalysisAction(persistedRun.id, { id: 'terminal-final', label: 'Terminal', kind: 'terminal', state: 'running', terminal: { stdout: 'done\n' } });
    fresh.addAnalysisAction(persistedRun.id, { id: 'terminal-final', label: 'Terminal', kind: 'terminal', state: 'completed', terminal: { command: 'printf done', cwd: '/project', pid: 4813, pgid: 4813, sessionId: 4813, startedAt: '2026-09-24T16:02:01.000Z', finishedAt: '2026-09-24T16:02:02.000Z', exitCode: 0, timedOut: false, cancelled: false, status: 'completed', stdout: 'done\n', stderr: '' } });
    const finalPlan = {
      milestones: [
        { id: 'milestone-1', label: 'GLM context fix', status: 'in_progress' as const, workPlan: { tasks: [{ id: 'task-1', label: 'Investigate GLM context bug', status: 'completed' as const }, { id: 'task-2', label: 'Implement GLM context fix', status: 'in_progress' as const }, { id: 'task-3', label: 'Verify GLM fix', status: 'pending' as const }] } },
      ],
      activeMilestoneId: 'milestone-1',
      revision: 3,
      modelTodo: { phases: [{ name: 'Work', items: [{ id: 'todo-1', content: 'Investigate GLM context bug', status: 'completed' as const, memoryId: 'tm-001' }, { id: 'todo-2', content: 'Implement GLM context fix', status: 'in_progress' as const }, { id: 'todo-3', content: 'Verify GLM fix', status: 'pending' as const }] }] },
      taskMemory: { entries: [{ id: 'tm-001', finding: 'summary requests omitted the configured context', evidence: 'rust-agent/src/agent/loop_runtime.rs / summary_payload', implication: 'the summary request could use a smaller server default window', next: 'preserve the selected context in every request phase' }] },
    };
    fresh.addAnalysisAction(persistedRun.id, { id: 'plan-update', label: 'Планирование', kind: 'planning', state: 'completed', plan: finalPlan, metadata: { steps: 2, completed_steps: 1 } });
    const actionCountedRun = fresh.addAnalysisAction(persistedRun.id, { id: 'context-1', label: 'Контекст оптимизирован', detail: '26 151 → 18 028 токенов', kind: 'context', state: 'completed', metadata: { context_window: 32_768, input_tokens_before: 26_151, input_tokens_after: 18_028, compacted_messages: 13, compacted_tool_results: 6, compaction_count: 1 } });
    const progressRun = fresh.addAnalysisAction(persistedRun.id, { id: 'progress-1', label: 'Проверка', kind: 'progress', state: 'completed' });
    const deduplicatedRun = fresh.addAnalysisAction(persistedRun.id, { id: 'context-1', label: 'Контекст оптимизирован', kind: 'context', state: 'completed', metadata: { input_tokens_after: 18_028 } });
    assert.equal(actionCountedRun.actionCount, 4, 'plan, terminal, and context activities were not counted exactly once');
    assert.equal(progressRun.actionCount, 4, 'reasoning/progress activity was counted as an Agent action');
    assert.equal(deduplicatedRun.actionCount, 4, 'updating a persisted activity counted the same action twice');
    fresh.saveAgentPlan(freshChat.id, finalPlan);
    fresh.finishAnalysisRun(persistedRun.id, 'completed', null);
    fresh.close();
    const legacyMode = new DatabaseSync(freshPath);
    legacyMode.prepare("UPDATE conversations SET reasoning_mode='auto' WHERE id=?").run(freshChat.id);
    legacyMode.close();
    assert(!schema(freshPath).columns.includes('depth'), 'new installations still create legacy analysis_runs.depth');
    const reopenedFresh = new Database(freshPath);
    assert.equal(reopenedFresh.getConversation(freshChat.id)?.reasoningMode, 'fast', 'persisted Auto conversation did not migrate to Fast');
    const loaded = reopenedFresh.listAnalysisRuns(freshChat.id)[0];
    const restoredResponse = reopenedFresh.getMessage(response.id);
    assert.equal(restoredResponse?.thinking, 'I checked the backend timing fields first.', 'message Thinking was not preserved after restart');
    assert.deepEqual(restoredResponse?.thinkingTimeline, [{ id: 'reasoning-1', kind: 'reasoning', content: 'I checked the backend timing fields first.', position: 1 }, { id: 'steering-1', kind: 'steering', messageId: 'steering-message', position: 2, status: 'applied' }, { id: 'plan-event', kind: 'activity', activityId: 'plan-update', position: 3 }], 'message Thinking and steering event order was not preserved after restart');
    assert.equal(reopenedFresh.getMessage('steering-message')?.content, 'Поправка, напиши ещё плюсы и минусы.', 'canonical steering message did not survive database reopen');
    assert.deepEqual(restoredResponse?.generationStats, { outputTokens: 4049, tokensPerSecond: 49, generationDurationMs: 82_600, timeToFirstTokenMs: 620, inputTokens: 1_200 }, 'message generation statistics were not preserved after restart');
    assert.deepEqual(loaded.actions.find((action) => action.id === 'plan-update')?.plan, finalPlan, 'last structured Agent Plan was not preserved after restart');
    assert.deepEqual(reopenedFresh.getAgentPlan(freshChat.id), finalPlan, 'canonical Goal/Work Plan was not preserved after restart');
    const resumedPlan = reopenedFresh.getAgentPlan(freshChat.id)!;
    assert.deepEqual(resumedPlan.taskMemory?.entries[0], finalPlan.taskMemory.entries[0], 'Task Memory handoff fields changed across database reopen');
    assert.deepEqual(resumedPlan.modelTodo?.phases[0]?.items.map((item) => item.status), ['completed', 'in_progress', 'pending'], 'Todo lifecycle changed across database reopen');
    const context = loaded.actions.find((action) => action.id === 'context-1');
    assert.equal(context?.kind, 'context', 'context compaction semantic type was not preserved after restart');
    assert.equal(context?.metadata?.input_tokens_after, 18_028, 'context compaction details were not preserved after restart');
    const interruptedTerminal = loaded.actions.find((action) => action.id === 'terminal-interrupted')?.terminal;
    assert.deepEqual(interruptedTerminal, { command: 'printf ---AUTHORS---', cwd: '/project', pid: 4812, pgid: 4812, sessionId: 4812, startedAt: '2026-09-24T16:02:00.000Z', status: 'running', stdout: '---AUTHORS---\nauthor@example.test\n' }, 'stdout deltas overwrote terminal command/process identity');
    const completedTerminal = loaded.actions.find((action) => action.id === 'terminal-final')?.terminal;
    assert.deepEqual(completedTerminal, { command: 'printf done', cwd: '/project', pid: 4813, pgid: 4813, sessionId: 4813, startedAt: '2026-09-24T16:02:01.000Z', finishedAt: '2026-09-24T16:02:02.000Z', exitCode: 0, timedOut: false, cancelled: false, status: 'completed', stdout: 'done\n', stderr: '' }, 'final terminal buffer was appended to its streamed prefix');
    reopenedFresh.close();

    // Regenerate removes failed downstream runs as well as runs already paired
    // with deleted assistant messages. Failed runs have no assistant ID, but
    // their action timeline must not leak into the new branch.
    const regenerate = new Database(freshPath);
    const regenerationChat = regenerate.createConversation('qwen3.8:27b-q4_K_M');
    const regenerateUser = regenerate.addMessage(regenerationChat.id, 'user', 'Create a file');
    const failedRun = regenerate.createAnalysisRun(regenerationChat.id, 'fast');
    regenerate.addAnalysisAction(failedRun.id, { id: 'failed-tool', label: 'Malformed call', kind: 'other', state: 'error' });
    regenerate.finishAnalysisRun(failedRun.id, 'error', null);
    const successfulAssistant = regenerate.addMessage(regenerationChat.id, 'assistant', 'Old answer');
    const successfulRun = regenerate.createAnalysisRun(regenerationChat.id, 'fast');
    regenerate.finishAnalysisRun(successfulRun.id, 'completed', successfulAssistant.id);
    const retained = regenerate.regenerateUserMessageAndTruncate(regenerateUser.id);
    assert.equal(retained.length, 1, 'Regenerate did not preserve exactly the user prefix');
    assert.equal(regenerate.listAnalysisRuns(regenerationChat.id).length, 0, 'Regenerate retained stale downstream failed or completed Agent runs');
    regenerate.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (require.main === module) void runDatabaseMigrationRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
