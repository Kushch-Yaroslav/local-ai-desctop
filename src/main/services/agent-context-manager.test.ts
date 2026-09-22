import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolMessage } from '../backends/types';
import type { StreamEvent } from '../../shared/types';
import { AgentContextManager, agentContextThresholds } from './agent-context-manager';
import { AgentToolContext } from './agent-tool-context';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import { Database } from './database';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const tool = (name: string, content: string, id: string): ToolMessage => ({ role: 'tool', tool_name: name, tool_call_id: id, content });
const count = (messages: ToolMessage[], tools?: unknown[]): number => Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools ?? []).length) / 2) + messages.length * 20;
const memory = { plan: { steps: [{ id: 'implement', label: 'Implement the requested change', status: 'in_progress' as const }] }, taskNotes: 'Current goal: preserve continuity. Known fact A. File B modified. Failed approach C: it did not work. Next intended step: D.' };

async function compact(manager: AgentContextManager, messages: ToolMessage[], tools: unknown[] = []): Promise<ReturnType<AgentContextManager['stats']>> {
  return manager.prepare(messages, tools, async () => count(messages, tools), memory);
}

function syntheticHistory(entries: number, chars = 5_000): ToolMessage[] {
  const messages: ToolMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: '<project_references>Explicit file: src/important.ts</project_references> Original goal: implement it.' }];
  for (let index = 0; index < entries; index += 1) {
    messages.push({ role: 'assistant', content: `Investigating step ${index}`, tool_calls: [{ id: `call-${index}`, function: { name: 'run_terminal', arguments: { command: `cat log-${index}` } } }] });
    messages.push(tool('run_terminal', JSON.stringify({ command: `cat log-${index}`, exit_code: index === 2 ? 1 : 0, stdout: `result-${index}\n${'x'.repeat(chars)}`, ...(index === 2 ? { error: 'approach C failed because fixture is incompatible' } : {}) }), `call-${index}`));
  }
  return messages;
}

/** Context-manager unit and Agent-loop integration coverage. */
export async function runAgentContextManagerRegression(): Promise<void> {
  // A. Small runs are byte-for-byte untouched.
  const small = [{ role: 'system', content: 'system' }, { role: 'user', content: 'small request' }] as ToolMessage[];
  const smallBefore = JSON.stringify(small);
  const smallStats = await compact(new AgentContextManager(32_768), small);
  assert(!smallStats.compactionTriggered && JSON.stringify(small) === smallBefore, 'small context unexpectedly compacted');

  // No-op tokenizer results must not rewrite history or emit a false-success
  // compaction on every following inference.
  const ineffective = syntheticHistory(8, 2_000); const ineffectiveBefore = JSON.stringify(ineffective);
  const ineffectiveManager = new AgentContextManager(32_768);
  const fixedCount = async (): Promise<number> => 24_000;
  const firstIneffective = await ineffectiveManager.prepare(ineffective, [], fixedCount, memory);
  const secondIneffective = await ineffectiveManager.prepare(ineffective, [], fixedCount, memory);
  assert(firstIneffective.compactionAttempted && !firstIneffective.compactionTriggered && firstIneffective.ineffectiveCompactionCount === 1, 'tiny/no-op compaction was reported as successful');
  assert(!secondIneffective.compactionAttempted && secondIneffective.ineffectiveCompactionCount === 1, 'ineffective compaction retried without meaningful context growth');
  assert(JSON.stringify(ineffective) === ineffectiveBefore, 'ineffective compaction changed active history');

  // B/G. Thresholds are relative to 16K/32K/64K and leave the chosen window unchanged.
  for (const window of [16_384, 32_768, 65_536]) {
    const messages = syntheticHistory(window === 16_384 ? 12 : window === 32_768 ? 24 : 48, 3_800);
    const manager = new AgentContextManager(window);
    const stats = await compact(manager, messages);
    assert(stats.contextWindow === window && stats.compactionTriggered, `context manager did not compact ${window}`);
    assert(stats.meaningfulSavings && stats.inputTokensAfter < stats.inputTokensBefore, `compaction did not materially reduce ${window} (after=${stats.inputTokensAfter})`);
    const checkpoint = messages.find((message) => message.content.includes('working_memory_checkpoint'))?.content ?? '';
    assert(checkpoint.includes('Known fact A') && checkpoint.includes('Failed approach C') && checkpoint.includes('src/important.ts'), `checkpoint lost continuity for ${window}`);
  }

  // C. Huge outputs retain raw input outside the model-facing representation,
  // including exit status and critical stderr lines.
  const hugeRaw = JSON.stringify({ command: 'cat huge.log', exit_code: 2, stdout: `head\n${'x'.repeat(80_000)}\ntail`, stderr: `warning: attention\nFATAL: important failure\n${'y'.repeat(8_000)}` });
  const toolContext = new AgentToolContext(32_768);
  const hugeMessage = tool('run_terminal', hugeRaw, 'huge');
  toolContext.add('run_terminal', { command: 'cat huge.log' }, hugeMessage, 1);
  assert(hugeMessage.content.length < hugeRaw.length / 4 && hugeMessage.content.includes('exit_code') && hugeMessage.content.includes('FATAL'), 'huge terminal result was not shaped safely');
  assert(hugeRaw.includes('FATAL: important failure'), 'raw terminal fixture was altered');
  const rawHistoryPath = join(tmpdir(), `local-ai-context-raw-${Date.now()}.sqlite`);
  const rawHistory = new Database(rawHistoryPath);
  let rawHistoryClosed = false;
  try {
    const chat = rawHistory.createConversation(); const run = rawHistory.createAnalysisRun(chat.id, 'auto');
    rawHistory.addAnalysisAction(run.id, { id: 'raw-terminal', label: 'Terminal', kind: 'terminal', rawOutput: hugeRaw });
    assert(!('rawOutput' in rawHistory.listAnalysisRuns(chat.id)[0].actions[0]), 'raw output leaked to the UI run representation');
    rawHistory.close(); rawHistoryClosed = true;
    const inspection = new DatabaseSync(rawHistoryPath);
    const stored = inspection.prepare("SELECT data FROM analysis_actions WHERE id='raw-terminal'").get() as { data: string };
    inspection.close();
    assert((JSON.parse(stored.data) as { rawOutput?: string }).rawOutput === hugeRaw, 'full raw tool result was not persisted in SQLite');
  } finally { if (!rawHistoryClosed) rawHistory.close(); await rm(rawHistoryPath, { force: true }); }

  // D. Repeated file reads are represented once in active context.
  const duplicate = new AgentToolContext(32_768);
  const one = tool('read_file', JSON.stringify({ path: 'a.ts', project_id: 'project-1', fingerprint: 'same', start_line: 1, end_line: 2, has_more: false, content: 'const answer = 42;' }), 'one');
  const two = tool('read_file', one.content, 'two');
  duplicate.add('read_file', { path: 'a.ts' }, one, 1); duplicate.add('read_file', { path: 'a.ts' }, two, 2);
  assert(two.content.includes('unchanged') || two.content.includes('restored_cached_read'), 'duplicate read retained a second full active result');

  // E/F. Multiple cycles preserve checkpoint facts without restoring obsolete raw messages.
  const long = syntheticHistory(30, 5_000); const cycleManager = new AgentContextManager(32_768);
  const first = await compact(cycleManager, long);
  long.push(...syntheticHistory(18, 5_000).slice(2));
  const second = await compact(cycleManager, long);
  assert(first.compactionTriggered && second.compactionTriggered && second.compactionCount >= 2, 'long run did not survive multiple compactions');
  const continuity = long.find((message) => message.content.includes('working_memory_checkpoint'))?.content ?? '';
  assert(continuity.includes('Failed approach C') && long.filter((message) => message.content.includes('context_compacted')).length > 4, 'old raw failures/results were not compacted while preserving continuity');

  // Working Memory is a bounded durable index, not another raw transcript.
  // Exact evidence remains available through the generation-local recall path.
  const recalled = cycleManager.retrieve('approach C');
  assert(recalled.includes('approach C failed because fixture is incompatible'), 'targeted history recall did not return compacted raw evidence');
  assert(cycleManager.stats().historyRetrievalCount === 1, 'history retrieval telemetry was not incremented');
  assert(cycleManager.stats().workingMemoryTokens <= Math.ceil(32_768 * 0.1), 'Working Memory exceeded its bounded share of the active context');

  const durable = syntheticHistory(24, 4_000); durable[1].content = 'Analyze both projects only. Do not modify any files. Keep a plan and task notes.';
  const durableManager = new AgentContextManager(32_768);
  await compact(durableManager, durable);
  const firstCheckpoint = durable.find((message) => message.content.includes('working_memory_checkpoint'))?.content ?? '';
  assert(firstCheckpoint.includes('Do not modify any files'), 'explicit user constraint was lost during compaction');
  const duplicateRead = tool('read_file', JSON.stringify({ path: 'core/audio.py', project_label: 'Project 1', content: 'audio fact' }), 'dedup-1');
  durable.push(duplicateRead); durableManager.observe(duplicateRead, durable, memory, duplicateRead.content);
  const repeatedRead = tool('read_file', duplicateRead.content, 'dedup-2');
  durable.push(repeatedRead); durableManager.observe(repeatedRead, durable, memory, repeatedRead.content);
  assert(durableManager.stats().factsDeduplicated > 0, 'repeated fact expanded Working Memory instead of being deduplicated');
  const hypothesis = tool('task_notes', JSON.stringify({ updated: true }), 'hypothesis');
  durableManager.observe(hypothesis, durable, { ...memory, taskNotes: 'Hypothesis: AudioEngine owns the queue (tentative). Open question: confirm owner.' });
  durableManager.observe(hypothesis, durable, { ...memory, taskNotes: 'Confirmed fact: AudioEngine owns the queue. Next step: trace controller handoff.' });
  const currentCheckpoint = durable.find((message) => message.content.includes('working_memory_checkpoint'))?.content ?? '';
  assert(currentCheckpoint.includes('Confirmed fact: AudioEngine owns the queue') && !currentCheckpoint.includes('tentative). Open question'), 'Task Notes hypothesis lifecycle was not consolidated');
  const projectOne = tool('read_file', JSON.stringify({ path: 'main.py', project_label: 'Project 1', content: 'one' }), 'project-one');
  const projectTwo = tool('read_file', JSON.stringify({ path: 'main.py', project_label: 'Project 2', content: 'two' }), 'project-two');
  durableManager.observe(projectOne, durable, memory, projectOne.content); durableManager.observe(projectTwo, durable, memory, projectTwo.content);
  const projectsCheckpoint = durable.find((message) => message.content.includes('working_memory_checkpoint'))?.content ?? '';
  assert(projectsCheckpoint.includes('Project 1 / main.py') && projectsCheckpoint.includes('Project 2 / main.py'), 'Working Memory mixed facts from the two projects');

  // A reminder is periodic: it asks the existing Agent turn to checkpoint
  // knowledge, without starting a separate summary inference.
  const reminderManager = new AgentContextManager(32_768); const reminderMessages = syntheticHistory(24, 4_000);
  await compact(reminderManager, reminderMessages);
  let reminder = undefined as ReturnType<AgentContextManager['observe']>;
  for (let index = 0; index < 8; index += 1) {
    const inspection = tool('read_file', JSON.stringify({ path: `flow-${index}.py`, content: 'new source' }), `reminder-${index}`);
    reminderMessages.push(inspection); reminder = reminderManager.observe(inspection, reminderMessages, memory, inspection.content) ?? reminder;
  }
  assert(reminder?.reason === 'inspection_batch' && reminder.message.includes('Task Notes'), 'long inspection phase did not request a Working Memory checkpoint');

  // Real Agent-loop simulation: project tools, a huge terminal result, writes,
  // many tool decisions, compaction, and a normal final response in one run.
  const root = await mkdtemp(join(tmpdir(), 'local-ai-context-stress-'));
  try {
    await writeFile(join(root, 'huge.log'), `${'ordinary line\n'.repeat(16_000)}FATAL: retained critical line\n`);
    let turn = 0; const snapshots: ToolMessage[][] = []; const managerSnapshots: ToolMessage[][] = [];
    const backend = {
      countInputTokens: async (_model: string, messages: ToolMessage[], tools: unknown[] | undefined) => count(messages, tools),
      chatWithTools: async (_model: string, messages: ToolMessage[]) => {
        turn += 1; snapshots.push(messages.map((message) => ({ ...message })));
        if (messages.some((message) => message.content.includes('working_memory_checkpoint'))) managerSnapshots.push(messages.map((message) => ({ ...message })));
        if (turn === 1) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'task_notes', arguments: { action: 'update', notes: memory.taskNotes } } }] };
        if (turn === 2) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'task_plan', arguments: { action: 'create', steps: memory.plan.steps } } }] };
        if (turn <= 18) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'run_terminal', arguments: { command: `cat huge.log | head -n ${turn * 800}` } } }] };
        if (turn === 19) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'modified.txt', content: 'done' } } }] };
        if (turn === 20) return { role: 'assistant' as const, content: 'Implementation and verification are complete.' };
        return { role: 'assistant' as const, content: 'Final completion after context compaction.', finish_reason: 'stop' as const };
      },
    };
    const service = new ProjectChatService(backend, new WebBrowserService());
    const events: StreamEvent[] = [];
    const history = [{ id: 'user', conversationId: 'chat', role: 'user' as const, content: 'Inspect logs, update the fixture and finish safely.', createdAt: new Date().toISOString() }];
    for await (const event of service.stream('test-model', history, root, new AbortController().signal, 32_768, 'fast', 'off', async () => ({ approved: true as const, reason: 'once' as const }))) events.push(event);
    assert(turn >= 21 && managerSnapshots.length > 0, 'Agent runtime did not cross the context checkpoint threshold');
    const finalCheckpoint = managerSnapshots.at(-1)!.find((message) => message.content.includes('working_memory_checkpoint'))?.content ?? '';
    assert(finalCheckpoint.includes('Known fact A') && finalCheckpoint.includes('Failed approach C') && finalCheckpoint.includes('modified.txt'), 'Agent checkpoint did not retain task continuity');
    assert(await readFile(join(root, 'modified.txt'), 'utf8') === 'done', 'Agent could not continue to mutation after compaction');
    const contextEvent = events.find((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'context');
    assert(contextEvent?.activity.state === 'completed' && contextEvent.activity.metadata?.context_window === 32_768 && typeof contextEvent.activity.metadata?.input_tokens_before === 'number', 'automatic compaction did not produce a structured Agent status event');
    assert(events.some((event) => event.type === 'token' && event.content.includes('Final completion')), 'Agent did not complete after compaction');
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith('agent-context-manager.test.js')) void runAgentContextManagerRegression().catch((error) => { console.error(error); process.exitCode = 1; });
