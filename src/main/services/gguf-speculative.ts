import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type GgufSpeculativeMetadata = { values: Record<string, string | number | boolean>; tokenizer: Record<string, string> };

/** Bounded, buffered metadata inspection. No model tensors are interpreted or loaded for inference. */
export function readGgufSpeculativeMetadata(path: string): GgufSpeculativeMetadata {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const window = Buffer.alloc(64 * 1024);
    let position = 0, windowStart = -1, windowLength = 0;
    const bytes = (length: number): Buffer => {
      if (!Number.isSafeInteger(length) || length < 0 || position + length > Math.min(size, 64 * 1024 ** 2)) throw new Error('Некорректные или обрезанные метаданные draft GGUF.');
      const result = Buffer.alloc(length);
      for (let copied = 0; copied < length;) {
        if (position < windowStart || position >= windowStart + windowLength) {
          windowStart = position;
          windowLength = readSync(fd, window, 0, Math.min(window.length, size - position), position);
          if (!windowLength) throw new Error('Метаданные draft GGUF обрезаны.');
        }
        const count = Math.min(length - copied, windowStart + windowLength - position);
        window.copy(result, copied, position - windowStart, position - windowStart + count);
        position += count; copied += count;
      }
      return result;
    };
    const u32 = () => bytes(4).readUInt32LE();
    const u64 = () => { const n = bytes(8).readBigUInt64LE(); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Слишком большие метаданные GGUF.'); return Number(n); };
    const text = () => { const n = u64(); if (n > 4 * 1024 ** 2) throw new Error('Слишком длинная строка GGUF.'); return bytes(n).toString('utf8'); };
    const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const value = (type: number, digest?: ReturnType<typeof createHash>, depth = 0): string | number | boolean | undefined => {
      if (depth > 1) throw new Error('Вложенный массив GGUF не поддерживается.');
      if (type === 8) { const length = bytes(8); const n = Number(length.readBigUInt64LE()); if (n > 4 * 1024 ** 2) throw new Error('Слишком длинная строка GGUF.'); const b = bytes(n); digest?.update(length).update(b); return b.toString('utf8'); }
      if (type === 9) {
        const header = bytes(12), element = header.readUInt32LE(), count = Number(header.readBigUInt64LE(4));
        if (!Number.isSafeInteger(count) || count > 1_000_000) throw new Error('Слишком большой массив GGUF.');
        digest?.update(header);
        for (let i = 0; i < count; i += 1) value(element, digest, depth + 1);
        return undefined;
      }
      if (!sizes[type]) throw new Error(`Неизвестный тип GGUF: ${type}.`);
      const b = bytes(sizes[type]); digest?.update(b);
      if (type === 4) return b.readUInt32LE();
      if (type === 10) return Number(b.readBigUInt64LE());
      if (type === 7) return Boolean(b[0]);
      return undefined;
    };
    if (bytes(4).toString('ascii') !== 'GGUF' || ![2, 3].includes(u32())) throw new Error('Draft должен быть корректным GGUF v2/v3.');
    u64(); const count = u64();
    if (count > 1_000_000) throw new Error('Слишком много полей GGUF.');
    const metadata: GgufSpeculativeMetadata = { values: {}, tokenizer: {} };
    for (let i = 0; i < count; i += 1) {
      const key = text(), type = u32();
      const digest = key.startsWith('tokenizer.ggml.') ? createHash('sha256').update(String(type)) : undefined;
      const item = value(type, digest);
      if (item !== undefined) metadata.values[key] = item;
      if (digest) metadata.tokenizer[key] = digest.digest('hex');
    }
    return metadata;
  } finally { closeSync(fd); }
}
