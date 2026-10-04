// Exports one persisted Agent run (the one with the most reasoning by default) from a COPY of the app database into the
// JSON that replay.mjs and load.mjs consume:  node export-run.mjs /tmp/copy-of.db [conversationId] > run.json
// Never point it at the live database; copy the file first.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const explicit = process.argv[3];
const target = explicit ?? db.prepare("SELECT conversation_id AS id FROM messages WHERE role = 'assistant' ORDER BY length(coalesce(thinking_timeline, '')) DESC LIMIT 1").get()?.id;
if (!target) throw new Error('no conversation with an Agent timeline found');
const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(target);
const assistant = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY length(coalesce(thinking_timeline, '')) DESC LIMIT 1").get(target);
const run = db.prepare('SELECT id FROM analysis_runs WHERE assistant_message_id = ?').get(assistant.id);
const actions = db.prepare('SELECT data FROM analysis_actions WHERE run_id = ? ORDER BY position').all(run.id).map((row) => JSON.parse(row.data));
const user = db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at <= ? ORDER BY created_at DESC LIMIT 1").get(target, assistant.created_at);
process.stdout.write(JSON.stringify({
  conversation, user: user?.content ?? '', timeline: JSON.parse(assistant.thinking_timeline), actions,
  assistant: { id: assistant.id, conversationId: target, role: 'assistant', content: assistant.content, createdAt: assistant.created_at, thinking: assistant.thinking, thinkingTimeline: JSON.parse(assistant.thinking_timeline) },
  userMessage: { id: 'user-final', conversationId: target, role: 'user', content: user?.content ?? '', createdAt: assistant.created_at },
}));
