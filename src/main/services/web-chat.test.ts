import assert from 'node:assert/strict';
import { setLanguage } from '../../shared/locale';
import type { ChatMessage, StreamEvent } from '../../shared/types';
import type { LlmBackend, ToolCallingBackend, ToolMessage, ToolInferenceStreamEvent } from '../backends/types';
import { validateLlamaMessageSequence } from '../backends/llama-cpp-backend';
import { WebBrowserService } from '../web/web-tools';
import { parseQwenToolText, WebChatService } from './web-chat';
import { QwenContentBuffer } from './qwen-content-buffer';
import { galleryFailureWarning, visualArtifactExamples, type DiscoveredImage } from '../../shared/rich-artifacts';
import { chatMessagesWithSystemPrefix, chatSystemContext } from './capabilities';

const history: ChatMessage[] = [{ id: 'u', conversationId: 'fixture', role: 'user', content: 'Create an interactive visualization.', createdAt: '' }];
const call = (name: string, args: unknown, id = name) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const noBrowser = { openSession: async () => { throw new Error('This request should not open a browser.'); } } as unknown as WebBrowserService;
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function scriptedBackend(turns: ToolMessage[], onRequest?: (messages: ToolMessage[], tools: unknown[] | undefined, reasoning: unknown) => void, streaming = true) {
  let count = 0; const requests: ToolMessage[][] = []; const schemas: Array<unknown[] | undefined> = [];
  const take = (messages: ToolMessage[], tools: unknown[] | undefined, reasoning: unknown) => {
    assert.equal(validateLlamaMessageSequence(messages), undefined, 'native call/result pairing must remain valid');
    requests.push(snapshot(messages)); schemas.push(tools); onRequest?.(messages, tools, reasoning);
    assert(count < turns.length, 'unexpected extra router or final inference pass');
    return turns[count++];
  };
  const backend: ToolCallingBackend & LlmBackend = {
    async chatWithTools(_model, messages, tools, _signal, _window, reasoning) { return take(messages, tools, reasoning); },
    streamChat(): AsyncIterable<StreamEvent> { throw new Error('Separate tool-free finalization must never run.'); },
    async getModels() { return []; }, async getStatus() { return { available: true }; },
  };
  if (streaming) backend.streamWithTools = async function* (_model, messages, tools, _signal, _window, reasoning): AsyncIterable<ToolInferenceStreamEvent> {
    const response = take(messages, tools, reasoning);
    if (response.thinking) yield { type: 'thinking', content: response.thinking };
    // Deliberately split protocol tokens/JSON in the middle of names, escapes and brackets.
    for (let offset = 0; offset < response.content.length; offset += 7) yield { type: 'token', content: response.content.slice(offset, offset + 7) };
    for (const [index, tool] of (response.tool_calls ?? []).entries()) yield { type: 'tool_call_delta', index, id: tool.id, name: tool.function.name, argumentsDelta: String(tool.function.arguments) };
    yield { type: 'response', response };
  };
  return { backend, requests, schemas, count: () => count };
}
async function collect(service: WebChatService, webEnabled = false, signal = new AbortController().signal, messages = history) {
  const events: StreamEvent[] = [];
  for await (const event of service.stream('qwen3.8:27b-q4_K_M', messages, signal, 32768, 'deep', webEnabled)) events.push(event);
  return events;
}
const prose = (events: StreamEvent[]) => events.flatMap((event) => event.type === 'token' ? [event.content] : []).join('');

export async function runWebChatRegression(): Promise<void> {
  const languageRule = 'Если пользователь явно общается на одном языке';
  const oldHistory = [...history, { ...history[0], id: 'late-system', role: 'system' as const, content: 'Continue the prior answer.' }];
  const prefix = chatMessagesWithSystemPrefix(oldHistory, [chatSystemContext({ webAvailable: false }, 'fast')], 'fixture', 'prefix');
  assert.deepEqual(prefix.map((message) => message.role), ['system', 'user']);
  assert.equal((prefix[0].content.match(new RegExp(languageRule, 'g')) ?? []).length, 1);
  let closed = false;
  const web = { openSession: async () => ({ execute: async () => '{"results":[{"url":"https://example.test/data"}]}', close: async () => { closed = true; } }) } as unknown as WebBrowserService;
  const fixture = scriptedBackend([
    { role: 'assistant', content: '', thinking: 'Searching for data.', tool_calls: [call('web_search', { query: 'fixture data' })] },
    { role: 'assistant', content: 'Here is the sourced answer.', thinking: 'I received the sources.' },
  ], (messages, tools, reasoning) => {
    assert.equal(reasoning, 'deep', 'selected Thinking/effort must be preserved through every inference');
    assert(tools?.length, 'tools disappeared after a web result');
    assert(!messages[0].content.includes('без новых вызовов инструментов'));
    assert(!messages[0].content.includes('NO_TOOLS'));
  });
  setLanguage('en'); const events = await collect(new WebChatService(fixture.backend, web), true); setLanguage('ru');
  assert.equal(fixture.count(), 2, 'ordinary web Chat should use search then final, not an extra router/final pass');
  assert.equal(closed, true);
  assert.match(fixture.requests[0][0].content, /Interface language: English/);
  assert.deepEqual(fixture.requests[1].map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(fixture.requests[1].at(-1)?.tool_call_id, 'web_search');
  assert.equal(prose(events), 'Here is the sourced answer.');
  assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.content), ['Searching for data.', 'I received the sources.']);
  assert(events.some((event) => event.type === 'tool' && event.activity.label === 'Ожидаю ответ модели'));
  const plain = scriptedBackend([{ role: 'assistant', content: 'Ordinary answer with a Markdown table.\n\n|A|B|\n|-|-|\n|1|2|' }]);
  assert.equal(prose(await collect(new WebChatService(plain.backend, noBrowser))), plain.requests.length && 'Ordinary answer with a Markdown table.\n\n|A|B|\n|-|-|\n|1|2|');
  assert.equal(plain.count(), 1, 'ordinary Chat must not require hidden inference');
}

export async function runRichResponseRoutingRegression(): Promise<void> {
  const fixture = scriptedBackend([
    { role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: visualArtifactExamples.rich_report })] },
    { role: 'assistant', content: 'Fictional revenue is 10 USD. This is illustrative data.' },
  ]);
  const events = await collect(new WebChatService(fixture.backend, noBrowser));
  const report = events.find((event) => event.type === 'rich-artifact');
  assert(report?.type === 'rich-artifact' && report.artifact.type === 'rich_report');
  assert.equal(report.artifact.charts?.[0].data[0].revenue, report.artifact.metrics?.[0].value);
  assert.equal(report.artifact.tables?.[0].rows[0].revenue, report.artifact.metrics?.[0].value);
  assert(!fixture.schemas[0]?.some((tool) => (tool as { function?: { name?: string } }).function?.name === 'web_search'));
  assert(events.findIndex((event) => event.type === 'rich-artifact') < events.findIndex((event) => event.type === 'done'), 'artifacts must appear before final completion');
  const found: DiscoveredImage = { id: 'real-id', url: 'https://img.test/flower.png', sourceUrl: 'https://flowers.test/peony', title: 'Peony', alt: 'Peony photo' };
  const web = { openSession: async () => ({ execute: async () => JSON.stringify({ status: 'ok', results: [{ discovery_id: found.id }] }), getImageResults: () => new Map([[found.id, found]]), getKnownSources: () => new Set([found.sourceUrl]), close: async () => undefined }) } as unknown as WebBrowserService;
  const image = scriptedBackend([
    { role: 'assistant', content: '', tool_calls: [call('web_image_search', { query: 'peony' })] },
    { role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: { version: 1, type: 'image_gallery', images: [{ discovery_id: found.id }] } })] },
    { role: 'assistant', content: 'A sourced photograph.' },
  ]);
  const gallery = (await collect(new WebChatService(image.backend, web), true)).find((event) => event.type === 'rich-artifact');
  assert(gallery?.type === 'rich-artifact' && gallery.artifact.type === 'image_gallery' && gallery.artifact.images[0].sourceUrl === found.sourceUrl);
}

export async function runQwenRichToolRoutingRegression(): Promise<void> {
  const chart = visualArtifactExamples.chart;
  const wrapper = `<tool_call>${JSON.stringify({ name: 'create_visual_artifact', arguments: { artifact: chart } })}</tool_call>`;
  const literal = `Example: \`${wrapper}\`\n\n\`\`\`json\n${wrapper}\n\`\`\``;
  assert.equal(parseQwenToolText(literal).calls.length, 0);
  assert.equal(parseQwenToolText(`Before. ${wrapper} After.`).visibleContent, 'Before. After.');
  const buffer = new QwenContentBuffer(parseQwenToolText); let visible = '';
  const mixed = `Before. ${wrapper} After.\n${literal}`;
  for (const char of mixed) visible += buffer.push(char); visible += buffer.finish();
  assert.equal(visible, `Before.  After.\n${literal}`, 'streaming must hide actual protocol but preserve literal examples');
  assert.match(parseQwenToolText('<tool_call>{"name":"create_visual_artifact","arguments":</tool_call>').calls[0].parseError ?? '', /malformed/);

  const invalid = { ...chart, data: [{ quarter: 'Q1', revenue: '10 USD' }] };
  const transcript = scriptedBackend([
    { role: 'assistant', content: '', tool_calls: [call('web_search', { query: 'GPU comparison fixture' }, 'research')] },
    { role: 'assistant', content: `<tool_call>${JSON.stringify({ name: 'create_visual_artifact', arguments: { artifact: invalid } })}</tool_call>` },
    { role: 'assistant', content: `Corrected. ${wrapper}`, tool_calls: [call('create_visual_artifact', { artifact: chart }, 'fixed-chart'), call('create_visual_artifact', { artifact: visualArtifactExamples.data_table }, 'table')] },
    { role: 'assistant', content: wrapper },
    { role: 'assistant', content: 'Values match the chart and table.' },
  ]);
  const web = { openSession: async () => ({ execute: async () => '{"results":[]}', getImageResults: () => new Map(), getKnownSources: () => new Set(), close: async () => undefined }) } as unknown as WebBrowserService;
  const events = await collect(new WebChatService(transcript.backend, web), true);
  assert.equal(events.filter((event) => event.type === 'rich-artifact').length, 2, 'native/text mirror or repeated accepted call duplicated an artifact');
  assert(!prose(events).includes('<tool_call>'));
  assert.match(transcript.requests[2].at(-1)?.content ?? '', /data\[0\]\.revenue.*finite number or null/);
  assert.equal(transcript.requests[3].at(-1)?.tool_call_id, 'table');
  assert.equal(transcript.schemas.length, 5); assert(transcript.schemas.every((tools) => tools?.length), 'tools shut down before successful final answer');

  let validateCount = 0;
  const diagram = scriptedBackend([
    { role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: { version: 1, type: 'diagram', source: 'graph TD\nA-->B' } })] },
    { role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: visualArtifactExamples.diagram }), call('create_visual_artifact', { artifact: visualArtifactExamples.diagram }, 'duplicate')] },
    { role: 'assistant', content: `Illustrative branches.\n\`\`\`mermaid\n${visualArtifactExamples.diagram.mermaid}\n\`\`\`` },
  ]);
  const diagramEvents = await collect(new WebChatService(diagram.backend, noBrowser, async () => { validateCount += 1; }));
  assert.equal(validateCount, 1); assert.equal(diagramEvents.filter((event) => event.type === 'rich-artifact').length, 1);
  assert.match(diagram.requests[1].at(-1)?.content ?? '', /diagram.source.*mermaid/);
  assert(!prose(diagramEvents).includes('gitGraph'), 'the same diagram rendered through both Markdown and artifact pipelines');
  assert(!prose(diagramEvents).includes('Start'));

  const repeated = scriptedBackend([
    ...Array.from({ length: 3 }, () => ({ role: 'assistant' as const, content: '', tool_calls: [call('create_visual_artifact', { artifact: invalid })] })),
    { role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: chart })] },
    { role: 'assistant', content: 'Corrected chart.' },
  ], undefined, false);
  const corrected = await collect(new WebChatService(repeated.backend, noBrowser));
  assert.equal(corrected.filter((event) => event.type === 'rich-artifact').length, 1, 'repeated errors incorrectly disabled corrected calls');
  assert.match(repeated.requests[3].at(-1)?.content ?? '', /identical arguments already failed twice/);
  const pairedIds = repeated.requests.at(-1)!.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
  assert.equal(new Set(pairedIds).size, pairedIds.length, 'reused provider IDs must not associate results with an earlier attempt');

  const abort = new AbortController();
  const stopped = scriptedBackend([{ role: 'assistant', content: '', thinking: 'Preparing chart.', tool_calls: [call('create_visual_artifact', { artifact: chart })] }]);
  const stoppedEvents: StreamEvent[] = [];
  for await (const event of new WebChatService(stopped.backend, noBrowser).stream('model', history, abort.signal, 32768, 'deep', false)) { stoppedEvents.push(event); if (event.type === 'thinking') abort.abort(); }
  assert(!stoppedEvents.some((event) => event.type === 'rich-artifact' || event.type === 'done'));
  const regenerated = scriptedBackend([{ role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: chart })] }, { role: 'assistant', content: 'Fresh attempt.' }]);
  assert.equal((await collect(new WebChatService(regenerated.backend, noBrowser))).filter((event) => event.type === 'rich-artifact').length, 1, 'regenerated attempt must own its artifact state');

  const loop = scriptedBackend([...Array.from({ length: 12 }, () => ({ role: 'assistant' as const, content: '', tool_calls: [call('create_visual_artifact', { artifact: invalid })] })), { role: 'assistant', content: 'The chart could not be created.' }]);
  await collect(new WebChatService(loop.backend, noBrowser));
  assert.equal(loop.count(), 13); assert.equal(loop.schemas.at(-1), undefined);
  assert.match(loop.requests.at(-1)?.[0].content ?? '', /execution budget is exhausted/);
}

export async function runMultiSearchGalleryRegression() {
  const discovered = new Map<string, DiscoveredImage>();
  const web = { openSession: async () => ({
    execute: async (call: { arguments: { query: string } }) => {
      const color = call.arguments.query;
      const results = Array.from({ length: 3 }, (_, index) => { const id = `${color}-${index}`; const found = { id, url: `https://images.test/${id}.jpg`, sourceUrl: `https://commons.wikimedia.org/wiki/File:${id}.jpg`, title: color, alt: color }; discovered.set(id, found); return { discovery_id: id, retrieval_status: 'ready' }; });
      return JSON.stringify({ status: 'ok', gallery_created: false, results });
    }, getImageResults: () => discovered, getKnownSources: () => new Set(), close: async () => undefined,
  }) } as unknown as WebBrowserService;
  const colors = ['white', 'pink', 'red', 'yellow'];
  const searches = { role: 'assistant' as const, content: '', tool_calls: colors.map(color => call('web_image_search', { query: color, max_results: 3 }, color)) };
  const gallery = { version: 1, type: 'image_gallery', title: 'Four peonies', summary: 'Licenses have not been verified.', images: colors.map(color => ({ discovery_id: `${color}-0` })) };
  const happy = scriptedBackend([searches, { role: 'assistant', content: `<tool_call>${JSON.stringify({ name: 'create_visual_artifact', arguments: { artifact: gallery } })}</tool_call>` }, { role: 'assistant', content: 'Four photographs with sources.' }]);
  const events = await collect(new WebChatService(happy.backend, web), true);
  assert.equal(discovered.size, 12); assert.equal(happy.count(), 3); assert.equal(events.filter(event => event.type === 'rich-artifact').length, 1);
  assert.match(happy.requests[2].at(-1)?.content ?? '', /"accepted":true.*"stage":"emitted_to_ui".*"image_count":4/);
  assert(!prose(events).includes('<tool_call>'));
  const invalid = { ...gallery, images: [{ discovery_id: 'wrong-session' }] };
  const retry = scriptedBackend([searches, ...[1, 2].map(index => ({ role: 'assistant' as const, content: '', tool_calls: [call('create_visual_artifact', { artifact: invalid }, `invalid-${index}`)] })), { role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: gallery })] }, { role: 'assistant', content: 'Corrected gallery.' }]);
  const corrected = await collect(new WebChatService(retry.backend, web), true);
  assert.match(retry.requests[2].at(-1)?.content ?? '', /INVALID_DISCOVERY_ID/); assert.match(retry.requests[3].at(-1)?.content ?? '', /ARTIFACT_DUPLICATE/);
  assert.equal(corrected.filter(event => event.type === 'rich-artifact').length, 1);
  const failed = scriptedBackend([searches, { role: 'assistant', content: '', tool_calls: [call('create_visual_artifact', { artifact: invalid })] }, { role: 'assistant', content: 'All four images loaded successfully.' }]);
  const failureEvents = await collect(new WebChatService(failed.backend, web), true);
  assert(!failureEvents.some(event => event.type === 'rich-artifact'));
  assert(galleryFailureWarning(failureEvents.flatMap(event => event.type === 'tool' ? [event.activity] : [])), 'failed gallery must have a deterministic host warning, irrespective of model prose');
  assert(!galleryFailureWarning(corrected.flatMap(event => event.type === 'tool' ? [event.activity] : []), corrected.flatMap(event => event.type === 'rich-artifact' ? [event.artifact] : [])));
}

if (require.main === module) void (async () => { await runWebChatRegression(); await runRichResponseRoutingRegression(); await runQwenRichToolRoutingRegression(); await runMultiSearchGalleryRegression(); console.log('Chat unified Qwen tool-loop regression: ok'); })().catch((error: unknown) => { setLanguage('ru'); console.error(error); process.exitCode = 1; });
