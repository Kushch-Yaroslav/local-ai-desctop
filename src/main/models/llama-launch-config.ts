import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { getModelProfile } from './model-registry';
import { llamaRuntimeProfile, type LlamaRuntimeProfile } from './llama-runtime-policy';
import { readGgufSpeculativeMetadata, type GgufSpeculativeMetadata } from '../services/gguf-speculative';
import { verifyGgufArtifacts } from '../services/gguf-artifacts';
import { verifyHostMemory } from '../services/host-memory-guard';

export function effectiveSpeculativeMode(profile: LlamaRuntimeProfile, enabled: string | undefined) {
  if (enabled !== undefined && enabled !== '0' && enabled !== '1') throw new Error('LOCAL_AI_LLAMA_SPECULATIVE должно быть 0 или 1.');
  if (profile.draft && profile.speculative === 'none') throw new Error('Draft настроен для модели без speculative capability.');
  if (profile.speculative === 'eagle3' && !profile.draft) throw new Error('EAGLE требует отдельный совместимый draft GGUF.');
  if (profile.draft && (!/^[a-f0-9]{64}$/.test(profile.draft.sha256) || !Number.isSafeInteger(profile.draft.sizeBytes) || profile.draft.sizeBytes <= 0 || !Number.isInteger(profile.draft.maxDraftTokens) || profile.draft.maxDraftTokens <= 0)) throw new Error('Некорректная конфигурация draft GGUF.');
  return enabled === '0' ? 'none' : profile.speculative;
}

export function validateDraftMetadata(profile: LlamaRuntimeProfile, target: GgufSpeculativeMetadata, draft: GgufSpeculativeMetadata): void {
  const expected = profile.draft;
  if (!expected) throw new Error('Совместимый draft не настроен.');
  const arch = expected.architecture, targetArch = expected.targetArchitecture;
  const context = draft.values[`${arch}.context_length`];
  if (draft.values['general.architecture'] !== arch || target.values['general.architecture'] !== targetArch
    || target.values[`${targetArch}.embedding_length`] !== expected.targetEmbeddingLength
    || draft.values[`${arch}.embedding_length_out`] !== expected.targetEmbeddingLength
    || typeof context !== 'number' || !Number.isSafeInteger(context) || context < profile.maxContext
    || (profile.speculative === 'mtp' && !(Number(draft.values[`${arch}.nextn_predict_layers`]) > 0))) throw new Error('Draft GGUF несовместим с архитектурой, размером или контекстом основной модели.');
  // MTP uses the target's template/stop policy. Its tokenizer token texts, merges,
  // vocabulary type and BOS policy must match; assistant EOS/type annotations may differ.
  for (const key of ['model', 'tokens', 'merges', 'bos_token_id', 'add_bos_token']) {
    const field = `tokenizer.ggml.${key}`;
    if (!target.tokenizer[field] || target.tokenizer[field] !== draft.tokenizer[field]) throw new Error(`Несовместимый tokenizer draft: ${field}.`);
  }
  if (expected.kvCache === 'shared' && !(Number(draft.values[`${arch}.attention.shared_kv_layers`]) > 0)) throw new Error('Draft GGUF не подтверждает разделяемый KV-cache.');
}

export function verifyEmbeddedMtp(profile: LlamaRuntimeProfile): void {
  if (!profile.modelPath) throw new Error('Не настроена GGUF встроенной MTP-модели.');
  const metadata = readGgufSpeculativeMetadata(profile.modelPath);
  const architecture = metadata.values['general.architecture'];
  if (typeof architecture !== 'string' || !(Number(metadata.values[`${architecture}.nextn_predict_layers`]) > 0)) {
    throw new Error(`GGUF не подтверждает встроенные MTP-слои: ${profile.modelPath}.`);
  }
}

export async function verifyDraftFile(profile: LlamaRuntimeProfile): Promise<void> {
  const draft = profile.draft;
  if (!draft || !profile.modelPath) throw new Error('Не настроены основная модель и draft.');
  const file = statSync(draft.path);
  if (!file.isFile() || file.size !== draft.sizeBytes) throw new Error(`Некорректный размер draft GGUF: ${draft.path}.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(draft.path)) hash.update(chunk);
  if (hash.digest('hex') !== draft.sha256) throw new Error(`SHA-256 draft GGUF не совпадает: ${draft.path}.`);
  validateDraftMetadata(profile, readGgufSpeculativeMetadata(profile.modelPath), readGgufSpeculativeMetadata(draft.path));
}

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function placementArguments(profile: LlamaRuntimeProfile): string[] {
  const placement = profile.placement;
  if (!placement) return [];
  if (!Number.isInteger(placement.cpuMoeLayers) || placement.cpuMoeLayers < 0 || placement.cpuMoeLayers > 1_024
    || [placement.threads, placement.threadsBatch, placement.batchSize, placement.ubatchSize].some((value) => !Number.isInteger(value) || value < 1 || value > 65_536)
    || placement.ubatchSize > placement.batchSize || !['auto', 'mmap', 'none'].includes(placement.loadMode)) throw new Error('Некорректная конфигурация CPU/GPU placement.');
  return ['--fit', 'off', '--n-cpu-moe', String(placement.cpuMoeLayers), '--threads', String(placement.threads), '--threads-batch', String(placement.threadsBatch),
    '--batch-size', String(placement.batchSize), '--ubatch-size', String(placement.ubatchSize), '--load-mode', placement.loadMode];
}
/** One source of model paths/capabilities for Electron and the shell launcher. */
export function launchProfileEnvironment(profile: LlamaRuntimeProfile, enabled?: string): string {
  if (!profile.modelPath) throw new Error(`Не настроен llama.cpp GGUF: ${profile.id}.`);
  const mode = effectiveSpeculativeMode(profile, enabled);
  const draft = mode !== 'none' ? profile.draft : undefined;
  const mmproj = profile.mmprojPath && (mode !== 'mtp' || profile.visionWithMtp !== false) ? profile.mmprojPath : '';
  if (profile.speculativeDraftTokens !== undefined && (!Number.isInteger(profile.speculativeDraftTokens) || profile.speculativeDraftTokens < 1)) throw new Error('Некорректное число токенов embedded MTP.');
  const values = {
    VARIANT: profile.id, MODEL: profile.modelPath, MMPROJ: mmproj, RUNTIME_MODEL_ID: profile.id,
    RUNTIME_LABEL: getModelProfile(profile.id)?.displayName ?? profile.id, DEFAULT_LLAMA_CONTEXT: String(profile.normalContext?.initialContextWindow ?? 32_768), MAX_LLAMA_CONTEXT: String(profile.maxContext),
    SPECULATIVE_MODE: mode, DRAFT_MODEL: draft?.path ?? '', DRAFT_KV_SHARED: draft?.kvCache === 'shared' ? '1' : '0',
    DRAFT_N_MAX: draft ? String(draft.maxDraftTokens) : mode === 'mtp' && profile.speculativeDraftTokens ? String(profile.speculativeDraftTokens) : '',
  };
  return [...Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`), `PROFILE_SERVER_ARGS=(${placementArguments(profile).map(quote).join(' ')})`].join('\n');
}

if (require.main === module) {
  void (async () => {
    const profile = llamaRuntimeProfile(process.argv[2]);
    if (!profile) throw new Error(`Unknown Local AI llama.cpp model: ${process.argv[2]}`);
    const environment = launchProfileEnvironment(profile, process.env.LOCAL_AI_LLAMA_SPECULATIVE);
    if (process.argv[3] === '--verify') {
      verifyGgufArtifacts(profile.modelPath!);
      if (profile.hostResidentBudgetBytes !== undefined) verifyHostMemory(profile.hostResidentBudgetBytes);
      const mode = effectiveSpeculativeMode(profile, process.env.LOCAL_AI_LLAMA_SPECULATIVE);
      if (mode === 'mtp' && !profile.draft) verifyEmbeddedMtp(profile);
      if (mode !== 'none' && profile.draft) await verifyDraftFile(profile);
    }
    process.stdout.write(environment + '\n');
  })().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
