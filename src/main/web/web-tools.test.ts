import assert from 'node:assert/strict';
import { ArtifactToolError, validateRichArtifact, validatePersistedRichArtifact } from '../../shared/rich-artifacts';
import { WebBrowserSession, type SearchProvider } from './web-tools';
import type { ImageSearchProvider } from './search-providers';

function publicUrl(raw: string) { return { url: new URL(raw), address: '93.184.216.34', family: 4 }; }

function fakeSession(options: { imageProvider?: ImageSearchProvider; allowBing?: boolean; bingFails?: boolean; bingStatus?: number; bingResults?: unknown[]; failImages?: string[]; fallbackResults?: Array<{ title: string; url: string; snippet: string }> }) {
  let current = 'https://www.bing.com/images/search'; let navigation = 0;
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    goto: async (url: string) => { navigation += 1; if (url.includes('bing.com/images') && options.bingFails) throw new Error('net::ERR_CONNECTION_RESET'); current = url; const status = url.includes('bing.com/images') ? options.bingStatus ?? 200 : 200; return { ok: () => status < 400, status: () => status, statusText: () => status === 503 ? 'Service Unavailable' : 'Bad Gateway' }; },
    url: () => current,
    locator: (selector: string) => {
      const locator = {
        evaluateAll: async (callback: (nodes: Array<{ getAttribute: (name: string) => string | null }>) => unknown) => callback(selector === 'a.iusc' ? (options.bingResults ?? []).map((value) => ({ getAttribute: (name: string) => name === 'm' ? JSON.stringify(value) : null })) : []),
        first: () => locator,
        getAttribute: async (name: string) => {
          if (name !== 'content') return null;
          if (selector.includes('og:image')) return current.includes('other') ? 'https://cdn.example.test/other.webp' : 'https://cdn.example.test/flower.webp';
          if (selector.includes('og:title')) return 'Flower photograph';
          if (selector.includes('og:description')) return 'A photographed flower.';
          return null;
        },
      };
      return locator;
    },
  };
  const context = { newPage: async () => page, close: async () => undefined };
  const browser = { close: async () => undefined };
  const provider: SearchProvider = { name: 'Fixture Search', search: async () => options.fallbackResults ?? [] };
  const checkedUrls: string[] = [];
  return { session: new WebBrowserSession(browser as never, context as never, provider, undefined, async (raw) => { checkedUrls.push(String(raw)); return publicUrl(String(raw)); }, { load: async (url) => { if (options.failImages?.includes(url)) throw new Error('Image HTTP 403'); return { mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,fixture' }; } }, options.allowBing === true, options.imageProvider), getNavigationCount: () => navigation, checkedUrls };
}

export async function runWebImageSearchReliabilityRegression(): Promise<void> {
  const broken: string[] = [];
  const multi = fakeSession({ failImages: broken, imageProvider: { name: 'Wikimedia fixture', search: async query => Array.from({ length: 3 }, (_, index) => ({ image: `https://cdn.example.test/${query}-${index}.jpg`, sourceUrl: `https://commons.wikimedia.org/wiki/File:${query}-${index}.jpg`, title: query, alt: query })) } });
  const chosen: string[] = [];
  for (const color of ['white', 'pink', 'red', 'yellow']) {
    const result = JSON.parse(await multi.session.execute({ name: 'web_image_search', arguments: { query: color, max_results: 3 } }));
    assert.equal(result.results.length, 3); assert.equal(result.gallery_created, false); chosen.push(result.results[0].discovery_id);
  }
  assert.equal(multi.session.getImageResults().size, 12);
  const shape = { version: 1, type: 'image_gallery', summary: 'Licenses not verified.', images: chosen.map(discovery_id => ({ discovery_id })) };
  const valid = validateRichArtifact(shape, multi.session.getImageResults());
  assert(valid.artifact?.type === 'image_gallery'); assert.equal(valid.artifact.images.length, 4);
  await multi.session.verifyGalleryImages(valid.artifact, new AbortController().signal);
  assert.deepEqual(validatePersistedRichArtifact(valid.artifact).artifact, valid.artifact);
  broken.push(valid.artifact.images[0].url);
  await assert.rejects(multi.session.verifyGalleryImages(valid.artifact, new AbortController().signal), error => error instanceof ArtifactToolError && error.result.code === 'IMAGE_RETRIEVAL_FAILED');
  assert.equal(multi.session.getImageResults().size, 12, 'failed gallery consumed IDs');
  const replacement = [...multi.session.getImageResults().values()].find(image => image.title === 'white' && image.id !== chosen[0])!;
  const replaced = validateRichArtifact({ ...shape, images: [{ discovery_id: replacement.id }, ...shape.images.slice(1)] }, multi.session.getImageResults());
  assert(replaced.artifact?.type === 'image_gallery'); await multi.session.verifyGalleryImages(replaced.artifact, new AbortController().signal);
  const invalidId = validateRichArtifact({ ...shape, images: [{ discovery_id: 'unrelated-session' }] }, multi.session.getImageResults());
  assert(invalidId.error); assert.equal(invalidId.code, 'INVALID_DISCOVERY_ID'); assert.equal(invalidId.validDiscoveryIds?.length, 12);
  const limited = validateRichArtifact({ ...shape, images: Array(9).fill(shape.images[0]) }, multi.session.getImageResults()); assert(limited.error); assert.equal(limited.code, 'GALLERY_ITEM_LIMIT'); assert.equal(limited.received, 9);
  const badShape = validateRichArtifact({ ...shape, layout: '2x2' }, multi.session.getImageResults()); assert(badShape.error); assert.equal(badShape.code, 'ARTIFACT_SCHEMA_INVALID'); assert.match(badShape.error ?? '', /layout/);

  const badLimit = JSON.parse(await multi.session.execute({ name: 'web_image_search', arguments: { query: 'white', max_results: 9 } })); assert.equal(badLimit.code, 'IMAGE_SEARCH_RESULT_LIMIT');
  let exhausted: { code?: string } = {};
  for (let index = 0; index < 45; index++) { exhausted = JSON.parse(await multi.session.execute({ name: 'web_image_search', arguments: { query: `extra-${index}`, max_results: 3 } })); if (exhausted.code) break; }
  assert.match(exhausted.code ?? '', /IMAGE_FETCH_BUDGET_EXHAUSTED|IMAGE_DISCOVERY_CAPACITY_EXCEEDED/);
  assert(multi.session.getImageResults().size <= 128); assert(chosen.every(id => multi.session.getImageResults().has(id)), 'capacity handling silently expired issued IDs');

  const fallback = fakeSession({ allowBing: true, bingStatus: 503, fallbackResults: [{ title: 'Peony page', url: 'https://flowers.example.test/peonies', snippet: 'Peony photos' }] });
  const recovered = JSON.parse(await fallback.session.execute({ name: 'web_image_search', arguments: { query: 'peony photographs', max_results: 4 } }));
  assert.equal(recovered.status, 'ok', `provider error did not invoke safe source-page fallback: ${JSON.stringify(recovered)}`);
  assert(recovered.issues.some((issue: { error: string }) => issue.error === 'Bing Images HTTP 503 Service Unavailable'), 'Bing HTTP error was not diagnosed');
  assert.equal(recovered.providers[0].provider, 'Fixture Search / page metadata', 'Bing must not be the primary dependency');
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.results[0].url, 'https://cdn.example.test/flower.webp');
  assert.equal(recovered.results[0].sourceUrl, 'https://flowers.example.test/peonies');
  assert.match(recovered.results[0].discovery_id, /^[0-9a-f-]{36}$/i, 'fallback result lacks an actual session discovery ID');
  assert.equal(fallback.session.getImageResults().has(recovered.results[0].discovery_id), true, 'fallback image was not registered for artifact validation');
  assert(fallback.getNavigationCount() >= 2, 'fallback did not navigate to the source page');

  const empty = fakeSession({ allowBing: true, bingFails: true });
  const unavailable = JSON.parse(await empty.session.execute({ name: 'web_image_search', arguments: { query: 'peony' } }));
  assert.equal(unavailable.status, 'provider_error_or_no_usable_results');
  assert(unavailable.providers.some((provider: { status: string }) => provider.status === 'error'));
  assert.equal(unavailable.results.length, 0);
  assert.match(unavailable.message, /do not invent image URLs/i, 'empty search did not tell the model how to recover safely');


  const replacements = fakeSession({ failImages: ['https://cdn.example.test/flower.webp'], fallbackResults: [
    { title: 'Broken photo', url: 'https://flowers.example.test/peony', snippet: '' },
    { title: 'Usable alternative', url: 'https://flowers.example.test/other', snippet: '' },
  ] });
  const partial = JSON.parse(await replacements.session.execute({ name: 'web_image_search', arguments: { query: 'peonies', max_results: 1 } }));
  assert.equal(partial.status, 'ok'); assert.equal(partial.rejected_candidates, 1);
  assert.equal(partial.results[0].url, 'https://cdn.example.test/other.webp');
  assert.equal(partial.results[0].retrieval_status, 'ready');
  assert.equal(replacements.session.getImageResults().size, 1, 'broken image was registered as ready');

  const noBing = fakeSession({ bingResults: [{ murl: 'https://cdn.example.test/real.jpg', purl: 'https://garden.example.test/photo' }] });
  const disabled = JSON.parse(await noBing.session.execute({ name: 'web_image_search', arguments: { query: 'flower' } }));
  assert.equal(disabled.results.length, 0); assert.equal(noBing.getNavigationCount(), 0, 'Bing was used without opt-in');
  const bing = fakeSession({ allowBing: true, bingResults: [{ murl: 'https://cdn.example.test/real.jpg', purl: 'https://garden.example.test/photo', t: 'Real result', desc: 'Flower in a garden' }] });
  const parsed = JSON.parse(await bing.session.execute({ name: 'web_image_search', arguments: { query: 'flower' } }));
  assert.equal(parsed.results.length, 1, `Bing iusc result metadata was not parsed: ${JSON.stringify({ parsed, checkedUrls: bing.checkedUrls })}`);
  assert.equal(parsed.results[0].sourceUrl, 'https://garden.example.test/photo');
  const independent = fakeSession({ failImages: ['https://upload.wikimedia.org/broken.jpg'], imageProvider: { name: 'Wikimedia Commons', search: async () => [
    { image: 'https://upload.wikimedia.org/broken.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Broken.jpg', title: 'Broken', alt: 'Broken' },
    { image: 'https://upload.wikimedia.org/ready.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Ready.jpg', title: 'Peony', alt: 'Peony photograph' },
  ] } });
  const rescued = JSON.parse(await independent.session.execute({ name: 'web_image_search', arguments: { query: 'peonies', max_results: 1 } }));
  assert.equal(rescued.results.length, 1); assert.equal(rescued.results[0].retrieval_status, 'ready'); assert.equal(rescued.rejected_candidates, 1);
  assert.equal(rescued.results[0].sourceUrl, 'https://commons.wikimedia.org/wiki/File:Ready.jpg');
  assert.equal(independent.getNavigationCount(), 0); assert(independent.checkedUrls.includes(rescued.results[0].url));
  const badProvider = fakeSession({ imageProvider: { name: 'Wikimedia Commons', search: async () => { throw new Error('secret-key=private'); } } });
  const badResult = await badProvider.session.execute({ name: 'web_image_search', arguments: { query: 'flower' } });
  assert(!badResult.includes('secret-key')); assert.match(badResult, /network_or_provider_error/);
  await independent.session.close();
  const cancelled = JSON.parse(await independent.session.execute({ name: 'web_image_search', arguments: { query: 'peonies' } }));
  assert(cancelled.error);
}

if (require.main === module) void runWebImageSearchReliabilityRegression().catch((error) => { console.error(error); process.exitCode = 1; });
