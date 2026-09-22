import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AnalysisRun, Attachment, AttachmentKind, AttachmentStatus, ChatMessage, ChatMode, Conversation, GenerationDiagnostics, GenerationStats, ProjectReference, ProjectReferenceKind, ReasoningMode, ThinkingTimelineEvent, ToolActivity, WebMode } from '../../shared/types';
import { paths } from './paths';

type ConversationRow = {
  id: string; title: string; model_id: string | null; mode: ChatMode; working_directory: string | null;
  primary_project_id: string | null; secondary_working_directory: string | null; secondary_project_id: string | null;
  context_window: number;
  reasoning_mode: ReasoningMode;
  context_tokens: number | null; context_model_id: string | null;
  web_mode: WebMode;
  created_at: string; updated_at: string;
};
type MessageRow = { id: string; conversation_id: string; role: ChatMessage['role']; content: string; thinking: string | null; thinking_timeline: string | null; generation_stats: string | null; created_at: string };
type ProjectReferenceRow = { id: string; message_id: string; position: number; project_id: string; project_slot: 1 | 2; project_path: string; project_label: string; relative_path: string; kind: ProjectReferenceKind };
type AttachmentRow = { id: string; message_id: string; position: number; kind: AttachmentKind; mime_type: string; filename: string; size: number; storage_ref: string; status: AttachmentStatus; extracted_text: string | null; structured_data: string | null; vision_analysis: string | null; error: string | null; metadata: string | null; created_at: string; updated_at: string };
type AnalysisRunRow = { id: string; conversation_id: string; assistant_message_id: string | null; reasoning_mode: ReasoningMode; status: AnalysisRun['status']; action_count: number; created_at: string; completed_at: string | null };
type AnalysisActionRow = { id: string; run_id: string; label: string; detail: string | null; data: string | null; position: number };

const mapConversation = (row: ConversationRow): Conversation => ({
  id: row.id, title: row.title, modelId: row.model_id, mode: row.mode,
  workingDirectory: row.working_directory, primaryProjectId: row.primary_project_id ?? null, secondaryWorkingDirectory: row.secondary_working_directory ?? null, secondaryProjectId: row.secondary_project_id ?? null, contextWindow: row.context_window ?? 32_768, reasoningMode: row.reasoning_mode === 'deep' ? 'deep' : 'fast', contextTokens: row.context_tokens ?? null, contextModelId: row.context_model_id ?? null, webMode: row.web_mode ?? 'auto', createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id, messageId: row.message_id, index: row.position, kind: row.kind, mimeType: row.mime_type, filename: row.filename, size: row.size, storageRef: row.storage_ref, status: row.status,
  extractedText: row.extracted_text ?? undefined, structuredData: row.structured_data ?? undefined, visionAnalysis: row.vision_analysis ?? undefined, error: row.error ?? undefined,
  metadata: parseAttachmentMetadata(row.metadata), createdAt: row.created_at, updatedAt: row.updated_at,
});
function parseAttachmentMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}
const mapReference = (row: ProjectReferenceRow): ProjectReference => ({ id: row.id, projectId: row.project_id, projectSlot: row.project_slot, projectPath: row.project_path, projectLabel: row.project_label, relativePath: row.relative_path, kind: row.kind });
function parseGenerationStats(value: string | null): GenerationStats | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<GenerationStats>;
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.outputTokens) || parsed.outputTokens! < 0) return undefined;
    return {
      outputTokens: Math.round(parsed.outputTokens!),
      ...(Number.isFinite(parsed.tokensPerSecond) && parsed.tokensPerSecond! > 0 ? { tokensPerSecond: parsed.tokensPerSecond } : {}),
      ...(Number.isFinite(parsed.generationDurationMs) && parsed.generationDurationMs! >= 0 ? { generationDurationMs: parsed.generationDurationMs } : {}),
      ...(Number.isFinite(parsed.timeToFirstTokenMs) && parsed.timeToFirstTokenMs! >= 0 ? { timeToFirstTokenMs: parsed.timeToFirstTokenMs } : {}),
      ...(Number.isFinite(parsed.inputTokens) && parsed.inputTokens! >= 0 ? { inputTokens: Math.round(parsed.inputTokens!) } : {}),
    };
  } catch { return undefined; }
}
const mapMessage = (row: MessageRow, attachments?: Attachment[], projectReferences?: ProjectReference[]): ChatMessage => {
  const generationStats = parseGenerationStats(row.generation_stats);
  let thinkingTimeline: ThinkingTimelineEvent[] | undefined;
  try {
    const parsed = row.thinking_timeline ? JSON.parse(row.thinking_timeline) as unknown : undefined;
    if (Array.isArray(parsed)) thinkingTimeline = parsed.filter((item): item is ThinkingTimelineEvent => Boolean(item) && typeof item === 'object' && typeof item.id === 'string' && typeof item.position === 'number' && ((item.kind === 'reasoning' && typeof item.content === 'string') || (item.kind === 'activity' && typeof item.activityId === 'string')));
  } catch { /* Old or damaged timeline metadata remains optional. */ }
  return {
    id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, createdAt: row.created_at,
    attachments,
    projectReferences,
    ...(row.thinking?.trim() ? { thinking: row.thinking } : {}),
    ...(thinkingTimeline?.length ? { thinkingTimeline } : {}),
    ...(generationStats ? { generationStats } : {}),
  };
};
const mapRun = (row: AnalysisRunRow, actions: AnalysisActionRow[]): AnalysisRun => ({ id: row.id, conversationId: row.conversation_id, assistantMessageId: row.assistant_message_id, reasoningMode: row.reasoning_mode === 'deep' ? 'deep' : 'fast', status: row.status, actionCount: row.action_count, actions: actions.map((action) => {
  let stored: Partial<ToolActivity> = {};
  try { stored = action.data ? JSON.parse(action.data) as Partial<ToolActivity> : {}; } catch { /* Older or corrupt telemetry remains readable. */ }
  const visible = { ...stored };
  delete visible.rawOutput;
  return { ...visible, id: action.id, label: action.label, detail: action.detail ?? undefined };
}), createdAt: row.created_at, completedAt: row.completed_at });

export class Database {
  private readonly db: DatabaseSync;

  constructor(databasePath = paths.database) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL,
        working_directory TEXT, context_window INTEGER NOT NULL DEFAULT 32768, reasoning_mode TEXT NOT NULL DEFAULT 'fast', context_tokens INTEGER, context_model_id TEXT, web_mode TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, thinking TEXT, thinking_timeline TEXT, generation_stats TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS project_references (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, project_id TEXT NOT NULL, project_slot INTEGER NOT NULL,
        project_path TEXT NOT NULL, project_label TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_references_message_idx ON project_references(message_id, position);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL, filename TEXT NOT NULL,
        size INTEGER NOT NULL, storage_ref TEXT NOT NULL, status TEXT NOT NULL,
        extracted_text TEXT, structured_data TEXT, vision_analysis TEXT, error TEXT, metadata TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id, position);
      CREATE TABLE IF NOT EXISTS analysis_runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, assistant_message_id TEXT, reasoning_mode TEXT NOT NULL DEFAULT 'fast', status TEXT NOT NULL, action_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS analysis_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, data TEXT, position INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS analysis_actions_run_idx ON analysis_actions(run_id, position);
      CREATE TABLE IF NOT EXISTS generation_diagnostics (
        generation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, reasoning_mode TEXT NOT NULL DEFAULT 'fast',
        requested_max_output_tokens INTEGER NOT NULL, effective_max_output_tokens INTEGER NOT NULL,
        context_limit INTEGER NOT NULL, input_tokens INTEGER NOT NULL, agent_step_count INTEGER NOT NULL,
        finish_reason TEXT NOT NULL, prompt_eval_count INTEGER, prompt_eval_duration INTEGER,
        eval_count INTEGER, eval_duration INTEGER, tokens_per_second REAL, prompt_tokens_per_second REAL,
        time_to_first_token_ms REAL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS generation_diagnostics_conversation_idx ON generation_diagnostics(conversation_id, created_at DESC);
    `);
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN context_window INTEGER NOT NULL DEFAULT 32768'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN reasoning_mode TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN context_tokens INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN context_model_id TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec("ALTER TABLE conversations ADD COLUMN web_mode TEXT NOT NULL DEFAULT 'auto'"); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN primary_project_id TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN secondary_working_directory TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN secondary_project_id TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN thinking_timeline TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN generation_stats TEXT'); } catch { /* Existing databases already have this column. */ }
    this.db.exec("UPDATE conversations SET primary_project_id=lower(hex(randomblob(16))) WHERE working_directory IS NOT NULL AND primary_project_id IS NULL");
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN prompt_eval_count INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN prompt_eval_duration INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN eval_count INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN eval_duration INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN tokens_per_second REAL'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN prompt_tokens_per_second REAL'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN time_to_first_token_ms REAL'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE analysis_actions ADD COLUMN data TEXT'); } catch { /* Existing databases already have this column. */ }
    this.migrateAnalysisRuns();
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN reasoning_mode TEXT'); } catch { /* Existing databases already have this column. */ }
    // Map values persisted by the removed four-level control once. The legacy
    // columns stay in place for old SQLite files but are never read again.
    try { this.db.exec("UPDATE conversations SET reasoning_mode=CASE analysis_depth WHEN 'enhanced' THEN 'deep' WHEN 'deep' THEN 'deep' ELSE 'fast' END WHERE reasoning_mode IS NULL"); } catch { /* Fresh databases have no legacy column. */ }
    try { this.db.exec("UPDATE generation_diagnostics SET reasoning_mode=CASE reasoning_preset WHEN 'enhanced' THEN 'deep' WHEN 'deep' THEN 'deep' ELSE 'fast' END WHERE reasoning_mode IS NULL"); } catch { /* Fresh databases have no legacy column. */ }
    this.db.exec("UPDATE conversations SET reasoning_mode='fast' WHERE reasoning_mode IS NULL OR reasoning_mode NOT IN ('fast', 'deep')");
    this.db.exec("UPDATE analysis_runs SET reasoning_mode='fast' WHERE reasoning_mode IS NULL OR reasoning_mode NOT IN ('fast', 'deep')");
    this.db.exec("UPDATE generation_diagnostics SET reasoning_mode='fast' WHERE reasoning_mode IS NULL OR reasoning_mode NOT IN ('fast', 'deep')");
    // A removed model must not remain selected in persisted chats.
    this.db.prepare("UPDATE conversations SET model_id=NULL WHERE model_id='qwen3-coder:30b'").run();
  }

  close(): void { this.db.close(); }

  /** SQLite cannot remove NOT NULL columns in place. Rebuild only legacy
   * analysis_runs tables, preserving every run and its referenced actions. */
  private migrateAnalysisRuns(): void {
    const columns = this.db.prepare('PRAGMA table_info(analysis_runs)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('depth')) {
      if (!names.has('reasoning_mode')) this.db.exec("ALTER TABLE analysis_runs ADD COLUMN reasoning_mode TEXT NOT NULL DEFAULT 'fast'");
      this.db.exec('CREATE INDEX IF NOT EXISTS analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at)');
      return;
    }
    const reasoningMode = names.has('reasoning_mode')
      ? "CASE WHEN reasoning_mode='deep' OR depth IN ('enhanced', 'deep') THEN 'deep' ELSE 'fast' END"
      : "CASE WHEN depth IN ('enhanced', 'deep') THEN 'deep' ELSE 'fast' END";
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE analysis_runs_migrating (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, assistant_message_id TEXT,
        reasoning_mode TEXT NOT NULL DEFAULT 'fast', status TEXT NOT NULL,
        action_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT
      ) STRICT`);
      this.db.exec(`INSERT INTO analysis_runs_migrating
        (id, conversation_id, assistant_message_id, reasoning_mode, status, action_count, created_at, completed_at)
        SELECT id, conversation_id, assistant_message_id, ${reasoningMode}, status, action_count, created_at, completed_at
        FROM analysis_runs`);
      this.db.exec('DROP TABLE analysis_runs');
      this.db.exec('ALTER TABLE analysis_runs_migrating RENAME TO analysis_runs');
      this.db.exec('CREATE INDEX analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at)');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listConversations(): Conversation[] {
    return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as unknown as ConversationRow[]).map(mapConversation);
  }

  createConversation(modelId: string | null = null): Conversation {
    const id = randomUUID(); const now = new Date().toISOString();
    const title = 'Новый чат';
    this.db.prepare("INSERT INTO conversations (id, title, model_id, mode, working_directory, primary_project_id, secondary_working_directory, secondary_project_id, context_window, reasoning_mode, context_tokens, context_model_id, web_mode, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, 'auto', ?, ?)").run(id, title, modelId, 'chat', 32_768, 'fast', now, now);
    return { id, title, modelId, mode: 'chat', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 32_768, reasoningMode: 'fast', contextTokens: null, contextModelId: null, webMode: 'auto', createdAt: now, updatedAt: now };
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'reasoningMode' | 'webMode'>>): Conversation {
    const current = this.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory) next.primaryProjectId = patch.workingDirectory ? randomUUID() : null;
    if (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== current.secondaryWorkingDirectory) next.secondaryProjectId = patch.secondaryWorkingDirectory ? randomUUID() : null;
    const contextWindow = [16_384, 32_768, 65_536, 131_072, 262_144].includes(next.contextWindow) ? next.contextWindow : 32_768;
    const reasoningMode: ReasoningMode = next.reasoningMode === 'deep' ? 'deep' : 'fast';
    const webMode: WebMode = next.webMode === 'off' ? 'off' : 'auto';
    this.db.prepare('UPDATE conversations SET title=?, model_id=?, mode=?, working_directory=?, primary_project_id=?, secondary_working_directory=?, secondary_project_id=?, context_window=?, reasoning_mode=?, web_mode=?, updated_at=? WHERE id=?')
      .run(next.title, next.modelId, next.mode, next.workingDirectory, next.primaryProjectId, next.secondaryWorkingDirectory, next.secondaryProjectId, contextWindow, reasoningMode, webMode, next.updatedAt, id);
    next.contextWindow = contextWindow;
    next.reasoningMode = reasoningMode;
    next.webMode = webMode;
    return next;
  }

  deleteConversation(id: string): Attachment[] {
    const attachments = this.listAttachmentsForConversation(id);
    const runs = this.db.prepare('SELECT id FROM analysis_runs WHERE conversation_id=?').all(id) as unknown as Array<{ id: string }>;
    for (const run of runs) this.db.prepare('DELETE FROM analysis_actions WHERE run_id=?').run(run.id);
    this.db.prepare('DELETE FROM analysis_runs WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM generation_diagnostics WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(id);
    this.db.prepare('DELETE FROM project_references WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(id);
    this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
    return attachments;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as ConversationRow | undefined;
    return row ? mapConversation(row) : null;
  }

  listMessages(conversationId: string): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC').all(conversationId) as unknown as MessageRow[]).map((row) => mapMessage(row, this.listAttachments(row.id), this.listProjectReferences(row.id)));
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as MessageRow | undefined;
    return row ? mapMessage(row, this.listAttachments(row.id), this.listProjectReferences(row.id)) : null;
  }

  findUserMessage(conversationId: string, content: string): ChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='user' AND content=? ORDER BY rowid DESC LIMIT 1").get(conversationId, content) as unknown as MessageRow | undefined;
    return row ? mapMessage(row, this.listAttachments(row.id), this.listProjectReferences(row.id)) : null;
  }

  addMessage(conversationId: string, role: ChatMessage['role'], content: string, id: string = randomUUID(), projectReferences: ProjectReference[] = [], response?: Pick<ChatMessage, 'thinking' | 'thinkingTimeline' | 'generationStats'>): ChatMessage {
    const message: ChatMessage = { id, conversationId, role, content, createdAt: new Date().toISOString(), ...(response?.thinking?.trim() ? { thinking: response.thinking } : {}), ...(response?.thinkingTimeline?.length ? { thinkingTimeline: response.thinkingTimeline } : {}), ...(response?.generationStats ? { generationStats: response.generationStats } : {}) };
    this.db.prepare('INSERT INTO messages (id, conversation_id, role, content, thinking, thinking_timeline, generation_stats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(message.id, message.conversationId, message.role, message.content, message.thinking ?? null, message.thinkingTimeline ? JSON.stringify(message.thinkingTimeline) : null, message.generationStats ? JSON.stringify(message.generationStats) : null, message.createdAt);
    for (const [position, reference] of projectReferences.entries()) this.db.prepare('INSERT INTO project_references (id, message_id, position, project_id, project_slot, project_path, project_label, relative_path, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(reference.id, message.id, position, reference.projectId, reference.projectSlot, reference.projectPath, reference.projectLabel, reference.relativePath, reference.kind);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(message.createdAt, conversationId);
    return { ...message, projectReferences };
  }

  listProjectReferences(messageId: string): ProjectReference[] {
    return (this.db.prepare('SELECT * FROM project_references WHERE message_id=? ORDER BY position ASC').all(messageId) as unknown as ProjectReferenceRow[]).map(mapReference);
  }

  createAttachment(input: Omit<Attachment, 'createdAt' | 'updatedAt' | 'status'> & { status?: AttachmentStatus }): Attachment {
    const now = new Date().toISOString();
    const status = input.status ?? 'pending';
    this.db.prepare(`INSERT INTO attachments (id, message_id, position, kind, mime_type, filename, size, storage_ref, status, extracted_text, structured_data, vision_analysis, error, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.messageId, input.index, input.kind, input.mimeType, input.filename, input.size, input.storageRef, status, input.extractedText ?? null, input.structuredData ?? null, input.visionAnalysis ?? null, input.error ?? null, input.metadata ? JSON.stringify(input.metadata) : null, now, now);
    return this.getAttachment(input.id)!;
  }

  getAttachment(id: string): Attachment | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id) as unknown as AttachmentRow | undefined;
    return row ? mapAttachment(row) : null;
  }

  listAttachments(messageId: string): Attachment[] {
    return (this.db.prepare('SELECT * FROM attachments WHERE message_id=? ORDER BY position ASC').all(messageId) as unknown as AttachmentRow[]).map(mapAttachment);
  }

  listAttachmentsForConversation(conversationId: string): Attachment[] {
    return (this.db.prepare('SELECT attachments.* FROM attachments JOIN messages ON messages.id=attachments.message_id WHERE messages.conversation_id=? ORDER BY messages.rowid ASC, attachments.position ASC').all(conversationId) as unknown as AttachmentRow[]).map(mapAttachment);
  }

  updateAttachment(id: string, patch: Partial<Pick<Attachment, 'status' | 'extractedText' | 'structuredData' | 'visionAnalysis' | 'error' | 'metadata'>>): Attachment | null {
    const current = this.getAttachment(id); if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare('UPDATE attachments SET status=?, extracted_text=?, structured_data=?, vision_analysis=?, error=?, metadata=?, updated_at=? WHERE id=?')
      .run(next.status, next.extractedText ?? null, next.structuredData ?? null, next.visionAnalysis ?? null, next.error ?? null, next.metadata ? JSON.stringify(next.metadata) : null, new Date().toISOString(), id);
    return this.getAttachment(id);
  }

  editUserMessageAndTruncate(messageId: string, content: string): ChatMessage[] {
    const target = this.db.prepare("SELECT rowid, conversation_id, role FROM messages WHERE id=?").get(messageId) as { rowid: number; conversation_id: string; role: ChatMessage['role'] } | undefined;
    if (!target || target.role !== 'user') throw new Error('Можно редактировать только существующее пользовательское сообщение');
    const text = content.trim(); if (!text) throw new Error('Сообщение не может быть пустым');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE messages SET content=? WHERE id=?').run(text, messageId);
      return this.truncateAfterUserMessage(target, true);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  regenerateUserMessageAndTruncate(messageId: string): ChatMessage[] {
    const target = this.db.prepare("SELECT rowid, conversation_id, role FROM messages WHERE id=?").get(messageId) as { rowid: number; conversation_id: string; role: ChatMessage['role'] } | undefined;
    if (!target || target.role !== 'user') throw new Error('Можно перегенерировать ответ только для существующего сообщения пользователя');
    this.db.exec('BEGIN IMMEDIATE');
    try { return this.truncateAfterUserMessage(target, true); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private truncateAfterUserMessage(target: { rowid: number; conversation_id: string }, commit: boolean): ChatMessage[] {
    const downstream = this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND rowid>?').all(target.conversation_id, target.rowid) as Array<{ id: string }>;
    const assistantIds = downstream.map((row) => row.id);
    if (assistantIds.length) {
      const placeholders = assistantIds.map(() => '?').join(',');
      const runIds = this.db.prepare(`SELECT id FROM analysis_runs WHERE conversation_id=? AND assistant_message_id IN (${placeholders})`).all(target.conversation_id, ...assistantIds) as Array<{ id: string }>;
      for (const run of runIds) this.db.prepare('DELETE FROM analysis_actions WHERE run_id=?').run(run.id);
      if (runIds.length) this.db.prepare(`DELETE FROM analysis_runs WHERE id IN (${runIds.map(() => '?').join(',')})`).run(...runIds.map((run) => run.id));
    }
    this.db.prepare('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=? AND rowid>?)').run(target.conversation_id, target.rowid);
    this.db.prepare('DELETE FROM project_references WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=? AND rowid>?)').run(target.conversation_id, target.rowid);
    this.db.prepare('DELETE FROM messages WHERE conversation_id=? AND rowid>?').run(target.conversation_id, target.rowid);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), target.conversation_id);
    if (commit) this.db.exec('COMMIT');
    return this.listMessages(target.conversation_id);
  }

  setContextUsage(conversationId: string, modelId: string | null, tokens: number | null): Conversation | null {
    this.db.prepare('UPDATE conversations SET context_tokens=?, context_model_id=? WHERE id=?').run(tokens, modelId, conversationId);
    return this.getConversation(conversationId);
  }

  saveGenerationDiagnostics(diagnostics: GenerationDiagnostics): void {
    this.db.prepare(`INSERT OR REPLACE INTO generation_diagnostics
      (generation_id, conversation_id, reasoning_mode, requested_max_output_tokens, effective_max_output_tokens, context_limit, input_tokens, agent_step_count, finish_reason, prompt_eval_count, prompt_eval_duration, eval_count, eval_duration, tokens_per_second, prompt_tokens_per_second, time_to_first_token_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(diagnostics.generationId, diagnostics.conversationId, diagnostics.reasoningMode, diagnostics.requestedMaxOutputTokens, diagnostics.effectiveMaxOutputTokens, diagnostics.contextLimit, diagnostics.inputTokens, diagnostics.agentStepCount, diagnostics.finishReason, diagnostics.promptEvalCount ?? null, diagnostics.promptEvalDuration ?? null, diagnostics.evalCount ?? null, diagnostics.evalDuration ?? null, diagnostics.tokensPerSecond ?? null, diagnostics.promptTokensPerSecond ?? null, diagnostics.timeToFirstTokenMs ?? null, diagnostics.createdAt);
  }

  createAnalysisRun(conversationId: string, reasoningMode: ReasoningMode): AnalysisRun {
    const run = { id: randomUUID(), conversationId, assistantMessageId: null, reasoningMode, status: 'running' as const, actionCount: 0, actions: [], createdAt: new Date().toISOString(), completedAt: null };
    this.db.prepare('INSERT INTO analysis_runs (id, conversation_id, assistant_message_id, reasoning_mode, status, action_count, created_at, completed_at) VALUES (?, ?, NULL, ?, ?, 0, ?, NULL)').run(run.id, run.conversationId, run.reasoningMode, run.status, run.createdAt);
    return run;
  }

  addAnalysisAction(runId: string, activity: ToolActivity): AnalysisRun {
    const existing = this.db.prepare('SELECT id FROM analysis_actions WHERE id=? AND run_id=?').get(activity.id, runId) as { id: string } | undefined;
    const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS position FROM analysis_actions WHERE run_id=?').get(runId) as { position: number }).position + 1;
    const data = JSON.stringify({ ...activity, approval: undefined, attachment: undefined });
    if (existing) this.db.prepare('UPDATE analysis_actions SET label=?, detail=?, data=? WHERE id=? AND run_id=?').run(activity.label, activity.detail ?? null, data, activity.id, runId);
    else {
      this.db.prepare('INSERT INTO analysis_actions (id, run_id, label, detail, data, position) VALUES (?, ?, ?, ?, ?, ?)').run(activity.id, runId, activity.label, activity.detail ?? null, data, position);
      if (activity.kind !== 'progress' && activity.kind !== 'context') this.db.prepare('UPDATE analysis_runs SET action_count=action_count+1 WHERE id=?').run(runId);
    }
    return this.getAnalysisRun(runId)!;
  }

  finishAnalysisRun(runId: string, status: AnalysisRun['status'], assistantMessageId: string | null): AnalysisRun {
    this.db.prepare('UPDATE analysis_runs SET status=?, assistant_message_id=?, completed_at=? WHERE id=?').run(status, assistantMessageId, new Date().toISOString(), runId);
    return this.getAnalysisRun(runId)!;
  }

  listAnalysisRuns(conversationId: string): AnalysisRun[] { return (this.db.prepare('SELECT * FROM analysis_runs WHERE conversation_id=? ORDER BY created_at ASC').all(conversationId) as unknown as AnalysisRunRow[]).map((row) => mapRun(row, this.db.prepare('SELECT * FROM analysis_actions WHERE run_id=? ORDER BY position ASC').all(row.id) as unknown as AnalysisActionRow[])); }

  private getAnalysisRun(runId: string): AnalysisRun | null { const row = this.db.prepare('SELECT * FROM analysis_runs WHERE id=?').get(runId) as unknown as AnalysisRunRow | undefined; return row ? mapRun(row, this.db.prepare('SELECT * FROM analysis_actions WHERE run_id=? ORDER BY position ASC').all(runId) as unknown as AnalysisActionRow[]) : null; }
}
