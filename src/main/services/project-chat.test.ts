import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolMessage } from '../backends/types';
import { OllamaRequestError } from '../backends/ollama-errors';
import { AgentToolContext } from './agent-tool-context';
import { MAX_AGENT_STEPS_PER_GENERATION } from './analysis-engine';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const confirm = async () => ({ approved: false as const, reason: 'cancelled' as const });
const history = [{ id: 'user', conversationId: 'chat', role: 'user' as const, content: 'Make the change', createdAt: new Date().toISOString() }];

async function eventsFor(service: ProjectChatService, root: string, signal = new AbortController().signal): Promise<Array<{ type: string; content?: string; details?: string }>> {
  const events: Array<{ type: string; content?: string; details?: string }> = [];
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
    assert(events.filter((event) => event.type === 'tool').length === 1, 'tool was emitted more than once around inference retry');
    assert(await readFile(join(root, 'once.txt'), 'utf8') === 'written once', 'mutating tool was re-executed after inference retry');
    assert(snapshots[2].filter((message) => message.role === 'tool' && message.tool_name === 'write_file').length === 1, 'retry lost the completed tool result');
    assert(events.some((event) => event.content?.includes('Final response.')), 'tool-call turn without text was treated as an empty final response');

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
    assert(repeated.content.includes('cached_read'), 'unchanged repeat created another full tool history entry');
    assert(first.content.includes('A'.repeat(100)), 'active repeated read did not keep content available to the model');
    const rangeTwo: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 100, byte_end: 200, content: 'second range' }) };
    assert(!working.add('read_file', { path: 'src/A.ts', offset: 100 }, rangeTwo, 3).read?.sameContentAlreadyRead, 'different ranges were treated as the same read');
    const third: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 0, byte_end: 100, content: 'A'.repeat(6_000) }) };
    assert(working.add('read_file', { path: 'src/A.ts' }, third, 4).read?.repeatedReadLoopSuspected, 'repeated unchanged read loop was not diagnosed');
    const laterResult: ToolMessage = { role: 'tool', tool_name: 'search_text', content: JSON.stringify({ matches: ['x'.repeat(10_000)] }) };
    working.add('search_text', { query: 'x' }, laterResult, 20);
    assert(working.stats().size <= working.stats().budget, 'expired working-set read pin allowed context growth past its budget');
    const mutation: ToolMessage = { role: 'tool', tool_name: 'apply_patch', content: JSON.stringify({ applied: true, files: ['src/A.ts'] }) };
    working.add('apply_patch', {}, mutation, 5);
    const fresh: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '11:2', byte_start: 0, byte_end: 100, content: 'fresh content' }) };
    assert(!working.add('read_file', { path: 'src/A.ts' }, fresh, 6).read?.sameContentAlreadyRead && fresh.content.includes('fresh content'), 'mutation did not invalidate cached file content');
    assert(repeatUpdate.stats.size <= repeatUpdate.stats.budget, 'repeat cache made context unbounded');
    assert(MAX_AGENT_STEPS_PER_GENERATION === 100, 'existing Agent action limit changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (require.main === module) void runProjectChatRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
