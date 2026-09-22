import { access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { log } from '../services/logger';
import type { ProjectToolCall, ProjectToolDefinition } from '../tools/project-tools';

const browserCandidates = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const pageTimeoutMs = 15_000;
const maxPageChars = 12_000;
const maxLinks = 40;

type SearchResult = { title: string; url: string; snippet: string };
type PageSnapshot = { title: string; url: string; content: string; links: Array<{ id: number; text: string; href: string }>; truncated: boolean };

export const webToolDefinitions: ProjectToolDefinition[] = [
  { type: 'function', function: { name: 'web_search', description: 'Ищет актуальную информацию в интернете. Возвращает title, URL и snippet; затем открой подходящий результат через web_open.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Поисковый запрос.' }, max_results: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_open', description: 'Открывает URL в изолированном read-only headless browser и возвращает очищенный читаемый текст страницы и ссылки.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_read', description: 'Повторно читает текущую открытую страницу, включая компактный список ссылок с ID.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_follow_link', description: 'Переходит по ссылке из текущей страницы. Передай link_id из web_read или явный href.', parameters: { type: 'object', properties: { link_id: { type: 'integer', minimum: 1 }, href: { type: 'string' } } } } },
  { type: 'function', function: { name: 'web_back', description: 'Возвращается к предыдущей странице текущей изолированной web-сессии.', parameters: { type: 'object', properties: {} } } },
];

export function activityForWebTool(call: ProjectToolCall): { label: string; detail?: string } {
  if (call.name === 'web_search') return { label: 'Поиск в интернете', detail: String(call.arguments.query ?? '') };
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

export interface SearchProvider {
  readonly name: string;
  search(page: Page, query: string, limit: number): Promise<SearchResult[]>;
}

/** Bing is used as a replaceable provider; strict SafeSearch is encoded in its URL. */
export class BingSearchProvider implements SearchProvider {
  readonly name = 'Bing';
  async search(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?${new URLSearchParams({ q: query, adlt: 'strict', setlang: 'ru' })}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    const body = (await page.locator('body').innerText({ timeout: 3_000 })).toLowerCase();
    if (body.includes('captcha') || body.includes('unusual traffic') || body.includes('verify you are human')) throw new Error('Поисковый провайдер запросил CAPTCHA или временно заблокировал запрос');
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    const body = (await page.locator('body').innerText({ timeout: 3_000 })).toLowerCase();
    if (body.includes('captcha') || body.includes('unusual traffic') || body.includes('verify you are human')) throw new Error('Поисковый провайдер запросил CAPTCHA или временно заблокировал запрос');
    return page.locator('.result').evaluateAll((nodes, maximum) => nodes.slice(0, maximum).map((node) => {
      const link = node.querySelector('.result__a') as HTMLAnchorElement | null;
      const snippet = node.querySelector('.result__snippet')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return link ? { title: link.textContent?.replace(/\s+/g, ' ').trim() ?? '', url: link.href, snippet } : null;
    }).filter((item): item is { title: string; url: string; snippet: string } => Boolean(item?.url)), limit);
  }
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
  constructor(private readonly browser: Browser, private readonly context: BrowserContext, private readonly searchProvider: SearchProvider) {}

  async execute(call: ProjectToolCall): Promise<string> {
    try {
      if (call.name === 'web_search') return await this.search(String(call.arguments.query ?? ''), Math.max(1, Math.min(8, Number(call.arguments.max_results) || 5)));
      if (call.name === 'web_open') return await this.open(String(call.arguments.url ?? ''));
      if (call.name === 'web_read') return await this.read();
      if (call.name === 'web_follow_link') return await this.follow(call.arguments);
      if (call.name === 'web_back') return await this.back();
      return toolError(`Неизвестный web-инструмент: ${call.name}`);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      log('web.error', { timestamp: new Date().toISOString(), tool: call.name, error: details });
      return toolError('Web-инструмент временно недоступен', details);
    }
  }

  async close(): Promise<void> { await this.context.close().catch(() => undefined); await this.browser.close().catch(() => undefined); }

  private async activePage(): Promise<Page> {
    if (!this.page) this.page = await this.context.newPage();
    this.page.setDefaultNavigationTimeout(pageTimeoutMs); this.page.setDefaultTimeout(pageTimeoutMs);
    return this.page;
  }

  private async search(query: string, limit: number): Promise<string> {
    if (!query.trim()) return toolError('Не указан поисковый запрос');
    if (policyBlock(`https://search.invalid/${encodeURIComponent(query)}`)) return blocked(policyBlock(`https://search.invalid/${encodeURIComponent(query)}`)!);
    log('web.search.started', { timestamp: new Date().toISOString(), query });
    const results = await this.searchProvider.search(await this.activePage(), query, limit);
    const safeResults = results.map((result) => ({ ...result, url: destinationUrl(result.url) })).filter((result) => !policyBlock(result.url));
    log('web.search.completed', { timestamp: new Date().toISOString(), query, status: 'ok', resultCount: safeResults.length });
    return JSON.stringify({ query, provider: this.searchProvider.name, safe_search: 'strict', results: safeResults });
  }

  private async open(rawUrl: string): Promise<string> {
    const url = safeUrl(rawUrl); if (!url) return toolError('Некорректный URL');
    const preflight = policyBlock(url); if (preflight) { log('web.blocked', { timestamp: new Date().toISOString(), tool: 'web_open', url, reason: preflight }); return blocked(preflight); }
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
  constructor(private readonly searchProvider: SearchProvider = new DuckDuckGoSearchProvider()) {}

  async openSession(): Promise<WebBrowserSession> {
    const executablePath = await chromeExecutable();
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check'] });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, userAgent: 'Local AI Desktop read-only web research' });
    await context.route('**/*', async (route) => {
      const request = route.request(); const resource = request.resourceType();
      if (!['GET', 'HEAD'].includes(request.method()) || ['image', 'media', 'font'].includes(resource) || policyBlock(request.url())) return route.abort();
      return route.continue();
    });
    log('web.session.started', { timestamp: new Date().toISOString(), engine: 'Google Chrome headless', isolated: true });
    return new WebBrowserSession(browser, context, this.searchProvider);
  }
}
