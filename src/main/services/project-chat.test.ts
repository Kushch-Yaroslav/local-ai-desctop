import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { StreamEvent } from '../../shared/types';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolInferenceRequestContext, ToolMessage } from '../backends/types';
import { OllamaRequestError } from '../backends/ollama-errors';
import { AgentToolContext } from './agent-tool-context';
import { MAX_AGENT_STEPS_PER_GENERATION } from './analysis-engine';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import { validateLlamaMessageSequence } from '../backends/llama-cpp-backend';
import { projectDirectoryName } from '../../shared/project-references';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const confirm = async () => ({ approved: false as const, reason: 'cancelled' as const });
const history = [{ id: 'user', conversationId: 'chat', role: 'user' as const, content: 'Make the change', createdAt: new Date().toISOString() }];
const malformedToolArgumentsError = () => Object.assign(new Error('llama.cpp rejected tool arguments'), {
  request: { status: 500, serverError: 'Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] invalid string: missing closing quote' },
});
const ollamaMalformedToolArgumentsError = () => new OllamaRequestError(
  'http_error',
  "Ollama вернул HTTP 400: Value looks like object, but can't find closing '}' symbol",
  { status: 400, causeDetail: "Value looks like object, but can't find closing '}' symbol" },
);

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
    const requestContexts: ToolInferenceRequestContext[] = [];
    const backend = { chatWithTools: async (_model: string, messages: ToolMessage[], _tools?: unknown[], _signal?: AbortSignal, _contextWindow?: number, _depth?: unknown, requestContext?: ToolInferenceRequestContext) => {
      calls += 1; snapshots.push(messages.map((message) => ({ ...message })));
      if (requestContext) requestContexts.push(requestContext);
      if (calls === 1) throw new Error('llama.cpp inference connection failed: fetch failed');
      if (calls === 2) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'once.txt', content: 'written once' } } }] };
      if (calls === 3) return { role: 'assistant' as const, content: 'Tool completed.' };
      return { role: 'assistant' as const, content: 'Final response.', prompt_eval_count: 9, finish_reason: 'stop' as const };
    } };
    const service = new ProjectChatService(backend, new WebBrowserService());
    const events = await eventsFor(service, root);
    assert(calls === 4, 'initial transient llama.cpp connection failure was not retried exactly once');
    assert(JSON.stringify(snapshots[0]) === JSON.stringify(snapshots[1]), 'initial retry changed the logical Agent request');
    assert(requestContexts.length === 4 && requestContexts[0].phase === 'initial' && requestContexts[1].phase === 'initial' && requestContexts[2].phase === 'post_tool' && requestContexts[3].phase === 'final', 'Agent inference phases were not preserved for runtime diagnostics');
    assert(requestContexts.slice(0, 3).every((context) => context.maxOutputTokens === 4_096) && requestContexts[3].maxOutputTokens === undefined, 'non-streaming tool-decision turns were not bounded independently from final synthesis');
    const writeEvents = events.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'mutation');
    assert(writeEvents.length === 2 && writeEvents[0].activity.id === writeEvents[1].activity.id, 'initial retry duplicated Agent tool telemetry');
    assert(await readFile(join(root, 'once.txt'), 'utf8') === 'written once', 'initial retry duplicated a mutating tool');
    assert(snapshots[2].filter((message) => message.role === 'tool' && message.tool_name === 'write_file').length === 1, 'Agent tool result was duplicated after initial retry');
    assert(events.some((event) => event.type === 'token' && event.content.includes('Final response.')), 'tool-call turn without text was treated as an empty final response');
    assert(!events.some((event) => event.type === 'tool' && event.activity.kind === 'planning'), 'simple Agent run created a plan without requesting one');

    let inlineCalls = 0;
    const inlineAgent = new ProjectChatService({ chatWithTools: async () => {
      inlineCalls += 1;
      if (inlineCalls === 1) return { role: 'assistant' as const, content: 'Сначала закоммичу изменения.\n<tool_call>\n<function=run_terminal>\n<parameter=command>\ngit commit -m "fix"\n</parameter>\n</function>\n</tool_call>\nГотово.', tool_calls: undefined };
      return { role: 'assistant' as const, content: 'Готово.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const inlineEvents = await eventsFor(inlineAgent, root);
    const inlineTokens = inlineEvents.filter((event) => event.type === 'token').map((event) => (event as { content: string }).content).join('');
    assert(!inlineTokens.includes('<tool_call>') && !inlineTokens.includes('<function=') && !inlineTokens.includes('<parameter='), 'raw inline tool-call markup leaked into the assistant message');

    let truncatedDecisionCalls = 0;
    const truncatedDecisionSnapshots: ToolMessage[][] = [];
    const truncatedDecisionAgent = new ProjectChatService({ chatWithTools: async (_model, messages) => {
      truncatedDecisionCalls += 1; truncatedDecisionSnapshots.push(messages.map((message) => ({ ...message })));
      if (truncatedDecisionCalls === 1) return { role: 'assistant' as const, content: '', thinking: 'tool decision was cut off before the call', finish_reason: 'length' as const };
      if (truncatedDecisionCalls === 2) return { role: 'assistant' as const, content: '<tool_call>\n<function=run_terminal>\n<parameter=command>\npwd\n</parameter>\n</function>\n</tool_call>' };
      if (truncatedDecisionCalls === 3) return { role: 'assistant' as const, content: 'The terminal command completed.' };
      return { role: 'assistant' as const, content: 'Final terminal result.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const truncatedDecisionEvents = await eventsFor(truncatedDecisionAgent, root);
    assert(truncatedDecisionCalls === 4, 'a truncated tool-decision response entered final synthesis instead of continuing with tools enabled');
    assert(truncatedDecisionEvents.some((event) => event.type === 'tool' && event.activity.kind === 'terminal' && event.activity.state === 'completed'), 'textual run_terminal after a truncated tool decision was not executed');
    assert(truncatedDecisionSnapshots[2].some((message) => message.role === 'tool' && message.tool_name === 'run_terminal'), 'terminal result after a truncated tool decision was not returned to Qwen');
    assert(truncatedDecisionEvents.some((event) => event.type === 'token' && event.content.includes('Final terminal result.')), 'truncated tool-decision continuation did not reach a final response');

    const html = '<!doctype html>\n<html>\n<head><style>body { color: #123; }</style></head>\n<body><script>const title = `Local <tool_call> text`;</script><h1>Ready</h1></body>\n</html>\n';
    let textualCalls = 0;
    const textualSnapshots: ToolMessage[][] = [];
    const textualAgent = new ProjectChatService({ chatWithTools: async (_model, messages) => {
      textualCalls += 1; textualSnapshots.push(messages.map((message) => ({ ...message })));
      if (textualCalls === 1) return { role: 'assistant' as const, content: `<tool_call>\n<function=create_file>\n<parameter=content>${html}</parameter>\n<parameter=file_path>index.html</parameter>\n</function>\n</tool_call>` };
      if (textualCalls === 2) return { role: 'assistant' as const, content: 'File created.' };
      return { role: 'assistant' as const, content: 'Done.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const textualEvents = await eventsFor(textualAgent, root);
    assert(await readFile(join(root, 'index.html'), 'utf8') === html, 'textual create_file corrupted multiline HTML content');
    assert(textualEvents.some((event) => event.type === 'tool' && event.activity.kind === 'mutation' && event.activity.state === 'completed' && event.activity.detail === 'index.html'), 'textual create_file was not executed through normal project tools');
    const normalizedAssistant = textualSnapshots[1].find((message) => message.role === 'assistant' && message.tool_calls?.[0]?.function.name === 'create_file');
    const normalizedArguments = normalizedAssistant?.tool_calls?.[0]?.function.arguments;
    assert(typeof normalizedArguments === 'object' && normalizedArguments !== null && !Array.isArray(normalizedArguments) && normalizedArguments.path === 'index.html', 'textual file_path was not normalized into canonical structured path arguments');
    assert(!validateLlamaMessageSequence(textualSnapshots[1]), 'textual tool call did not produce a valid llama.cpp assistant/tool message sequence');
    assert(textualSnapshots[1].some((message) => message.role === 'tool' && message.tool_name === 'create_file'), 'textual tool result was not returned to the next Agent inference turn');
    const textualTokens = textualEvents.filter((event) => event.type === 'token').map((event) => (event as { content: string }).content).join('');
    assert(!textualTokens.includes('<tool_call>') && !textualTokens.includes('<function=') && !textualTokens.includes('<parameter='), 'recognized textual protocol leaked into assistant-visible text');

    let unknownCalls = 0;
    const unknownTextualAgent = new ProjectChatService({ chatWithTools: async () => {
      unknownCalls += 1;
      if (unknownCalls === 1) return { role: 'assistant' as const, content: '<tool_call><function=unknown_project_tool><parameter=path>ignored.txt</parameter></function></tool_call>' };
      return unknownCalls === 2 ? { role: 'assistant' as const, content: 'I will not use that tool.' } : { role: 'assistant' as const, content: 'Corrected.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const unknownEvents = await eventsFor(unknownTextualAgent, root);
    assert(unknownCalls === 3 && unknownEvents.some((event) => event.type === 'tool' && event.activity.metadata?.failure === 'unknown_tool') && unknownEvents.some((event) => event.type === 'token' && event.content.includes('Corrected.')), 'unknown textual tool call was not returned for bounded model correction');

    let malformedCalls = 0;
    const malformedTextualAgent = new ProjectChatService({ chatWithTools: async () => {
      malformedCalls += 1;
      if (malformedCalls === 1) return { role: 'assistant' as const, content: '<tool_call><function=create_file><parameter=content>broken</parameter><parameter=file_path>broken.html</function></tool_call>' };
      return malformedCalls === 2 ? { role: 'assistant' as const, content: 'I will correct the protocol.' } : { role: 'assistant' as const, content: 'Corrected protocol.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const malformedEvents = await eventsFor(malformedTextualAgent, root);
    assert(malformedCalls === 3 && malformedEvents.some((event) => event.type === 'tool' && event.activity.metadata?.failure === 'malformed_textual_protocol') && malformedEvents.some((event) => event.type === 'token' && event.content.includes('Corrected protocol.')), 'malformed textual protocol was not returned for bounded model correction');

    let proseCalls = 0;
    const proseTextualAgent = new ProjectChatService({ chatWithTools: async () => {
      proseCalls += 1;
      return proseCalls === 1 ? { role: 'assistant' as const, content: 'The documentation mentions the literal tag <tool_call>, but this is ordinary prose.' } : { role: 'assistant' as const, content: 'No tool needed.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const proseEvents = await eventsFor(proseTextualAgent, root);
    assert(proseCalls === 2 && !proseEvents.some((event) => event.type === 'tool'), 'ordinary prose mentioning <tool_call> was interpreted as a tool call');

    let nativePreferenceCalls = 0;
    const nativePreferenceAgent = new ProjectChatService({ chatWithTools: async () => {
      nativePreferenceCalls += 1;
      if (nativePreferenceCalls === 1) return { role: 'assistant' as const, content: '<tool_call><function=create_file><parameter=content>must not write</parameter><parameter=file_path>duplicate.txt</parameter></function></tool_call>', tool_calls: [{ function: { name: 'create_file', arguments: { path: 'native.txt', content: 'native only' } } }] };
      return { role: 'assistant' as const, content: 'Native call done.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const nativePreferenceEvents = await eventsFor(nativePreferenceAgent, root);
    assert(await readFile(join(root, 'native.txt'), 'utf8') === 'native only', 'native structured tool call did not execute');
    await readFile(join(root, 'duplicate.txt'), 'utf8').then(() => { throw new Error('textual fallback duplicated a native structured tool call'); }, () => undefined);
    assert(nativePreferenceEvents.filter((event) => event.type === 'tool' && event.activity.kind === 'mutation' && event.activity.state === 'completed').length === 1, 'native structured tool call was duplicated by textual fallback');

    let invalidPathCalls = 0;
    const invalidPathAgent = new ProjectChatService({ chatWithTools: async () => {
      invalidPathCalls += 1;
      return invalidPathCalls === 1 ? { role: 'assistant' as const, content: '<tool_call><function=create_file><parameter=content>outside</parameter><parameter=file_path>../outside-textual-tool-call.html</parameter></function></tool_call>' } : { role: 'assistant' as const, content: 'Path rejected.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const invalidPathEvents = await eventsFor(invalidPathAgent, root);
    assert(invalidPathEvents.some((event) => event.type === 'tool' && event.activity.kind === 'mutation' && event.activity.state === 'error'), 'textual create_file bypassed project-root path validation');
    await readFile(join(root, '..', 'outside-textual-tool-call.html'), 'utf8').then(() => { throw new Error('textual create_file wrote outside the project root'); }, () => undefined);

    // A. A local validation failure is a normal tool result. Qwen receives a
    // compact reason and can create the corrected file in this same run.
    let missingPathCalls = 0;
    const missingPathSnapshots: ToolMessage[][] = [];
    const missingPathAgent = new ProjectChatService({ chatWithTools: async (_model, messages) => {
      missingPathCalls += 1; missingPathSnapshots.push(messages.map((message) => ({ ...message })));
      if (missingPathCalls === 1) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'create_file', arguments: { content: 'first attempt' } } }] };
      if (missingPathCalls === 2) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'create_file', arguments: { path: 'corrected.txt', content: 'corrected' } } }] };
      if (missingPathCalls === 3) return { role: 'assistant' as const, content: 'File was corrected.' };
      return { role: 'assistant' as const, content: 'Corrected final.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const missingPathEvents = await eventsFor(missingPathAgent, root);
    const missingPathResult = missingPathSnapshots[1].find((message) => message.role === 'tool' && message.tool_name === 'create_file')?.content ?? '';
    assert(missingPathCalls === 4 && missingPathResult.includes('Не указан обязательный параметр') && missingPathResult.includes('path') && missingPathResult.includes('tool_call_failed'), 'missing create_file path was not returned as a compact tool result');
    assert(await readFile(join(root, 'corrected.txt'), 'utf8') === 'corrected', 'corrected create_file did not execute in the same Agent run');
    assert(missingPathEvents.some((event) => event.type === 'token' && event.content.includes('Corrected final.')), 'Agent did not complete after correcting create_file arguments');

    // B. A thrown tool implementation error is also normalized into a compact
    // result and does not abort the surrounding Agent run.
    let thrownToolCalls = 0;
    const thrownToolSnapshots: ToolMessage[][] = [];
    const throwingWeb = { openSession: async () => ({ execute: async () => { throw new Error('temporary web adapter failure'); }, close: async () => undefined }) } as unknown as WebBrowserService;
    const thrownToolAgent = new ProjectChatService({ chatWithTools: async (_model, messages) => {
      thrownToolCalls += 1; thrownToolSnapshots.push(messages.map((message) => ({ ...message })));
      if (thrownToolCalls === 1) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'web_open', arguments: { url: 'https://example.com' } } }] };
      if (thrownToolCalls === 2) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'list_directory', arguments: {} } }] };
      if (thrownToolCalls === 3) return { role: 'assistant' as const, content: 'Continued after tool failure.' };
      return { role: 'assistant' as const, content: 'Recovered final.', finish_reason: 'stop' as const };
    } }, throwingWeb);
    const thrownToolEvents: StreamEvent[] = [];
    for await (const event of thrownToolAgent.stream('test-model', history, root, new AbortController().signal, 16_384, 'fast', 'auto', confirm)) thrownToolEvents.push(event);
    const thrownToolResult = thrownToolSnapshots[1].find((message) => message.role === 'tool' && message.tool_name === 'web_open')?.content ?? '';
    assert(thrownToolCalls === 4 && thrownToolResult.includes('temporary web adapter failure') && thrownToolResult.includes('tool_call_failed'), 'thrown tool error was not returned compactly to the model');
    assert(thrownToolEvents.some((event) => event.type === 'tool' && event.activity.kind === 'directory' && event.activity.state === 'completed'), 'Agent could not continue after a thrown tool error');

    // Every sibling in one assistant tool-call batch must be resolved before a
    // recovery notice. This is the exact shape that previously left a second
    // web_search unresolved after the first temporary web failure.
    let multiWebCalls = 0;
    let executedWebCalls = 0;
    const multiWebSnapshots: ToolMessage[][] = [];
    const unavailableWeb = { openSession: async () => ({
      execute: async () => { executedWebCalls += 1; throw new Error('Web-инструмент временно недоступен'); },
      close: async () => undefined,
    }) } as unknown as WebBrowserService;
    const multiWebAgent = new ProjectChatService({ chatWithTools: async (_model, messages) => {
      multiWebCalls += 1; multiWebSnapshots.push(messages.map((message) => ({ ...message, tool_calls: message.tool_calls?.map((call) => ({ ...call, function: { ...call.function } })) })));
      if (multiWebCalls === 1) return {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'web-search-a', type: 'function' as const, function: { name: 'web_search', arguments: { query: 'first' } } },
          { id: 'web-search-b', type: 'function' as const, function: { name: 'web_search', arguments: { query: 'second' } } },
        ],
      };
      if (multiWebCalls === 2) return { role: 'assistant' as const, content: '', tool_calls: [{ id: 'list-after-web-failure', type: 'function' as const, function: { name: 'list_directory', arguments: {} } }] };
      if (multiWebCalls === 3) return { role: 'assistant' as const, content: 'Recovered after unavailable web.' };
      return { role: 'assistant' as const, content: 'Web recovery final.', finish_reason: 'stop' as const };
    } }, unavailableWeb);
    const multiWebEvents: StreamEvent[] = [];
    for await (const event of multiWebAgent.stream('test-model', history, root, new AbortController().signal, 16_384, 'fast', 'auto', confirm)) multiWebEvents.push(event);
    const multiWebHistory = multiWebSnapshots[1];
    const multiWebAssistant = multiWebHistory.find((message) => message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'web-search-a'));
    const firstWebResult = multiWebHistory.find((message) => message.role === 'tool' && message.tool_call_id === 'web-search-a');
    const secondWebResult = multiWebHistory.find((message) => message.role === 'tool' && message.tool_call_id === 'web-search-b');
    const secondResultIndex = multiWebHistory.indexOf(secondWebResult!);
    const recoveryIndex = multiWebHistory.findIndex((message) => message.role === 'user' && message.content.includes('kind="tool_call_failed"'));
    assert(multiWebAssistant?.tool_calls?.map((call) => call.id).join(',') === 'web-search-a,web-search-b', 'native sibling tool-call IDs were not retained in Agent history');
    assert(firstWebResult?.content.includes('Web-инструмент временно недоступен') && secondWebResult?.content.includes('tool_call_skipped'), 'failed and skipped sibling web calls did not receive explicit tool results');
    assert(recoveryIndex > secondResultIndex && !validateLlamaMessageSequence(multiWebHistory), 'recovery context was inserted before all sibling tool results');
    assert(executedWebCalls === 1 && multiWebEvents.some((event) => event.type === 'tool' && event.activity.kind === 'directory' && event.activity.state === 'completed'), 'a failed web batch either replayed siblings or did not continue safely');

    // C. llama.cpp rejects malformed generated JSON before it returns a
    // ChatCompletion. The Agent asks for a corrected decision once, keeps its
    // history, and never replays an already completed tool.
    let malformedJsonCalls = 0;
    const malformedJsonSnapshots: ToolMessage[][] = [];
    const malformedJsonContexts: ToolInferenceRequestContext[] = [];
    const malformedJsonAgent = new ProjectChatService({ chatWithTools: async (_model, messages, _tools, _signal, _context, _depth, requestContext) => {
      malformedJsonCalls += 1; malformedJsonSnapshots.push(messages.map((message) => ({ ...message }))); if (requestContext) malformedJsonContexts.push(requestContext);
      if (malformedJsonCalls === 1) throw malformedToolArgumentsError();
      if (malformedJsonCalls === 2) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'after-json-recovery.txt', content: 'valid' } } }] };
      if (malformedJsonCalls === 3) return { role: 'assistant' as const, content: 'Tool call corrected.' };
      return { role: 'assistant' as const, content: 'JSON recovery final.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const malformedJsonEvents = await eventsFor(malformedJsonAgent, root);
    assert(malformedJsonCalls === 4 && malformedJsonContexts[1]?.phase === 'recovery', 'malformed llama.cpp tool JSON did not resume through the recovery phase');
    assert(malformedJsonSnapshots[1].some((message) => message.content.includes('kind="malformed_tool_arguments"')), 'malformed llama.cpp tool JSON did not provide a compact correction notice');
    assert(await readFile(join(root, 'after-json-recovery.txt'), 'utf8') === 'valid', 'corrected tool call after malformed llama.cpp JSON did not execute');
    assert(malformedJsonEvents.some((event) => event.type === 'tool' && event.activity.metadata?.failure === 'malformed_tool_arguments'), 'malformed llama.cpp JSON recovery was not visible in activity');

    // Ollama returns its parser rejection as HTTP 400 before an assistant
    // message exists. Recovery must not fabricate a tool result or call ID.
    let ollamaMalformedCalls = 0;
    const ollamaMalformedSnapshots: ToolMessage[][] = [];
    const ollamaMalformedContexts: ToolInferenceRequestContext[] = [];
    const ollamaMalformedAgent = new ProjectChatService({ chatWithTools: async (_model, messages, _tools, _signal, _context, _depth, requestContext) => {
      ollamaMalformedCalls += 1; ollamaMalformedSnapshots.push(messages.map((message) => ({ ...message }))); if (requestContext) ollamaMalformedContexts.push(requestContext);
      if (ollamaMalformedCalls === 1) throw ollamaMalformedToolArgumentsError();
      if (ollamaMalformedCalls === 2) return { role: 'assistant' as const, content: '', tool_calls: [{ id: 'ollama-corrected', type: 'function' as const, function: { name: 'write_file', arguments: { path: 'ollama-corrected.txt', content: 'valid' } } }] };
      if (ollamaMalformedCalls === 3) return { role: 'assistant' as const, content: 'Tool call corrected.' };
      return { role: 'assistant' as const, content: 'Ollama recovery final.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const ollamaMalformedEvents = await eventsFor(ollamaMalformedAgent, root);
    assert(ollamaMalformedCalls === 4 && ollamaMalformedContexts[1]?.phase === 'recovery', 'Ollama malformed tool JSON did not resume through the recovery phase');
    assert(ollamaMalformedSnapshots[1].some((message) => message.content.includes('kind="malformed_tool_arguments"')) && !ollamaMalformedSnapshots[1].some((message) => message.role === 'tool'), 'Ollama pre-response parser failure fabricated a tool result or omitted its correction notice');
    assert(await readFile(join(root, 'ollama-corrected.txt'), 'utf8') === 'valid', 'valid native tool call after Ollama malformed JSON did not execute');
    assert(ollamaMalformedEvents.some((event) => event.type === 'tool' && event.activity.metadata?.failure === 'malformed_tool_arguments'), 'Ollama malformed-tool recovery was not visible in activity');

    // A valid response resets the consecutive failure counter. Two consecutive
    // Ollama rejections are recoverable; a later episode starts at attempt one.
    let resetCalls = 0;
    const resetContexts: ToolInferenceRequestContext[] = [];
    const resetAgent = new ProjectChatService({ chatWithTools: async (_model, _messages, _tools, _signal, _context, _depth, requestContext) => {
      resetCalls += 1; if (requestContext) resetContexts.push(requestContext);
      if (resetCalls === 1 || resetCalls === 2 || resetCalls === 4) throw ollamaMalformedToolArgumentsError();
      if (resetCalls === 3) return { role: 'assistant' as const, content: '', tool_calls: [{ id: 'ollama-reset-tool', type: 'function' as const, function: { name: 'list_directory', arguments: {} } }] };
      if (resetCalls === 5) return { role: 'assistant' as const, content: 'Recovered after reset.' };
      return { role: 'assistant' as const, content: 'Reset final.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const resetEvents = await eventsFor(resetAgent, root);
    assert(resetCalls === 6 && resetContexts[1]?.phase === 'recovery' && resetContexts[2]?.phase === 'recovery' && resetContexts[4]?.phase === 'recovery', 'a valid Ollama response did not reset malformed-tool recovery attempts');
    assert(resetEvents.filter((event) => event.type === 'tool' && event.activity.metadata?.failure === 'malformed_tool_arguments').length === 3, 'Ollama malformed-tool recovery did not remain bounded per consecutive episode');

    let exhaustedOllamaCalls = 0;
    const exhaustedOllama = new ProjectChatService({ chatWithTools: async () => { exhaustedOllamaCalls += 1; throw ollamaMalformedToolArgumentsError(); } }, new WebBrowserService());
    const exhaustedOllamaEvents = await eventsFor(exhaustedOllama, root);
    assert(exhaustedOllamaCalls === 3 && exhaustedOllamaEvents.filter((event) => event.type === 'tool' && event.activity.metadata?.failure === 'malformed_tool_arguments').length === 2 && exhaustedOllamaEvents.some((event) => event.type === 'error' && event.message === 'Агент не смог сформировать корректный вызов инструмента'), 'Ollama malformed-tool recovery was not bounded at two attempts');

    // D. Other HTTP 500 responses remain normal inference errors, never an
    // unsafe malformed-tool retry.
    let unrelated500Calls = 0;
    const unrelated500 = new ProjectChatService({ chatWithTools: async () => {
      unrelated500Calls += 1;
      throw Object.assign(new Error('llama.cpp internal error'), { request: { status: 500, serverError: 'internal server failure' } });
    } }, new WebBrowserService());
    const unrelated500Events = await eventsFor(unrelated500, root);
    assert(unrelated500Calls === 1 && unrelated500Events.some((event) => event.type === 'error' && event.message === 'Анализ не завершился'), 'unrelated HTTP 500 was treated as malformed-tool recovery');

    // E. Two recovery requests are allowed. A third malformed generated call
    // stops with a controlled failure instead of an unbounded loop.
    let exhaustedMalformedCalls = 0;
    const exhaustedMalformed = new ProjectChatService({ chatWithTools: async () => {
      exhaustedMalformedCalls += 1; throw malformedToolArgumentsError();
    } }, new WebBrowserService());
    const exhaustedMalformedEvents = await eventsFor(exhaustedMalformed, root);
    assert(exhaustedMalformedCalls === 3 && exhaustedMalformedEvents.filter((event) => event.type === 'tool' && event.activity.metadata?.failure === 'malformed_tool_arguments').length === 2 && exhaustedMalformedEvents.some((event) => event.type === 'error' && event.message === 'Агент не смог сформировать корректный вызов инструмента'), 'malformed tool JSON recovery was not bounded at two attempts');

    // F. Stop wins immediately while a malformed-tool recovery is being
    // considered; it cannot schedule another inference request.
    let cancelledMalformedCalls = 0;
    const cancelledMalformedController = new AbortController();
    const cancelledMalformed = new ProjectChatService({ chatWithTools: async () => {
      cancelledMalformedCalls += 1; cancelledMalformedController.abort(); throw malformedToolArgumentsError();
    } }, new WebBrowserService());
    const cancelledMalformedEvents = await eventsFor(cancelledMalformed, root, cancelledMalformedController.signal);
    assert(cancelledMalformedCalls === 1 && !cancelledMalformedEvents.some((event) => event.type === 'error'), 'Stop did not cancel malformed-tool recovery immediately');

    // G. A parser recovery after a completed mutation only asks for a new
    // decision; it never replays the completed mutation.
    let noReplayCalls = 0;
    const noReplaySnapshots: ToolMessage[][] = [];
    const noReplay = new ProjectChatService({ chatWithTools: async (_model, messages) => {
      noReplayCalls += 1; noReplaySnapshots.push(messages.map((message) => ({ ...message })));
      if (noReplayCalls === 1) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'do-not-replay.txt', content: 'once' } } }] };
      if (noReplayCalls === 2) throw malformedToolArgumentsError();
      if (noReplayCalls === 3) return { role: 'assistant' as const, content: 'Recovered without replay.' };
      return { role: 'assistant' as const, content: 'No replay final.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    await eventsFor(noReplay, root);
    assert(noReplayCalls === 4 && await readFile(join(root, 'do-not-replay.txt'), 'utf8') === 'once', 'parser recovery replayed an already executed mutation');
    assert(noReplaySnapshots[2].filter((message) => message.role === 'tool' && message.tool_name === 'write_file').length === 1, 'recovery history duplicated an executed tool result');

    // H. Tool-like text in final synthesis remains a controlled error and is
    // never rendered as ordinary assistant output.
    let finalProtocolCalls = 0;
    const finalProtocol = new ProjectChatService({ chatWithTools: async () => {
      finalProtocolCalls += 1;
      return finalProtocolCalls === 1 ? { role: 'assistant' as const, content: 'Ready for final answer.' } : { role: 'assistant' as const, content: '<tool_call><function=run_terminal><parameter=command>pwd</parameter></function></tool_call>' };
    } }, new WebBrowserService());
    const finalProtocolEvents = await eventsFor(finalProtocol, root);
    assert(finalProtocolCalls === 2 && finalProtocolEvents.some((event) => event.type === 'error' && event.message === 'Не удалось сформировать итоговый ответ') && !finalProtocolEvents.some((event) => event.type === 'token' && event.content.includes('<tool_call>')), 'final synthesis leaked internal tool protocol');

    let repeatedCalls = 0;
    const repeatedlyFailing = new ProjectChatService({ chatWithTools: async () => {
      repeatedCalls += 1;
      throw new Error('llama.cpp inference connection failed: fetch failed');
    } }, new WebBrowserService());
    const repeatedEvents = await eventsFor(repeatedlyFailing, root);
    assert(repeatedCalls === 2, 'initial connection retry did not stop after one retry');
    assert(repeatedEvents.some((event) => event.type === 'error' && event.message === 'Не удалось подключиться к локальному inference runtime.' && !event.details), 'repeated connection failure exposed an analysis error or internal detail');

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

    let supersededCalls = 0;
    const supersededController = new AbortController();
    const superseded = new ProjectChatService({ chatWithTools: async () => {
      supersededCalls += 1;
      throw new Error('llama.cpp inference connection failed: fetch failed');
    } }, new WebBrowserService());
    const supersededPending = eventsFor(superseded, root, supersededController.signal);
    setTimeout(() => supersededController.abort(), 20);
    const supersededEvents = await supersededPending;
    assert(supersededCalls === 1, 'superseded generation started an initial inference retry');
    assert(!supersededEvents.some((event) => event.type === 'error'), 'superseded generation emitted a stale runtime error');

    let postToolCalls = 0;
    const postToolFailure = new ProjectChatService({ chatWithTools: async () => {
      postToolCalls += 1;
      if (postToolCalls === 1) return { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'post-tool-once.txt', content: 'written once' } } }] };
      throw new Error('llama.cpp inference connection failed: fetch failed');
    } }, new WebBrowserService());
    const postToolEvents = await eventsFor(postToolFailure, root);
    assert(postToolCalls === 2, 'connection failure after a tool action retried the Agent inference');
    assert(await readFile(join(root, 'post-tool-once.txt'), 'utf8') === 'written once', 'post-tool failure replayed a mutating tool');
    assert(postToolEvents.some((event) => event.type === 'error' && event.message === 'Не удалось подключиться к локальному inference runtime.'), 'post-tool runtime failure lost its connection classification');

    let normalCalls = 0;
    const normal = new ProjectChatService({ chatWithTools: async () => {
      normalCalls += 1;
      return normalCalls === 1
        ? { role: 'assistant' as const, content: 'Ready to answer.' }
        : { role: 'assistant' as const, content: 'Normal final response.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const normalEvents = await eventsFor(normal, root);
    assert(normalCalls === 2 && normalEvents.some((event) => event.type === 'token' && event.content.includes('Normal final response.')), 'successful normal Agent run added an unnecessary retry');

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
      if (planCalls === 3) return toolReply('task_plan', { action: 'update', step_id: 'cancel', status: 'in_progress' });
      if (planCalls === 4) return toolReply('task_plan', { action: 'update', step_id: 'flow', status: 'completed' });
      if (planCalls === 5) return toolReply('task_plan', { action: 'update', step_id: 'verify', status: 'completed' });
      return { role: 'assistant' as const, content: 'Plan complete.', finish_reason: 'stop' as const };
    } }, new WebBrowserService());
    const planEvents = await eventsFor(plannedAgent, root);
    const planActivities = planEvents.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'planning');
    assert(planActivities.some((event) => event.activity.state === 'error' && event.activity.detail?.includes('План обновлён')), 'invalid Plan status transition was not rejected as a tool error');
    const finalPlan = planActivities.filter((event) => event.activity.state === 'completed').at(-1)?.activity.plan;
    assert(finalPlan?.steps.map((step) => `${step.id}:${step.status}`).join(',') === 'flow:completed,cancel:completed,verify:completed', 'Plan creation or status transitions lost their structured state');
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

    const secondary = await mkdtemp(join(tmpdir(), 'local-ai-agent-secondary-'));
    try {
      await writeFile(join(root, 'same.ts'), 'export const project = 1;\n', 'utf8');
      await writeFile(join(secondary, 'same.ts'), 'export const project = 2;\n', 'utf8');
      let crossProjectCalls = 0;
      const crossProjectSnapshots: ToolMessage[][] = [];
      const crossProjectAgent = new ProjectChatService({ chatWithTools: async (_model: string, messages: ToolMessage[]) => {
        crossProjectCalls += 1; crossProjectSnapshots.push(messages.map((message) => ({ ...message })));
        if (crossProjectCalls === 1) return toolReply('read_file', { path: 'same.ts', project_id: 'secondary-id' });
        return { role: 'assistant' as const, content: 'Cross-project read complete.', finish_reason: 'stop' as const };
      } }, new WebBrowserService());
      const referencedHistory = [{ id: 'with-reference', conversationId: 'chat', role: 'user' as const, content: 'Use the selected file.', createdAt: new Date().toISOString(), projectReferences: [
        { id: 'reference-file', projectId: 'secondary-id', projectSlot: 2 as const, projectPath: secondary, projectLabel: 'Project 2', relativePath: 'same.ts', kind: 'file' as const },
        { id: 'reference-folder', projectId: 'project-1-id', projectSlot: 1 as const, projectPath: root, projectLabel: 'Project 1', relativePath: 'src', kind: 'folder' as const },
      ] }];
      const crossEvents: StreamEvent[] = [];
      for await (const event of crossProjectAgent.stream('test-model', referencedHistory, [{ id: 'project-1-id', slot: 1, root, label: 'Project 1' }, { id: 'secondary-id', slot: 2, root: secondary, label: 'Project 2' }], new AbortController().signal, 16_384, 'fast', 'off', confirm)) crossEvents.push(event);
      const secondaryRead = crossProjectSnapshots.flat().find((message) => message.role === 'tool' && message.tool_name === 'read_file')?.content ?? '';
      assert(secondaryRead.includes('project = 2') && secondaryRead.includes('"project_id":"secondary-id"'), 'cross-project read did not target the explicitly selected Project 2');
      const initialPrompt = crossProjectSnapshots[0].map((message) => message.content).join('\n');
      assert(initialPrompt.includes('project_id=secondary-id') && initialPrompt.includes('Explicit folder scope') && initialPrompt.includes('do not recursively load it'), 'file and folder references were not represented explicitly in Agent context');
      assert(initialPrompt.includes(`Name: ${projectDirectoryName(root)}; Role: primary`) && initialPrompt.includes(`Name: ${projectDirectoryName(secondary)}; Role: secondary`), 'Agent project context did not include human-readable project names and roles');
      assert(!initialPrompt.includes('export const project = 2'), 'selected file was injected before the Agent chose to read it');
      assert(crossEvents.some((event) => event.type === 'tool' && event.activity.metadata?.project_slot === 2), 'tool activity did not preserve the target project slot');

      const distinctProjects = new AgentToolContext(12_000);
      const projectOneRead: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ project_id: 'project-1-id', path: 'same.ts', fingerprint: 'same', byte_start: 0, byte_end: 1, content: 'one' }) };
      const projectTwoRead: ToolMessage = { role: 'tool', tool_name: 'read_file', content: JSON.stringify({ project_id: 'secondary-id', path: 'same.ts', fingerprint: 'same', byte_start: 0, byte_end: 1, content: 'two' }) };
      distinctProjects.add('read_file', { path: 'same.ts', project_id: 'project-1-id' }, projectOneRead, 1);
      assert(distinctProjects.add('read_file', { path: 'same.ts', project_id: 'secondary-id' }, projectTwoRead, 2).read?.relationship === 'new', 'identical relative paths in different projects were deduplicated');
    } finally { await rm(secondary, { recursive: true, force: true }); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (require.main === module) void runProjectChatRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
