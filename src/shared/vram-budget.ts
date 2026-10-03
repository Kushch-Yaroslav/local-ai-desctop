const MiB = 1024 ** 2;
export const nonLlmBudgetBytes = 1550 * MiB;
export const vramEstimatorMarginBytes = 384 * MiB;
export const vramChangeToleranceBytes = 256 * MiB;
export const vramProbeGuardBytes = 150 * MiB;

export interface VramBudget {
  totalBytes: number;
  nonLlmBytes: number;
  llmBytes: number;
  freeBytes: number;
  driverReservedBytes: number;
  backgroundBudgetBytes: number;
  marginBytes: number;
  llmBudgetBytes: number;
  availableLlmBytes: number;
  backgroundOverBudget: boolean;
  loggedDeviceBytes?: number;
  unloggedDeviceBytes?: number;
}

export function createVramBudget(totalBytes: number, usedBytes: number, freeBytes: number, llmBytes: number): VramBudget {
  if (![totalBytes, usedBytes, freeBytes, llmBytes].every((value) => Number.isFinite(value) && value >= 0)
    || totalBytes <= 0 || usedBytes + freeBytes > totalBytes || llmBytes > usedBytes) throw new Error('Invalid owned-process VRAM accounting.');
  const nonLlmBytes = usedBytes - llmBytes;
  const driverReservedBytes = totalBytes - usedBytes - freeBytes;
  const llmBudgetBytes = totalBytes - nonLlmBudgetBytes - vramEstimatorMarginBytes;
  // 1550 MiB is absolute, not added to observed background usage.
  const availableLlmBytes = Math.min(llmBudgetBytes, llmBytes + freeBytes - vramEstimatorMarginBytes);
  return { totalBytes, nonLlmBytes, llmBytes, freeBytes, driverReservedBytes,
    backgroundBudgetBytes: nonLlmBudgetBytes, marginBytes: vramEstimatorMarginBytes,
    llmBudgetBytes, availableLlmBytes, backgroundOverBudget: nonLlmBytes > nonLlmBudgetBytes };
}

export function vramBudgetStillFits(prior: VramBudget, current: VramBudget): boolean {
  return prior.totalBytes === current.totalBytes
    && Math.abs(prior.nonLlmBytes - current.nonLlmBytes) <= vramChangeToleranceBytes
    && prior.llmBytes <= current.availableLlmBytes;
}
