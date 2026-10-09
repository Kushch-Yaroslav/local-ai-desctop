import type { Page } from 'playwright-core';
import type { RuntimeConfiguration } from '../../shared/types';
import { fetchPublicResource, publicWebUserAgent } from './public-network';
export type SearchResult = { title: string; url: string; snippet: string };
const pageTimeoutMs = 8_000;

export interface SearchProvider {
  readonly name: string;
  readonly diagnostics?: SearchDiagnostics;
  search(page: Page, query: string, limit: number): Promise<SearchResult[]>;
}

/** Bing is used as a replaceable provider; strict SafeSearch is encoded in its URL. */
export class BingSearchProvider implements SearchProvider {
  readonly name = 'Bing';
  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?${new URLSearchParams({ q: query, adlt: 'strict', setlang: 'ru' })}`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    if (response && !response.ok()) throw new Error(`${this.name} HTTP ${response.status()} ${response.statusText()}`);
    const body = (await page.locator('body').innerText({ timeout: 3_000 })).toLowerCase();
    if (body.includes('captcha') || body.includes('unusual traffic') || body.includes('verify you are human') || body.includes('bots use duckduckgo') || body.includes('anomaly-modal')) throw new Error('Поисковый провайдер запросил CAPTCHA или временно заблокировал запрос');
    return page.locator('li.b_algo').evaluateAll((nodes, maximum) => nodes.slice(0, maximum).map((node) => {
      const link = node.querySelector('h2 a') as HTMLAnchorElement | null;
      const snippet = node.querySelector('.b_caption p, p')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return link ? { title: link.textContent?.replace(/\s+/g, ' ').trim() ?? '', url: link.href, snippet } : null;
    }).filter((item): item is { title: string; url: string; snippet: string } => Boolean(item?.url)), limit);
  }
}

/** Default provider: DuckDuckGo supplies clean public results without a personal account. */
export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly name = 'DuckDuckGo';

  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query, kp: '1' })}`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    if (response && !response.ok()) throw new Error(`${this.name} HTTP ${response.status()} ${response.statusText()}`);
    const body = (await page.locator('body').innerText({ timeout: 3_000 })).toLowerCase();
    if (body.includes('captcha') || body.includes('unusual traffic') || body.includes('verify you are human') || body.includes('bots use duckduckgo') || body.includes('anomaly-modal')) throw new Error('Поисковый провайдер запросил CAPTCHA или временно заблокировал запрос');
    return page.locator('.result').evaluateAll((nodes, maximum) => nodes.slice(0, maximum).map((node) => {
      const link = node.querySelector('.result__a') as HTMLAnchorElement | null;
      const snippet = node.querySelector('.result__snippet')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return link ? { title: link.textContent?.replace(/\s+/g, ' ').trim() ?? '', url: link.href, snippet } : null;
    }).filter((item): item is { title: string; url: string; snippet: string } => Boolean(item?.url)), limit);
  }
}


export type SearchDiagnostics = { preferred: string; used?: string; fallback: boolean; durationMs: number; attempts: Array<{ provider: string; category: string; durationMs: number }> };

/** Alternative public document endpoint, not a CAPTCHA workaround. */
export class DuckDuckGoLiteSearchProvider implements SearchProvider {
  readonly name = 'DuckDuckGo Lite';
  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const response = await page.goto(`https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query, kp: '1' })}`, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    if (response && !response.ok()) throw new Error(`HTTP ${response.status()}`);
    const body = (await page.locator('body').innerText({ timeout: 3000 })).toLowerCase();
    if (/captcha|unusual traffic|verify you are human|anomaly-modal|bots use duckduckgo/.test(body)) throw new Error('CAPTCHA challenge');
    return page.locator('a.result-link').evaluateAll((nodes, maximum) => nodes.slice(0, maximum).map((node) => {
      const link = node as HTMLAnchorElement;
      const row = link.closest('tr');
      const snippet = row?.nextElementSibling?.querySelector('.result-snippet')?.textContent?.trim() ?? '';
      return { title: link.textContent?.trim() ?? '', url: link.href, snippet };
    }), limit);
  }
}

function errorCategory(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (/captcha|challenge|unusual traffic|verify.*human|заблокировал/i.test(text)) return 'challenge';
  if (/timeout|timed out/i.test(text)) return 'timeout';
  if (/HTTP\s+[45]\d\d/i.test(text)) return 'http_error';
  if (/closed|abort|cancel/i.test(text)) return 'cancelled';
  return 'network_or_provider_error';
}

/** Finite, auditable fallback. Never logs queries, URLs, credentials or raw provider exceptions. */
export class FallbackSearchProvider implements SearchProvider {
  readonly name: string;
  private challengedDuckDuckGo = false;
  diagnostics?: SearchDiagnostics;
  constructor(private readonly providers: SearchProvider[], preferred = 'Automatic') { this.name = preferred; }
  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const started = performance.now(); const attempts: SearchDiagnostics['attempts'] = [];
    this.diagnostics = { preferred: this.name, fallback: false, durationMs: 0, attempts };
    for (const provider of this.providers) {
      if (page.isClosed() || performance.now() - started >= 25_000) break;
      if (this.challengedDuckDuckGo && provider.name.startsWith('DuckDuckGo')) { attempts.push({ provider: provider.name, category: 'challenge_cached', durationMs: 0 }); continue; }
      const attemptStarted = performance.now();
      try {
        const result = await provider.search(page, query, limit);
        attempts.push({ provider: provider.name, category: result.length ? 'ok' : 'empty', durationMs: Math.round(performance.now() - attemptStarted) });
        if (!result.length) continue;
        this.diagnostics = { preferred: this.name, used: provider.name, fallback: provider !== this.providers[0], durationMs: Math.round(performance.now() - started), attempts };
        return result.slice(0, limit);
      } catch (error) {
        const category = errorCategory(error); attempts.push({ provider: provider.name, category, durationMs: Math.round(performance.now() - attemptStarted) });
        if (category === 'challenge' && provider.name.startsWith('DuckDuckGo')) this.challengedDuckDuckGo = true;
        if (category === 'cancelled') break;
      }
    }
    this.diagnostics = { preferred: this.name, fallback: attempts.filter(attempt => attempt.category !== 'challenge_cached').length > 1, durationMs: Math.round(performance.now() - started), attempts };
    throw new Error('No search provider returned usable results. Retry later or change search settings.');
  }
}

export function createSearchProvider(config: Pick<RuntimeConfiguration, 'searchProvider' | 'allowBingFallback'>): FallbackSearchProvider {
  const ddg = [new DuckDuckGoSearchProvider(), new DuckDuckGoLiteSearchProvider()];
  const providers = config.searchProvider === 'bing' ? [new BingSearchProvider(), ...ddg] : [...ddg, ...(config.allowBingFallback ? [new BingSearchProvider()] : [])];
  return new FallbackSearchProvider(providers, config.searchProvider === 'bing' ? 'Bing' : config.searchProvider === 'duckduckgo' ? 'DuckDuckGo' : 'Automatic');
}

export type ImageCandidate = { image: string; sourceUrl: string; title: string; alt: string };
export interface ImageSearchProvider {
  readonly name: string;
  search(query: string, limit: number, signal: AbortSignal): Promise<ImageCandidate[]>;
}

/** Independent no-key image fallback using Commons' JSON API, not search HTML.
 * Results are candidates only; the session must verify each through its image proxy.
 * No assertion about licensing is inferred from a Commons URL. */
export class WikimediaImageSearchProvider implements ImageSearchProvider {
  readonly name = 'Wikimedia Commons';
  constructor(private readonly fetchResource: typeof fetchPublicResource = fetchPublicResource) {}
  async search(query: string, limit: number, signal: AbortSignal): Promise<ImageCandidate[]> {
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.search = new URLSearchParams({ action: 'query', generator: 'search', gsrnamespace: '6',
      gsrsearch: query, gsrlimit: String(Math.max(1, Math.min(16, limit))), prop: 'imageinfo',
      iiprop: 'url|mime', iiurlwidth: '800', format: 'json' }).toString();
    const response = await this.fetchResource(url.href, 'GET', { accept: 'application/json', 'user-agent': publicWebUserAgent }, signal, 512 * 1024);
    if (response.status !== 200) throw new Error(`Wikimedia Commons HTTP ${response.status}`);
    if (!response.headers['content-type']?.toLowerCase().includes('application/json') || response.body.length > 512 * 1024) throw new Error('Wikimedia Commons returned an invalid or oversized JSON response');
    const raw = JSON.parse(response.body.toString('utf8')) as { error?: unknown; query?: { pages?: Record<string, { title?: unknown; imageinfo?: Array<{ url?: unknown; thumburl?: unknown; descriptionurl?: unknown; mime?: unknown }> }> } };
    if (raw?.error || !raw || typeof raw !== 'object') throw new Error('Wikimedia Commons API could not complete the search');
    return Object.values(raw.query?.pages ?? {}).flatMap((page) => {
      const info = page?.imageinfo?.[0];
      if (!info || !['image/png', 'image/jpeg', 'image/webp'].includes(String(info.mime))) return [];
      const image = info.thumburl ?? info.url;
      if (typeof image !== 'string' || typeof info.descriptionurl !== 'string' || typeof page.title !== 'string') return [];
      const title = page.title.replace(/^File:/, '').slice(0, 200);
      return [{ image, sourceUrl: info.descriptionurl, title, alt: title }];
    }).slice(0, Math.max(1, Math.min(16, limit)));
  }
}
