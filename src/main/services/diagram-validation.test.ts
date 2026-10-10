import assert from 'node:assert/strict';
import { DiagramValidationBridge } from './diagram-validation';
export async function runDiagramValidationRegression() {
  const bridge = new DiagramValidationBridge(100);
  let request: { id: string; source: string } | undefined;
  const sender = { id: 5, isDestroyed: () => false, send: (_channel: string, value: { id: string; source: string }) => { request = value; } };
  const pass = bridge.validate(sender, 'flowchart LR\nA-->B', new AbortController().signal);
  bridge.reply(6, request!.id, undefined); // another renderer cannot accept this request
  bridge.reply(5, request!.id, undefined); await pass;
  const fail = bridge.validate(sender, 'broken diagram', new AbortController().signal);
  bridge.reply(5, request!.id, 'Parse error on line 1');
  await assert.rejects(fail, /Invalid mermaid syntax.*Parse error.*retry/);
  const controller = new AbortController();
  const cancelled = bridge.validate(sender, 'flowchart LR\nA-->B', controller.signal); controller.abort();
  await assert.rejects(cancelled, /cancelled/); bridge.reply(5, request!.id, undefined);
  await assert.rejects(bridge.validate(sender, 'x'.repeat(16001), new AbortController().signal), /limit/);
  await assert.rejects(bridge.validate(sender, 'flowchart LR\nA-->B', new AbortController().signal), /timed out/);
  console.log('Mermaid renderer validation bridge: ok');
}
if (require.main === module) void runDiagramValidationRegression().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
