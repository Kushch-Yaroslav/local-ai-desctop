import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HardwareStats } from '../../shared/types';
import { estimateHardwareSafeContext, type ContextEstimatorInput, type RuntimeContextEstimate, type SpeculativeMode } from '../../shared/context-estimator';
import type { RuntimeContextEvidence } from '../backends/types';

type AllocationLocation = 'host' | 'device';
type AllocationKind = 'weights' | 'compute' | 'output' | 'kv' | 'speculativeWeights' | 'speculativeCompute' | 'speculativeKv' | 'ssm';

export interface LlamaAllocationLog {
  modelPath: string | null;
  contextTokens: number | null;
  sequenceSlots: number | null;
  speculativeSlots: number | null;
  speculativeMode: SpeculativeMode;
  visionPresent: boolean | null;
  kvTypeK: string | null;
  kvTypeV: string | null;
  speculativeKvTypeK: string | null;
  speculativeKvTypeV: string | null;
  allocations: Record<AllocationKind, Partial<Record<AllocationLocation, number>>>;
  unknownReasons: string[];
}

export interface ContextEstimateRequest {
  backend: 'ollama' | 'llama-cpp';
  modelId: string;
  configuredMaxTokens: number;
  contextPresets: number[];
  hardware: HardwareStats;
  runtime: RuntimeContextEvidence | null;
  startupLogPath?: string | null;
  hostReserveBytes?: number | null;
  deviceReserveBytes?: number | null;
  reserveErrors?: string[];
}

export const defaultContextHostReserveBytes = 8 * 1024 ** 3;
export const defaultContextDeviceReserveBytes = 2 * 1024 ** 3;

export function resolveContextReserve(value: string | undefined, variable: string, defaultBytes: number): { bytes: number | null; error?: string } {
  if (value === undefined) return { bytes: defaultBytes };
  if (!/^\d+$/.test(value)) return { bytes: null, error: `${variable} must be an integer byte count at least ${defaultBytes}` };
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < defaultBytes) {
    return { bytes: null, error: `${variable} must be a safe integer byte count at least ${defaultBytes}` };
  }
  return { bytes };
}

const allocationKinds: AllocationKind[] = ['weights', 'compute', 'output', 'kv', 'speculativeWeights', 'speculativeCompute', 'speculativeKv', 'ssm'];

function bytesFromSize(value: string, unit: string): number | null {
  const amount = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const normalized = unit.toLowerCase();
  const powers: Record<string, number> = { b: 0, byte: 0, bytes: 0, kib: 1, kb: 1, mib: 2, mb: 2, gib: 3, gb: 3, tib: 4, tb: 4 };
  const power = powers[normalized];
  return power === undefined ? null : Math.ceil(amount * 1024 ** power);
}

function locationOf(line: string): AllocationLocation | null {
  if (/\bCUDA_Host\b|\bCPU(?:_|\b)|\bHOST\b/i.test(line)) return 'host';
  if (/\b(?:CUDA\d*|GPU\d*|ROCm\d*|Vulkan\d*|Metal\d*|SYCL\d*|ACCELERATOR)\b/i.test(line)) return 'device';
  return null;
}

type AllocationPhase = 'target' | 'speculative';
type AllocationMeasurement = { value: number; phase: AllocationPhase; kind: AllocationKind; location: AllocationLocation };

function lastMatchingIndex(lines: string[], pattern: RegExp): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) if (pattern.test(lines[index])) return index;
  return -1;
}

function sizeFromLine(line: string): number | null {
  const match = line.match(/\b(?:buffer size|model size|size)\s*[:=]\s*([\d,.]+)\s*(bytes?|B|[KMGT]i?B)\b/i);
  return match ? bytesFromSize(match[1], match[2]) : null;
}

function kvTypesFromLine(line: string): { key: string; value: string } | null {
  const match = line.match(/\bK\s*\(([^)]+)\):[^,]+,\s*V\s*\(([^)]+)\):/i);
  return match ? { key: match[1].trim(), value: match[2].trim() } : null;
}

function setTier(allocation: Partial<Record<AllocationLocation, number>>, location: AllocationLocation, value: number): void {
  allocation[location] = Math.max(allocation[location] ?? 0, value);
}

/** Parses final non-dry-run allocation evidence; repeat reserve summaries are maxima, not additive allocations. */
export function parseLlamaAllocationLog(text: string): LlamaAllocationLog {
  const lines = text.split(/\r?\n/);
  const offloadIndex = lastMatchingIndex(lines, /load_tensors:.*offloaded\s+\d+\/\d+\s+layers/i);
  const nonZeroWeightsIndex = lastMatchingIndex(lines, /model buffer size\s*=\s*(?!0+(?:\.0+)?\s*(?:MiB|GiB|MB|GB))/i);
  const start = offloadIndex >= 0 ? offloadIndex : Math.max(0, nonZeroWeightsIndex);
  const runtimeInitIndex = lines.findIndex((line, index) => index >= start && /srv.*load_model: initializing,/i.test(line));
  const end = runtimeInitIndex >= start ? runtimeInitIndex + 1 : lines.length;

  const allocations = Object.fromEntries(allocationKinds.map((kind) => [kind, {}])) as LlamaAllocationLog['allocations'];
  const phaseTotals: Record<AllocationPhase, Record<AllocationKind, Partial<Record<AllocationLocation, number>>>> = {
    target: Object.fromEntries(allocationKinds.map((kind) => [kind, {}])) as Record<AllocationKind, Partial<Record<AllocationLocation, number>>>,
    speculative: Object.fromEntries(allocationKinds.map((kind) => [kind, {}])) as Record<AllocationKind, Partial<Record<AllocationLocation, number>>>,
  };
  let contextTokens: number | null = null;
  let sequenceSlots: number | null = null;
  let speculativeSlots: number | null = null;
  let speculativeMode: SpeculativeMode = 'unknown';
  let kvTypeK: string | null = null;
  let kvTypeV: string | null = null;
  let speculativeKvTypeK: string | null = null;
  let speculativeKvTypeV: string | null = null;
  let visionPresent: boolean | null = null;
  let modelPath: string | null = null;
  let visionWeightsBytes = 0;
  let visionComputeBytes = 0;
  let targetKvSummaryBytes: number | null = null;
  let speculativeKvSummaryBytes: number | null = null;
  let targetRsSummaryBytes: number | null = null;
  let sawTargetKvSummary = false;
  let sawSpeculativeKvSummary = false;
  let sawTargetRsSummary = false;
  let targetKvTypesSeen = false;
  let speculativeKvTypesSeen = false;
  let speculativeUsesTargetModel = false;
  let inVisionSection = false;
  let currentPhase: AllocationPhase = 'target';
  const measurements: AllocationMeasurement[] = [];
  let latestContextFromServer: number | null = null;
  for (let index = 0; index < start; index += 1) {
    const line = lines[index];
    const loadedPath = line.match(/srv\s+load_model: loading model ['"](.+?)['"]/i)?.[1]
      ?? line.match(/llama_model_loader: loaded meta data .* from (.+?) \(version GGUF/i)?.[1];
    if (loadedPath) modelPath = loadedPath;
  }

  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    const loadedPath = line.match(/srv\s+load_model: loading model ['"](.+?)['"]/i)?.[1]
      ?? line.match(/llama_model_loader: loaded meta data .* from (.+?) \(version GGUF/i)?.[1];
    if (loadedPath) modelPath = loadedPath;
    if (/clip_model_loader: has vision encoder/i.test(line)) { visionPresent = true; inVisionSection = true; }
    if (/srv.*load_model: initializing,/i.test(line)) {
      const context = line.match(/\bn_ctx_slot\s*=\s*(\d+)\b/i)?.[1];
      if (context) latestContextFromServer = Number(context);
      const slots = line.match(/\bn_slots\s*=\s*(\d+)\b/i)?.[1];
      if (slots) sequenceSlots = Number(slots);
    }
    if (/common_speculative_init_result: creating (MTP|EAGLE|draft)\b/i.test(line)) {
      currentPhase = 'speculative';
      speculativeMode = /EAGLE/i.test(line) ? 'eagle3' : /MTP/i.test(line) ? 'mtp' : 'draft';
      if (/against the target model/i.test(line)) speculativeUsesTargetModel = true;
    }
    if (/speculative.*(?:disabled|none)|draft.*(?:disabled|none)/i.test(line)) speculativeMode = 'none';

    const seqMax = line.match(/\bn_seq_max\s*=\s*(\d+)\b/i)?.[1];
    if (seqMax) {
      const slots = Number(seqMax);
      if (currentPhase === 'speculative') speculativeSlots = slots;
      else sequenceSlots = slots;
    }
    const context = line.match(/\bn_ctx(?:_slot|_seq)?\s*=\s*(\d+)\b/i)?.[1];
    if (context && currentPhase === 'target') contextTokens = Number(context);

    const types = kvTypesFromLine(line);
    if (types) {
      if (/llama_kv_cache/i.test(line)) {
        if (currentPhase === 'speculative') { speculativeKvTypeK = types.key; speculativeKvTypeV = types.value; speculativeKvTypesSeen = true; }
        else { kvTypeK = types.key; kvTypeV = types.value; targetKvTypesSeen = true; }
      }
    }

    const totalSize = sizeFromLine(line);
    if (/llama_kv_cache: size\s*=/i.test(line) && totalSize !== null) {
      if (currentPhase === 'speculative') { speculativeKvSummaryBytes = totalSize; sawSpeculativeKvSummary = true; }
      else { targetKvSummaryBytes = totalSize; sawTargetKvSummary = true; }
    }
    if (/llama_memory_recurrent: size\s*=/i.test(line) && totalSize !== null && currentPhase === 'target') {
      targetRsSummaryBytes = totalSize;
      sawTargetRsSummary = true;
    }

    if (inVisionSection && /load_hparams: model size:/i.test(line) && totalSize !== null) visionWeightsBytes = Math.max(visionWeightsBytes, totalSize);
    if (/reserve_compute_meta:.*CPU compute buffer size/i.test(line) && totalSize !== null) visionComputeBytes = Math.max(visionComputeBytes, totalSize);

    let kind: AllocationKind | null = null;
    if (/llama_kv_cache:.*KV buffer size/i.test(line)) kind = currentPhase === 'speculative' ? 'speculativeKv' : 'kv';
    else if (/llama_memory_recurrent:.*RS buffer size/i.test(line)) kind = 'ssm';
    else if (/load_tensors:.*model buffer size/i.test(line)) kind = currentPhase === 'speculative' ? 'speculativeWeights' : 'weights';
    else if (/sched_reserve:.*compute buffer size/i.test(line)) kind = currentPhase === 'speculative' ? 'speculativeCompute' : 'compute';
    else if (/llama_context:.*output buffer size/i.test(line)) kind = 'output';
    if (!kind || totalSize === null || totalSize <= 0) continue;
    const location = locationOf(line);
    if (!location) continue;
    measurements.push({ value: totalSize, phase: currentPhase, kind, location });
  }
  contextTokens = latestContextFromServer ?? contextTokens;

  for (const measurement of measurements) {
    const target = phaseTotals[measurement.phase][measurement.kind];
    setTier(target, measurement.location, measurement.value);
  }
  allocations.weights = { ...phaseTotals.target.weights };
  allocations.compute = { ...phaseTotals.target.compute };
  allocations.output = { ...phaseTotals.target.output };
  allocations.kv = { ...phaseTotals.target.kv };
  allocations.ssm = { ...phaseTotals.target.ssm };
  allocations.speculativeWeights = { ...phaseTotals.speculative.speculativeWeights };
  allocations.speculativeCompute = { ...phaseTotals.speculative.speculativeCompute };
  allocations.output.host = (allocations.output.host ?? 0) + (phaseTotals.speculative.output.host ?? 0);
  allocations.output.device = (allocations.output.device ?? 0) + (phaseTotals.speculative.output.device ?? 0);
  allocations.speculativeKv = { ...phaseTotals.speculative.speculativeKv };

  if (visionWeightsBytes > 0) allocations.weights.host = (allocations.weights.host ?? 0) + visionWeightsBytes;
  if (visionComputeBytes > 0) allocations.compute.host = (allocations.compute.host ?? 0) + visionComputeBytes;
  if (Object.keys(allocations.output).length) {
    allocations.output.host ??= 0;
    allocations.output.device ??= 0;
  }
  if (targetKvSummaryBytes !== null) {
    const allocated = Object.values(allocations.kv).reduce((sum, value) => sum + (value ?? 0), 0);
    if (Math.abs(targetKvSummaryBytes - allocated) <= 1024 ** 2) {
      for (const location of ['host', 'device'] as const) allocations.kv[location] ??= 0;
    }
  }
  if (speculativeKvSummaryBytes !== null) {
    const allocated = Object.values(allocations.speculativeKv).reduce((sum, value) => sum + (value ?? 0), 0);
    if (Math.abs(speculativeKvSummaryBytes - allocated) <= 1024 ** 2) {
      for (const location of ['host', 'device'] as const) allocations.speculativeKv[location] ??= 0;
    }
  }
  if (sawTargetRsSummary && targetRsSummaryBytes !== null) {
    const allocated = Object.values(allocations.ssm).reduce((sum, value) => sum + (value ?? 0), 0);
    if (Math.abs(targetRsSummaryBytes - allocated) <= 1024 ** 2) {
      for (const location of ['host', 'device'] as const) allocations.ssm[location] ??= 0;
    }
  }
  if (speculativeMode === 'none' || speculativeUsesTargetModel) {
    allocations.speculativeWeights = { host: 0, device: 0 };
  }
  if (speculativeMode === 'none') {
    speculativeSlots = 0;
    allocations.speculativeCompute = { host: 0, device: 0 };
    allocations.speculativeKv = { host: 0, device: 0 };
  }

  const unknownReasons: string[] = [];
  if (!contextTokens) unknownReasons.push('startup log has no active per-sequence context allocation');
  if (!sequenceSlots) unknownReasons.push('startup log has no target sequence-slot count');
  if (speculativeMode === 'unknown') unknownReasons.push('startup log does not confirm speculative mode');
  if (speculativeMode !== 'none' && !speculativeSlots) unknownReasons.push('startup log has no draft sequence-slot count');
  if (!targetKvTypesSeen || !kvTypeK || !kvTypeV) unknownReasons.push('startup log does not report target K/V cache precisions');
  if (speculativeMode !== 'none' && (!speculativeKvTypesSeen || !speculativeKvTypeK || !speculativeKvTypeV)) unknownReasons.push('startup log does not report draft K/V cache precisions');
  if (visionPresent === null) unknownReasons.push('startup log does not confirm whether a vision projector is loaded');
  if (visionPresent && !visionWeightsBytes) unknownReasons.push('startup log has no vision projector weight size');
  if (visionPresent && !visionComputeBytes) unknownReasons.push('startup log has no vision projector compute reservation');
  for (const kind of allocationKinds) {
    if (kind === 'speculativeWeights' && (speculativeMode === 'none' || speculativeUsesTargetModel)) continue;
    if (speculativeMode === 'none' && ['speculativeCompute', 'speculativeKv'].includes(kind)) continue;
    if (!Object.keys(allocations[kind]).length) unknownReasons.push(`startup log has no final ${kind} allocation`);
  }
  if (!sawTargetKvSummary) unknownReasons.push('startup log has no target KV allocation summary');
  if (speculativeMode !== 'none' && !sawSpeculativeKvSummary) unknownReasons.push('startup log has no draft KV allocation summary');
  if (!sawTargetRsSummary) unknownReasons.push('startup log has no recurrent-state allocation summary');
  return {
    modelPath,
    contextTokens,
    sequenceSlots,
    speculativeSlots,
    speculativeMode,
    visionPresent,
    kvTypeK,
    kvTypeV,
    speculativeKvTypeK,
    speculativeKvTypeV,
    allocations,
    unknownReasons: [...new Set(unknownReasons)],
  };
}

function totalFor(allocation: Partial<Record<AllocationLocation, number>>, location: AllocationLocation): number {
  return allocation[location] ?? 0;
}

function completeAllocationTier(log: LlamaAllocationLog, location: AllocationLocation): boolean {
  return allocationKinds.every((kind) => (log.speculativeMode === 'none' && (kind === 'speculativeWeights' || kind === 'speculativeCompute'))
    || Object.prototype.hasOwnProperty.call(log.allocations[kind], location));
}

function createEstimatorInput(request: ContextEstimateRequest, log: LlamaAllocationLog): ContextEstimatorInput | null {
  const { hardware } = request;
  if (!hardware.available || hardware.ramTotalBytes <= 0 || hardware.ramUsedBytes < 0 || hardware.ramUsedBytes > hardware.ramTotalBytes) return null;
  if (!log.contextTokens || !log.sequenceSlots || log.speculativeSlots === null || log.unknownReasons.length) return null;
  if (request.hostReserveBytes == null || request.deviceReserveBytes == null) return null;
  if (!completeAllocationTier(log, 'host') || !completeAllocationTier(log, 'device')) return null;
  const hostCurrentAllocations = allocationKinds.reduce((sum, kind) => sum + totalFor(log.allocations[kind], 'host'), 0);
  const deviceCurrentAllocations = allocationKinds.reduce((sum, kind) => sum + totalFor(log.allocations[kind], 'device'), 0);
  const currentHostAvailable = Math.max(0, hardware.ramTotalBytes - hardware.ramUsedBytes);
  const vramTotalBytes = hardware.vramTotalBytes;
  const vramUsedBytes = hardware.vramUsedBytes;
  if (vramTotalBytes === null || vramUsedBytes === null || vramTotalBytes <= 0 || vramUsedBytes < 0 || vramUsedBytes > vramTotalBytes) return null;
  const currentDeviceAvailable = Math.max(0, vramTotalBytes - vramUsedBytes);

  return {
    configuredMaxTokens: request.configuredMaxTokens,
    contextPresets: request.contextPresets,
    hostAvailableBytes: currentHostAvailable + hostCurrentAllocations,
    deviceAvailableBytes: currentDeviceAvailable + deviceCurrentAllocations,
    hostReserveBytes: request.hostReserveBytes,
    deviceReserveBytes: request.deviceReserveBytes,
    hostWeightBytes: totalFor(log.allocations.weights, 'host') + totalFor(log.allocations.compute, 'host') + totalFor(log.allocations.output, 'host') + totalFor(log.allocations.ssm, 'host'),
    deviceWeightBytes: totalFor(log.allocations.weights, 'device') + totalFor(log.allocations.compute, 'device') + totalFor(log.allocations.output, 'device') + totalFor(log.allocations.ssm, 'device'),
    hostKvBytesPerToken: totalFor(log.allocations.kv, 'host') / (log.contextTokens * log.sequenceSlots),
    deviceKvBytesPerToken: totalFor(log.allocations.kv, 'device') / (log.contextTokens * log.sequenceSlots),
    speculativeHostKvBytesPerToken: log.speculativeSlots ? totalFor(log.allocations.speculativeKv, 'host') / (log.contextTokens * log.speculativeSlots) : 0,
    speculativeDeviceKvBytesPerToken: log.speculativeSlots ? totalFor(log.allocations.speculativeKv, 'device') / (log.contextTokens * log.speculativeSlots) : 0,
    sequenceSlots: log.sequenceSlots,
    speculativeMode: log.speculativeMode,
    speculativeHostWeightBytes: totalFor(log.allocations.speculativeWeights, 'host'),
    speculativeDeviceWeightBytes: totalFor(log.allocations.speculativeWeights, 'device'),
    speculativeHostBufferBytesPerSlot: log.speculativeSlots ? totalFor(log.allocations.speculativeCompute, 'host') / log.speculativeSlots : 0,
    speculativeDeviceBufferBytesPerSlot: log.speculativeSlots ? totalFor(log.allocations.speculativeCompute, 'device') / log.speculativeSlots : 0,
    speculativeSlots: log.speculativeSlots,
  };
}

export async function readLlamaAllocationLog(path: string | null | undefined): Promise<{ text: string | null; reason?: string }> {
  if (!path) return { text: null, reason: 'LOCAL_AI_LLAMA_SERVER_LOG is not configured' };
  try {
    return { text: await readFile(path, 'utf8') };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { text: null, reason: 'configured llama-server allocation log was not found' };
    throw error;
  }
}

/** Uses live runtime observations as a known-running baseline; extrapolates only with complete logged allocations and explicit reserves. */
export async function collectRuntimeContextEstimate(
  request: ContextEstimateRequest,
  readLog: typeof readLlamaAllocationLog = readLlamaAllocationLog,
): Promise<RuntimeContextEstimate> {
  const observed = request.runtime?.backend === request.backend && request.runtime.modelId === request.modelId ? request.runtime : null;
  const base: RuntimeContextEstimate = {
    backend: request.backend,
    modelId: request.modelId,
    configuredMaxTokens: Number.isSafeInteger(request.configuredMaxTokens) && request.configuredMaxTokens > 0 ? request.configuredMaxTokens : null,
    modelTrainContextTokens: observed?.modelTrainContextTokens ?? null,
    observedContextTokens: observed?.activeContextTokens ?? null,
    modelFileSizeBytes: observed?.modelFileSizeBytes ?? null,
    observedResidentBytes: observed?.residentBytes ?? null,
    observedDeviceResidentBytes: observed?.deviceResidentBytes ?? null,
    hardwareSafeTokens: null,
    status: observed ? 'observed' : 'unknown',
    source: observed ? 'live-runtime' : 'none',
    unknownReasons: [],
    estimator: null,
  };
  if (request.reserveErrors?.length) {
    return { ...base, unknownReasons: [...request.reserveErrors] };
  }
  if (request.backend !== 'llama-cpp') {
    return { ...base, unknownReasons: ['Ollama does not expose KV allocation, KV precision, slot allocation, or memory reserves needed for context extrapolation'] };
  }
  if (!observed) {
    return { ...base, unknownReasons: ['active runtime context is not reported for this model; startup log alone does not prove it is currently loaded'] };
  }
  const logResult = await readLog(request.startupLogPath);
  if (!logResult.text) {
    return { ...base, unknownReasons: [logResult.reason ?? 'llama-server allocation log unavailable'] };
  }
  const allocationEvidence = parseLlamaAllocationLog(logResult.text);
  if (allocationEvidence.contextTokens !== observed.activeContextTokens) {
    return {
      ...base,
      unknownReasons: [`allocation log context (${allocationEvidence.contextTokens ?? 'unknown'}) does not match active runtime context (${observed.activeContextTokens})`],
      allocationEvidence,
    };
  }
  if (!observed.modelPath || !allocationEvidence.modelPath || resolve(observed.modelPath) !== resolve(allocationEvidence.modelPath)) {
    return {
      ...base,
      unknownReasons: ['allocation log model path does not confirm the currently selected runtime model'],
      allocationEvidence,
    };
  }
  const estimatorInput = createEstimatorInput(request, allocationEvidence);
  if (!estimatorInput) {
    const vramTotalBytes = request.hardware.vramTotalBytes;
    const vramUsedBytes = request.hardware.vramUsedBytes;
    const reserveReasons = [
      ...(request.hostReserveBytes == null ? ['explicit system RAM reserve is not configured'] : []),
      ...(request.deviceReserveBytes == null ? ['explicit accelerator-memory reserve is not configured'] : []),
      ...(!request.hardware.available || request.hardware.ramTotalBytes <= 0 || request.hardware.ramUsedBytes < 0 || request.hardware.ramUsedBytes > request.hardware.ramTotalBytes ? ['system memory snapshot is unavailable or invalid'] : []),
      ...(vramTotalBytes === null || vramUsedBytes === null || vramTotalBytes <= 0 || vramUsedBytes < 0 || vramUsedBytes > vramTotalBytes ? ['accelerator memory availability is unavailable or invalid'] : []),
      ...(!completeAllocationTier(allocationEvidence, 'host') ? ['startup log does not provide complete host allocation categories'] : []),
      ...(!completeAllocationTier(allocationEvidence, 'device') ? ['startup log does not provide complete accelerator allocation categories'] : []),
    ];
    return {
      ...base,
      source: observed ? 'live-runtime' : 'startup-log',
      unknownReasons: [...allocationEvidence.unknownReasons, ...reserveReasons],
      allocationEvidence,
    };
  }
  const maximumContextFromLog = allocationEvidence.contextTokens ?? 0;
  const estimator = estimateHardwareSafeContext({
    ...estimatorInput,
    contextPresets: estimatorInput.contextPresets.filter((preset) => preset <= maximumContextFromLog),
  });
  const isEstimate = estimator.hardwareSafeTokens !== null;
  return {
    ...base,
    hardwareSafeTokens: estimator.hardwareSafeTokens,
    status: isEstimate ? 'estimated' : observed ? 'observed' : 'unknown',
    source: 'startup-log',
    unknownReasons: estimator.unknownReasons,
    estimator,
    allocationEvidence,
  };
}
