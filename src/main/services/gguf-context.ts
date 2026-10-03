import { open, stat } from 'node:fs/promises';
import { llamaRuntimeProfile } from '../models/llama-runtime-policy';

const cache = new Map<string, { identity: string; context: number }>();

/** Reads only metadata, never tensor data or the entire model file. */
export async function ggufTrainContext(path: string): Promise<number> {
  const fileStat = await stat(path);
  const identity = `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
  const cached = cache.get(path);
  if (cached?.identity === identity) return cached.context;
  const file = await open(path, 'r');
  let position = 0;
  const bytes = async (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || position + length > fileStat.size || position + length > 64 * 1024 ** 2) throw new Error('Invalid or excessive GGUF metadata.');
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, position);
    if (result.bytesRead !== length) throw new Error('Truncated GGUF metadata.');
    position += length;
    return buffer;
  };
  const uint32 = async () => (await bytes(4)).readUInt32LE();
  const uint64 = async () => {
    const value = (await bytes(8)).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Excessive GGUF metadata length.');
    return Number(value);
  };
  const text = async () => {
    const length = await uint64();
    if (length > 4 * 1024 ** 2) throw new Error('Excessive GGUF metadata string.');
    return (await bytes(length)).toString('utf8');
  };
  const value = async (type: number, depth = 0): Promise<string | number | null> => {
    if (depth > 1) throw new Error('Invalid nested GGUF metadata array.');
    if (type === 8) return text();
    if (type === 9) {
      const elementType = await uint32();
      const count = await uint64();
      if (count > 1_000_000) throw new Error('Excessive GGUF metadata array.');
      for (let i = 0; i < count; i += 1) await value(elementType, depth + 1);
      return null;
    }
    const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const size = sizes[type];
    if (!size) throw new Error(`Unknown GGUF metadata type ${type}.`);
    const buffer = await bytes(size);
    if (type === 4) return buffer.readUInt32LE();
    if (type === 10) return Number(buffer.readBigUInt64LE());
    return null;
  };
  try {
    if ((await bytes(4)).toString('ascii') !== 'GGUF') throw new Error('Model is not GGUF.');
    const version = await uint32();
    if (version !== 2 && version !== 3) throw new Error(`Unsupported GGUF version ${version}.`);
    await uint64();
    const count = await uint64();
    if (count > 1_000_000) throw new Error('Excessive GGUF metadata count.');
    let architecture: string | null = null;
    const contexts = new Map<string, number>();
    for (let i = 0; i < count; i += 1) {
      const key = await text();
      const item = await value(await uint32());
      if (key === 'general.architecture' && typeof item === 'string') architecture = item;
      if (key.endsWith('.context_length') && typeof item === 'number' && Number.isSafeInteger(item) && item > 0) contexts.set(key, item);
      const context = architecture ? contexts.get(`${architecture}.context_length`) : undefined;
      if (context) {
        cache.set(path, { identity, context });
        return context;
      }
    }
    throw new Error('GGUF does not report the architecture trained context length.');
  } finally {
    await file.close();
  }
}

export async function llamaCapabilityLimit(modelId: string): Promise<number> {
  const profile = llamaRuntimeProfile(modelId);
  if (!profile) throw new Error(`Unknown llama.cpp model ${modelId}.`);
  return Math.min(profile.maxContext, profile.modelPath ? await ggufTrainContext(profile.modelPath) : profile.maxContext);
}
