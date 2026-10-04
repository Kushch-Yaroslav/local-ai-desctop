// Optional diagnostic, not part of `npm test`: needs Chrome and an exported run (see export-run.mjs).
// Environment: RUN_JSON (default ./run.json), RENDERER_DIR (default dist/renderer), CHROME (default /usr/bin/google-chrome).
// Cold-load of the persisted long run (what a restart does) and repaint latency afterwards.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const run = JSON.parse(readFileSync(process.env.RUN_JSON ?? './run.json', 'utf8'));
const rendererDir = process.env.RENDERER_DIR ?? fileURLToPath(new URL('../../dist/renderer', import.meta.url));
const label = process.env.LABEL ?? 'load';
const c = run.conversation;
const conversation = { id: c.id, title: c.title, modelId: c.model_id, mode: 'agent', workingDirectory: c.working_directory, primaryProjectId: c.primary_project_id, secondaryWorkingDirectory: c.secondary_working_directory, secondaryProjectId: c.secondary_project_id, contextWindow: c.context_window, reasoningMode: 'deep', contextTokens: 1000, contextModelId: c.model_id, webMode: 'off', llamaKvCacheType: 'f16', llamaKvOffload: true, createdAt: c.created_at, updatedAt: c.updated_at };
const model = { id: c.model_id, name: 'Qwen', backend: 'llama-cpp', installed: true, quantization: 'Q4', maxContext: 262144, supportedContextPresets: [32768, 65536, 90112], supportsTools: true, supportsReasoning: true, shortName: 'Qwen' };
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--allow-file-access-from-files', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message.slice(0, 200)));
const actions = run.actions.map((a) => ({ ...a, rawOutput: undefined }));
await page.addInitScript(({ conversation, model, assistant, userMessage, actions }) => {
  const ok = (v) => Promise.resolve(v);
  window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ['longtask'] });
  window.localAi = {
    conversations: { list: () => ok([conversation]), create: () => ok(conversation), update: (_i, p) => ok({ ...conversation, ...p }), delete: () => ok(true) },
    messages: { list: () => ok([userMessage, assistant]), edit: () => ok([]), regenerate: () => ok([]) }, agentPlans: { get: () => ok(null) }, projects: { search: () => ok([]) },
    attachments: { import: () => ok(null), list: () => ok([]), dataUrl: () => ok('') },
    analysis: { list: () => ok([{ id: 'run-1', conversationId: conversation.id, assistantMessageId: assistant.id, reasoningMode: 'deep', status: 'completed', actionCount: actions.length, actions, createdAt: '', completedAt: '' }]) },
    models: { list: () => ok([model]) }, settings: { get: () => ok({ llamaServerPath: null, modelsPath: '', llamaRuntime: { status: 'ready', modelId: model.id, contextWindow: 90112, kvCacheType: 'f16', kvOffload: true } }) },
    hardware: { get: () => ok({ cpu: 10, ramUsedGb: 10, ramTotalGb: 62, gpu: 5, vramUsedGb: 22, vramTotalGb: 24 }) },
    contextEstimate: () => ok(null), contextDiscover: () => ok(null), contextDiscoveryStatus: () => ok({ busy: false, modelId: model.id, stage: '', probeCount: 0 }),
    dialog: { chooseDirectory: () => ok(null) }, chat: { send: () => new Promise(() => {}), steer: () => ok(true), stop: () => ok(true), approve: () => ok(true), onStream: () => () => {} },
  };
}, { conversation, model, assistant: run.assistant, userMessage: run.userMessage, actions });
const t0 = Date.now();
await page.goto('file://' + rendererDir + '/index.html');
await page.waitForFunction(() => document.querySelectorAll('.agent-timeline-thought').length > 100, null, { timeout: 180000 }).catch(() => {});
const mountMs = Date.now() - t0;
const r = await page.evaluate(async () => {
  const frame = () => new Promise((res) => requestAnimationFrame(() => res(performance.now())));
  await frame(); await frame();
  const t2 = performance.now(); document.documentElement.style.display = 'none'; void document.body.offsetHeight; document.documentElement.style.display = ''; await frame(); await frame(); const repaint = performance.now() - t2;
  // Interaction latency with the full history mounted: scroll the conversation to the top and back.
  const el = document.querySelector('.conversation'); const t3 = performance.now(); el.scrollTop = 0; await frame(); el.scrollTop = el.scrollHeight; await frame(); const scroll = performance.now() - t3;
  return { dom: document.getElementsByTagName('*').length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6), long: window.__long.sort((a, b) => b[1] - a[1]).slice(0, 5), longTotalMs: window.__long.reduce((s, x) => s + x[1], 0), repaintAfterInvalidationMs: Math.round(repaint), scrollRoundTripMs: Math.round(scroll), thoughts: document.querySelectorAll('.agent-timeline-thought').length };
});
console.log(JSON.stringify({ label, mountMs, ...r }));
await browser.close();
