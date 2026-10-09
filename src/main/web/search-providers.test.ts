import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchProvider, DuckDuckGoLiteSearchProvider, FallbackSearchProvider, WikimediaImageSearchProvider, type SearchProvider } from './search-providers';
import { loadRuntimeConfiguration, normalizeConfiguration, saveRuntimeConfiguration } from '../services/runtime-settings';

async function run() {
  const result = [{ title: 'Fixture', url: 'https://public.example.test/', snippet: 'Observed data' }];
  const page = { isClosed: () => false } as never;
  let calls = 0;
  const okay: SearchProvider = { name: 'Fixture', search: async () => { calls++; return result; } };
  const failed: SearchProvider = { name: 'Preferred', search: async () => { throw new Error('HTTP 503 key=SECRET-CREDENTIAL query=private'); } };
  const preferred = new FallbackSearchProvider([okay, failed], 'Fixture');
  assert.deepEqual(await preferred.search(page, 'test', 4), result);
  assert.equal(preferred.diagnostics?.fallback, false); assert.equal(calls, 1);
  const fallback = new FallbackSearchProvider([failed, okay], 'Preferred');
  assert.deepEqual(await fallback.search(page, 'test', 4), result);
  assert.equal(fallback.diagnostics?.used, 'Fixture'); assert.equal(fallback.diagnostics?.fallback, true);
  assert.equal(fallback.diagnostics?.attempts[0].category, 'http_error');
  assert(!JSON.stringify(fallback.diagnostics).includes('SECRET-CREDENTIAL'));
  const allFailed = new FallbackSearchProvider([failed, { name: 'Empty', search: async () => [] }]);
  await assert.rejects(allFailed.search(page, 'test', 4), /No search provider/);
  assert.deepEqual(allFailed.diagnostics?.attempts.map(item => item.category), ['http_error', 'empty']);
  const challenge = new FallbackSearchProvider([{ name: 'DuckDuckGo', search: async () => { throw new Error('CAPTCHA'); } }, { name: 'DuckDuckGo Lite', search: async () => { throw new Error('should not bypass challenge'); } }, okay]);
  await challenge.search(page, 'test', 4); assert.deepEqual(challenge.diagnostics?.attempts.map(attempt => attempt.category), ['challenge', 'challenge_cached', 'ok']);
  await challenge.search(page, 'different query', 4); assert(challenge.diagnostics?.attempts.slice(0, 2).every(attempt => attempt.category === 'challenge_cached' && attempt.durationMs === 0));
  const litePage = { goto: async () => ({ ok: () => true }), locator: (selector: string) => ({ innerText: async () => 'Search results', evaluateAll: (fn: (nodes: unknown[], maximum: number) => unknown, max: number) => {
    assert.equal(selector, 'a.result-link');
    return fn([{ textContent: 'Page title', href: 'https://public.example.test/', closest: () => ({ nextElementSibling: { querySelector: () => ({ textContent: 'Snippet' }) } }) }], max);
  } }) } as never;
  assert.deepEqual(await new DuckDuckGoLiteSearchProvider().search(litePage, 'test', 4), [{ title: 'Page title', url: 'https://public.example.test/', snippet: 'Snippet' }]);
  // Default chain is no-key DuckDuckGo; Bing is opt-in. A challenge is not evaded.
  const unavailablePage = { isClosed: () => false, goto: async (url: string) => { assert(!url.includes('bing')); throw new Error('HTTP 503'); } } as never;
  await assert.rejects(createSearchProvider({}).search(unavailablePage, 'test', 4), /No search provider/);
  const bingPreference = createSearchProvider({ searchProvider: 'bing' });
  const providerPage = { isClosed: () => false, goto: async (url: string) => ({ ok: () => !url.includes('bing'), status: () => 503, statusText: () => 'Unavailable' }), locator: () => ({ innerText: async () => 'results', evaluateAll: async () => result }) } as never;
  assert.deepEqual(await bingPreference.search(providerPage, 'test', 4), result);
  assert.equal(bingPreference.diagnostics?.used, 'DuckDuckGo');
  const signal = new AbortController().signal;
  const images = new WikimediaImageSearchProvider(async (url, method, headers, usedSignal, maxBytes) => {
    assert.equal(new URL(url).hostname, 'commons.wikimedia.org'); assert.equal(new URL(url).searchParams.get('iiurlwidth'), '800');
    assert.equal(method, 'GET'); assert.equal(usedSignal, signal); assert.equal(maxBytes, 512 * 1024); assert.equal(headers.accept, 'application/json');
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ query: { pages: {
      '1': { title: 'File:Peony.jpg', imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/800px-Peony.jpg', url: 'https://upload.wikimedia.org/Peony.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Peony.jpg' }] },
      '2': { title: 'File:Unsafe.svg', imageinfo: [{ mime: 'image/svg+xml', url: 'https://upload.wikimedia.org/Unsafe.svg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Unsafe.svg' }] },
      '3': { title: 'Missing', imageinfo: [] },
    } } })) };
  });
  assert.deepEqual(await images.search('peony', 4, signal), [{ image: 'https://upload.wikimedia.org/800px-Peony.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Peony.jpg', title: 'Peony.jpg', alt: 'Peony.jpg' }]);
  for (const response of [
    { status: 503, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') },
    { status: 302, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') },
    { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>challenge</html>') },
    { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{invalid') },
    { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":{"code":"badrequest"}}') },
    { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(512 * 1024 + 1) },
  ]) await assert.rejects(new WikimediaImageSearchProvider(async () => response).search('peony', 4, signal));
  const folder = mkdtempSync(join(tmpdir(), 'search-settings-'));
  try {
    const raw = { schemaVersion: 2, llamaServerPath: null, modelsPath: folder, gpuLayers: 999, models: [], language: 'ru' };
    const migrated = normalizeConfiguration(raw); assert.equal(migrated.searchProvider, 'auto'); assert.equal(migrated.allowBingFallback, false);
    assert.throws(() => normalizeConfiguration({ ...raw, searchProvider: 'google' }), /Google.*недоступен/);
    const file = join(folder, 'settings.json');
    saveRuntimeConfiguration({ ...migrated, searchProvider: 'bing', allowBingFallback: true }, file);
    assert.equal(loadRuntimeConfiguration(file).searchProvider, 'bing'); assert.equal(loadRuntimeConfiguration(file).allowBingFallback, true);
    assert.equal(loadRuntimeConfiguration(file).language, 'ru');
  } finally { rmSync(folder, { recursive: true, force: true }); }
  console.log('Search providers: preferred/fallback/all-failed, no mandatory Bing, no CAPTCHA evasion, diagnostics redaction, Lite parsing and settings migration/persistence passed.');
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
