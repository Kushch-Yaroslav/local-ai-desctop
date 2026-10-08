import assert from 'node:assert/strict';
import { isPublicAddress, publicDestination, fetchPublicResource } from './public-network';

export async function runPublicNetworkRegression() {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001::1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['file:///etc/passwd', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://[::1]', 'http://user:password@example.com', 'http://foo.local']) await assert.rejects(publicDestination(url));
  const resolver = (async () => [{ address: '10.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }]) as Parameters<typeof publicDestination>[1];
  await assert.rejects(publicDestination('https://example.com', resolver), /blocked/);
  const publicResolver = (async () => [{ address: '93.184.216.34', family: 4 }]) as Parameters<typeof publicDestination>[1];
  assert.equal((await publicDestination('https://example.com', publicResolver)).address, '93.184.216.34');
  await assert.rejects(fetchPublicResource('https://example.com', 'POST', {}, new AbortController().signal), /read-only/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchPublicResource('https://8.8.8.8', 'GET', {}, controller.signal), /cancelled/);
}


/** Mock the transport rather than contacting the Internet. A hostname that
 * rebinds on a second resolution must still connect to its first vetted IP. */
export async function runPinnedTransportRegression() {
  const { createRequire } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const moduleRequire = createRequire(__filename);
  const http = moduleRequire('node:http'), dns = moduleRequire('node:dns/promises');
  const originalRequest = http.request, originalLookup = dns.lookup;
  let lookups = 0, connections = 0;
  try {
    dns.lookup = async () => [{ address: ++lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    http.request = (url: URL, options: { lookup: (host: string, options: object, done: (error: null, address: string, family: number) => void) => void }, callback: (response: unknown) => void) => {
      connections++; assert.equal(url.hostname, 'public.example');
      options.lookup(url.hostname, {}, (_error, address, family) => { assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
      const request = Object.assign(new EventEmitter(), {
        setTimeout: () => {}, destroy: (error: Error) => { request.emit('error', error); },
        end: () => { const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/plain' } }); callback(response); response.end('fixture'); },
      }); return request;
    };
    const result = await fetchPublicResource('http://public.example/', 'GET', {}, new AbortController().signal);
    assert.equal(result.body.toString(), 'fixture'); assert.equal(lookups, 1); assert.equal(connections, 1);
    await assert.rejects(fetchPublicResource('http://public.example/', 'GET', {}, new AbortController().signal), /blocked/);
    assert.equal(connections, 1, 'private rebinding created a connection');
  } finally { http.request = originalRequest; dns.lookup = originalLookup; }
}
if (require.main === module) void (async () => { await runPublicNetworkRegression(); await runPinnedTransportRegression(); })().catch(error => { console.error(error); process.exitCode = 1; });
