import { createHash } from 'node:crypto';
import type { ContextDiscoveryOption } from '../../shared/context-estimator';
import { nonLlmBudgetBytes, vramChangeToleranceBytes, vramEstimatorMarginBytes, vramProbeGuardBytes } from '../../shared/vram-budget';

/** Bump when the discovery algorithm or its acceptance policy changes in a way
 * that makes earlier calibrations incomparable. The numeric policy constants
 * below are folded into the key automatically. */
export const contextDiscoveryPolicyVersion = 1;
const contextBucket = 4_096;
const minimumContext = 16_384;

/** Everything that materially changes what the discovery measured, and nothing volatile
 * (free VRAM, current usage, running context/cache mode). KV type and offload are the
 * per-option part of the key, not of the configuration. */
export interface ContextDiscoveryIdentity {
  modelId: string;
  model: string;
  projector: string | null;
  runtime: string;
  arguments: string[];
  speculative: string;
  hardLimit: number;
  gpuName: string;
  vramTotalBytes: number;
  hostReserveBytes: number;
}

export function contextDiscoveryKey(identity: ContextDiscoveryIdentity): { key: string; serialized: string } {
  const serialized = JSON.stringify({
    policy: { version: contextDiscoveryPolicyVersion, nonLlmBudgetBytes, vramEstimatorMarginBytes, vramChangeToleranceBytes, vramProbeGuardBytes },
    modelId: identity.modelId, model: identity.model, projector: identity.projector, runtime: identity.runtime,
    arguments: identity.arguments, speculative: identity.speculative, hardLimit: identity.hardLimit,
    gpuName: identity.gpuName, vramTotalBytes: identity.vramTotalBytes, hostReserveBytes: identity.hostReserveBytes,
  });
  return { key: createHash('sha256').update(serialized).digest('hex'), serialized };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bytesPair = (value: unknown, a: string, b: string): boolean =>
  typeof value === 'object' && value !== null && finite((value as Record<string, unknown>)[a]) && finite((value as Record<string, unknown>)[b]);

/** A stored option is trusted only when it is structurally complete and internally consistent. */
export function isPersistableDiscoveryOption(value: unknown, expected?: { modelId: string; hardLimit?: number }): value is ContextDiscoveryOption {
  if (typeof value !== 'object' || value === null) return false;
  const option = value as Partial<ContextDiscoveryOption>;
  return typeof option.modelId === 'string' && option.modelId.length > 0 && (!expected || option.modelId === expected.modelId)
    && Number.isInteger(option.contextWindow) && option.contextWindow! >= minimumContext && option.contextWindow! % contextBucket === 0
    && (expected?.hardLimit === undefined || option.contextWindow! <= expected.hardLimit)
    && (option.kvCacheType === 'f16' || option.kvCacheType === 'q8_0')
    && typeof option.kvOffload === 'boolean'
    && typeof option.discoveredAt === 'string' && Number.isFinite(Date.parse(option.discoveredAt))
    && bytesPair(option.memoryBaseline, 'hostAvailableBytes', 'deviceAvailableBytes')
    && bytesPair(option.measuredHeadroom, 'hostBytes', 'deviceBytes')
    && (option.vramBudget === undefined || (typeof option.vramBudget === 'object' && option.vramBudget !== null
      && ['totalBytes', 'nonLlmBytes', 'llmBytes', 'freeBytes', 'availableLlmBytes', 'marginBytes'].every((field) => finite((option.vramBudget as unknown as Record<string, unknown>)[field]))));
}

/** Saved options come back flagged `restored`: they were not measured in this session, so age is not
 * a validity signal; the live memory/VRAM checks decide whether one may be selected right now. */
export function parseStoredDiscoveryOption(serialized: string, expected: { modelId: string; kvCacheType: string; kvOffload: boolean; hardLimit?: number }): ContextDiscoveryOption | null {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return null; }
  if (!isPersistableDiscoveryOption(parsed, expected)) return null;
  if (parsed.kvCacheType !== expected.kvCacheType || parsed.kvOffload !== expected.kvOffload) return null;
  const option: ContextDiscoveryOption = { ...parsed, restored: true };
  return option;
}

/** Fresh results replace the saved value for the same KV mode; modes the new run did not establish keep their last successful value. */
export function mergeSavedDiscoveryOptions(fresh: readonly ContextDiscoveryOption[], saved: readonly ContextDiscoveryOption[]): ContextDiscoveryOption[] {
  const covered = new Set(fresh.map((option) => `${option.kvCacheType}:${option.kvOffload}`));
  return [...fresh, ...saved.filter((option) => !covered.has(`${option.kvCacheType}:${option.kvOffload}`))]
    .sort((left, right) => left.contextWindow - right.contextWindow || left.kvCacheType.localeCompare(right.kvCacheType));
}

const valueArguments = new Set(['--ctx-size', '-c', '--cache-type-k', '--cache-type-v', '--cache-type-k-draft', '--cache-type-v-draft', '--host', '--port']);
const flagArguments = new Set(['--kv-offload', '--no-kv-offload', '-kvo', '-nkvo']);

/** Launch arguments minus what selects the context/KV mode being calibrated or only where the server listens. */
export function stableRuntimeArguments(args: readonly string[]): string[] {
  const stable: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (valueArguments.has(args[i])) { i += 1; continue; }
    if (flagArguments.has(args[i])) continue;
    stable.push(args[i]);
  }
  return stable;
}

export function buildContextDiscoveryIdentity(input: {
  modelId: string; modelFingerprint: string; projectorFingerprint: string | null; runtimeFingerprint: string;
  arguments: readonly string[]; speculative: string; hardLimit: number; gpu: { name: string; vramTotalBytes: number }; hostReserveBytes: number;
}): ContextDiscoveryIdentity {
  return { modelId: input.modelId, model: input.modelFingerprint, projector: input.projectorFingerprint, runtime: input.runtimeFingerprint,
    arguments: stableRuntimeArguments(input.arguments), speculative: input.speculative, hardLimit: input.hardLimit,
    gpuName: input.gpu.name, vramTotalBytes: input.gpu.vramTotalBytes, hostReserveBytes: input.hostReserveBytes };
}
