import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { ChatRequest, Conversation, StreamEvent } from '../../shared/types';
import type { LlamaRuntimeState } from '../services/llama-runtime-controller';

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lad-failed-ipc-'));
  process.env.LOCAL_AI_RUNTIME_ROOT = root;
  let planNext = false;
  const provider = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (planNext) {
        planNext = false;
        const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
        response.writeHead(200, {'content-type':'text/event-stream'});
        response.end(frame({tool_calls:[{index:0,id:'plan-call',type:'function',function:{name:'plan',arguments:JSON.stringify({action:'set',steps:['Inspect projects','Verify changes']})}}]},null) + frame({},'tool_calls') + 'data: [DONE]\n\n');
        return;
      }
      response.writeHead(500, {'content-type':'application/json'}); response.end(JSON.stringify({error:{message:'Jinja Exception: conversation roles must alternate'}}));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  process.env.LOCAL_AI_AGENT_ENDPOINT = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, ...args) => name === 'electron' ? { ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } } : originalLoad(name, ...args);
  const { ensureAppDirectories } = await import('../services/paths'); ensureAppDirectories();
  const { Database } = await import('../services/database'); const db = new Database();
  const { LlamaRuntimeController } = await import('../services/llama-runtime-controller');
  const { LlamaCppBackend } = await import('../backends/llama-cpp-backend');
  let runtime: LlamaRuntimeState = { status:'idle', modelId:null, contextWindow:null };
  LlamaRuntimeController.prototype.state = async () => runtime;
  LlamaRuntimeController.prototype.switchTo = async (modelId, contextWindow) => { runtime = {status:'ready',modelId,contextWindow}; return {ok:true,state:runtime}; };
  LlamaCppBackend.prototype.ensureModelAvailable = async () => {};
  LlamaCppBackend.prototype.resolveContextWindow = async (_model, requested) => ({requested,active:requested,supported:requested});
  LlamaCppBackend.prototype.streamChat = async function* () { yield {type:'token',content:'new chat works'}; yield {type:'done'}; };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({data:[]}), {status:200});
  const events: Array<StreamEvent & {conversationId:string}> = [];
  const invoke = async <T>(channel:string, ...args:unknown[]) => await handlers.get(channel)!({sender:{send:(_channel:string,event:StreamEvent & {conversationId:string})=>events.push(event)}},...args) as T;
  try {
    const {registerIpc} = await import('./register-ipc'); registerIpc();
    const model = 'devstral-small-2:24b-q4_k_m';
    const first = await invoke<Conversation>('conversations:create');
    mkdirSync(join(root,'project1')); mkdirSync(join(root,'project2'));
    await invoke('conversations:update',first.id,{modelId:model,mode:'agent',webMode:'off',workingDirectory:join(root,'project1'),secondaryWorkingDirectory:join(root,'project2')});
    const send = (conversationId:string,generationId:string):ChatRequest => ({conversationId,generationId,model,persistUserMessage:true,messages:[{id:generationId+'-user',conversationId,role:'user',content:'Inspect both projects using tools and a plan.',createdAt:''}]});
    const timer = setTimeout(() => { void invoke('chat:stop',first.id); }, 3000);
    try { await invoke('chat:send',send(first.id,'http500')); } finally {clearTimeout(timer);}
    assert(events.some(event=>event.type==='error' && `${event.message} ${event.details ?? ''}`.includes('500')), JSON.stringify(events));
    assert.equal(db.listAnalysisRuns(first.id).at(-1)?.status,'error', 'failed worker must settle the persisted run');
    assert(!events.some(event=>event.type==='cancelled'), 'failure must not require Stop');
    const next = await invoke<Conversation>('conversations:create');
    await invoke('conversations:update',next.id,{modelId:model,mode:'chat',webMode:'off'});
    await invoke('chat:send',send(next.id,'recovered'));
    assert(events.some(event=>event.conversationId===next.id && event.type==='done'), 'main-process inference slot must be immediately reusable');
    planNext = true;
    await invoke('chat:send',send(first.id,'plan-then-failure'));
    const update = events.find(event=>event.type==='task-memory');
    assert(update?.type === 'task-memory', 'canonical task-memory must reach the renderer as well as persistence');
    assert.equal(update.memory.plan?.steps.length, 2);
    assert.equal(db.getAgentPlan(first.id)?.taskMemory?.plan?.steps.length, 2);
    assert.equal(db.listAnalysisRuns(first.id).at(-1)?.status, 'error', 'live plan remains persisted after a later model failure');
    console.log('production IPC + real Rust HTTP500 → persisted failed run → new-chat recovery passed');
  } finally { globalThis.fetch=originalFetch; loader._load=originalLoad; db.close(); provider.close(); rmSync(root,{recursive:true,force:true}); }
}
void run().catch((error:unknown)=>{console.error(error);process.exitCode=1;});
