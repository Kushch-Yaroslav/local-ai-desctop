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
    await backend.chatWithTools(model, messages, tools, new AbortController().signal, 65_536, 'normal', { phase: 'post_tool', maxOutputTokens: 4_096 });
    assert.equal(requests.length, 2, 'Ollama Agent request did not run a preflight and a chat turn');
    assert.equal(requests[0].tools, undefined, 'one-token Ollama preflight still enabled tool parsing');
    assert.equal((requests[0].options as Record<string, unknown>).num_predict, 1, 'Ollama preflight output budget changed');
    assert.equal((requests[1].options as Record<string, unknown>).num_predict, 4_096, 'Ollama ignored the bounded Agent tool-turn output limit');
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
      await new OllamaBackend('http://unit.test').chatWithTools(model, messages, tools, new AbortController().signal, 65_536, 'normal');
      const historicalCall = ((requests[1].messages as Array<Record<string, unknown>>)[2].tool_calls as Array<{ function: { arguments: unknown } }>)[0];
      assert.deepEqual(historicalCall.function.arguments, { path: '.' }, 'stringified Agent history was forwarded to Ollama instead of canonical object arguments');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}

if (require.main === module) void runOllamaBackendRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
