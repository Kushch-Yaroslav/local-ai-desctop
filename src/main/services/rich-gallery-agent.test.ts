import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RustAgentRuntime } from './rust-agent-runtime';
import type { WebBrowserService } from '../web/web-tools';
import type { DiscoveredImage } from '../../shared/rich-artifacts';
import type { StreamEvent } from '../../shared/types';

async function run() {
  for (const strategy of ['fast', 'deep'] as const) {
    const images = new Map<string, DiscoveredImage>(); const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let turn = 0; let verifications = 0;
    const colors = ['white', 'pink', 'red', 'yellow'];
    const gallery = { version: 1, type: 'image_gallery', summary: 'Licenses not verified.', images: colors.map(color => ({ discovery_id: `${color}-0` })) };
    const browser = { openSession: async () => ({
      execute: async (call: { arguments: { query: string } }) => {
        const results = Array.from({ length: 3 }, (_, index) => { const id = `${call.arguments.query}-${index}`; images.set(id, { id, url: `https://images.test/${id}.jpg`, sourceUrl: `https://sources.test/${id}`, title: id, alt: id }); return { discovery_id: id, retrieval_status: 'ready' }; });
        return JSON.stringify({ status: 'ok', results, gallery_created: false });
      }, getImageResults: () => images, getKnownSources: () => new Set(), verifyGalleryImages: async () => { verifications++; }, close: async () => undefined,
    }) } as unknown as WebBrowserService;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString())); turn++;
      const operations = turn === 1 ? colors.map(color => ({ name: 'web_image_search', args: { query: color, max_results: 3 } }))
        : turn <= 3 ? [{ name: 'create_visual_artifact', args: { artifact: { ...gallery, layout: '2x2' } } }]
          : turn === 4 ? [{ name: 'create_visual_artifact', args: { artifact: gallery } }] : [];
      const delta = operations.length ? { tool_calls: operations.map((operation, index) => ({ index, id: `${turn}-${index}`, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.args) } })) } : { content: 'Gallery emitted with four source references.' };
      res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: operations.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string');
    try {
      const runtime = new RustAgentRuntime(`http://127.0.0.1:${address.port}/v1/chat/completions`, undefined, browser);
      const events: StreamEvent[] = [];
      for await (const event of runtime.stream('qwen3.8:27b-q4_K_M', [{ id: 'u', conversationId: `gallery-${strategy}`, role: 'user', content: 'Find white, pink, red and yellow peony photographs and show one sourced gallery.', createdAt: '' }], [], AbortSignal.timeout(20_000), 32768, strategy, 'auto', `gallery-${strategy}`)) events.push(event);
      assert.equal(turn, 5); assert.equal(images.size, 12); assert.equal(verifications, 1);
      assert.match(JSON.stringify(requests[2].messages), /ARTIFACT_SCHEMA_INVALID/); assert.match(JSON.stringify(requests[3].messages), /ARTIFACT_DUPLICATE/);
      const artifacts = events.flatMap(event => event.type === 'rich-artifact' ? [event.artifact] : []);
      assert.equal(artifacts.length, 1); assert(artifacts[0].type === 'image_gallery'); assert.equal(artifacts[0].images.length, 4); assert.equal(artifacts[0].summary, gallery.summary);
      assert(events.some(event => event.type === 'done')); assert(!events.some(event => event.type === 'error'));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  console.log('Real Rust worker gallery fixture: Fast/Deep, four searches, twelve retained IDs, schema rejection, identical retry suppressed and corrected gallery emitted.');
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
