import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveSpeculativeMode, launchProfileEnvironment, validateDraftMetadata, verifyDraftFile } from './llama-launch-config';
import { llamaRuntimeProfiles, type LlamaRuntimeProfile } from './llama-runtime-policy';
import { readGgufSpeculativeMetadata } from '../services/gguf-speculative';
import { parseLlamaRuntimeState } from '../services/llama-runtime-controller';

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const text = (s: string) => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
function fixture(architecture: string, draft: boolean): Buffer {
  const fields: Record<string, string | number | string[]> = {
    'general.architecture': architecture, [`${architecture}.context_length`]: 262_144,
    [`${architecture}.embedding_length`]: draft ? 8 : 16,
    'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.tokens': ['a', 'b'], 'tokenizer.ggml.merges': ['a b'],
    'tokenizer.ggml.bos_token_id': 1, 'tokenizer.ggml.add_bos_token': 1,
    ...(draft ? { [`${architecture}.embedding_length_out`]: 16, [`${architecture}.nextn_predict_layers`]: 4, [`${architecture}.attention.shared_kv_layers`]: 4 } : {}),
  };
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(fields).length), ...Object.entries(fields).flatMap(([key, value]) => [text(key),
    typeof value === 'string' ? Buffer.concat([u32(8), text(value)]) : typeof value === 'number' ? Buffer.concat([u32(4), u32(value)]) : Buffer.concat([u32(9), u32(8), u64(value.length), ...value.map(text)])])]);
}

async function run() {
  for (const profile of llamaRuntimeProfiles) {
    assert.equal(effectiveSpeculativeMode(profile, '0'), 'none');
    assert.equal(effectiveSpeculativeMode(profile, '1'), profile.speculative);
    assert.equal(effectiveSpeculativeMode(profile, undefined), profile.speculative, 'Qwen default remains enabled');
    assert(!launchProfileEnvironment(profile, '0').includes('DRAFT_MODEL=\'/media/'), 'OFF must not request an external model');
  }
  const plain: LlamaRuntimeProfile = { id: 'future-without-reasoning', maxContext: 32_768, modelPath: "/models/a'b.gguf", speculative: 'none', vision: false };
  assert.equal(effectiveSpeculativeMode(plain, '1'), 'none');
  assert(launchProfileEnvironment(plain).includes("a'\"'\"'b.gguf"), 'profile values must be shell escaped');
  assert.throws(() => effectiveSpeculativeMode(plain, 'yes'), /0 или 1/);
  assert.throws(() => effectiveSpeculativeMode({ ...plain, speculative: 'eagle3' }, '1'), /EAGLE/);
  const directory = await mkdtemp(join(tmpdir(), 'lad-draft-'));
  try {
    const main = join(directory, 'main.gguf'), path = join(directory, 'draft.gguf');
    const contents = fixture('future-assistant', true);
    await writeFile(main, fixture('future-main', false)); await writeFile(path, contents);
    const profile: LlamaRuntimeProfile = { ...plain, modelPath: main, speculative: 'mtp', maxContext: 262_144, mmprojPath: '/models/projector.gguf', vision: true,
      draft: { path, sizeBytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex'), architecture: 'future-assistant', targetArchitecture: 'future-main', targetEmbeddingLength: 16, kvCache: 'shared', maxDraftTokens: 4 } };
    await verifyDraftFile(profile);
    const target = readGgufSpeculativeMetadata(main), assistant = readGgufSpeculativeMetadata(path);
    validateDraftMetadata(profile, target, assistant);
    const invalid = (field: string, value: string | number) => ({ ...assistant, values: { ...assistant.values, [field]: value } });
    for (const [field, value] of [['general.architecture', 'unrelated'], ['future-assistant.context_length', 8192], ['future-assistant.embedding_length_out', 17], ['future-assistant.nextn_predict_layers', 0], ['future-assistant.attention.shared_kv_layers', 0]] as const) {
      assert.throws(() => validateDraftMetadata(profile, target, invalid(field, value)), /несовместим|разделяемый/);
    }
    const missingContext = { ...assistant, values: { ...assistant.values } };
    delete missingContext.values['future-assistant.context_length'];
    assert.throws(() => validateDraftMetadata(profile, target, missingContext), /несовместим/);
    assert.throws(() => validateDraftMetadata(profile, target, { ...assistant, tokenizer: { ...assistant.tokenizer, 'tokenizer.ggml.tokens': 'different' } }), /tokenizer/);
    assert.throws(() => effectiveSpeculativeMode({ ...profile, speculative: 'none' }, '1'), /без speculative/);
    await assert.rejects(verifyDraftFile({ ...profile, draft: { ...profile.draft!, path: path + '.missing' } }), /ENOENT/);
    await assert.rejects(verifyDraftFile({ ...profile, draft: { ...profile.draft!, sizeBytes: contents.length + 1 } }), /размер/);
    const corrupt = Buffer.from(contents); corrupt[corrupt.length - 1] ^= 1;
    await writeFile(path, corrupt);
    await assert.rejects(verifyDraftFile(profile), /SHA-256/);
    await writeFile(path, Buffer.from('not GGUF'));
    assert.throws(() => readGgufSpeculativeMetadata(path), /GGUF/);
    await writeFile(path, contents.subarray(0, contents.length - 1));
    assert.throws(() => readGgufSpeculativeMetadata(path), /обрезан/);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.equal(parseLlamaRuntimeState('{"status":"ready","speculativeMode":"mtp"}')?.speculativeMode, 'mtp');
  assert.equal(parseLlamaRuntimeState('{"status":"ready","speculativeMode":"pretend"}')?.speculativeMode, undefined);
  assert.equal(parseLlamaRuntimeState('{"status":"offline","speculativeMode":"none"}')?.speculativeMode, 'none');
  console.log('generic speculative configuration regression passed (four profiles, OFF/ON, future family, verified/invalid/missing/corrupt draft, runtime state)');
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
