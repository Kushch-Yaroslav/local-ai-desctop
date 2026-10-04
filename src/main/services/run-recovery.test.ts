import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './database';
import { agentEvidenceDir, discardAgentEvidence } from './agent-evidence';
import type { AgentPlan } from '../../shared/types';

const exists = (path: string) => access(path).then(() => true, () => false);
const memory = (finding: string): AgentPlan => ({ milestones: [], taskMemory: { entries: [{ id: 'tm-001', finding, evidence: 'obs-00000001', implication: 'x', status: 'confirmed' }] } } as unknown as AgentPlan);

/** Mirrors what `messages:regenerate` does in the main process. */
async function regenerate(database: Database, userData: string, messageId: string): Promise<void> {
  const message = database.getMessage(messageId)!;
  database.regenerateUserMessageAndTruncate(message.id);
  await discardAgentEvidence(userData, message.conversationId);
}

async function seedEvidence(userData: string, conversationId: string): Promise<string> {
  const dir = agentEvidenceDir(userData, conversationId);
  await mkdir(join(dir, 'run', 'observations'), { recursive: true });
  await writeFile(join(dir, 'active.json'), '{}');
  await writeFile(join(dir, 'run', 'events.jsonl'), '');
  return dir;
}

export async function runRunRecoveryRegression(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'local-ai-run-recovery-'));
  const databasePath = join(directory, 'recovery.db');
  const userData = join(directory, 'app-data');
  try {
    let database = new Database(databasePath);
    const chat = database.createConversation('qwen3.8:27b-q4_K_M');
    database.updateConversation(chat.id, { mode: 'agent' });

    // A completed run survives a restart untouched.
    const first = database.addMessage(chat.id, 'user', 'first question');
    const completedRun = database.createAnalysisRun(chat.id, 'deep');
    const answer = database.addMessage(chat.id, 'assistant', 'first answer');
    database.finishAnalysisRun(completedRun.id, 'completed', answer.id);
    database.saveAgentPlan(chat.id, memory('completed memory'));
    database.setContextUsage(chat.id, 'qwen3.8:27b-q4_K_M', 20_000);
    database.close();
    database = new Database(databasePath);
    assert.equal(database.recoverInterruptedRuns(), 0, 'a completed run was treated as interrupted');
    assert.equal(database.listAnalysisRuns(chat.id)[0].status, 'completed');
    assert.equal(database.getConversation(chat.id)?.contextTokens, 20_000);

    // The process dies mid-run: the row is still `running` after restart.
    const second = database.addMessage(chat.id, 'user', 'second question');
    const killedRun = database.createAnalysisRun(chat.id, 'deep');
    database.addAnalysisAction(killedRun.id, { id: 'read-1', label: 'read', kind: 'file_read', state: 'completed' });
    database.saveAgentPlan(chat.id, memory('interrupted memory'));
    database.setContextUsage(chat.id, 'qwen3.8:27b-q4_K_M', 54_000);
    const evidence = await seedEvidence(userData, chat.id);
    database.close();
    database = new Database(databasePath);
    assert.equal(database.recoverInterruptedRuns(), 1, 'the killed run was not recognized');
    assert.equal(database.recoverInterruptedRuns(), 0, 'recovery is not idempotent');
    const runs = database.listAnalysisRuns(chat.id);
    assert.deepEqual(runs.map((run) => run.status), ['completed', 'interrupted']);
    assert.equal(runs[1].assistantMessageId, null);
    assert.notEqual(runs[1].completedAt, null);
    assert.equal(runs[1].actions.length, 1, 'interrupted run lost its recorded activity');
    assert.deepEqual(database.listMessages(chat.id).map((message) => message.id), [first.id, answer.id, second.id], 'an interrupted run must not invent an assistant message');

    // Continue: a follow-up message keeps the interrupted progress. Nothing is dropped.
    database.addMessage(chat.id, 'user', 'continue');
    assert.equal(database.getAgentPlan(chat.id)?.taskMemory?.entries[0].finding, 'interrupted memory');
    assert.equal(database.getConversation(chat.id)?.contextTokens, 54_000);
    assert.equal(await exists(evidence), true, 'Continue must retain the interrupted evidence lineage');

    // Regenerate after the interrupted run drops every trace of the attempt.
    await regenerate(database, userData, second.id);
    assert.deepEqual(database.listMessages(chat.id).map((message) => message.id), [first.id, answer.id, second.id]);
    assert.deepEqual(database.listAnalysisRuns(chat.id).map((run) => run.id), [completedRun.id], 'the interrupted run survived Regenerate');
    assert.equal(database.getAgentPlan(chat.id), null, 'stale Task Memory survived Regenerate');
    assert.equal(database.getConversation(chat.id)?.contextTokens, null, 'stale context meter survived Regenerate');
    assert.equal(database.getConversation(chat.id)?.contextModelId, null);
    assert.equal(await exists(evidence), false, 'stale evidence lineage survived Regenerate');

    // The regenerated attempt gets its own state, is interrupted again, and
    // survives a restart between two Regenerates.
    const attempt = database.createAnalysisRun(chat.id, 'deep');
    database.saveAgentPlan(chat.id, memory('attempt two'));
    await seedEvidence(userData, chat.id);
    database.close();
    database = new Database(databasePath);
    assert.equal(database.recoverInterruptedRuns(), 1);
    await regenerate(database, userData, second.id);
    assert.equal(database.listAnalysisRuns(chat.id).some((run) => run.id === attempt.id), false);
    assert.equal(database.getAgentPlan(chat.id), null);
    assert.equal(await exists(agentEvidenceDir(userData, chat.id)), false);
    await regenerate(database, userData, second.id);
    assert.equal(database.listMessages(chat.id).length, 3, 'repeated Regenerate changed the retained prefix');

    // Regenerate after a completed run also resets run-scoped state.
    const done = database.createAnalysisRun(chat.id, 'deep');
    const secondAnswer = database.addMessage(chat.id, 'assistant', 'second answer');
    database.finishAnalysisRun(done.id, 'completed', secondAnswer.id);
    database.saveAgentPlan(chat.id, memory('completed two'));
    database.setContextUsage(chat.id, 'qwen3.8:27b-q4_K_M', 31_000);
    await seedEvidence(userData, chat.id);
    await regenerate(database, userData, second.id);
    assert.deepEqual(database.listMessages(chat.id).map((message) => message.id), [first.id, answer.id, second.id]);
    assert.equal(database.getAgentPlan(chat.id), null);
    assert.equal(database.getConversation(chat.id)?.contextTokens, null);
    assert.equal(await exists(agentEvidenceDir(userData, chat.id)), false);

    // Edit shares the same boundary, and other conversations are untouched.
    const other = database.createConversation('qwen3.8:27b-q4_K_M');
    database.saveAgentPlan(other.id, memory('other chat'));
    const otherEvidence = await seedEvidence(userData, other.id);
    database.saveAgentPlan(chat.id, memory('before edit'));
    await seedEvidence(userData, chat.id);
    database.editUserMessageAndTruncate(second.id, 'edited question');
    await discardAgentEvidence(userData, chat.id);
    assert.equal(database.getAgentPlan(chat.id), null);
    assert.equal(database.getAgentPlan(other.id)?.taskMemory?.entries[0].finding, 'other chat', 'Regenerate leaked into another conversation');
    assert.equal(await exists(otherEvidence), true);
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (require.main === module) void runRunRecoveryRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
