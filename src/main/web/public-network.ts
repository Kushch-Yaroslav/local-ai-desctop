import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // Conservatively permit global unicast only, excluding transition and
  // documentation prefixes. Mapped IPv4, loopback and ULA are outside 2000::/3.
  const lower = address.toLowerCase();
  const [first, second] = lower.split(':').slice(0, 2).map(part => parseInt(part || '0', 16));
  return (first & 0xe000) === 0x2000 && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

export async function publicDestination(raw: string, resolve: (host: string, options: LookupAllOptions) => Promise<LookupAddress[]> = lookup, signal?: AbortSignal): Promise<{ url: URL; address: string; family: number }> {
  if (signal?.aborted) throw new Error('Web request cancelled');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP/HTTPS URLs without credentials are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) throw new Error('Local and private network access is blocked');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let addresses: LookupAddress[];
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      resolve(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Web DNS lookup timed out')), 15_000); timer.unref();
        onAbort = () => reject(new Error('Web request cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Local, private, and reserved network addresses are blocked');
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  return { url, ...selected };
}

/** Pin the resolved public address to this connection. Browser navigation and
 * redirects go through this again, so a second DNS lookup cannot rebind it. */
export async function fetchPublicResource(raw: string, method: string, headers: Record<string, string>, signal: AbortSignal) {
  if (!['GET', 'HEAD'].includes(method)) throw new Error('Web requests are read-only');
  const { url, address, family } = await publicDestination(raw, lookup, signal);
  if (signal.aborted) throw new Error('Web request cancelled');
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, headers, signal, family, lookup: (_host, _options, done) => done(null, address, family),
    }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) request.destroy(new Error('Web resource exceeds the size limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        clearTimeout(deadline);
        const resultHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders[key] = Array.isArray(value) ? value.join('\n') : value;
        resolve({ status: response.statusCode ?? 502, headers: resultHeaders, body: Buffer.concat(chunks) });
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Web request timed out')), 15_000); deadline.unref();
    request.once('close', () => clearTimeout(deadline));
    request.once('error', () => clearTimeout(deadline));
    request.setTimeout(15_000, () => request.destroy(new Error('Web request timed out')));
    request.on('error', reject); request.end();
  });
}
