import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RustAgentRuntime } from './rust-agent-runtime';
import { visualArtifactExamples } from '../../shared/rich-artifacts';
import type { StreamEvent } from '../../shared/types';

/** Real Rust worker + host bridge + scripted llama.cpp HTTP fixture. No model inference. */
export async function runRichAgentHttpRegression() {
  const root = mkdtempSync(join(tmpdir(), 'rich-agent-'));
  writeFileSync(join(root, 'untouched.txt'), 'User project must remain untouched.');
  try {
    for (const selectedProject of [false, true]) {
      let turn = 0; const requests: Array<Record<string, unknown>> = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload); turn += 1;
        res.setHeader('content-type', 'text/event-stream');
        const invalid = { ...visualArtifactExamples.chart, data: [{ quarter: 'Q1', revenue: '10 USD' }] };
        const args = { artifact: turn <= 3 ? invalid : visualArtifactExamples.chart };
        const delta = turn <= 5 ? { tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: 'create_visual_artifact', arguments: JSON.stringify(args) } }] } : { content: 'Interactive chart complete. Fictional demonstration data only.' };
        res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: turn <= 5 ? 'tool_calls' : 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string');
      const runtime = new RustAgentRuntime(`http://127.0.0.1:${address.port}/v1/chat/completions`);
      const signal = AbortSignal.timeout(15000); const events: StreamEvent[] = [];
      try {
        for await (const event of runtime.stream('qwen3.8:27b-q4_K_M', [{ id: 'u', conversationId: 'fixture', role: 'user', content: 'Show a fictional interactive revenue chart. This is an informational visualization request.', createdAt: '' }], selectedProject ? [{ id: 'p', slot: 1, root, label: 'Project fixture' }] : [], signal, 32768, selectedProject ? 'deep' : 'fast', 'off', `fixture-${selectedProject}`)) events.push(event);
        assert(!signal.aborted, 'worker did not finish its bounded correction sequence');
        assert(!events.some((event) => event.type === 'error'), JSON.stringify(events.filter((event) => event.type === 'error')));
        assert.equal(turn, 6, 'repeated invalid artifact attempts prematurely withdrew all tools or added planning turns');
        assert(requests.every((request) => (request.tools as Array<{ function: { name: string } }>).some((tool) => tool.function.name === 'create_visual_artifact')));
        assert.match(JSON.stringify(requests[3].messages), /failed twice|rejected twice/);
        assert.equal(events.filter((event) => event.type === 'rich-artifact').length, 1, 'accepted duplicate artifact was emitted twice');
        assert(events.some((event) => event.type === 'done'));
        assert.equal(events.filter((event) => event.type === 'token').map((event) => event.content).join(''), 'Interactive chart complete. Fictional demonstration data only.');
        // The existing ledger creates .ai-framework bookkeeping, never a model-directed edit.
        assert.deepEqual(readdirSync(root).filter((name) => name !== '.ai-framework'), ['untouched.txt'], 'informational artifacts triggered user-file writes');
        assert.equal(readFileSync(join(root, 'untouched.txt'), 'utf8'), 'User project must remain untouched.');
      } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
    console.log('Real Rust worker/host HTTP fixture: invalid identical artifacts bounded, corrected artifact accepted, duplicate reused, Fast/Deep and selected/no project, final answer and no project modifications passed.');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) void runRichAgentHttpRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
