import { RemoteImageService } from '../services/remote-image-service';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { fetchPublicResource, publicDestination } from './public-network';
import { log } from '../services/logger';
import type { ProjectToolCall, ProjectToolDefinition } from '../tools/project-tools';
import { ArtifactToolError, type DiscoveredImage, type RichArtifact } from '../../shared/rich-artifacts';
export const MAX_SESSION_IMAGE_DISCOVERIES = 128;
export const MAX_SESSION_IMAGE_FETCHES = 128;

const browserCandidates = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const pageTimeoutMs = 15_000;
const maxPageChars = 12_000;
const maxLinks = 40;

import { createSearchProvider, WikimediaImageSearchProvider, type ImageSearchProvider, type SearchProvider, type SearchResult } from './search-providers';
import { effectiveRuntimeConfiguration } from '../services/runtime-settings';
export { BingSearchProvider, DuckDuckGoSearchProvider, DuckDuckGoLiteSearchProvider, FallbackSearchProvider, type SearchProvider } from './search-providers';
type PageSnapshot = { title: string; url: string; content: string; links: Array<{ id: number; text: string; href: string }>; truncated: boolean };

export const webToolDefinitions: ProjectToolDefinition[] = [
  { type: 'function', function: { name: 'web_search', description: 'Ищет актуальную информацию в интернете. Возвращает title, URL и snippet; затем открой подходящий результат через web_open.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Поисковый запрос.' }, max_results: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_image_search', description: 'Ищет реальные публичные изображения. Возвращает discovery_id, image URL и страницу источника. Для галереи передавай только discovery_id из результата; не выдумывай ссылки.', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_open', description: 'Открывает URL в изолированном read-only headless browser и возвращает очищенный читаемый текст страницы и ссылки.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_read', description: 'Повторно читает текущую открытую страницу, включая компактный список ссылок с ID.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_follow_link', description: 'Переходит по ссылке из текущей страницы. Передай link_id из web_read или явный href.', parameters: { type: 'object', properties: { link_id: { type: 'integer', minimum: 1 }, href: { type: 'string' } } } } },
  { type: 'function', function: { name: 'web_back', description: 'Возвращается к предыдущей странице текущей изолированной web-сессии.', parameters: { type: 'object', properties: {} } } },
];

export function activityForWebTool(call: ProjectToolCall): { label: string; detail?: string } {
  if (call.name === 'web_search' || call.name === 'web_image_search') return { label: call.name === 'web_image_search' ? 'Поиск изображений' : 'Поиск в интернете', detail: String(call.arguments.query ?? '') };
  if (call.name === 'web_open') return { label: 'Открытие веб-страницы', detail: String(call.arguments.url ?? '') };
  if (call.name === 'web_read') return { label: 'Чтение веб-страницы' };
  if (call.name === 'web_follow_link') return { label: 'Переход по ссылке', detail: String(call.arguments.href ?? call.arguments.link_id ?? '') };
  if (call.name === 'web_back') return { label: 'Возврат к предыдущей странице' };
  return { label: 'Web-инструмент' };
}

type PolicyBlock = 'adult content' | 'gambling' | 'malicious/phishing' | 'ru_domain';
const adultHosts = ['pornhub.com', 'xvideos.com', 'xnxx.com', 'redtube.com', 'youporn.com', 'onlyfans.com'];
const gamblingHosts = ['bet365.com', '1xbet.com', 'betway.com', 'pokerstars.com', 'draftkings.com', 'fanduel.com', 'stake.com'];
const maliciousHosts = ['malware.test', 'phishing.test', 'example-phishing.test'];

function policyBlock(urlText: string): PolicyBlock | null {
  let url: URL;
  try { url = new URL(urlText); } catch { return 'malicious/phishing'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'malicious/phishing';
  const host = url.hostname.toLowerCase(); const value = `${host}${url.pathname}`.toLowerCase();
  if (host === 'ru' || host.endsWith('.ru')) return 'ru_domain';
  const matches = (items: string[]) => items.some((item) => host === item || host.endsWith(`.${item}`));
  if (matches(adultHosts) || /(^|[./_-])(porn|xxx|sexcam|hentai)([./_-]|$)/.test(value)) return 'adult content';
  if (matches(gamblingHosts) || /(^|[./_-])(casino|sportsbook|bookmaker|betting|slots)([./_-]|$)/.test(value)) return 'gambling';
  if (matches(maliciousHosts) || /(^|[./_-])(phishing|malware|credential-stealer|ransomware|keylogger)([./_-]|$)/.test(value)) return 'malicious/phishing';
  return null;
}

function contentBlock(snapshot: PageSnapshot): PolicyBlock | null {
  const sample = `${snapshot.title}\n${snapshot.content.slice(0, 4000)}`.toLowerCase();
  if (/\b(pornhub|xvideos|live sex|adult webcam|explicit porn)\b/.test(sample)) return 'adult content';
  if (/\b(online casino|sportsbook|place a bet|casino slots)\b/.test(sample)) return 'gambling';
  if (/\b(enter your password|seed phrase|wallet recovery|verify your credentials)\b/.test(sample)) return 'malicious/phishing';
  return null;
}

const diagnosticOutputLimit = 20_000;
function diagnosticOutput(value: string): string { return value.length <= diagnosticOutputLimit ? value : `${value.slice(0, diagnosticOutputLimit)}\n[diagnostic output truncated]`; }
function toolError(message: string, details?: string | Record<string, unknown>): string { return JSON.stringify({ error: message, ...(details ? typeof details === 'string' ? { details: diagnosticOutput(details) } : details : {}) }); }
function blocked(kind: PolicyBlock): string {
  if (kind === 'ru_domain') return JSON.stringify({ blocked_reason: 'ru_domain', message: 'Access to .ru domains is disabled by local web policy.' });
  return toolError(`Blocked by web policy: ${kind}`);
}
function safeUrl(input: unknown): string | null { try { const url = new URL(String(input)); return url.toString(); } catch { return null; } }
function destinationUrl(raw: string): string {
  try {
    const url = new URL(raw); const direct = url.searchParams.get('uddg'); if (direct && /^https?:\/\//i.test(direct)) return direct;
    const encoded = url.hostname.endsWith('bing.com') ? url.searchParams.get('u') : null;
    if (!encoded?.startsWith('a1')) return raw;
    const decoded = Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : raw;
  } catch { return raw; }
}

async function chromeExecutable(): Promise<string> {
  for (const candidate of browserCandidates) { try { await access(candidate); return candidate; } catch { /* Try the next supported binary. */ } }
  throw new Error('Google Chrome/Chromium не найден. Установите браузер или включите web позже.');
}

async function snapshot(page: Page): Promise<PageSnapshot> {
  return page.evaluate(({ maximum, linkLimit }) => {
    for (const selector of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '.advertisement', '.ads', '.cookie', '.modal']) document.querySelectorAll(selector).forEach((node) => node.remove());
    const root = document.querySelector('main, article, [role="main"]') ?? document.body;
    const text = (root.textContent ?? '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    const links: Array<{ id: number; text: string; href: string }> = []; const seen = new Set<string>();
    for (const anchor of Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      const href = anchor.href; const label = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!href || !label || href.startsWith('javascript:') || href.startsWith('mailto:') || seen.has(href)) continue;
      seen.add(href); links.push({ id: links.length + 1, text: label.slice(0, 160), href }); if (links.length >= linkLimit) break;
    }
    return { title: document.title, url: location.href, content: text.slice(0, maximum), links, truncated: text.length > maximum };
  }, { maximum: maxPageChars, linkLimit: maxLinks });
}

export class WebBrowserSession {
  private page: Page | null = null;
  private lastSnapshot: PageSnapshot | null = null;
  private readonly discoveredImages = new Map<string, DiscoveredImage>();
  private imageFetches = 0;
  private readonly knownSources = new Set<string>();
  constructor(private readonly browser: Browser, private readonly context: BrowserContext, private readonly searchProvider: SearchProvider, private readonly abort: AbortController = new AbortController(), private readonly validatePublicDestination: typeof publicDestination = publicDestination, private readonly imageLoader: Pick<RemoteImageService, 'load'> & Partial<Pick<RemoteImageService, 'hasCached'>> = new RemoteImageService(), private readonly allowBingImages = false, private readonly imageProvider?: ImageSearchProvider) {}

  getImageResults(): ReadonlyMap<string, DiscoveredImage> { return this.discoveredImages; }
  getKnownSources(): ReadonlySet<string> { return this.knownSources; }

  async verifyGalleryImages(artifact: Extract<RichArtifact, { type: 'image_gallery' }>, signal: AbortSignal): Promise<void> {
    for (const [index, image] of artifact.images.entries()) {
      if (signal.aborted || this.abort.signal.aborted) throw new Error('Web request cancelled');
      if (!this.imageLoader.hasCached?.(image.url)) {
        if (this.imageFetches >= MAX_SESSION_IMAGE_FETCHES) throw new ArtifactToolError({ accepted: false, code: 'IMAGE_FETCH_BUDGET_EXHAUSTED', retrySameArguments: false, error: 'Request image fetch budget exhausted. This selected preview is not cached; existing IDs have not expired. Start a new request to fetch it.' });
        this.imageFetches += 1;
      }
      try { await this.imageLoader.load(image.url, signal); }
      catch { throw new ArtifactToolError({ accepted: false, code: 'IMAGE_RETRIEVAL_FAILED', stage: 'retrieval', field: `images[${index}].discovery_id`, discovery_id: image.discoveryId, retrySameArguments: false, error: `Selected image ${index + 1} could not be retrieved. Replace this ID with another verified discovery ID; other IDs remain usable. No gallery was emitted.` }); }
    }
  }

  async execute(call: ProjectToolCall): Promise<string> {
    try {
      if (call.name === 'web_search') return await this.search(String(call.arguments.query ?? ''), Math.max(1, Math.min(8, Number(call.arguments.max_results) || 5)));
      if (call.name === 'web_image_search' && call.arguments.max_results !== undefined && (!Number.isInteger(call.arguments.max_results) || Number(call.arguments.max_results) < 1 || Number(call.arguments.max_results) > 8)) return JSON.stringify({ error: 'max_results must be an integer from 1 to 8 per search. This is independent of gallery size and the session registry.', code: 'IMAGE_SEARCH_RESULT_LIMIT', field: 'max_results', received: typeof call.arguments.max_results === 'number' ? call.arguments.max_results : typeof call.arguments.max_results, retrySameArguments: false });
      if (call.name === 'web_image_search') return await this.imageSearch(String(call.arguments.query ?? ''), Math.max(1, Math.min(8, Number(call.arguments.max_results) || 5)));
      if (call.name === 'web_open') return await this.open(String(call.arguments.url ?? ''));
      if (call.name === 'web_read') return await this.read();
      if (call.name === 'web_follow_link') return await this.follow(call.arguments);
      if (call.name === 'web_back') return await this.back();
      return toolError(`Неизвестный web-инструмент: ${call.name}`);
    } catch (error) {
      if (call.name === 'web_search' && this.searchProvider.diagnostics) { log('web.search.failed', this.searchProvider.diagnostics); return toolError('Поисковые провайдеры недоступны. Проверьте категории отказов; используйте известные публичные страницы или повторите позже.', { ...this.searchProvider.diagnostics, code: 'SEARCH_PROVIDERS_UNAVAILABLE', categories: this.searchProvider.diagnostics.attempts.map(attempt => attempt.category), retrySameArguments: false }); }
      const details = error instanceof Error ? error.message : String(error);
      log('web.error', { timestamp: new Date().toISOString(), tool: call.name, error: details });
      return toolError('Web-инструмент временно недоступен', details);
    }
  }

  async close(): Promise<void> { this.abort.abort(); await this.context.close().catch(() => undefined); await this.browser.close().catch(() => undefined); }

  private async activePage(): Promise<Page> {
    if (!this.page) this.page = await this.context.newPage();
    this.page.setDefaultNavigationTimeout(pageTimeoutMs); this.page.setDefaultTimeout(pageTimeoutMs);
    return this.page;
  }

  private async search(query: string, limit: number): Promise<string> {
    if (!query.trim()) return toolError('Не указан поисковый запрос');
    if (policyBlock(`https://search.invalid/${encodeURIComponent(query)}`)) return blocked(policyBlock(`https://search.invalid/${encodeURIComponent(query)}`)!);
    log('web.search.started', { preferred: this.searchProvider.name });
    const results = await this.searchProvider.search(await this.activePage(), query, limit);
    const safeResults: SearchResult[] = [];
    for (const result of results) {
      const url = destinationUrl(result.url);
      if (policyBlock(url)) continue;
      try { const validated = await publicDestination(url, undefined, this.abort.signal); const safeResult = { ...result, url: validated.url.href }; safeResults.push(safeResult); this.knownSources.add(safeResult.url); }
      catch { /* Non-public or unresolvable search results are not evidence. */ }
    }
    log('web.search.completed', { ...this.searchProvider.diagnostics, provider: this.searchProvider.diagnostics?.used ?? this.searchProvider.name, status: 'ok', resultCount: safeResults.length });
    return JSON.stringify({ query, provider: this.searchProvider.diagnostics?.used ?? this.searchProvider.name, provider_diagnostics: this.searchProvider.diagnostics, safe_search: 'strict', results: safeResults });
  }

  private async imageSearch(query: string, limit: number): Promise<string> {
    if (!query.trim()) return toolError('Не указан поисковый запрос');
    if (this.discoveredImages.size >= MAX_SESSION_IMAGE_DISCOVERIES || this.imageFetches >= MAX_SESSION_IMAGE_FETCHES) return JSON.stringify({ error: 'Image discovery/fetch budget is exhausted for this request. Existing IDs remain valid; select from them instead of searching again.', code: this.discoveredImages.size >= MAX_SESSION_IMAGE_DISCOVERIES ? 'IMAGE_DISCOVERY_CAPACITY_EXCEEDED' : 'IMAGE_FETCH_BUDGET_EXHAUSTED', retrySameArguments: false, validDiscoveryIds: [...this.discoveredImages.keys()] });
    const started = performance.now(); const page = await this.activePage();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(25_000)]);
    const results: DiscoveredImage[] = []; const issues: Array<{ provider: string; error: string }> = [];
    let rejected = 0; let imageVerificationMs = 0; let candidateIssue: string | undefined;
    const providers: Array<{ provider: string; status: string; candidates: number }> = [];
    const accept = async (candidate: { image: string; sourceUrl: string; title: string; alt: string }) => {
      if (signal.aborted || results.length >= limit || this.discoveredImages.size >= MAX_SESSION_IMAGE_DISCOVERIES || this.imageFetches >= MAX_SESSION_IMAGE_FETCHES) return;
      const verificationStarted = performance.now();
      try {
        if (policyBlock(candidate.image) || policyBlock(candidate.sourceUrl)) throw new Error('Image or source is blocked by web policy.');
        const checkedSource = await this.validatePublicDestination(candidate.sourceUrl, undefined, signal);
        const checkedImage = await this.validatePublicDestination(candidate.image, undefined, signal);
        if (results.some((result) => result.url === checkedImage.url.href)) return;
        // Discovery alone is not readiness. Use the same pinned, bounded,
        // MIME-verified image proxy that the gallery will read from its cache.
        if (!this.imageLoader.hasCached?.(checkedImage.url.href)) this.imageFetches += 1;
        await this.imageLoader.load(checkedImage.url.href, signal);
        const found = [...this.discoveredImages.values()].find(image => image.url === checkedImage.url.href) ?? { id: randomUUID(), url: checkedImage.url.href, sourceUrl: checkedSource.url.href, title: candidate.title.slice(0, 200) || checkedSource.url.hostname, alt: candidate.alt.slice(0, 300) || candidate.title.slice(0, 300) || 'Web image result' };
        this.discoveredImages.set(found.id, found); this.knownSources.add(found.sourceUrl); results.push(found);
      } catch (error) { rejected += 1; candidateIssue = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240); } finally { imageVerificationMs += performance.now() - verificationStarted; }
    };
    // Prefer the existing account-free text provider and source page metadata.
    // Bing remains an optional fallback, never the sole dependency.
    let sourceCandidates = 0;
    try {
      const pages = await this.searchProvider.search(page, `${query} photographs`, Math.min(8, limit * 2));
      for (const result of pages) {
        if (results.length >= limit || signal.aborted) break;
        try {
          const sourceUrl = await this.validatePublicDestination(destinationUrl(result.url), undefined, signal);
          if (policyBlock(sourceUrl.url.href)) continue;
          const response = await page.goto(sourceUrl.url.href, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(8_000, 25_000 - (performance.now() - started))) });
          if (response && !response.ok()) continue;
          const checkedSource = await this.validatePublicDestination(page.url(), undefined, signal);
          if (policyBlock(checkedSource.url.href)) continue;
          const image = await page.locator('meta[property="og:image"], meta[name="twitter:image"]').first().getAttribute('content', { timeout: 500 }).catch(() => null);
          if (!image) continue;
          const title = await page.locator('meta[property="og:title"]').first().getAttribute('content', { timeout: 500 }).catch(() => null) ?? result.title;
          const alt = await page.locator('meta[property="og:description"]').first().getAttribute('content', { timeout: 500 }).catch(() => null) ?? result.snippet;
          sourceCandidates += 1;
          await accept({ image: new URL(image, checkedSource.url).href, sourceUrl: checkedSource.url.href, title, alt });
        } catch (error) { issues.push({ provider: 'source metadata', error: String(error).slice(0, 240) }); }
      }
      providers.push({ provider: `${this.searchProvider.diagnostics?.used ?? this.searchProvider.name} / page metadata`, status: sourceCandidates ? 'ok' : 'empty', candidates: sourceCandidates });
    } catch (error) { issues.push({ provider: this.searchProvider.name, error: String(error).slice(0, 300) }); providers.push({ provider: this.searchProvider.name, status: 'error', candidates: 0 }); }
    if (this.imageProvider && results.length < limit && !signal.aborted) {
      try {
        const candidates = await this.imageProvider.search(query, Math.min(16, limit * 3), signal);
        providers.push({ provider: this.imageProvider.name, status: candidates.length ? 'ok' : 'empty', candidates: candidates.length });
        for (const candidate of candidates) { if (results.length >= limit || signal.aborted) break; await accept(candidate); }
      } catch {
        // Never echo provider response bodies, query strings or credentials.
        issues.push({ provider: this.imageProvider.name, error: signal.aborted ? 'cancelled_or_timeout' : 'network_or_provider_error' });
        providers.push({ provider: this.imageProvider.name, status: 'error', candidates: 0 });
      }
    }
    if (this.allowBingImages && results.length < limit && !signal.aborted) {
      try {
        const response = await page.goto(`https://www.bing.com/images/search?${new URLSearchParams({ q: query, safeSearch: 'Strict', form: 'HDRSC3' })}`, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(8_000, 25_000 - (performance.now() - started))) });
        if (response && !response.ok()) throw new Error(`Bing Images HTTP ${response.status()} ${response.statusText()}`);
        const candidates = await page.locator('a.iusc').evaluateAll((nodes) => nodes.flatMap((node) => {
          try {
            const raw = node.getAttribute('m'); const meta = raw ? JSON.parse(raw) as { murl?: unknown; purl?: unknown; t?: unknown; desc?: unknown } : {};
            if (typeof meta.murl !== 'string' || typeof meta.purl !== 'string') return [];
            const title = typeof meta.t === 'string' ? meta.t : ''; const alt = typeof meta.desc === 'string' ? meta.desc : title;
            return [{ image: meta.murl, sourceUrl: meta.purl, title, alt }];
          } catch { return []; }
        }).slice(0, 24));
        providers.push({ provider: 'Bing Images', status: candidates.length ? 'ok' : 'empty', candidates: candidates.length });
        for (const candidate of candidates) { if (results.length >= limit || signal.aborted) break; await accept(candidate); }
      } catch (error) { issues.push({ provider: 'Bing Images', error: error instanceof Error ? error.message : String(error) }); providers.push({ provider: 'Bing Images', status: 'error', candidates: 0 }); }
    }
    if (this.abort.signal.aborted) throw new Error('Web request cancelled');
    const status = results.length ? 'ok' : issues.length ? 'provider_error_or_no_usable_results' : 'no_usable_results';
    log('web.image-search.completed', { status, providers, search: this.searchProvider.diagnostics, resultCount: results.length, rejected, elapsedMs: Math.round(performance.now() - started) });
    return JSON.stringify({ query, status, timing: { durationMs: Math.round(performance.now() - started), imageVerificationMs: Math.round(imageVerificationMs) }, stage: 'retrieval_verified', gallery_created: false, registry: { count: this.discoveredImages.size, capacity: MAX_SESSION_IMAGE_DISCOVERIES, imageFetches: this.imageFetches, fetchBudget: MAX_SESSION_IMAGE_FETCHES, idLifetime: 'This request session; IDs are not consumed by gallery attempts.' }, providers, search_diagnostics: this.searchProvider.diagnostics, issues, rejected_candidates: rejected, ...(candidateIssue ? { candidate_issue: candidateIssue } : {}), ...(signal.aborted ? { timeout: true } : {}), ...(results.length ? {} : { message: 'No retrievable public PNG/JPEG/WebP image URLs were found. Try a narrower query; do not invent image URLs.' }), results: results.map(({ id, ...image }) => ({ discovery_id: id, ...image, retrieval_status: 'ready' })) });
  }

  private async open(rawUrl: string): Promise<string> {
    const url = safeUrl(rawUrl); if (!url) return toolError('Некорректный URL');
    const preflight = policyBlock(url); if (preflight) { log('web.blocked', { timestamp: new Date().toISOString(), tool: 'web_open', url, reason: preflight }); return blocked(preflight); }
    await publicDestination(url, undefined, this.abort.signal);
    log('web.open.started', { timestamp: new Date().toISOString(), url });
    const page = await this.activePage(); const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    if (response && !response.ok()) {
      const responseBody = await response.text().catch(() => '');
      return toolError(`HTTP ${response.status()} ${response.statusText()}`, {
        http_status: response.status(),
        http_status_text: response.statusText(),
        ...(responseBody ? { response_body: diagnosticOutput(responseBody) } : {}),
      });
    }
    const current = page.url(); const redirectedBlock = policyBlock(current); if (redirectedBlock) return blocked(redirectedBlock);
    this.knownSources.add(current);
    this.lastSnapshot = await snapshot(page); const detected = contentBlock(this.lastSnapshot); if (detected) { log('web.blocked', { timestamp: new Date().toISOString(), tool: 'web_open', url: current, reason: detected }); return blocked(detected); }
    log('web.open.completed', { timestamp: new Date().toISOString(), url: current, status: 'ok', title: this.lastSnapshot.title, chars: this.lastSnapshot.content.length });
    return JSON.stringify({ ...this.lastSnapshot, notice: this.lastSnapshot.truncated ? 'Текст страницы ограничен по размеру.' : undefined });
  }

  private async read(): Promise<string> {
    if (!this.page) return toolError('Нет открытой страницы. Сначала используй web_open.');
    this.lastSnapshot = await snapshot(this.page); const detected = contentBlock(this.lastSnapshot); if (detected) return blocked(detected);
    log('web.read.completed', { timestamp: new Date().toISOString(), url: this.lastSnapshot.url, status: 'ok', chars: this.lastSnapshot.content.length });
    return JSON.stringify({ ...this.lastSnapshot, notice: this.lastSnapshot.truncated ? 'Текст страницы ограничен по размеру.' : undefined });
  }

  private async follow(argumentsObject: Record<string, unknown>): Promise<string> {
    const byId = Number(argumentsObject.link_id); const href = typeof argumentsObject.href === 'string' ? argumentsObject.href : this.lastSnapshot?.links.find((link) => link.id === byId)?.href;
    if (!href) return toolError('Укажи href или корректный link_id из web_read.');
    return this.open(href);
  }

  private async back(): Promise<string> {
    if (!this.page) return toolError('Нет истории web-сессии.');
    log('web.back.started', { timestamp: new Date().toISOString(), url: this.page.url() });
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: pageTimeoutMs }); return this.read();
  }
}

export class WebBrowserService {
  constructor(private readonly searchProvider: SearchProvider | undefined = undefined, private readonly imageLoader: Pick<RemoteImageService, 'load'> & Partial<Pick<RemoteImageService, 'hasCached'>> = new RemoteImageService()) {}

  async openSession(): Promise<WebBrowserSession> {
    const config = effectiveRuntimeConfiguration();
    const provider = this.searchProvider ?? createSearchProvider(config);
    const executablePath = await chromeExecutable();
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check'] });
    try {
    const abort = new AbortController();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, userAgent: 'Local AI Desktop read-only web research' });
    await context.addInitScript(() => { Object.defineProperty(window, 'RTCPeerConnection', { value: undefined, configurable: false }); });
    await context.route('**/*', async (route) => {
      const request = route.request(); const resource = request.resourceType();
      if (!['GET', 'HEAD'].includes(request.method()) || ['image', 'media', 'font'].includes(resource) || policyBlock(request.url())) return route.abort();
      try {
        const response = await fetchPublicResource(request.url(), request.method(), request.headers(), abort.signal);
        // Redirects are fulfilled rather than followed here. Chromium's next
        // request is intercepted and validated independently.
        return await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      } catch { return route.abort('blockedbyclient'); }
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    log('web.session.started', { timestamp: new Date().toISOString(), engine: 'Google Chrome headless', isolated: true });
    return new WebBrowserSession(browser, context, provider, abort, publicDestination, this.imageLoader, config.searchProvider === 'bing' || config.allowBingFallback === true, new WikimediaImageSearchProvider());
    } catch (error) { await browser.close().catch(() => undefined); throw error; }
  }
}
