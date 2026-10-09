import assert from 'node:assert/strict';
import { ensureAppDirectories } from './paths';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LlamaCppBackend } from '../backends/llama-cpp-backend';
import { WebChatService } from './web-chat';
import { WebBrowserService } from '../web/web-tools';
import { visualArtifactExamples } from '../../shared/rich-artifacts';
import type { StreamEvent } from '../../shared/types';

/** Actual llama.cpp HTTP/SSE adapter + Chat host loop; the server is a scripted Qwen protocol fixture. */
export async function runRichChatHttpRegression() {
  ensureAppDirectories();
  let completion = 0; const payloads: Array<Record<string, unknown>> = [];
  const chart = visualArtifactExamples.chart;
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.endsWith('/input_tokens')) { res.end('{"input_tokens":3000}'); return; }
    payloads.push(body); completion += 1;
    res.setHeader('content-type', 'text/event-stream');
    const emit = (delta: unknown, finish_reason?: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\r\n\r\n`);
    emit({ reasoning_content: `Turn ${completion} reasoning. ` });
    if (completion === 1) {
      emit({ tool_calls: [{ index: 0, id: 'source-call', type: 'function', function: { name: 'web_', arguments: '{"query":' } }] });
      emit({ tool_calls: [{ index: 0, function: { name: 'search', arguments: '"fixture"}' } }] }, 'tool_calls');
    } else if (completion === 2) {
      const wrapper = `<tool_call>${JSON.stringify({ name: 'create_visual_artifact', arguments: { artifact: { ...chart, data: [{ quarter: 'Q1', revenue: '10 USD' }] } } })}</tool_call>`;
      for (let offset = 0; offset < wrapper.length; offset += 11) emit({ content: wrapper.slice(offset, offset + 11) });
      emit({}, 'stop');
    } else if (completion === 3) {
      const args = JSON.stringify({ artifact: chart });
      emit({ tool_calls: [{ index: 0, id: 'chart-call', type: 'function', function: { name: 'create_visual_', arguments: args.slice(0, 37) } }] });
      emit({ tool_calls: [{ index: 0, function: { name: 'artifact', arguments: args.slice(37) } }] }, 'tool_calls');
    } else emit({ content: 'The interactive chart is ready; Q2 is unavailable.' }, 'stop');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3000, completion_tokens: 30 } })}\r\n\r\n`);
    res.end('data: [DONE]\r\n\r\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const backend = new LlamaCppBackend(`http://127.0.0.1:${address.port}`);
  const web = { openSession: async () => ({ execute: async () => '{"results":[]}', getImageResults: () => new Map(), getKnownSources: () => new Set(), close: async () => undefined }) } as unknown as WebBrowserService;
  try {
    const events: StreamEvent[] = [];
    for await (const event of new WebChatService(backend, web).stream('qwen3.8:27b-q4_K_M', [{ id: 'u', conversationId: 'http-fixture', role: 'user', content: 'Research and show an interactive chart.', createdAt: '' }], new AbortController().signal, 32768, 'fast', true)) events.push(event);
    assert(!events.some((event) => event.type === 'error'), JSON.stringify(events.filter((event) => event.type === 'error')));
    assert.equal(completion, 4, 'unneeded final-answer-only inference pass');
    assert(payloads.every((payload) => Array.isArray(payload.tools) && payload.stream === true && payload.tool_choice === 'auto'), 'tools/streaming were lost during continuation');
    assert(payloads.every((payload) => !JSON.stringify(payload.messages).includes('без новых вызовов инструментов')));
    const messages = payloads[1].messages as Array<Record<string, unknown>>;
    assert.equal(messages.at(-1)?.tool_call_id, 'source-call');
    assert.match(String((payloads[2].messages as Array<Record<string, unknown>>).at(-1)?.content), /data\[0\]\.revenue/);
    assert.equal((payloads[3].messages as Array<Record<string, unknown>>).at(-1)?.tool_call_id, 'chart-call');
    const artifacts = events.filter((event) => event.type === 'rich-artifact');
    assert.equal(artifacts.length, 1); assert(artifacts[0].type === 'rich-artifact' && artifacts[0].artifact.type === 'chart' && artifacts[0].artifact.data[1].revenue === null);
    assert.equal(events.filter((event) => event.type === 'token').map((event) => event.content).join(''), 'The interactive chart is ready; Q2 is unavailable.');
    assert.equal(events.filter((event) => event.type === 'thinking').length, 4);
    console.log('Qwen HTTP/SSE host integration: web_search → malformed textual chart → corrected native chart → final; CRLF, split names/JSON, call IDs, live reasoning and persistent artifact passed.');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
if (require.main === module) void runRichChatHttpRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
