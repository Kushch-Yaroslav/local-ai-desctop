import assert from 'node:assert/strict';
import { OllamaBackend } from './ollama-backend';
import type { ToolMessage } from './types';

const model = 'qwen3.8:27b-q4_K_M';
const tools = [{ type: 'function', function: { name: 'list_directory', description: 'List files.', parameters: { type: 'object', properties: {} } } }];

export async function runOllamaBackendRegression(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done_reason: 'stop', prompt_eval_count: 1_000 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const messages: ToolMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_directory', arguments: {} } }] },
      { role: 'tool', tool_name: 'list_directory', tool_call_id: 'call-1', content: '{"entries":[]}' },
    ];
    const backend = new OllamaBackend('http://unit.test');
    await backend.chatWithTools(model, messages, tools, new AbortController().signal, 65_536, 'fast', { phase: 'post_tool' });
    assert.equal(requests.length, 2, 'Ollama Agent request did not run a preflight and a chat turn');
    assert.equal(requests[0].tools, undefined, 'one-token Ollama preflight still enabled tool parsing');
    assert.equal((requests[0].options as Record<string, unknown>).num_predict, 1, 'Ollama preflight output budget changed');
    assert.equal((requests[1].options as Record<string, unknown>).num_predict, 32_768, 'Ollama Agent request did not use the shared safe output budget');
    assert.equal(requests[1].think, 'low', 'Ollama Fast reasoning did not use its native think control');
    assert.equal((requests[1].tools as unknown[])?.length, 1, 'actual Ollama Agent request lost its tool schema');
    const result = (requests[1].messages as Array<Record<string, unknown>>)[3];
    assert.equal(result.tool_name, 'list_directory', 'Ollama tool result lost its supported name field');
    assert.equal(result.tool_call_id, undefined, 'OpenAI-only tool_call_id leaked into Ollama wire payload');
    const historicalCall = (requests[1].messages as Array<Record<string, unknown>>)[2];
    assert.deepEqual(((historicalCall.tool_calls as Array<{ function: { arguments: unknown } }>)[0]).function.arguments, {}, 'Ollama history did not retain object tool arguments');
    await backend.unloadTrackedModels();
    assert.equal(requests.at(-1)?.keep_alive, 0, 'Ollama model was not explicitly released on application shutdown');
  } finally {
    globalThis.fetch = originalFetch;
  }
  {
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done_reason: 'stop', prompt_eval_count: 1_000 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const messages: ToolMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'continue' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call-plan', type: 'function', function: { name: 'list_directory', arguments: '{"path":"."}' } }] }, { role: 'tool', tool_name: 'list_directory', content: '{"entries":[]}' }];
      await new OllamaBackend('http://unit.test').chatWithTools(model, messages, tools, new AbortController().signal, 65_536, 'auto');
      const historicalCall = ((requests[1].messages as Array<Record<string, unknown>>)[2].tool_calls as Array<{ function: { arguments: unknown } }>)[0];
      assert.deepEqual(historicalCall.function.arguments, { path: '.' }, 'stringified Agent history was forwarded to Ollama instead of canonical object arguments');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ message: { role: 'assistant', content: '' }, prompt_eval_count: 12 }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(`${JSON.stringify({ message: { thinking: 'First, inspect the stream.' } })}\n${JSON.stringify({ message: { content: 'Visible answer.' } })}\n${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 4, eval_duration: 1_000_000_000 })}\n`, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }) as typeof fetch;
    try {
      const events = [];
      for await (const event of new OllamaBackend('http://unit.test').streamChat(model, [{ id: 'stream-user', conversationId: 'stream', role: 'user', content: 'hello', createdAt: new Date().toISOString() }], new AbortController().signal)) events.push(event);
      assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.content), ['First, inspect the stream.'], 'Ollama reasoning chunks were not forwarded as Thinking events');
      assert.deepEqual(events.filter((event) => event.type === 'token').map((event) => event.content), ['Visible answer.'], 'Ollama answer chunks changed while forwarding Thinking');
    } finally { globalThis.fetch = originalFetch; }
  }
}

if (require.main === module) void runOllamaBackendRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
