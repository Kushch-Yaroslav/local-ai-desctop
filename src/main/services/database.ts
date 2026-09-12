import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AnalysisDepth, AnalysisRun, ChatMessage, ChatMode, Conversation, ToolActivity } from '../../shared/types';
import { paths } from './paths';

type ConversationRow = {
  id: string; title: string; model_id: string | null; mode: ChatMode; working_directory: string | null;
  context_window: number;
  analysis_depth: AnalysisDepth;
  created_at: string; updated_at: string;
};
type MessageRow = { id: string; conversation_id: string; role: ChatMessage['role']; content: string; created_at: string };
type AnalysisRunRow = { id: string; conversation_id: string; assistant_message_id: string | null; depth: AnalysisDepth; status: AnalysisRun['status']; action_count: number; created_at: string; completed_at: string | null };
type AnalysisActionRow = { id: string; run_id: string; label: string; detail: string | null; position: number };

const mapConversation = (row: ConversationRow): Conversation => ({
  id: row.id, title: row.title, modelId: row.model_id, mode: row.mode,
  workingDirectory: row.working_directory, contextWindow: row.context_window ?? 32_768, analysisDepth: row.analysis_depth ?? 'normal', createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapMessage = (row: MessageRow): ChatMessage => ({
  id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, createdAt: row.created_at,
});
const mapRun = (row: AnalysisRunRow, actions: AnalysisActionRow[]): AnalysisRun => ({ id: row.id, conversationId: row.conversation_id, assistantMessageId: row.assistant_message_id, depth: row.depth, status: row.status, actionCount: row.action_count, actions: actions.map((action) => ({ id: action.id, label: action.label, detail: action.detail ?? undefined })), createdAt: row.created_at, completedAt: row.completed_at });

export class Database {
  private readonly db = new DatabaseSync(paths.database);

  constructor() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL,
        working_directory TEXT, context_window INTEGER NOT NULL DEFAULT 32768, analysis_depth TEXT NOT NULL DEFAULT 'normal', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS analysis_runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, assistant_message_id TEXT, depth TEXT NOT NULL, status TEXT NOT NULL, action_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS analysis_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, position INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS analysis_actions_run_idx ON analysis_actions(run_id, position);
    `);
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN context_window INTEGER NOT NULL DEFAULT 32768'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec("ALTER TABLE conversations ADD COLUMN analysis_depth TEXT NOT NULL DEFAULT 'normal'"); } catch { /* Existing databases already have this column. */ }
  }

  listConversations(): Conversation[] {
    return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as unknown as ConversationRow[]).map(mapConversation);
  }

  createConversation(): Conversation {
    const id = randomUUID(); const now = new Date().toISOString();
    const title = 'Новый чат';
    this.db.prepare('INSERT INTO conversations (id, title, model_id, mode, working_directory, context_window, analysis_depth, created_at, updated_at) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?)').run(id, title, 'chat', 32_768, 'normal', now, now);
    return { id, title, modelId: null, mode: 'chat', workingDirectory: null, contextWindow: 32_768, analysisDepth: 'normal', createdAt: now, updatedAt: now };
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'contextWindow' | 'analysisDepth'>>): Conversation {
    const current = this.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const contextWindow = [16_384, 32_768, 65_536, 131_072, 262_144].includes(next.contextWindow) ? next.contextWindow : 32_768;
    const analysisDepth: AnalysisDepth = ['fast', 'normal', 'deep'].includes(next.analysisDepth) ? next.analysisDepth : 'normal';
    this.db.prepare('UPDATE conversations SET title=?, model_id=?, mode=?, working_directory=?, context_window=?, analysis_depth=?, updated_at=? WHERE id=?')
      .run(next.title, next.modelId, next.mode, next.workingDirectory, contextWindow, analysisDepth, next.updatedAt, id);
    next.contextWindow = contextWindow;
    next.analysisDepth = analysisDepth;
    return next;
  }

  deleteConversation(id: string): void {
    const runs = this.db.prepare('SELECT id FROM analysis_runs WHERE conversation_id=?').all(id) as unknown as Array<{ id: string }>;
    for (const run of runs) this.db.prepare('DELETE FROM analysis_actions WHERE run_id=?').run(run.id);
    this.db.prepare('DELETE FROM analysis_runs WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as ConversationRow | undefined;
    return row ? mapConversation(row) : null;
  }

  listMessages(conversationId: string): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC').all(conversationId) as unknown as MessageRow[]).map(mapMessage);
  }

  addMessage(conversationId: string, role: ChatMessage['role'], content: string): ChatMessage {
    const message = { id: randomUUID(), conversationId, role, content, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(message.id, message.conversationId, message.role, message.content, message.createdAt);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(message.createdAt, conversationId);
    return message;
  }

  createAnalysisRun(conversationId: string, depth: AnalysisDepth): AnalysisRun {
    const run = { id: randomUUID(), conversationId, assistantMessageId: null, depth, status: 'running' as const, actionCount: 0, actions: [], createdAt: new Date().toISOString(), completedAt: null };
    this.db.prepare('INSERT INTO analysis_runs VALUES (?, ?, NULL, ?, ?, 0, ?, NULL)').run(run.id, run.conversationId, run.depth, run.status, run.createdAt);
    return run;
  }

  addAnalysisAction(runId: string, activity: ToolActivity): AnalysisRun {
    const position = (this.db.prepare('SELECT action_count FROM analysis_runs WHERE id=?').get(runId) as { action_count: number }).action_count;
    this.db.prepare('INSERT INTO analysis_actions VALUES (?, ?, ?, ?, ?)').run(activity.id, runId, activity.label, activity.detail ?? null, position);
    this.db.prepare('UPDATE analysis_runs SET action_count=action_count+1 WHERE id=?').run(runId);
    return this.getAnalysisRun(runId)!;
  }

  finishAnalysisRun(runId: string, status: AnalysisRun['status'], assistantMessageId: string | null): AnalysisRun {
    this.db.prepare('UPDATE analysis_runs SET status=?, assistant_message_id=?, completed_at=? WHERE id=?').run(status, assistantMessageId, new Date().toISOString(), runId);
    return this.getAnalysisRun(runId)!;
  }

  listAnalysisRuns(conversationId: string): AnalysisRun[] { return (this.db.prepare('SELECT * FROM analysis_runs WHERE conversation_id=? ORDER BY created_at ASC').all(conversationId) as unknown as AnalysisRunRow[]).map((row) => mapRun(row, this.db.prepare('SELECT * FROM analysis_actions WHERE run_id=? ORDER BY position ASC').all(row.id) as unknown as AnalysisActionRow[])); }

  private getAnalysisRun(runId: string): AnalysisRun | null { const row = this.db.prepare('SELECT * FROM analysis_runs WHERE id=?').get(runId) as unknown as AnalysisRunRow | undefined; return row ? mapRun(row, this.db.prepare('SELECT * FROM analysis_actions WHERE run_id=? ORDER BY position ASC').all(runId) as unknown as AnalysisActionRow[]) : null; }
}
