import { publicDestination, fetchPublicResource, publicWebUserAgent } from '../web/public-network';
import type { RemoteImageData } from '../../shared/types';

export type RemoteImage = RemoteImageData;
type FetchImage = typeof fetchPublicResource;

function imageMime(bytes: Buffer, header: string | undefined): RemoteImage['mimeType'] | null {
  const type = header?.split(';')[0]?.trim().toLowerCase();
  if (type === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return type;
  if (type === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) return type;
  if (type === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return type;
  return null;
}

/** Read-only, bounded image proxy. Remote SVG, redirects, private hosts and other formats are rejected. */
export class RemoteImageService {
  private readonly cache = new Map<string, RemoteImage>();
  constructor(private readonly fetchImage: FetchImage = fetchPublicResource, private readonly resolve?: Parameters<typeof publicDestination>[1]) {}

  hasCached(raw: string): boolean { return this.cache.has(raw); }

  async load(raw: string, signal = new AbortController().signal): Promise<RemoteImage> {
    const cached = this.cache.get(raw); if (cached) return cached;
    const destination = await publicDestination(raw, this.resolve, signal);
    const response = await this.fetchImage(destination.url.href, 'GET', { accept: 'image/png,image/jpeg,image/webp', 'user-agent': publicWebUserAgent }, signal, 2 * 1024 * 1024);
    if (response.status < 200 || response.status >= 300) throw new Error('The image source did not return a successful response.');
    if (response.body.length > 2 * 1024 * 1024) throw new Error('The image exceeds the 2 MB display limit.');
    const mimeType = imageMime(response.body, response.headers['content-type']);
    if (!mimeType) throw new Error('Only verified PNG, JPEG and WebP images can be displayed.');
    const result = { mimeType, dataUrl: `data:${mimeType};base64,${response.body.toString('base64')}` };
    this.cache.set(raw, result);
    while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  async validateSource(raw: string): Promise<string> {
    const { url } = await publicDestination(raw, this.resolve);
    return url.href;
  }
}
