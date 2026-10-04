// Optional diagnostic, not part of `npm test`: needs Chrome and an exported run (see export-run.mjs).
// Environment: RUN_JSON (default ./run.json), RENDERER_DIR (default dist/renderer), CHROME (default /usr/bin/google-chrome).
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
const run = JSON.parse(readFileSync(process.env.RUN_JSON ?? './run.json', 'utf8'));
const rendererDir = process.env.RENDERER_DIR ?? fileURLToPath(new URL('../../dist/renderer', import.meta.url));
const maxChars = Number(process.env.MAX_CHARS ?? 400000);
const rate = Number(process.env.EVENTS_PER_SEC ?? 120);        // injected thinking events per second
const chunk = Number(process.env.CHUNK ?? 4);                   // chars per thinking event (~1 token)
const label = process.env.LABEL ?? 'run';
const profile = process.env.PROFILE === '1'; const profFrom = Number(process.env.PROFILE_FROM ?? 0); const profTo = Number(process.env.PROFILE_TO ?? 1e12);

const c = run.conversation;
const conversation = { id: c.id, title: c.title, modelId: c.model_id, mode: 'agent', workingDirectory: c.working_directory, primaryProjectId: c.primary_project_id, secondaryWorkingDirectory: c.secondary_working_directory, secondaryProjectId: c.secondary_project_id, contextWindow: c.context_window, reasoningMode: 'deep', contextTokens: 1000, contextModelId: c.model_id, webMode: 'off', llamaKvCacheType: 'f16', llamaKvOffload: true, createdAt: c.created_at, updatedAt: c.updated_at };
const model = { id: c.model_id, name: 'Qwen', backend: 'llama-cpp', installed: true, quantization: 'Q4', maxContext: 262144, supportedContextPresets: [32768, 65536, 90112], supportsTools: true, supportsReasoning: true, shortName: 'Qwen' };

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--allow-file-access-from-files', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message.slice(0, 300)));
await page.addInitScript(({ conversation, model }) => {
  const ok = (v) => Promise.resolve(v);
  window.__listener = null; window.__sent = null;
  window.localAi = {
    conversations: { list: () => ok([conversation]), create: () => ok(conversation), update: (_i, p) => ok({ ...conversation, ...p }), delete: () => ok(true) },
    messages: { list: () => ok([]), edit: () => ok([]), regenerate: () => ok([]) }, agentPlans: { get: () => ok(null) }, projects: { search: () => ok([]) },
    attachments: { import: () => ok(null), list: () => ok([]), dataUrl: () => ok('') }, analysis: { list: () => ok([]) },
    models: { list: () => ok([model]) }, settings: { get: () => ok({ llamaServerPath: null, modelsPath: '', llamaRuntime: { status: 'ready', modelId: model.id, contextWindow: 90112, kvCacheType: 'f16', kvOffload: true } }) },
    hardware: { get: () => ok({ cpu: 10, ramUsedGb: 10, ramTotalGb: 62, gpu: 90, vramUsedGb: 22, vramTotalGb: 24 }) },
    contextEstimate: () => ok(null), contextDiscover: () => ok(null), contextDiscoveryStatus: () => ok({ busy: false, modelId: model.id, stage: '', probeCount: 0 }),
    dialog: { chooseDirectory: () => ok(null) },
    chat: { send: (req) => { window.__sent = req; return new Promise(() => {}); }, steer: () => ok(true), stop: () => ok(true), approve: () => ok(true), onStream: (l) => { window.__listener = l; return () => {}; } },
  };
  // Measurements
  window.__m = { lag: [], long: [], frames: [], t0: performance.now() };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__m.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ['longtask'] });
  let last = performance.now(); setInterval(() => { const n = performance.now(); window.__m.lag.push(Math.max(0, n - last - 50)); last = n; }, 50);
  let lf = performance.now(); const raf = () => { const n = performance.now(); window.__m.frames.push(n - lf); lf = n; requestAnimationFrame(raf); }; requestAnimationFrame(raf);
}, { conversation, model });
await page.goto('file://' + rendererDir + '/index.html');
await page.waitForSelector('textarea', { timeout: 20000 });
await page.evaluate((v) => { window.__cpStep = v[0]; window.__pFrom = v[1]; window.__pTo = v[2]; }, [25000, profile ? profFrom : -1, profile ? profTo : -1]); await page.fill('textarea', run.user.slice(0, 200));
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__sent, null, { timeout: 10000 });
const generationId = await page.evaluate(() => window.__sent.generationId);
const cdp = await page.context().newCDPSession(page);
if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  page.on('console', async (m) => { const t = m.text(); if (t === '__PSTART__') await cdp.send('Profiler.start'); if (t === '__PSTOP__') { const { profile: pr } = await cdp.send('Profiler.stop'); writeFileSync(`${process.env.OUT_DIR ?? '.'}/${label}.cpuprofile`, JSON.stringify(pr)); console.error('profile saved'); } }); }

const pumpStartMs = await page.evaluate(() => Math.round(performance.now()));
const t0 = Date.now();
// The stream is built inside the page exactly as the main process emits it (reasoning deltas, tool lifecycle events and a
// full analysis-run snapshot after every tool event); structuredClone models Electron's IPC deserialization of each event.
const info = await page.evaluate(async ({ timeline, actionsList, generationId, conversationId, rate, chunk, maxChars }) => {
  const actions = new Map(actionsList.map((a) => [a.id, a]));
  const sorted = [...timeline].sort((a, b) => a.position - b.position);
  const runActions = []; let chars = 0; let turn = 0; let thinkingSent = 0; let eventsSent = 0; let toolEvents = 0; let runBytes = 0;
  const emit = (e) => { eventsSent++; window.__listener(structuredClone({ ...e, conversationId, generationId })); };
  const snapshot = () => ({ id: 'run-1', conversationId, assistantMessageId: null, reasoningMode: 'deep', status: 'running', actionCount: runActions.length, actions: runActions.map((a) => ({ ...a })), createdAt: new Date().toISOString(), completedAt: null });
  const tool = (activity) => { toolEvents++; emit({ type: 'tool', activity }); const run = snapshot(); emit({ type: 'analysis-run', run }); };
  const startedAt = performance.now();
  const pace = async () => { while (thinkingSent > ((performance.now() - startedAt) / 1000) * rate) await new Promise((r) => setTimeout(r, 4)); };
  window.__progress = { chars: 0 }; window.__cp = []; let nextCp = Number(window.__cpStep);
  const checkpoint = () => { const m = window.__m; const q = (a, p) => { const x = [...a].sort((u, v) => u - v); return x[Math.min(x.length - 1, Math.floor(x.length * p))] ?? 0; };
    window.__cp.push({ chars, lagP95: Math.round(q(m.lag, 0.95)), lagMax: Math.round(Math.max(0, ...m.lag)), longTasks: m.long.length, longMs: m.long.reduce((a, x) => a + x[1], 0), longMax: Math.max(0, ...m.long.map((x) => x[1])), frameP95: Math.round(q(m.frames, 0.95)), frameMax: Math.round(Math.max(0, ...m.frames)), dom: document.getElementsByTagName('*').length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6) });
    m.lag = []; m.long = []; m.frames = []; };
  outer: for (const entry of sorted) {
    if (entry.kind === 'reasoning') {
      turn++; emit({ type: 'agent-telemetry', telemetry: { turn } });
      for (let i = 0; i < entry.content.length; i += chunk) {
        emit({ type: 'thinking', content: entry.content.slice(i, i + chunk), timelinePosition: entry.position }); thinkingSent++; chars += chunk; window.__progress.chars = chars;
        if (thinkingSent % 8 === 0) await pace(); if (chars >= nextCp) { checkpoint(); nextCp += Number(window.__cpStep); } if (chars === window.__pFrom) console.log('__PSTART__'); if (chars === window.__pTo) console.log('__PSTOP__'); if (chars >= maxChars) break outer;
      }
      emit({ type: 'context-usage', used: 1000 + chars / 4, maximum: 90112 });
    } else if (entry.kind === 'activity') {
      const a = actions.get(entry.activityId); if (!a) continue;
      const base = { ...a, rawOutput: undefined, timelinePosition: entry.position };
      const running = { ...base, state: 'running', output: undefined, terminal: a.terminal ? { command: a.terminal.command, status: 'running' } : undefined };
      runActions.push(running); tool(running);
      if (a.kind === 'terminal' && a.terminal?.stdout) for (const line of String(a.terminal.stdout).split('\n').slice(0, 400)) { tool({ ...base, state: 'running', terminal: { stdout: line } }); running.terminal = { ...running.terminal, stdout: (running.terminal.stdout ?? '') + line + '\n' }; await pace(); }
      runActions[runActions.length - 1] = base; tool(base); runBytes += JSON.stringify(snapshot()).length;
    }
  }
  return { thinkingEvents: thinkingSent, toolEvents, totalEvents: eventsSent, chars, avgRunSnapshotKB: Math.round(runBytes / Math.max(1, toolEvents) / 1024) };
}, { timeline: run.timeline, actionsList: run.actions, generationId, conversationId: conversation.id, rate, chunk, maxChars });
console.error(`[${label}]`, JSON.stringify(info));
const wall = (Date.now() - t0) / 1000;
let finish = null;
if (process.env.FINISH === '1') {
  finish = await page.evaluate(async ({ assistant, generationId, conversationId }) => {
    const longs = []; const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(Math.round(e.duration)); }); obs.observe({ entryTypes: ['longtask'] });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
    const t = performance.now();
    window.__listener(structuredClone({ type: 'analysis-run', run: { id: 'run-1', conversationId, assistantMessageId: assistant.id, reasoningMode: 'deep', status: 'completed', actionCount: 0, actions: [], createdAt: '', completedAt: '' }, conversationId, generationId }));
    window.__listener(structuredClone({ type: 'done', assistant, finishReason: 'stop', conversationId, generationId }));
    await frame(); const afterDone = performance.now() - t; await frame();
    const settled = performance.now() - t;
    // Frame production after a full invalidation: what a window re-exposed after being hidden must do before anything is visible.
    const t2 = performance.now(); document.documentElement.style.display = 'none'; void document.body.offsetHeight; document.documentElement.style.display = ''; await frame(); await frame(); const repaint = performance.now() - t2;
    await new Promise((r) => setTimeout(r, 300)); obs.disconnect();
    return { doneToTwoFramesMs: Math.round(settled), doneToFirstFrameMs: Math.round(afterDone), longTasksMs: longs, repaintAfterInvalidationMs: Math.round(repaint), dom: document.getElementsByTagName('*').length };
  }, { assistant: run.assistant, generationId, conversationId: conversation.id });
}
await page.waitForTimeout(1500);
const diag = process.env.DIAG === '1' ? await page.evaluate(() => {
  const sections = [...document.querySelectorAll('.agent-timeline > *')];
  const rows = sections.map((el, i) => ({ i, cls: el.className.toString().slice(0, 50), n: el.getElementsByTagName('*').length, text: el.textContent.length }));
  const byCls = {}; for (const r of rows) { const k = r.cls.split(' ')[0] + ' ' + (r.cls.split(' ')[2] ?? ''); byCls[k] = (byCls[k] ?? 0) + r.n; }
  const other = document.getElementsByTagName('*').length - rows.reduce((a, r) => a + r.n, 0) - sections.length;
  const texts = sections.filter((e) => e.className.toString().includes('thought')).map((e) => e.querySelector('header')?.textContent + ' | ' + (e.textContent.slice(e.querySelector('header')?.textContent.length ?? 0)).slice(0, 90));
  return { sample: texts.slice(0, 12), thoughtTextSum: sections.filter((e) => e.className.toString().includes('thought')).reduce((a, e) => a + e.textContent.length, 0), sections: sections.length, byCls, nonTimelineNodes: other, biggest: rows.sort((a, b) => b.n - a.n).slice(0, 6) };
}) : null;
const result = await page.evaluate(() => {
  const m = window.__m; const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
  return { lagP50: q(m.lag, 0.5), lagP95: q(m.lag, 0.95), lagMax: Math.max(0, ...m.lag), longTasks: m.long.length, longTaskTotalMs: m.long.reduce((s, x) => s + x[1], 0), longTaskMaxMs: Math.max(0, ...m.long.map((x) => x[1])), frames: m.frames.length, frameP50: q(m.frames, 0.5), frameP95: q(m.frames, 0.95), frameMax: Math.max(0, ...m.frames),
    dom: document.getElementsByTagName('*').length, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6), uiText: document.querySelector('.conversation')?.innerText.length ?? 0, long: m.long.slice(0, 12) };
});
// Is the page still responsive to input right now?
const probeStart = Date.now(); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
result.pumpStartMs = pumpStartMs; result.rafAfterMs = Date.now() - probeStart; result.wallSeconds = wall; result.injected = info;

result.checkpoints = await page.evaluate(() => window.__cp); result.finish = finish; result.diag = diag;
console.log(JSON.stringify({ label, ...result }));
await browser.close();
