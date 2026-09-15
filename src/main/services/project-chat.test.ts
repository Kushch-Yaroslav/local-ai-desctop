import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { StreamEvent } from '../../shared/types';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolMessage } from '../backends/types';
import { OllamaRequestError } from '../backends/ollama-errors';
import { AgentToolContext } from './agent-tool-context';
import { MAX_AGENT_STEPS_PER_GENERATION } from './analysis-engine';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import { validateLlamaMessageSequence } from '../backends/llama-cpp-backend';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const confirm = async () => ({ approved: false as const, reason: 'cancelled' as const });
const history = [{ id: 'user', conversationId: 'chat', role: 'user' as const, content: 'Make the change', createdAt: new Date().toISOString() }];

async function eventsFor(service: ProjectChatService, root: string, signal = new AbortController().signal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of service.stream('test-model', history, root, signal, 16_384, 'fast', 'off', confirm)) events.push(event);
  return events;
}

/** Focused Agent lifecycle regression coverage; run with `npm run test:agent-runtime`. */
export async function runProjectChatRegression(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-agent-runtime-'));
  try {
    let calls = 0;
    const snapshots: ToolMessage[][] = [];
    const backend = { chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      calls += 1; snapshots.push(messages.map((message) => ({ ...message })));
      if (calls === 1) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'once.txt', content: 'written once' } } }] };
      if (calls === 2) throw new OllamaRequestError('connection_reset', 'connection reset', { retryable: true, causeDetail: 'ECONNRESET' });
      if (calls === 3) return { role: 'assistant' as const, content: 'Tool completed.' };
      return { role: 'assistant' as const, content: 'Final response.', prompt_eval_count: 9, finish_reason: 'stop' as const };
    } };
    const service = new ProjectChatService(backend, new WebBrowserService());
    const events = await eventsFor(service, root);
    assert(calls === 4, 'transient inference failure was not retried exactly once');
    const writeEvents = events.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'mutation');
    assert(writeEvents.length === 2 && writeEvents[0].activity.id === writeEvents[1].activity.id, 'tool telemetry did not update one action around inference retry');
    assert(await readFile(join(root, 'once.txt'), 'utf8') === 'written once', 'mutating tool was re-executed after inference retry');
    assert(snapshots[2].filter((message) => message.role === 'tool' && message.tool_name === 'write_file').length === 1, 'retry lost the completed tool result');
    assert(events.some((event) => event.type === 'token' && event.content.includes('Final response.')), 'tool-call turn without text was treated as an empty final response');

    let repeatedCalls = 0;
    const repeatedlyFailing = new ProjectChatService({ chatWithTools: async () => {
      repeatedCalls += 1;
      throw new OllamaRequestError('connection_failure', 'fetch failed', { retryable: true, causeDetail: 'ECONNREFUSED' });
    } }, new WebBrowserService());
    const repeatedEvents = await eventsFor(repeatedlyFailing, root);
    assert(repeatedCalls === 3, 'retry policy did not stop after its bounded attempts');
    assert(repeatedEvents.some((event) => event.type === 'error' && event.details === 'fetch failed'), 'repeated transport failure did not produce the original clean error');

    let stoppedCalls = 0;
    const controller = new AbortController();
    const stopping = new ProjectChatService({ chatWithTools: async () => {
      stoppedCalls += 1;
      throw new OllamaRequestError('connection_failure', 'fetch failed', { retryable: true });
    } }, new WebBrowserService());
    const pending = eventsFor(stopping, root, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const stoppedEvents = await pending;
    assert(stoppedCalls === 1, 'Stop allowed a delayed retry or stale inference to start');
    assert(!stoppedEvents.some((event) => event.type === 'error'), 'Stop was reported as an inference failure');

    let emptyCalls = 0;
    const empty = new ProjectChatService({ chatWithTools: async () => {
      emptyCalls += 1;
      return { role: 'assistant' as const, content: '' };
    } }, new WebBrowserService());
    const emptyEvents = await eventsFor(empty, root);
    assert(emptyCalls === 2, 'true empty final response did not reach final synthesis');
    assert(emptyEvents.some((event) => event.type === 'error' && event.details?.includes('без итогового текста')), 'true empty final response was not classified');

    let contextCalls = 0;
    const exhausted = new ProjectChatService({ chatWithTools: async () => {
      contextCalls += 1;
      throw new OllamaRequestError('context_exhausted', 'Контекстное окно заполнено.', { causeDetail: 'input_tokens=16384' });
    } }, new WebBrowserService());
    const exhaustedEvents = await eventsFor(exhausted, root);
    assert(contextCalls === 1, 'context exhaustion was retried as a transport failure');
    assert(exhaustedEvents.some((event) => event.type === 'error' && event.details?.includes('Контекстное окно')), 'context exhaustion classification was lost');

    const context = new AgentToolContext(16_384);
    const previous: ToolMessage[] = [];
    for (let index = 0; index < 8; index += 1) {
      const message: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: `src/${index}.ts`, fingerprint: `v${index}`, start_line: 1, end_line: 300, content: String(index).repeat(7_000) }) };
      previous.push(message); context.add('read_file', { path: `src/${index}.ts`, start_line: 1, end_line: 300 }, message);
    }
    assert(context.stats().size <= context.stats().budget, 'large read_file results grew active Agent context past its budget');
    assert(previous.some((message) => message.content.includes('context_compacted')), 'old read_file result was not compacted deterministically');
    const reread: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/0.ts', fingerprint: 'v0', start_line: 301, end_line: 320, content: 're-read specific range' }) };
    context.add('read_file', { path: 'src/0.ts', start_line: 301, end_line: 320 }, reread);
    assert(reread.content.includes('re-read specific range'), 'a compacted file could not be read again with a specific range');

    const working = new AgentToolContext(12_000);
    const first: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 0, byte_end: 100, content: 'A'.repeat(6_000) }) };
    working.add('read_file', { path: 'src/A.ts' }, first, 1);
    const repeated: ToolMessage = { role: 'tool', tool_name: 'read_file', content: first.content };
    const repeatUpdate = working.add('read_file', { path: 'src/A.ts' }, repeated, 2);
    assert(repeated.content.includes('"status":"unchanged"'), 'unchanged repeat did not return a compact valid tool acknowledgement');
    assert(first.content.includes('A'.repeat(100)), 'active repeated read did not keep content available to the model');
    const rangeTwo: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 100, byte_end: 200, content: 'second range' }) };
    assert(!working.add('read_file', { path: 'src/A.ts', offset: 100 }, rangeTwo, 3).read?.sameContentAlreadyRead, 'different ranges were treated as the same read');
    const third: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 0, byte_end: 100, content: 'A'.repeat(6_000) }) };
    assert(working.add('read_file', { path: 'src/A.ts' }, third, 4).read?.repeatedReadLoopSuspected, 'repeated unchanged read loop was not diagnosed');
    const laterResult: ToolMessage = { role: 'tool', tool_name: 'search_text', content: JSON.stringify({ matches: ['x'.repeat(10_000)] }) };
    working.add('search_text', { query: 'x' }, laterResult, 20);
    assert(working.stats().size <= working.stats().budget, 'expired working-set read pin allowed context growth past its budget');
    const restored: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 0, byte_end: 100, content: 'A'.repeat(6_000) }) };
    working.add('read_file', { path: 'src/A.ts' }, restored, 21);
    assert(restored.content.includes('"status":"restored_cached_read"') || restored.content.includes('"status":"unchanged"'), 'compacted cached read did not produce a valid restoration acknowledgement');
    const restoring = new AgentToolContext(6_000);
    const compactable: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/restored.ts', fingerprint: '1:1', byte_start: 0, byte_end: 1, content: 'R'.repeat(7_000) }) };
    restoring.add('read_file', { path: 'src/restored.ts' }, compactable, 1);
    restoring.add('search_text', { query: 'other' }, { role: 'tool', tool_name: 'search_text', content: JSON.stringify({ matches: ['S'.repeat(7_000)] }) }, 10);
    const restoredAfterCompaction: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/restored.ts', fingerprint: '1:1', byte_start: 0, byte_end: 1, content: 'R'.repeat(7_000) }) };
    restoring.add('read_file', { path: 'src/restored.ts' }, restoredAfterCompaction, 11);
    assert(restoredAfterCompaction.content.includes('"status":"restored_cached_read"'), 'compacted cached read was not restored into active context');
    const mutation: ToolMessage = { role: 'tool', tool_name: 'apply_patch', content: JSON.stringify({ applied: true, files: ['src/A.ts'] }) };
    working.add('apply_patch', {}, mutation, 5);
    const fresh: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '11:2', byte_start: 0, byte_end: 100, content: 'fresh content' }) };
    assert(!working.add('read_file', { path: 'src/A.ts' }, fresh, 6).read?.sameContentAlreadyRead && fresh.content.includes('fresh content'), 'mutation did not invalidate cached file content');
    assert(repeatUpdate.stats.size <= repeatUpdate.stats.budget, 'repeat cache made context unbounded');

    await writeFile(join(root, 'paged.ts'), 'first\nsecond\nthird\n', 'utf8');
    let activityCalls = 0;
    const activityAgent = new ProjectChatService({ chatWithTools: async () => {
      activityCalls += 1;
      if (activityCalls === 1) return { role: 'assistant' as const, content: '', tool_calls: [
        { function: { name: 'report_progress', arguments: { message: 'Изучаю текущую реализацию' } } },
        { function: { name: 'read_file', arguments: { path: 'paged.ts', start_line: 1, end_line: 2 } } },
        { function: { name: 'read_file', arguments: { path: 'paged.ts', start_line: 3, end_line: 3 } } },
      ] };
      return { role: 'assistant' as const, content: 'Готово.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const activityEvents = await eventsFor(activityAgent, root);
    const activities = activityEvents.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool').map((event) => event.activity);
    assert(activities.filter((activity) => activity.kind === 'progress').length === 1, 'progress event was not emitted separately');
    assert(activities.filter((activity) => activity.kind !== 'progress' && activity.state === 'completed').length === 2, 'progress consumed a normal Agent action or read completion was absent');
    const pageDetails = activities.filter((activity) => activity.kind === 'file_read' && activity.state === 'completed').map((activity) => activity.detail);
    assert(pageDetails.includes('paged.ts · строки 1–2') && pageDetails.includes('paged.ts · строка 3'), 'consecutive file pagination did not retain actual ranges');
    assert(MAX_AGENT_STEPS_PER_GENERATION === 100, 'progress changed the Agent action limit');

    let unchangedCalls = 0;
    const unchangedAgent = new ProjectChatService({ chatWithTools: async () => {
      unchangedCalls += 1;
      if (unchangedCalls <= 2) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'paged.ts', start_line: 1, end_line: 2 } } }] };
      return { role: 'assistant' as const, content: 'Готово.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const unchangedEvents = await eventsFor(unchangedAgent, root);
    const unchangedRead = unchangedEvents.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'file_read' && event.activity.state === 'completed').at(-1)?.activity;
    assert(unchangedRead?.metadata?.status === 'unchanged', 'identical active read was not presented as unchanged telemetry');

    let progressCalls = 0;
    const spamSafeAgent = new ProjectChatService({ chatWithTools: async () => {
      progressCalls += 1;
      if (progressCalls === 1) return { role: 'assistant' as const, content: '', tool_calls: Array.from({ length: 14 }, (_, index) => ({ function: { name: 'report_progress', arguments: { message: `Этап ${index + 1}` } } })) };
      return { role: 'assistant' as const, content: 'Готово.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const spamEvents = await eventsFor(spamSafeAgent, root);
    assert(spamEvents.filter((event) => event.type === 'tool' && event.activity.kind === 'progress').length === 12, 'progress report rate limit was not bounded');

    let longCalls = 0;
    const longSnapshots: ToolMessage[][] = [];
    const longAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      longCalls += 1; longSnapshots.push(messages.map((message) => ({ ...message })));
      if (longCalls <= 26) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: `missing-${longCalls}.ts`, start_line: 1, end_line: 2 } } }] };
      return { role: 'assistant' as const, content: 'Completed after a long tool sequence.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    await eventsFor(longAgent, root);
    assert(longSnapshots.length >= 27, 'long Agent regression did not reach final synthesis');
    assert(longSnapshots.every((messages) => !validateLlamaMessageSequence(messages)), 'runtime inserted an invalid mid-history system message during a long Agent sequence');
    assert(MAX_AGENT_STEPS_PER_GENERATION === 100, 'existing Agent action limit changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (require.main === module) void runProjectChatRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
