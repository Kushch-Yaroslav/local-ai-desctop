import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { StreamEvent } from '../../shared/types';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function eventsFor(service: ProjectChatService, root: string, signal = new AbortController().signal, messages = history): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of service.stream('test-model', messages, root, signal, 16_384, 'fast', 'off', confirm)) events.push(event);
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
    assert(!events.some((event) => event.type === 'tool' && event.activity.kind === 'planning'), 'simple Agent run created a plan without requesting one');

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
    assert(repeated.content.includes('"requested_range_already_available":true'), 'unchanged repeat did not tell the model that the requested range remains available');
    assert(repeatUpdate.read?.relationship === 'exact_duplicate', 'same path/range/fingerprint was not diagnosed as an exact duplicate');
    assert(first.content.includes('A'.repeat(100)), 'active repeated read did not keep content available to the model');
    const coveredRange: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 1, byte_end: 100, content: 'covered range' }) };
    assert(working.add('read_file', { path: 'src/A.ts', offset: 1 }, coveredRange, 3).read?.relationship === 'covered', 'fully covered byte range was treated as unrelated new information');
    const fullRangeContext = new AgentToolContext(12_000);
    fullRangeContext.add('read_file', { path: 'src/full.ts' }, { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/full.ts', fingerprint: '1:1', size_bytes: 100, byte_start: 0, byte_end: 100, content: 'full file' }) }, 1);
    const coveredLineRange: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/full.ts', fingerprint: '1:1', start_line: 1, end_line: 2, content: 'covered lines' }) };
    assert(fullRangeContext.add('read_file', { path: 'src/full.ts', start_line: 1, end_line: 2 }, coveredLineRange, 2).read?.relationship === 'covered', 'full byte read did not cover a later line-range diagnostic');
    const overlappingRange: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/A.ts', fingerprint: '10:1', byte_start: 80, byte_end: 120, content: 'overlapping range' }) };
    assert(working.add('read_file', { path: 'src/A.ts', offset: 80 }, overlappingRange, 3).read?.relationship === 'overlap', 'partially overlapping byte range was not diagnosed');
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

    const terminalContext = new AgentToolContext(12_000);
    const terminalRead: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/terminal.ts', fingerprint: '1:1', byte_start: 0, byte_end: 20, content: 'before terminal' }) };
    terminalContext.add('read_file', { path: 'src/terminal.ts' }, terminalRead, 1);
    terminalContext.add('run_terminal', { command: 'node --version && node -e "const { DatabaseSync } = require(\'node:sqlite\'); console.log(\'sqlite ok\', typeof DatabaseSync)"' }, { role: 'tool', tool_name: 'run_terminal', content: JSON.stringify({ exit_code: 0 }) }, 2);
    const afterReadOnlyTerminal: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/terminal.ts', fingerprint: '1:1', byte_start: 0, byte_end: 20, content: 'before terminal' }) };
    assert(terminalContext.add('read_file', { path: 'src/terminal.ts' }, afterReadOnlyTerminal, 3).read?.sameContentAlreadyRead, 'read-only terminal command invalidated a generation-local read');
    terminalContext.add('run_terminal', { command: 'command -v node node22 nodejs 2>/dev/null; ls ~/.nvm/versions/node 2>/dev/null; echo "---nvm---"; command -v nvm 2>/dev/null; echo "---engines---"; node -e "console.log(require(\'./package.json\').engines || \'no engines\'); console.log(\'scripts\', JSON.stringify(Object.keys(require(\'./package.json\').scripts)))"' }, { role: 'tool', tool_name: 'run_terminal', content: JSON.stringify({ exit_code: 0 }) }, 3);
    const afterRedirectedReadOnlyTerminal: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/terminal.ts', fingerprint: '1:1', byte_start: 0, byte_end: 20, content: 'before terminal' }) };
    assert(terminalContext.add('read_file', { path: 'src/terminal.ts' }, afterRedirectedReadOnlyTerminal, 3).read?.sameContentAlreadyRead, 'read-only terminal stderr suppression invalidated a generation-local read');
    terminalContext.add('run_terminal', { command: 'printf changed > src/terminal.ts' }, { role: 'tool', tool_name: 'run_terminal', content: JSON.stringify({ exit_code: 0 }) }, 4);
    const afterMutatingTerminal: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/terminal.ts', fingerprint: '1:1', byte_start: 0, byte_end: 20, content: 'after terminal' }) };
    const terminalInvalidated = terminalContext.add('read_file', { path: 'src/terminal.ts' }, afterMutatingTerminal, 5).read;
    assert(!terminalInvalidated?.sameContentAlreadyRead && terminalInvalidated?.previousResultInvalidated && terminalInvalidated.previousInvalidationReason === 'terminal_may_have_mutated_files', 'mutating terminal command did not invalidate the cache with a reason');
    const newGenerationContext = new AgentToolContext(12_000);
    const newGenerationRead: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ path: 'src/terminal.ts', fingerprint: '1:1', byte_start: 0, byte_end: 20, content: 'new generation' }) };
    assert(!newGenerationContext.add('read_file', { path: 'src/terminal.ts' }, newGenerationRead, 1).read?.sameContentAlreadyRead, 'read cache leaked across generations');

    await writeFile(join(root, 'paged.ts'), 'first\nsecond\nthird\n', 'utf8');
    let activityCalls = 0;
    const activityAgent = new ProjectChatService({ chatWithTools: async () => {
      activityCalls += 1;
      if (activityCalls === 1) return { role: 'assistant' as const, content: '', tool_calls: [
        { function: { name: 'report_progress', arguments: { message: 'Изучаю текущую реализацию' } } },
        { function: { name: 'read_file', arguments: { path: 'paged.ts', start_line: 1, end_line: 2 } } },
        { function: { name: 'read_file', arguments: { path: 'paged.ts', start_line: 3, end_line: 3 } } },
      ] };
      if (activityCalls === 2) return { role: 'assistant' as const, content: '', tool_calls: [
        { function: { name: 'report_progress', arguments: { message: 'Перехожу к изменениям' } } },
        { function: { name: 'write_file', arguments: { path: 'phase-change.ts', content: 'export const changed = true;\n' } } },
      ] };
      return { role: 'assistant' as const, content: 'Готово.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const activityEvents = await eventsFor(activityAgent, root);
    const activities = activityEvents.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool').map((event) => event.activity);
    assert(activities.filter((activity) => activity.kind === 'progress').length === 2, 'phase progress events were not emitted separately');
    assert(activities.filter((activity) => activity.kind !== 'progress' && activity.state === 'completed').length === 3, 'progress consumed a normal Agent action or a completed phase action was absent');
    assert(activities.filter((activity) => activity.kind === 'progress').map((activity) => activity.label).join(' / ') === 'Изучаю текущую реализацию / Перехожу к изменениям', 'phase progress did not preserve safe user-visible transitions');
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

    const toolReply = (name: string, argumentsObject: Record<string, unknown>) => ({ role: 'assistant' as const, content: '', tool_calls: [{ function: { name, arguments: argumentsObject } }] });
    let noteCalls = 0;
    const noteSnapshots: ToolMessage[][] = [];
    const notesAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      noteCalls += 1; noteSnapshots.push(messages.map((message) => ({ ...message })));
      if (noteCalls === 1) return toolReply('task_notes', { action: 'update', notes: 'Цель: исправить diagnostics.\nНаходка: src/main/backends/llama-cpp-backend.ts переводит ms в ns.\nСледующий шаг: добавить округление.' });
      if (noteCalls === 2) return toolReply('task_notes', { action: 'read' });
      return { role: 'assistant' as const, content: 'Notes used.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const noteEvents = await eventsFor(notesAgent, root);
    assert(noteEvents.some((event) => event.type === 'token' && event.content.includes('Notes used.')), 'Task Notes interrupted normal Agent completion');
    const noteResults = noteSnapshots[2].filter((message) => message.role === 'tool' && message.tool_name === 'task_notes');
    assert(noteResults.at(-1)?.content.includes('src/main/backends/llama-cpp-backend.ts'), 'Task Notes were not available later in the same Agent run');
    let freshCalls = 0;
    const freshSnapshots: ToolMessage[][] = [];
    const freshAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      freshSnapshots.push(messages.map((message) => ({ ...message })));
      return freshCalls++ === 0 ? toolReply('task_notes', { action: 'read' }) : { role: 'assistant' as const, content: 'Fresh notes.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    await eventsFor(freshAgent, root);
    const freshReadResult = freshSnapshots[1].find((message) => message.role === 'tool' && message.tool_name === 'task_notes')?.content ?? '';
    assert(freshReadResult.includes('"empty":true'), 'Task Notes leaked into a new independent Agent run');
    let planCalls = 0;
    const planSnapshots: ToolMessage[][] = [];
    const plannedAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      planCalls += 1; planSnapshots.push(messages.map((message) => ({ ...message })));
      if (planCalls === 1) return toolReply('task_plan', { action: 'create', steps: [
        { id: 'flow', label: 'Найти существующий flow', status: 'in_progress' },
        { id: 'cancel', label: 'Проверить cancellation', status: 'pending' },
        { id: 'verify', label: 'Запустить проверки', status: 'pending' },
      ] });
      if (planCalls === 2) return toolReply('task_plan', { action: 'update', step_id: 'cancel', status: 'completed' });
      if (planCalls === 3) return toolReply('task_plan', { action: 'update', step_id: 'flow', status: 'completed' });
      if (planCalls === 4) return toolReply('task_plan', { action: 'update', step_id: 'cancel', status: 'in_progress' });
      if (planCalls === 5) return toolReply('task_plan', { action: 'update', step_id: 'cancel', status: 'completed' });
      return { role: 'assistant' as const, content: 'Plan complete.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const planEvents = await eventsFor(plannedAgent, root);
    const planActivities = planEvents.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'planning');
    assert(planActivities.some((event) => event.activity.state === 'error' && event.activity.detail?.includes('План обновлён')), 'invalid Plan status transition was not rejected as a tool error');
    const finalPlan = planActivities.filter((event) => event.activity.state === 'completed').at(-1)?.activity.plan;
    assert(finalPlan?.steps.map((step) => `${step.id}:${step.status}`).join(',') === 'flow:completed,cancel:completed,verify:pending', 'Plan creation or status transitions lost their structured state');
    assert(planSnapshots[5].filter((message) => message.role === 'tool' && message.tool_name === 'task_plan').at(-1)?.content.includes('cancel'), 'Plan state was not available later in the same Agent run');
    let freshPlanCalls = 0;
    const freshPlanSnapshots: ToolMessage[][] = [];
    const freshPlanAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      freshPlanSnapshots.push(messages.map((message) => ({ ...message })));
      return freshPlanCalls++ === 0 ? toolReply('task_plan', { action: 'read' }) : { role: 'assistant' as const, content: 'No prior plan.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    await eventsFor(freshPlanAgent, root);
    const freshPlanRead = freshPlanSnapshots[1].find((message) => message.role === 'tool' && message.tool_name === 'task_plan')?.content ?? '';
    assert(freshPlanRead.includes('"plan":null') && freshPlanRead.includes('"empty":true'), 'Plan leaked into a new independent Agent run');
    const stagnationContexts = (snapshots: ToolMessage[][], kind: string): ToolMessage[] => [...new Map(snapshots.flat().filter((message) => message.role === 'user' && message.content.startsWith(`<runtime_context kind="${kind}"`)).map((message) => [message.content, message])).values()];
    const writeFixture = async (paths: string[], source: (path: string, index: number) => string): Promise<void> => {
      await Promise.all(paths.map(async (path, index) => {
        await mkdir(join(root, dirname(path)), { recursive: true });
        await writeFile(join(root, path), source(path, index), 'utf8');
      }));
    };
    const reactPaths = Array.from({ length: 24 }, (_, index) => {
      const folder = ['app', 'components', 'lib'][index % 3];
      return `${folder}/implementation-${index + 1}.${folder === 'components' ? 'tsx' : 'ts'}`;
    });
    await writeFixture(reactPaths, (_path, index) => `export const implementation${index + 1} = ${index + 1};\n`);

    let usefulCalls = 0;
    const usefulSnapshots: ToolMessage[][] = [];
    const usefulExploration = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      usefulCalls += 1; usefulSnapshots.push(messages.map((message) => ({ ...message })));
      if (usefulCalls <= 22) return toolReply('read_file', { path: reactPaths[usefulCalls - 1] });
      return { role: 'assistant' as const, content: 'Useful exploration complete.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const usefulEvents = await eventsFor(usefulExploration, root);
    assert(!usefulEvents.some((event) => event.type === 'error'), 'many unique implementation reads were treated as stagnation');
    assert(stagnationContexts(usefulSnapshots, 'stagnation_guidance').length === 0, 'useful unique exploration received a premature stagnation intervention');

    let recoveryCalls = 0;
    const recoverySnapshots: ToolMessage[][] = [];
    const recoveryAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      recoveryCalls += 1; recoverySnapshots.push(messages.map((message) => ({ ...message })));
      if (recoveryCalls <= 15) return toolReply('read_file', { path: reactPaths[recoveryCalls - 1] });
      if (recoveryCalls <= 18) return toolReply('read_file', { path: reactPaths[0] });
      if (recoveryCalls === 19) return toolReply('read_file', { path: reactPaths[15] });
      if (recoveryCalls <= 23) return toolReply('search_text', { query: `focused-${recoveryCalls}` });
      if (recoveryCalls === 24) return toolReply('write_file', { path: 'implemented.ts', content: 'export const done = true;\n' });
      if (recoveryCalls === 25) return toolReply('git_status', {});
      return { role: 'assistant' as const, content: 'Implemented and verified.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const recoveryEvents = await eventsFor(recoveryAgent, root);
    assert(stagnationContexts(recoverySnapshots, 'stagnation_guidance').length === 1, 'first stagnation episode did not add exactly one runtime intervention');
    assert(stagnationContexts(recoverySnapshots, 'stagnation_guard').length === 0, 'useful targeted exploration followed by mutation escalated stagnation');
    assert(!recoveryEvents.some((event) => event.type === 'error'), 'mutation and verification did not reset stagnation');

    let secondGuardCalls = 0;
    const secondGuardSnapshots: ToolMessage[][] = [];
    const secondGuardAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      secondGuardCalls += 1; secondGuardSnapshots.push(messages.map((message) => ({ ...message })));
      if (secondGuardCalls <= 15) return toolReply('read_file', { path: reactPaths[secondGuardCalls - 1] });
      if (secondGuardCalls <= 18) return toolReply('read_file', { path: reactPaths[0] });
      if (secondGuardCalls <= 26) return toolReply('search_text', { query: `unresolved-${secondGuardCalls}` });
      if (secondGuardCalls === 27) return toolReply('write_file', { path: 'implemented-after-guard.ts', content: 'export const guarded = true;\n' });
      return { role: 'assistant' as const, content: 'Guarded implementation complete.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const secondGuardEvents = await eventsFor(secondGuardAgent, root);
    assert(stagnationContexts(secondGuardSnapshots, 'stagnation_guidance').length === 1, 'first intervention was missing before the second guard');
    assert(stagnationContexts(secondGuardSnapshots, 'stagnation_guard').length === 1, 'second stagnation episode did not add a stronger runtime guard');
    assert(!secondGuardEvents.some((event) => event.type === 'error'), 'second guard forced a mutation or failure before the agent could recover');
    assert(secondGuardSnapshots.every((messages) => !validateLlamaMessageSequence(messages)), 'stagnation runtime notices inserted a mid-history system message');

    let stalledCalls = 0;
    const stalledSnapshots: ToolMessage[][] = [];
    const stalledAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      stalledCalls += 1; stalledSnapshots.push(messages.map((message) => ({ ...message })));
      if (stalledCalls <= 15) return toolReply('read_file', { path: reactPaths[stalledCalls - 1] });
      if (stalledCalls <= 18) return toolReply('read_file', { path: reactPaths[0] });
      if (stalledCalls <= 26) return toolReply('search_text', { query: `unresolved-stalled-${stalledCalls}` });
      return toolReply('read_file', { path: reactPaths[0] });
    } }, new WebBrowserService());
    const stalledEvents = await eventsFor(stalledAgent, root);
    assert(stalledEvents.some((event) => event.type === 'error' && event.details?.includes('agent_stalled_exploration')), 'persistent exploration did not end with a controlled stalled-agent outcome');
    assert(stalledCalls < MAX_AGENT_STEPS_PER_GENERATION, 'stalled exploration reached the global 100-action ceiling');
    assert(stagnationContexts(stalledSnapshots, 'stagnation_guidance').length === 1 && stagnationContexts(stalledSnapshots, 'stagnation_guard').length === 1, 'stalled-agent outcome skipped its bounded interventions');

    let plannedStalledCalls = 0;
    const plannedStalledSnapshots: ToolMessage[][] = [];
    const plannedStalledAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      plannedStalledCalls += 1; plannedStalledSnapshots.push(messages.map((message) => ({ ...message })));
      if (plannedStalledCalls === 1) return toolReply('task_notes', { action: 'update', notes: 'Цель: проверить flow. Следующий шаг: завершить исследование и начать реализацию.' });
      if (plannedStalledCalls === 2) return toolReply('task_plan', { action: 'create', steps: [{ id: 'research', label: 'Исследовать текущий flow', status: 'in_progress' }, { id: 'implement', label: 'Реализовать изменение', status: 'pending' }] });
      if (plannedStalledCalls <= 17) return toolReply('read_file', { path: reactPaths[plannedStalledCalls - 3] });
      if (plannedStalledCalls <= 20) return toolReply('read_file', { path: reactPaths[0] });
      return { role: 'assistant' as const, content: 'Stopped broad exploration.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const plannedStalledEvents = await eventsFor(plannedStalledAgent, root);
    const planReminder = stagnationContexts(plannedStalledSnapshots, 'stagnation_plan_guidance');
    assert(planReminder.length === 1 && planReminder[0].content.includes('Task Notes') && planReminder[0].content.includes('минимально необходимый следующий шаг'), 'stalled exploration with a Plan did not receive the Plan + Task Notes reminder');
    assert(!plannedStalledEvents.some((event) => event.type === 'error'), 'Plan-aware stagnation reminder changed the existing hard-limit behavior');

    let researchCalls = 0;
    const researchSnapshots: ToolMessage[][] = [];
    const researchAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      researchCalls += 1; researchSnapshots.push(messages.map((message) => ({ ...message })));
      if (researchCalls <= 15) return toolReply('read_file', { path: reactPaths[researchCalls - 1] });
      if (researchCalls <= 20) return toolReply('read_file', { path: reactPaths[0] });
      return { role: 'assistant' as const, content: 'Architecture summary.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const researchHistory = [{ ...history[0], content: 'Опиши архитектуру и связи в этом проекте.' }];
    const researchEvents = await eventsFor(researchAgent, root, new AbortController().signal, researchHistory);
    assert(!researchEvents.some((event) => event.type === 'error'), 'read-only research task was treated as a failed coding task');
    assert(stagnationContexts(researchSnapshots, 'stagnation_guidance').length === 0, 'read-only research task was pushed toward a mutation');

    const nonJavaScriptPaths = Array.from({ length: 18 }, (_, index) => {
      const extension = ['py', 'go', 'rs'][index % 3];
      const folder = ['backend', 'server', 'packages/core'][index % 3];
      return `${folder}/module-${index + 1}.${extension}`;
    });
    await writeFixture(nonJavaScriptPaths, (path, index) => path.endsWith('.py') ? `VALUE_${index + 1} = ${index + 1}\n` : path.endsWith('.go') ? `package server\nconst Value${index + 1} = ${index + 1}\n` : `pub const VALUE_${index + 1}: usize = ${index + 1};\n`);
    let nonJavaScriptCalls = 0;
    const nonJavaScriptSnapshots: ToolMessage[][] = [];
    const nonJavaScriptAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      nonJavaScriptCalls += 1; nonJavaScriptSnapshots.push(messages.map((message) => ({ ...message })));
      if (nonJavaScriptCalls <= 15) return toolReply('read_file', { path: nonJavaScriptPaths[nonJavaScriptCalls - 1] });
      if (nonJavaScriptCalls <= 18) return toolReply('read_file', { path: nonJavaScriptPaths[0] });
      if (nonJavaScriptCalls === 19) return toolReply('write_file', { path: 'implemented-non-js.txt', content: 'done\n' });
      return { role: 'assistant' as const, content: 'Non-JavaScript implementation complete.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const nonJavaScriptEvents = await eventsFor(nonJavaScriptAgent, root);
    assert(stagnationContexts(nonJavaScriptSnapshots, 'stagnation_guidance').length === 1, 'Python, Go, and Rust source discovery was not recognized generically');
    assert(!nonJavaScriptEvents.some((event) => event.type === 'error'), 'non-JavaScript project recovery was treated as stalled');

    const rootSourcePaths = Array.from({ length: 18 }, (_, index) => `worker-${index + 1}.go`);
    await writeFixture(rootSourcePaths, (_path, index) => `package main\nconst Worker${index + 1} = ${index + 1}\n`);
    let rootSourceCalls = 0;
    const rootSourceSnapshots: ToolMessage[][] = [];
    const rootSourceAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      rootSourceCalls += 1; rootSourceSnapshots.push(messages.map((message) => ({ ...message })));
      if (rootSourceCalls <= 15) return toolReply('read_file', { path: rootSourcePaths[rootSourceCalls - 1] });
      if (rootSourceCalls <= 18) return toolReply('read_file', { path: rootSourcePaths[0] });
      if (rootSourceCalls === 19) return toolReply('write_file', { path: 'implemented-at-root.txt', content: 'done\n' });
      return { role: 'assistant' as const, content: 'Root-source implementation complete.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const rootSourceEvents = await eventsFor(rootSourceAgent, root);
    assert(stagnationContexts(rootSourceSnapshots, 'stagnation_guidance').length === 1, 'source files at the repository root were not recognized');
    assert(!rootSourceEvents.some((event) => event.type === 'error'), 'root-source project recovery was treated as stalled');

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
