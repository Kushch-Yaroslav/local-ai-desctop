import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { LlamaCppBackend, LlamaCppContextExhaustedError, LlamaCppRequestError, validateLlamaMessageSequence } from './llama-cpp-backend';
import type { ToolMessage } from './types';
import type { ChatMessage } from '../../shared/types';

const model = 'qwen3.8:27b-q4_K_M';
type Scenario = { tokenCounts?: number[]; lastTokenCount?: number; tokenCountStatus?: number; chatStatus?: number; chatError?: string; timings?: { prompt_ms?: number; predicted_ms?: number }; stream?: boolean; requestBodies: Array<Record<string, unknown>>; countBodies: Array<Record<string, unknown>> };

async function readBody(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
function reply(response: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
}
async function startServer(scenario: Scenario): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/health') { reply(response, 200, { status: 'ok' }); return; }
    const body = await readBody(request);
    if (path === '/v1/chat/completions/input_tokens') {
      scenario.countBodies.push(body);
      if (scenario.tokenCountStatus) { reply(response, scenario.tokenCountStatus, { error: { message: 'not supported' } }); return; }
      const inputTokens = scenario.tokenCounts?.shift() ?? 1_000; scenario.lastTokenCount = inputTokens;
      reply(response, 200, { object: 'response.input_tokens', input_tokens: inputTokens }); return;
    }
    if (path === '/v1/chat/completions') {
      scenario.requestBodies.push(body);
      if (scenario.chatStatus) { reply(response, scenario.chatStatus, { error: { message: scenario.chatError ?? 'context length exceeded by server' } }); return; }
      if (scenario.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Reasoning. ' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: scenario.lastTokenCount ?? 1_000, completion_tokens: 7 }, ...(scenario.timings ? { timings: scenario.timings } : {}) })}\n\n`);
        response.end('data: [DONE]\n\n'); return;
      }
      reply(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: scenario.lastTokenCount ?? 1_000, completion_tokens: 1 }, ...(scenario.timings ? { timings: scenario.timings } : {}) }); return;
    }
    reply(response, 404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server): Promise<void> { server.close(); await once(server, 'close'); }

const baseMessages = (content = 'hello'): ToolMessage[] => [{ role: 'system', content: 'system instructions' }, { role: 'user', content }];
const toolSchema = [{ type: 'function', function: { name: 'read_file', description: 'read a project file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const call = (backend: LlamaCppBackend, messages: ToolMessage[], tools: unknown[] | undefined = toolSchema) => backend.chatWithTools(model, messages, tools, new AbortController().signal, 65_536, 'deep');

export async function runLlamaCppBackendRegression(): Promise<void> {
  {
    const scenario: Scenario = { tokenCounts: [1_000], timings: { prompt_ms: 2, predicted_ms: 500, predicted_per_second: 14 } as never, stream: true, requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      const history: ChatMessage[] = [{ id: 'user', conversationId: 'chat', role: 'user', content: 'Stream this response.', createdAt: new Date().toISOString() }];
      const events = [] as import('../../shared/types').StreamEvent[];
      for await (const event of new LlamaCppBackend(url).streamChat(model, history, new AbortController().signal, 65_536, 'deep')) events.push(event);
      assert.equal(events.find((event) => event.type === 'diagnostics')?.diagnostics?.evalCount, 7, 'usage emitted after finish_reason was not retained for message statistics');
      assert.equal(events.find((event) => event.type === 'diagnostics')?.diagnostics?.tokensPerSecond, 14, 'late timing data was not retained for message statistics');
      assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.content), ['Reasoning. '], 'real reasoning stream was not forwarded');
    } finally { await stop(server); }
  }
  {
    const complete: ToolMessage[] = [
      ...baseMessages(),
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: { path: 'a.ts' } } },
        { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: { path: 'b.ts' } } },
      ] },
      { role: 'tool', tool_name: 'read_file', tool_call_id: 'call-b', content: '{}' },
      { role: 'tool', tool_name: 'read_file', tool_call_id: 'call-a', content: '{}' },
      { role: 'user', content: '<runtime_context kind="tool_call_failed">continue</runtime_context>' },
    ];
    assert.equal(validateLlamaMessageSequence(complete), undefined, 'matching tool_call_id results were rejected');
    assert.match(validateLlamaMessageSequence(complete.slice(0, 4).concat(complete[5]!)) ?? '', /before 1 tool result/, 'a recovery context was accepted before a sibling tool result');
  }
  {
    const scenario: Scenario = { tokenCounts: [1_000], timings: { prompt_ms: 12.3456789, predicted_ms: 0.0012345 }, requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      const response = await call(new LlamaCppBackend(url), baseMessages());
      assert.equal(response.inference?.promptEvalDuration, 12_345_679, 'fractional llama.cpp milliseconds were not rounded to integral nanoseconds');
      assert.equal(response.inference?.evalDuration, 1_235, 'completion duration was not normalized to an SQLite INTEGER nanosecond value');
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCounts: [33_458], requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      const response = await call(new LlamaCppBackend(url), baseMessages('x'.repeat(134_599)));
      assert.equal(response.inference?.inputTokens, 33_458, 'exact llama.cpp count was not used');
      assert.equal(response.inference?.effectiveMaxOutputTokens, 31_566, 'shared output budget was not clamped to exact remaining context');
      assert.equal(scenario.requestBodies.length, 1, 'exact ~33K request was rejected before inference');
      assert.equal(scenario.requestBodies[0].max_tokens, 31_566);
      assert.equal((scenario.countBodies[0].tools as unknown[])?.length, 1, 'token count request omitted tool schema');
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCounts: [50_000], requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      const response = await call(new LlamaCppBackend(url), baseMessages());
      assert.equal(response.inference?.effectiveMaxOutputTokens, 15_024, 'output was not clamped to exact remaining context');
      assert.equal(scenario.requestBodies[0].max_tokens, 15_024);
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCounts: [65_536], requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      await assert.rejects(call(new LlamaCppBackend(url), baseMessages()), LlamaCppContextExhaustedError);
      assert.equal(scenario.requestBodies.length, 0, 'confirmed exhausted prompt reached inference');
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCounts: [30_000], chatStatus: 400, requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      await assert.rejects(call(new LlamaCppBackend(url), baseMessages()), (error: unknown) => error instanceof LlamaCppRequestError && error.request.contextClassification === 'backend_context_rejected');
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCounts: [2_000], chatStatus: 500, chatError: 'Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] invalid string: missing closing quote', requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      await assert.rejects(call(new LlamaCppBackend(url), baseMessages()), (error: unknown) => error instanceof LlamaCppRequestError && error.request.status === 500 && /Failed to parse tool call arguments as JSON/.test(error.request.serverError ?? ''));
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCounts: [33_000, 34_000], requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      const backend = new LlamaCppBackend(url);
      await call(backend, baseMessages('first Agent request'));
      const next: ToolMessage[] = [...baseMessages('first Agent request'), { role: 'assistant', content: '', tool_calls: [{ id: 'call-read-a', type: 'function', function: { name: 'read_file', arguments: { path: 'src/A.ts' } } }] }, { role: 'tool', tool_name: 'read_file', tool_call_id: 'call-read-a', content: JSON.stringify({ path: 'src/A.ts', content: 'small result' }) }];
      const response = await backend.chatWithTools(model, next, toolSchema, new AbortController().signal, 65_536, 'deep', { generationId: 'generation', conversationId: 'conversation', agentStep: 2, phase: 'post_tool' });
      assert.equal(response.inference?.inputTokens, 34_000, 'second request did not retain backend-authoritative token count');
      assert.equal(scenario.requestBodies.length, 2, 'appended Agent history was not sent');
      assert.equal(scenario.requestBodies[0].max_tokens, 32_024, 'ordinary tool-call requests did not use the shared output limit');
      assert.equal(scenario.requestBodies[1].max_tokens, 31_024, 'post-tool Agent request did not use the same shared output limit');
      const serializedMessages = scenario.requestBodies[1].messages as Array<Record<string, unknown>>;
      assert.equal((serializedMessages[2].tool_calls as Array<Record<string, unknown>>)[0].id, 'call-read-a', 'assistant tool-call ID was dropped while serializing llama.cpp history');
      assert.equal(((serializedMessages[2].tool_calls as Array<{ function: { arguments: unknown } }>)[0]).function.arguments, '{"path":"src/A.ts"}', 'llama.cpp did not serialize canonical tool arguments as OpenAI JSON text');
      assert.equal(serializedMessages[3].tool_call_id, 'call-read-a', 'tool result did not retain its matching tool-call ID');
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCounts: [1_000, 1_000], requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      const glm = 'glm-4.7-flash:q4_k';
      const backend = new LlamaCppBackend(url, 65_536, false, glm);
      await backend.chatWithTools(glm, baseMessages('GLM auto'), toolSchema, new AbortController().signal, 65_536, 'auto');
      await backend.chatWithTools(glm, baseMessages('GLM fast'), toolSchema, new AbortController().signal, 65_536, 'fast');
      await backend.chatWithTools(glm, baseMessages('GLM deep'), toolSchema, new AbortController().signal, 65_536, 'deep');
      assert.equal(scenario.requestBodies[0].reasoning_effort, undefined, 'GLM Auto should leave native reasoning at the model default');
      assert.equal(scenario.requestBodies[0].chat_template_kwargs, undefined, 'GLM Auto should not override template thinking');
      assert.deepEqual(scenario.requestBodies[1].chat_template_kwargs, { enable_thinking: false }, 'GLM fast request did not disable native thinking');
      assert.equal(scenario.requestBodies[1].reasoning_effort, 'none', 'GLM fast request did not use llama.cpp\'s native no-reasoning setting');
      assert.deepEqual(scenario.requestBodies[2].chat_template_kwargs, { enable_thinking: true }, 'GLM deep request did not enable native thinking');
      assert.equal(scenario.requestBodies[2].reasoning_effort, 'xhigh', 'GLM deep request did not use llama.cpp\'s native high-reasoning setting');
    } finally { await stop(server); }
  }
  {
    const scenario: Scenario = { tokenCountStatus: 404, requestBodies: [], countBodies: [] }; const { server, url } = await startServer(scenario);
    try {
      const messages = [...baseMessages('x'.repeat(134_599)), { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'report_progress', arguments: { message: 'Проверяю тесты' } } }] }, { role: 'tool' as const, tool_name: 'report_progress', content: JSON.stringify({ reported: true }) }];
      await call(new LlamaCppBackend(url), messages);
      assert.equal(scenario.requestBodies.length, 1, 'rough estimate hard-rejected when exact endpoint was unavailable');
      const serialized = JSON.stringify(scenario.countBodies[0] ?? scenario.requestBodies[0]);
      assert(!serialized.includes('activity-trace-only') && !serialized.includes('raw-cache-only'), 'activity telemetry or raw cache leaked into the inference request');
    } finally { await stop(server); }
  }
}

if (require.main === module) void runLlamaCppBackendRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
