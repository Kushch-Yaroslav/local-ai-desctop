import assert from 'node:assert/strict';
import { RemoteImageService } from './remote-image-service';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];

export async function runRemoteImageRegression(): Promise<void> {
  let reads = 0;
  let configuredLimit = 0;
  const service = new RemoteImageService(async (_url, _method, headers, _signal, maxBodyBytes) => { reads += 1; configuredLimit = maxBodyBytes ?? 0; assert.match(headers['user-agent'], /^Local-AI-Desktop\//, 'image requests must identify the application for Wikimedia policy'); assert(!headers.cookie && !headers.authorization, 'image fetch leaked credentials'); return { status: 200, headers: { 'content-type': 'image/png' }, body: png }; }, resolve);
  const loaded = await service.load('https://images.example.test/image.png');
  assert.equal(loaded.mimeType, 'image/png');
  assert.equal(loaded.dataUrl, `data:image/png;base64,${png.toString('base64')}`, 'image proxy changed binary bytes');
  assert.equal(configuredLimit, 2 * 1024 * 1024, 'image fetch did not enforce its streaming byte limit');
  await service.load('https://images.example.test/image.png');
  assert.equal(reads, 1, 'image cache refetched a repeated URL');

  const privateService = new RemoteImageService(async () => { throw new Error('must not fetch private targets'); }, async () => [{ address: '192.168.1.10', family: 4 }]);
  await assert.rejects(privateService.load('https://private.example.test/image.png'), /private|reserved/i, 'private destination was not blocked');
  const redirectService = new RemoteImageService(async () => ({ status: 302, headers: { location: 'https://public.example.test/next.png' }, body: Buffer.alloc(0) }), resolve);
  await assert.rejects(redirectService.load('https://images.example.test/redirect'), /successful response/i, 'redirect was followed or accepted');
  const svgService = new RemoteImageService(async () => ({ status: 200, headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }), resolve);
  await assert.rejects(svgService.load('https://images.example.test/vector.svg'), /verified PNG, JPEG and WebP/i, 'SVG was accepted as active image content');
  const oversizedService = new RemoteImageService(async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]) }), resolve);
  await assert.rejects(oversizedService.load('https://images.example.test/large.png'), /2 MB/i, 'oversized image passed the display limit');
  await assert.rejects(service.validateSource('file:///etc/passwd'), /protocol|HTTP/i, 'non-HTTP source link was accepted');
}

if (require.main === module) void runRemoteImageRegression().then(() => console.log('remote image service regression: ok')).catch((error) => { console.error(error); process.exitCode = 1; });
