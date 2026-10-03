export type SpeculativeMode = 'none' | 'mtp' | 'eagle3' | 'draft' | 'unknown';

export interface ContextEstimatorInput {
  configuredMaxTokens: number;
  contextPresets: number[];
  hostAvailableBytes: number | null;
  deviceAvailableBytes: number | null;
  hostReserveBytes: number | null;
  deviceReserveBytes: number | null;
  hostWeightBytes: number | null;
  deviceWeightBytes: number | null;
  hostKvBytesPerToken: number | null;
  deviceKvBytesPerToken: number | null;
  speculativeHostKvBytesPerToken: number | null;
  speculativeDeviceKvBytesPerToken: number | null;
  sequenceSlots: number | null;
  speculativeMode: SpeculativeMode;
  speculativeHostWeightBytes: number | null;
  speculativeDeviceWeightBytes: number | null;
  speculativeHostBufferBytesPerSlot: number | null;
  speculativeDeviceBufferBytesPerSlot: number | null;
  speculativeSlots: number | null;
}

export interface ContextEstimatorResult {
  configuredMaxTokens: number | null;
  hardwareSafeTokens: number | null;
  unknownReasons: string[];
}

export interface RuntimeContextEstimate {
  backend: 'ollama' | 'llama-cpp';
  modelId: string;
  configuredMaxTokens: number | null;
  modelTrainContextTokens: number | null;
  observedContextTokens: number | null;
  modelFileSizeBytes: number | null;
  observedResidentBytes: number | null;
  observedDeviceResidentBytes: number | null;
  hardwareSafeTokens: number | null;
  status: 'estimated' | 'observed' | 'unknown';
  source: 'live-runtime' | 'startup-log' | 'none';
  unknownReasons: string[];
  estimator: ContextEstimatorResult | null;
  allocationEvidence?: {
    contextTokens: number | null;
    sequenceSlots: number | null;
    speculativeSlots: number | null;
    speculativeMode: SpeculativeMode;
    kvTypeK: string | null;
    kvTypeV: string | null;
    speculativeKvTypeK: string | null;
    speculativeKvTypeV: string | null;
    allocations: Record<'weights' | 'compute' | 'output' | 'kv' | 'speculativeWeights' | 'speculativeCompute' | 'speculativeKv' | 'ssm', Partial<Record<'host' | 'device', number>>>;
    unknownReasons: string[];
  };
}

const requiredByteFields = [
  'hostAvailableBytes',
  'deviceAvailableBytes',
  'hostReserveBytes',
  'deviceReserveBytes',
  'hostWeightBytes',
  'deviceWeightBytes',
  'hostKvBytesPerToken',
  'deviceKvBytesPerToken',
  'speculativeHostKvBytesPerToken',
  'speculativeDeviceKvBytesPerToken',
  'sequenceSlots',
  'speculativeHostWeightBytes',
  'speculativeDeviceWeightBytes',
  'speculativeHostBufferBytesPerSlot',
  'speculativeDeviceBufferBytesPerSlot',
  'speculativeSlots',
] as const;

type RequiredEstimatorNumber = typeof requiredByteFields[number];

const displayNames: Partial<Record<keyof ContextEstimatorInput, string>> = {
  hostAvailableBytes: 'available system RAM',
  deviceAvailableBytes: 'available accelerator memory',
  hostReserveBytes: 'system RAM reserve',
  deviceReserveBytes: 'accelerator memory reserve',
  hostWeightBytes: 'model weight residency in system RAM',
  deviceWeightBytes: 'model weight residency in accelerator memory',
  hostKvBytesPerToken: 'KV-cache bytes per token in system RAM',
  deviceKvBytesPerToken: 'KV-cache bytes per token in accelerator memory',
  speculativeHostKvBytesPerToken: 'draft KV-cache bytes per token in system RAM',
  speculativeDeviceKvBytesPerToken: 'draft KV-cache bytes per token in accelerator memory',
  sequenceSlots: 'runtime sequence-slot count',
  speculativeHostWeightBytes: 'draft/MTP weight residency in system RAM',
  speculativeDeviceWeightBytes: 'draft/MTP weight residency in accelerator memory',
  speculativeHostBufferBytesPerSlot: 'draft/MTP buffer size in system RAM',
  speculativeDeviceBufferBytesPerSlot: 'draft/MTP buffer size in accelerator memory',
  speculativeSlots: 'draft/MTP slot count',
};

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasCompleteMemoryMetadata(input: ContextEstimatorInput): input is ContextEstimatorInput & Record<RequiredEstimatorNumber, number> {
  return requiredByteFields.every((field) => isNonNegativeFinite(input[field]));
}

/** Returns only supported presets that fit every known runtime memory budget. */
export function estimateHardwareSafeContext(input: ContextEstimatorInput): ContextEstimatorResult {
  const configuredMaxTokens = Number.isSafeInteger(input.configuredMaxTokens) && input.configuredMaxTokens > 0
    ? input.configuredMaxTokens
    : null;
  const unknownReasons = requiredByteFields
    .filter((field) => !isNonNegativeFinite(input[field]))
    .map((field) => displayNames[field] ?? String(field));

  if (!configuredMaxTokens) unknownReasons.unshift('valid configured model/runtime maximum');
  if (input.speculativeMode === 'unknown') unknownReasons.push('whether speculative decoding is enabled');
  if (!Number.isSafeInteger(input.sequenceSlots) || (input.sequenceSlots ?? 0) < 1) {
    const reason = displayNames.sequenceSlots ?? 'runtime sequence-slot count';
    if (!unknownReasons.includes(reason)) unknownReasons.push(reason);
  }
  if (!Number.isSafeInteger(input.speculativeSlots) || (input.speculativeSlots ?? 0) < 0) {
    const reason = displayNames.speculativeSlots ?? 'draft/MTP slot count';
    if (!unknownReasons.includes(reason)) unknownReasons.push(reason);
  }

  if (unknownReasons.length || !configuredMaxTokens || !hasCompleteMemoryMetadata(input)) {
    return { configuredMaxTokens, hardwareSafeTokens: null, unknownReasons: [...new Set(unknownReasons)] };
  }

  const presets = [...new Set(input.contextPresets)]
    .filter((preset) => Number.isSafeInteger(preset) && preset > 0 && preset <= configuredMaxTokens)
    .sort((left, right) => left - right);
  const fits = presets.filter((contextTokens) => {
    const hostRequired = input.hostWeightBytes
      + input.speculativeHostWeightBytes
      + input.speculativeHostBufferBytesPerSlot * input.speculativeSlots
      + input.hostKvBytesPerToken * contextTokens * input.sequenceSlots
      + input.speculativeHostKvBytesPerToken * contextTokens * input.speculativeSlots
      + input.hostReserveBytes;
    const deviceRequired = input.deviceWeightBytes
      + input.speculativeDeviceWeightBytes
      + input.speculativeDeviceBufferBytesPerSlot * input.speculativeSlots
      + input.deviceKvBytesPerToken * contextTokens * input.sequenceSlots
      + input.speculativeDeviceKvBytesPerToken * contextTokens * input.speculativeSlots
      + input.deviceReserveBytes;
    return Number.isFinite(hostRequired) && Number.isFinite(deviceRequired)
      && hostRequired <= input.hostAvailableBytes && deviceRequired <= input.deviceAvailableBytes;
  });
  return {
    configuredMaxTokens,
    hardwareSafeTokens: fits.at(-1) ?? 0,
    unknownReasons: [],
  };
}
