// Real production renderer. Only preload/model/network boundaries are deterministic fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
const { validateRichArtifact, visualArtifactExamples, visualChartExamples } = createRequire(import.meta.url)('../dist/shared/rich-artifacts.js');
const examples = Object.entries(visualArtifactExamples).filter(([type]) => type !== 'image_gallery').map(([, example]) => validateRichArtifact(example).artifact);
examples.push(...Object.values(visualChartExamples).filter(a=>a.chart!=='bar').map(example=>validateRichArtifact(example).artifact));
const multi = validateRichArtifact({ ...visualArtifactExamples.chart, title: 'Quarterly totals', xLabel: 'Квартал', yLabel: 'Выручка', series: [{key:'revenue',name:'Выручка',unit:'USD'},{key:'cost',name:'Длинное название ряда затрат',unit:'USD'}], data:[{quarter:'Q1',revenue:55000,cost:12000},{quarter:'A long category name preserved in data',revenue:110000,cost:10000},{quarter:'Q3',revenue:-2000,cost:null},{quarter:'Q4',revenue:220000,cost:51.23456789}] }).artifact; examples.push(multi);
const longGit = validateRichArtifact({ version: 1, type: 'diagram', title: 'Commit collision fixture', syntax: 'mermaid', mermaid: 'gitGraph\n  commit id: "main: init"\n  commit id: "main: release 1.0"\n  branch v2-migration\n  commit id: "v2: schema upgrade"\n  commit id: "v2: data migration"\n  branch feat/rich-responses\n  commit id: "feat: add rich responses"\n  commit id: "feat: unit tests"\n  checkout v2-migration\n  merge feat/rich-responses id: "merge: rich responses"\n  checkout main\n  merge v2-migration id: "merge: v2 into main"' }).artifact; examples.push(longGit);
const image = { id: 'photo', url: 'https://images.fixture.test/photo.png', sourceUrl: 'https://sources.fixture.test/photo', title: 'Peony photograph', alt: 'Peony' };
const photos = Array.from({ length: 4 }, (_, index) => ({ ...image, id: `${image.id}-${index}`, title: ['White', 'Pink', 'Red', 'Yellow'][index], url: `${image.url}?color=${index}`, sourceUrl: index === 0 ? image.sourceUrl : `${image.sourceUrl}/${index}` }));
const gallery = validateRichArtifact({ version: 1, type: 'image_gallery', summary: 'Licenses not verified.', images: photos.map(photo => ({ discovery_id: photo.id })) }, new Map(photos.map(photo => [photo.id, photo]))).artifact;
const root = resolve('dist/renderer');
const server = createServer(async (request, response) => {
  const path = resolve(root, `.${request.url === '/' ? '/index.html' : request.url}`);
  if (!path.startsWith(`${root}/`)) return response.writeHead(403).end();
  try { response.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(path)] ?? 'application/octet-stream'); response.end(await readFile(path)); } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.LOCAL_AI_TEST_BROWSER ?? '/usr/bin/google-chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ examples, gallery }) => {
    const chat = { id: 'visuals', title: 'Visual fixture', modelId: 'fixture', mode: 'chat', contextWindow: 32768, reasoningMode: 'fast', createdAt: '', updatedAt: '' };
    const saved = [{ id: 'saved', conversationId: chat.id, role: 'assistant', createdAt: '', content: 'Illustrative report.\n\n|Column|Value|\n|-|-|\n|Preserved Markdown|10|', richArtifacts: [...examples, gallery] }];
    saved.push({ id: 'failed-gallery', conversationId: chat.id, role: 'assistant', createdAt: '', content: 'All four images loaded successfully.' });
    let stream, validator, request, resolveSend, languageListener;
    window.richFixture = {
      validate: source => { window.richFixture.validation = undefined; validator({ id: 'validate', source }); },
      artifact: artifact => stream({ type: 'rich-artifact', artifact, conversationId: request.conversationId, generationId: request.generationId }),
      progress: label => stream({ type: 'tool', activity: { id: 'progress', label, kind: 'other', state: 'running' }, conversationId: request.conversationId, generationId: request.generationId }),
      finish: () => { stream({ type: 'done', assistant: { id: 'new-response', conversationId: request.conversationId, role: 'assistant', content: 'Chart complete.', richArtifacts: [examples.find(a => a.type === 'chart')], createdAt: '' }, conversationId: request.conversationId, generationId: request.generationId }); resolveSend(); },
      event: event => stream({ ...event, conversationId: request.conversationId, generationId: request.generationId }),
      language: value => languageListener(value),
      source: undefined,
    };
    window.localAi = {
      conversations: { list: async () => [chat], update: async (_id, patch) => Object.assign(chat, patch) },
      messages: { list: async () => saved }, analysis: { list: async () => [{ id: 'gallery-failure', conversationId: chat.id, assistantMessageId: 'failed-gallery', status: 'completed', reasoningMode: 'fast', createdAt: '', actionCount: 1, actions: [{ id: 'failed', label: 'Gallery creation', kind: 'other', state: 'error', metadata: { artifactType: 'image_gallery' } }] }] }, agentPlans: { get: async () => null },
      settings: { onLanguageChanged: listener => { languageListener = listener; return () => {}; }, get: async () => ({ uiLanguage: 'ru', modelsPath: '', llamaServerPath: null, llamaRuntime: { status: 'ready', modelId: 'fixture', contextWindow: 32768 } }) },
      hardware: { get: async () => null }, models: { list: async () => [{ id: 'fixture', name: 'Fixture', shortName: 'Fixture', installed: true, supportedContextPresets: [32768], maxContext: 32768, reasoning: { thinkingToggle: true, efforts: [] } }] },
      contextEstimate: async () => ({ unknownReasons: [], configuredMaxTokens: 32768 }), contextDiscoveryStatus: async () => ({ busy: false }),
      webImages: { load: async () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', mimeType: 'image/png' }), openSource: async url => { window.richFixture.source = url; } },
      chat: { onStream: listener => { stream = listener; return () => {}; }, onDiagramValidation: listener => { validator = listener; return () => {}; }, diagramValidationResult: (_id, error) => { window.richFixture.validation = error ?? 'valid'; }, send: value => { request = value; return new Promise(done => { resolveSend = done; }); }, stop: async () => { stream({ type: 'cancelled', conversationId: request.conversationId, generationId: request.generationId }); resolveSend(); } },
    };
  }, { examples, gallery });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('.rich-chart .recharts-wrapper');
  await page.waitForSelector('.rich-diagram .mermaid-canvas svg');
  assert.equal(await page.locator('.rich-gallery img').count(), 4);
  assert.equal(await page.locator('.rich-response-warning').count(), 1);
  assert.match(await page.locator('.rich-response-warning').innerText(), /Галерея не создана/);
  assert(await page.locator('table').count() >= 3, 'legacy Markdown and structured tables must coexist');
  assert.match(await page.locator('.rich-diagram').first().innerText(), /feat\/rich-responses/);
  await page.evaluate(source => window.richFixture.validate(source), visualArtifactExamples.diagram.mermaid);
  await page.waitForFunction(() => window.richFixture.validation === 'valid');
  await page.evaluate(() => window.richFixture.validate('flowchart LR\ninvalid @@@'));
  await page.waitForFunction(() => window.richFixture.validation?.includes('Parse error'));
  await page.locator('.rich-gallery-preview').first().click();
  await page.waitForSelector('.rich-image-modal');
  await page.locator('.rich-image-modal .rich-image-modal-content footer button').click();
  assert.equal(await page.evaluate(() => window.richFixture.source), image.sourceUrl);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.rich-image-modal').count(), 0);
  await page.setViewportSize({ width: 800, height: 900 });
  const dimensions = await page.locator('.rich-gallery-preview').first().boundingBox(); assert(dimensions.height <= 300);
  const grid = await page.locator('.rich-gallery-grid').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length); assert.equal(grid, 2);
  await page.locator('.composer textarea').fill('Show an interactive chart.'); await page.locator('.composer textarea').press('Enter');
  await page.evaluate(() => window.richFixture.progress('Создаю визуализацию'));
  await page.waitForFunction(() => document.querySelector('.generation-indicator')?.textContent.includes('Создаю визуализацию'));
  await page.evaluate(() => window.richFixture.event({ type: 'tool', activity: { id: 'progress', label: 'Создаю визуализацию', kind: 'other', state: 'completed' } }));
  await page.waitForFunction(() => document.querySelector('.generation-indicator')?.textContent.includes('Ожидаю ответ модели'));
  await page.evaluate(() => window.richFixture.event({ type: 'thinking', content: 'Streaming actual reasoning.' }));
  await page.waitForFunction(() => !document.querySelector('.generation-indicator'));
  await page.evaluate(() => window.richFixture.event({ type: 'model-state', state: 'waiting' }));
  await page.waitForSelector('.generation-indicator');
  await page.evaluate(() => window.richFixture.event({ type: 'token', content: 'Streaming answer.' }));
  await page.waitForFunction(() => !document.querySelector('.generation-indicator'));
  const previous = await page.locator('.rich-chart').count();
  await page.evaluate(artifact => window.richFixture.artifact(artifact), examples.find(a => a.type === 'chart'));
  await page.waitForFunction(count => document.querySelectorAll('.rich-chart').length > count, previous);
  await page.waitForFunction(() => performance.getEntriesByName('rich.artifact.dom_committed').length > 0);
  await page.evaluate(() => window.richFixture.finish());
  // Recharts text uses real theme colors, outside captions and wrapping legends.
  const chart = page.locator('.rich-chart').filter({ has: page.locator('h3', { hasText: 'Quarterly totals' }) });
  await chart.scrollIntoViewIfNeeded();
  assert.equal(await chart.locator('.rich-chart-legend li').count(), 2);
  const metrics = await chart.evaluate(element => {
    const tick = element.querySelector('.recharts-cartesian-axis-tick-value'); const caption = element.querySelector('.rich-chart-axis-titles').getBoundingClientRect(); const legend = element.querySelector('.rich-chart-legend').getBoundingClientRect();
    return { font: getComputedStyle(tick).fontSize, fill: getComputedStyle(tick).fill, overlap: caption.bottom > legend.top, overflow: element.scrollWidth > element.clientWidth + 1 };
  });
  assert.equal(metrics.font, '13px'); assert.notEqual(metrics.fill, 'rgb(102, 102, 102)'); assert.equal(metrics.overlap, false); assert.equal(metrics.overflow, false);
  await chart.locator('.recharts-bar-rectangle').first().hover();
  await page.waitForFunction(() => [...document.querySelectorAll('.recharts-tooltip-wrapper')].some(e => getComputedStyle(e).visibility === 'visible' && e.textContent.includes('55\u00a0000 USD')));
  const chartDownloadWait = page.waitForEvent('download'); await chart.getByRole('button', { name: 'Экспорт SVG' }).click();
  const chartExport = await readFile(await (await chartDownloadWait).path(), 'utf8');
  assert.match(chartExport, /Квартал/); assert.match(chartExport, /Выручка \(USD\)/); assert.match(chartExport, /Длинное название ряда затрат/);
  assert.equal(await page.locator('.rich-chart').filter({ has: page.locator('h3', { hasText: /^Demo revenue$/ }) }).first().locator('.rich-chart-legend').count(), 0);
  const diagram = page.locator('.rich-diagram .mermaid-git').first();
  const crowded = page.locator('.rich-diagram').filter({ has: page.locator('h3', { hasText: 'Commit collision fixture' }) });
  await crowded.scrollIntoViewIfNeeded(); await crowded.waitFor({ state: 'visible' });
  await crowded.locator('.mermaid-canvas svg').waitFor();
  const collisions = await crowded.locator('.commit-label').evaluateAll(labels => {
    const boxes = labels.map(label => label.getBoundingClientRect());
    return boxes.flatMap((a, index) => boxes.slice(index + 1).filter(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map(() => index));
  });
  assert.equal(collisions.length, 0, `Git labels collide: ${collisions.length} intersections`);
  assert.match(await crowded.locator('.git-commit-descriptions').innerText(), /main: release 1.0/);
  assert.match(await crowded.locator('.commit-label').first().getAttribute('aria-label'), /main: init/);
  await crowded.getByRole('button', { name: 'Развернуть', exact: true }).click();
  await crowded.getByRole('button', { name: 'Свернуть', exact: true }).click();
  const crowdedDownloadWait = page.waitForEvent('download');
  await crowded.getByRole('button', { name: 'Экспорт SVG' }).click();
  const crowdedExport = await readFile(await (await crowdedDownloadWait).path(), 'utf8');
  assert.match(crowdedExport, /main: release 1.0/);
  assert.match(crowdedExport, /feat: add rich responses/);
  assert.match(crowdedExport, /merge: v2 into main/);
  await diagram.scrollIntoViewIfNeeded();
  const gitMetrics = await diagram.evaluate(element => ({ labels: [...element.querySelectorAll('.branchLabel text')].map(e => getComputedStyle(e).fill), lanes: [...element.querySelectorAll('.branch')].map(e => getComputedStyle(e).stroke), strokes: [...element.querySelectorAll('.arrow')].map(e => getComputedStyle(e).stroke), widths: [...element.querySelectorAll('.arrow')].map(e => getComputedStyle(e).strokeWidth), rotated: [...element.querySelectorAll('.commit-label')].some(e => e.closest('g').getAttribute('transform')?.includes('rotate')) }));
  assert(gitMetrics.widths.every(width => width === '3px')); assert(new Set(gitMetrics.strokes).size >= 3); assert.equal(gitMetrics.rotated, false);
  assert.equal(new Set(gitMetrics.lanes).size, 3); assert(gitMetrics.labels.length >= 3); assert(gitMetrics.labels.every(color => color === 'rgb(22, 21, 19)'));
  await diagram.getByRole('button', { name: 'Увеличить диаграмму' }).click(); assert.match(await diagram.locator('output').innerText(), /125/);
  await diagram.getByRole('button', { name: 'Сбросить', exact: true }).click(); assert.match(await diagram.locator('output').innerText(), /100/);
  await diagram.screenshot({ path: '/tmp/rich-git-dark.png' });
  const downloadWait = page.waitForEvent('download'); await diagram.getByRole('button', { name: 'Экспорт SVG' }).click(); const download = await downloadWait; assert(download.suggestedFilename().endsWith('.svg'));
  const exported = await readFile(await download.path(), 'utf8'); assert.match(exported, /feat\/rich-responses/); assert.match(exported, /rgb\(22, 21, 19\)/); assert.match(exported, /<rect[^>]+fill=/);
  await page.evaluate(() => { document.documentElement.style.setProperty('--bg', '#ffffff'); document.documentElement.style.setProperty('--surface', '#ffffff'); document.documentElement.style.setProperty('--text', '#1d2733'); document.documentElement.style.setProperty('--text-muted', '#536273'); });
  await page.waitForSelector('.mermaid-git.mermaid-light svg');
  assert(await diagram.locator('.branchLabel text').evaluateAll(elements => elements.every(e => getComputedStyle(e).fill === 'rgb(255, 255, 255)')));
  await page.evaluate(() => window.richFixture.language('en')); await page.waitForFunction(() => document.querySelector('.rich-chart button')?.textContent.includes('Export'));
  await page.setViewportSize({ width: 650, height: 900 });
  await page.waitForFunction(() => [...document.querySelectorAll('.rich-chart')].every(e => e.scrollWidth <= e.clientWidth + 1));
  assert.equal(await chart.evaluate(e => e.scrollWidth > e.clientWidth + 1), false);
  const narrowCollisions = await crowded.locator('.commit-label').evaluateAll(labels => {
    const boxes = labels.map(label => label.getBoundingClientRect());
    return boxes.some((a, index) => boxes.slice(index + 1).some(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  }); assert.equal(narrowCollisions, false, 'narrow/light graph reintroduced commit collisions');
  await crowded.screenshot({ path: '/tmp/rich-git-collision-after.png' });
  await page.screenshot({ path: '/tmp/rich-polish-renderer.png', fullPage: false });
  assert.deepEqual(errors, [], `production renderer errors: ${errors.join(', ')}`);
  console.log('Production Rich Responses renderer: native Mermaid syntax validation, restored report/chart/table/gallery, legacy Markdown table, live artifact before completion, progress, compact preview and source/lightbox controls passed.');
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
