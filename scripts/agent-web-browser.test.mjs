// Real headless browser; all application HTTP transport is a fixture. No
// external page, private service, or model is contacted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'native-web-browser-'));
process.env.LOCAL_AI_RUNTIME_ROOT = root;
await mkdir(join(root, 'logs'));
const require = createRequire(import.meta.url), http = require('node:http');
const original = http.request;
let session, fixtureBrowser; const destinations = [];
try {
  http.request = (url, options, callback) => {
    destinations.push(url.toString()); assert.equal(url.hostname, '8.8.8.8'); assert.equal(options.method, 'GET');
    const request = new EventEmitter(); request.setTimeout = () => request;
    request.destroy = error => { request.emit('error', error); request.emit('close'); };
    request.end = () => {
      const redirect = url.pathname === '/redirect-private';
      const response = Object.assign(new PassThrough(), { statusCode: redirect ? 302 : 200, headers: redirect ? { location: 'http://127.0.0.1:1/private' } : { 'content-type': 'text/html' } });
      callback(response);
      response.end(redirect ? '' : `<html><head><title>Public fixture ${url.pathname}</title></head><body><main><h1>Fixture page</h1><p>Readable content</p><a href="http://8.8.8.8/next">Next</a><p id="rtc"></p><script>document.getElementById("rtc").textContent="RTC: " + typeof RTCPeerConnection;</script></main></body></html>`);
    }; return request;
  };
  const { WebBrowserService } = require('../dist/main/web/web-tools.js');
  session = await new WebBrowserService({ name: 'fixture', search: async (_page, query) => [{ title: query, url: 'http://8.8.8.8/page', snippet: 'Fixture result' }] }).openSession();
  const execute = async (name, args = {}) => JSON.parse(await session.execute({ name, arguments: args }));
  assert.equal((await execute('web_search', { query: 'fixture' })).results.length, 1);
  const opened = await execute('web_open', { url: 'http://8.8.8.8/page' });
  assert.match(opened.content, /Readable content/); assert.match(opened.content, /RTC: undefined/);
  const read = await execute('web_read'); assert.equal(read.links.length, 1);
  assert.match((await execute('web_follow_link', { link_id: read.links[0].id })).url, /next$/);
  assert.match((await execute('web_back')).url, /page$/);
  const before = destinations.length;
  for (const url of ['http://127.0.0.1:1/private', 'http://192.168.1.1', 'file:///etc/passwd', 'http://example.ru']) {
    const result = await execute('web_open', { url }); assert(result.error || result.blocked_reason);
  }
  assert.equal(destinations.length, before, 'blocked destinations reached the HTTP transport');
  const redirect = await execute('web_open', { url: 'http://8.8.8.8/redirect-private' }); assert(redirect.error);
  assert(destinations.every(url => new URL(url).hostname === '8.8.8.8'));
  await session.close(); session = undefined;
  // Exercise provider HTML parsing in an actual browser DOM; every response
  // is intercepted locally, so this suite never depends on public providers.
  const { chromium } = await import('playwright-core');
  const { createSearchProvider } = require('../dist/main/web/search-providers.js');
  fixtureBrowser = await chromium.launch({ executablePath: process.env.LOCAL_AI_TEST_BROWSER ?? '/usr/bin/google-chrome', headless: true });
  const fixtureContext = await fixtureBrowser.newContext({ javaScriptEnabled: false });
  const providerPage = await fixtureContext.newPage(); let mode = 'preferred'; const providerRequests = [];
  await fixtureContext.route('**/*', async route => {
    const host = new URL(route.request().url()).hostname; providerRequests.push(host);
    assert(['html.duckduckgo.com', 'lite.duckduckgo.com', 'www.bing.com'].includes(host), 'unexpected fixture destination');
    if (host === 'www.bing.com' || mode === 'all-failed' || (mode === 'fallback' && host === 'html.duckduckgo.com')) return route.fulfill({ status: 503, body: 'Unavailable' });
    if (mode === 'challenge') return route.fulfill({ contentType: 'text/html', body: '<body>CAPTCHA: verify you are human</body>' });
    const html = host === 'lite.duckduckgo.com'
      ? '<table><tr><td><a class="result-link" href="http://8.8.8.8/gpu">GPU fixture</a></td></tr><tr><td class="result-snippet">Verified fixture snippet</td></tr></table>'
      : '<div class="result"><a class="result__a" href="http://8.8.8.8/gpu">GPU fixture</a><span class="result__snippet">Verified fixture snippet</span></div>';
    await route.fulfill({ contentType: 'text/html', body: `<html><body>${html}</body></html>` });
  });
  for (const current of ['preferred', 'fallback']) {
    mode = current; const provider = createSearchProvider({});
    assert.deepEqual(await provider.search(providerPage, 'GPU fixture', 3), [{ title: 'GPU fixture', url: 'http://8.8.8.8/gpu', snippet: 'Verified fixture snippet' }]);
    assert.equal(provider.diagnostics.used, current === 'preferred' ? 'DuckDuckGo' : 'DuckDuckGo Lite');
    assert.equal(provider.diagnostics.fallback, current === 'fallback');
  }
  assert(!providerRequests.includes('www.bing.com'), 'default requires Bing');
  mode = 'preferred'; const bingUnavailable = createSearchProvider({ searchProvider: 'bing' });
  assert.equal((await bingUnavailable.search(providerPage, 'GPU fixture', 3)).length, 1); assert.equal(bingUnavailable.diagnostics.used, 'DuckDuckGo');
  mode = 'all-failed'; await assert.rejects(createSearchProvider({}).search(providerPage, 'GPU fixture', 3), /No search provider/);
  mode = 'challenge'; const beforeChallenge = providerRequests.length;
  await assert.rejects(createSearchProvider({}).search(providerPage, 'GPU fixture', 3), /No search provider/);
  assert.equal(providerRequests.length, beforeChallenge + 1, 'CAPTCHA attempted an alternate DuckDuckGo endpoint');
  await fixtureBrowser.close(); fixtureBrowser = undefined;
  console.log('Native browser tools: search/open/read/follow/back, structured results, private URL and redirect blocking, teardown passed (fixture transport; no Internet)');
  console.log('Real browser provider parsing: preferred DuckDuckGo, Lite fallback, optional Bing failure, all-failed and no CAPTCHA evasion passed (fixture HTML; no Internet)');
} finally { await session?.close(); await fixtureBrowser?.close(); http.request = original; await rm(root, { recursive: true, force: true }); }
