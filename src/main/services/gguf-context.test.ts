import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ggufTrainContext } from './gguf-context';

export async function runGgufContextRegression() {
  const directory = await mkdtemp(join(tmpdir(), 'gguf-context-'));
  const uint32 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };
  const uint64 = (value: number) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
  const text = (value: string) => Buffer.concat([uint64(Buffer.byteLength(value)), Buffer.from(value)]);
  const model = (context: number) => Buffer.concat([
    Buffer.from('GGUF'), uint32(3), uint64(0), uint64(2),
    text('general.architecture'), uint32(8), text('arbitrary_architecture'),
    text('arbitrary_architecture.context_length'), uint32(4), uint32(context),
  ]);
  try {
    const path = join(directory, 'model.gguf');
    await writeFile(path, model(131072));
    assert.equal(await ggufTrainContext(path), 131072, 'trained context must use the GGUF architecture key, not a model-name special case');
    await writeFile(path, Buffer.concat([model(65536), Buffer.from('changed-identity')]));
    assert.equal(await ggufTrainContext(path), 65536, 'replaced model file must invalidate metadata cache');
    await writeFile(path, Buffer.from('not gguf'));
    await assert.rejects(ggufTrainContext(path), /не в формате GGUF/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) void runGgufContextRegression().catch((error) => { console.error(error); process.exitCode = 1; });
