import type { ContextDiscoveryOption, ContextDiscoveryResult, ContextProbeRecord, RuntimeContextEstimate } from '../../shared/context-estimator';

const bucket = 4_096;
const granularity = 8_192;
const maxSearchProbes = 6;
const emergencyHostReserve = 4 * 1024 ** 3;
const emergencyDeviceReserve = 1024 ** 3;
const predictionUncertaintyBytes = 256 * 1024 ** 2;

export type DiscoveryProbe = {
  record: ContextProbeRecord;
  estimate: RuntimeContextEstimate | null;
};

export type DiscoveryDependencies = {
  modelId: string;
  hardLimit: number;
  kvOffload: boolean;
  hostReserveBytes: number;
  deviceReserveBytes: number;
  probe: (context: number, mode: 'f16' | 'q8_0', phase: ContextProbeRecord['phase']) => Promise<DiscoveryProbe>;
  restore: () => Promise<void>;
  progress: (stage: string, probeCount: number) => void;
};

function variableBytes(sample: RuntimeContextEstimate, tier: 'host' | 'device', compute: boolean): number {
  const evidence = sample.allocationEvidence;
  if (!evidence) return 0;
  const kinds = compute ? ['compute', 'speculativeCompute', 'output', 'ssm'] as const : ['kv', 'speculativeKv'] as const;
  return kinds.reduce((sum, kind) => sum + (evidence.allocations[kind][tier] ?? 0), 0);
}

/** KV is linear; compute growth is inferred from exact-context measurements.
 * Before a second point exists, budget all compute as context-proportional.
 * Unlogged CUDA/runtime residency stays in the measured free-memory baseline. */
export function predictContextHeadroom(samples: readonly RuntimeContextEstimate[], context: number) {
  const latest = samples.at(-1);
  if (!latest?.memoryHeadroom || !latest.observedContextTokens || !latest.allocationEvidence) return null;
  const current = latest.observedContextTokens;
  const result = { hostBytes: 0, deviceBytes: 0 };
  for (const tier of ['host', 'device'] as const) {
    const kvSlope = variableBytes(latest, tier, false) / current;
    const other = samples.find((sample) => sample.observedContextTokens && sample.observedContextTokens !== current);
    const computeSlope = other?.observedContextTokens
      ? Math.max(0, (variableBytes(latest, tier, true) - variableBytes(other, tier, true)) / (current - other.observedContextTokens))
      : variableBytes(latest, tier, true) / current;
    result[tier === 'host' ? 'hostBytes' : 'deviceBytes'] =
      latest.memoryHeadroom[tier === 'host' ? 'hostBytes' : 'deviceBytes'] - (context - current) * (kvSlope + computeSlope);
  }
  return result;
}

function predictionFits(samples: readonly RuntimeContextEstimate[], context: number, hostReserve: number, deviceReserve: number) {
  const predicted = predictContextHeadroom(samples, context);
  return predicted !== null && predicted.hostBytes >= hostReserve + predictionUncertaintyBytes
    && predicted.deviceBytes >= deviceReserve + predictionUncertaintyBytes;
}

function predictedCeiling(samples: readonly RuntimeContextEstimate[], upper: number, hostReserve: number, deviceReserve: number): number {
  let low = 0;
  let high = Math.floor(upper / bucket) + 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (predictionFits(samples, middle * bucket, hostReserve, deviceReserve)) low = middle;
    else high = middle;
  }
  return low * bucket;
}

function completeSample(probe: DiscoveryProbe, context: number, mode: 'f16' | 'q8_0', offload: boolean): probe is DiscoveryProbe & { estimate: RuntimeContextEstimate } {
  const sample = probe.estimate;
  return probe.record.startup && probe.record.health && probe.record.inference
    && sample?.status === 'estimated' && sample.observedContextTokens === context
    && sample.activeKvCacheType === mode && sample.activeKvOffload === offload
    && sample.memoryBaseline !== null && sample.memoryHeadroom !== null && sample.allocationEvidence !== undefined;
}

export async function discoverContextBoundary(deps: DiscoveryDependencies): Promise<ContextDiscoveryResult> {
  const options: ContextDiscoveryOption[] = [];
  const unsupported: ContextDiscoveryResult['unsupported'] = [];
  const probes: ContextProbeRecord[] = [];
  const hardLimit = Math.floor(deps.hardLimit / bucket) * bucket;
  const baseContext = Math.min(16_384, hardLimit);
  if (hardLimit < bucket) throw new Error('Model/backend context limit is below the minimum discovery bucket.');
  const runProbe = async (context: number, mode: 'f16' | 'q8_0', phase: ContextProbeRecord['phase']) => {
    deps.progress(`${mode === 'f16' ? 'FP16' : 'Q8'} · ${context / 1024}K · ${phase}`, probes.length + 1);
    const probe = await deps.probe(context, mode, phase);
    probes.push(probe.record);
    return probe;
  };
  try {
    for (const mode of ['f16', 'q8_0'] as const) {
      const base = await runProbe(baseContext, mode, 'base');
      if (!completeSample(base, baseContext, mode, deps.kvOffload)) {
        unsupported.push({ kvCacheType: mode, reason: base.record.reason ?? 'Missing matching allocation, health, or completed inference evidence.' });
        continue;
      }
      const samples = [base.estimate];
      let low = baseContext;
      let high = hardLimit + bucket;
      let latestGood = base;
      let candidate = predictedCeiling(samples, hardLimit, emergencyHostReserve, emergencyDeviceReserve);
      for (let attempt = 0; attempt < maxSearchProbes && high - low > granularity; attempt += 1) {
        candidate = Math.min(candidate, high - bucket, hardLimit);
        if (candidate <= low) break;
        if (!predictionFits(samples, candidate, emergencyHostReserve, emergencyDeviceReserve)) {
          probes.push({ kvCacheType: mode, contextWindow: candidate, phase: 'search', startup: false, health: false, inference: false, fits: false,
            reason: 'Skipped before startup: projected memory would cross the emergency reserve plus uncertainty guard.',
            headroom: predictContextHeadroom(samples, candidate), memoryBaseline: null, elapsedMs: 0 });
          high = candidate;
        } else {
          const probe = await runProbe(candidate, mode, 'search');
          if (completeSample(probe, candidate, mode, deps.kvOffload)
            && probe.estimate.memoryHeadroom!.hostBytes >= emergencyHostReserve
            && probe.estimate.memoryHeadroom!.deviceBytes >= emergencyDeviceReserve) {
            samples.push(probe.estimate);
            low = candidate;
            latestGood = probe;
            probe.record.fits = true;
          } else {
            high = candidate;
          }
        }
        if (low === hardLimit) break;
        candidate = Math.floor((low + high) / (2 * bucket)) * bucket;
      }
      // One final safety policy: keep explicit RAM/VRAM headroom, not stacked
      // KV multipliers or arbitrary percentage reductions of context.
      let finalContext = Math.min(low, predictedCeiling(samples, low, deps.hostReserveBytes, deps.deviceReserveBytes));
      if (finalContext < baseContext) {
        unsupported.push({ kvCacheType: mode, reason: 'No context left the final RAM/VRAM reserves.' });
        continue;
      }
      let final = finalContext === low ? latestGood : await runProbe(finalContext, mode, 'final');
      const finalFits = (probe: DiscoveryProbe, context: number) => completeSample(probe, context, mode, deps.kvOffload)
        && probe.estimate.memoryHeadroom!.hostBytes >= deps.hostReserveBytes
        && probe.estimate.memoryHeadroom!.deviceBytes >= deps.deviceReserveBytes;
      if (!finalFits(final, finalContext) && finalContext > baseContext) {
        finalContext = Math.floor((baseContext + finalContext) / (2 * bucket)) * bucket;
        final = await runProbe(finalContext, mode, 'final');
      }
      if (!finalFits(final, finalContext) || !final.estimate?.memoryBaseline || !final.estimate.memoryHeadroom) {
        unsupported.push({ kvCacheType: mode, reason: final.record.reason ?? 'Exact final-context inference did not leave the required reserves.' });
        continue;
      }
      final.record.fits = true;
      options.push({ modelId: deps.modelId, contextWindow: finalContext, kvCacheType: mode, kvOffload: deps.kvOffload,
        discoveredAt: new Date().toISOString(), memoryBaseline: final.estimate.memoryBaseline,
        measuredHeadroom: final.estimate.memoryHeadroom, boundaryTokens: low });
    }
    const f16 = options.find((option) => option.kvCacheType === 'f16');
    const q8 = options.find((option) => option.kvCacheType === 'q8_0');
    if (q8 && (!f16 || q8.contextWindow < f16.contextWindow + granularity)) {
      options.splice(options.indexOf(q8), 1);
      unsupported.push({ kvCacheType: 'q8_0', reason: 'Q8 did not establish a verified improvement of at least 8K over FP16.' });
    }
  } finally {
    deps.progress('Восстановление исходного runtime…', probes.length);
    await deps.restore();
  }
  return { modelId: deps.modelId, probeContextTokens: baseContext, hardLimit, options, unsupported, restored: true, probes };
}
