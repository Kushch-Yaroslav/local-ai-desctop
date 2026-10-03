import assert from 'node:assert/strict';
import { collectRuntimeContextEstimate, defaultContextDeviceReserveBytes, defaultContextHostReserveBytes, parseLlamaAllocationLog, resolveContextReserve } from './context-estimate';
import type { HardwareStats } from '../../shared/types';
import type { RuntimeContextEvidence } from '../backends/types';

const allocationLog = `
I srv load_model: loading model '/models/target.gguf'
I load_tensors: offloaded 66/66 layers to GPU
I load_tensors: CUDA0 model buffer size = 0.00 MiB
I load_tensors: CPU_Mapped model buffer size = 0.00 MiB
I llama_context: n_seq_max = 1
I llama_kv_cache: CUDA0 KV buffer size = 0.00 MiB
I load_tensors: CPU_Mapped model buffer size = 682.03 MiB
I load_tensors: CUDA0 model buffer size = 15339.44 MiB
I llama_context: n_seq_max = 1
I llama_context: n_ctx = 32768
I llama_context: CUDA_Host output buffer size = 0.95 MiB
I llama_kv_cache: CUDA0 KV buffer size = 2048.00 MiB
I llama_kv_cache: size = 2048.00 MiB (32768 cells, 16 layers, 1/1 seqs), K (f16): 1024 MiB, V (f16): 1024 MiB
I llama_memory_recurrent: CUDA0 RS buffer size = 598.50 MiB
I llama_memory_recurrent: size = 598.50 MiB (1 cells, 64 layers, 1 seqs 3 rs_seq), R (f32): 22.5 MiB, S (f32): 576 MiB
I sched_reserve: CUDA0 compute buffer size = 154.02 MiB
I sched_reserve: CUDA_Host compute buffer size = 52.02 MiB
I sched_reserve: CUDA0 compute buffer size = 154.02 MiB
I common_speculative_init_result: creating MTP draft context against the target model 'target.gguf'
I llama_context: n_seq_max = 1
I llama_context: n_ctx = 32768
I llama_context: CUDA_Host output buffer size = 0.95 MiB
I llama_kv_cache: CUDA0 KV buffer size = 128.00 MiB
I llama_kv_cache: size = 128.00 MiB (32768 cells, 1 layer, 1/1 seqs), K (f16): 64 MiB, V (f16): 64 MiB
I sched_reserve: CUDA0 compute buffer size = 130.02 MiB
I sched_reserve: CUDA_Host compute buffer size = 52.02 MiB
I clip_model_loader: has vision encoder
I load_hparams: model size: 887.99 MiB
I reserve_compute_meta: CPU compute buffer size = 248.10 MiB
I srv load_model: initializing, n_slots = 1, n_ctx_slot = 32768, kv_unified = 'false'
I sched_reserve: CUDA0 compute buffer size = 130.02 MiB
I sched_reserve: CUDA_Host compute buffer size = 52.02 MiB
I later request prompt: speculative decoding disabled in example text
`;

const hardware: HardwareStats = {
  ramUsedBytes: 8 * 1024 ** 3,
  ramTotalBytes: 32 * 1024 ** 3,
  vramUsedBytes: 19_707 * 1024 ** 2,
  vramTotalBytes: 24_118 * 1024 ** 2,
  gpuUtilization: 0,
  available: true,
};
const runtime: RuntimeContextEvidence = {
  backend: 'llama-cpp',
  modelId: 'runtime-model',
  modelPath: '/models/target.gguf',
  activeContextTokens: 32_768,
  modelFileSizeBytes: 17_000_000_000,
};

export async function runContextEstimateRegression(): Promise<void> {
  assert.deepEqual(resolveContextReserve(undefined, 'HOST_RESERVE', defaultContextHostReserveBytes), { bytes: 8 * 1024 ** 3 });
  assert.deepEqual(resolveContextReserve(undefined, 'DEVICE_RESERVE', defaultContextDeviceReserveBytes), { bytes: 2 * 1024 ** 3 });
  assert.deepEqual(resolveContextReserve(String(12 * 1024 ** 3), 'HOST_RESERVE', defaultContextHostReserveBytes), { bytes: 12 * 1024 ** 3 });
  assert.match(resolveContextReserve(String(4 * 1024 ** 3), 'HOST_RESERVE', defaultContextHostReserveBytes).error ?? '', /at least/);
  assert.match(resolveContextReserve('invalid', 'DEVICE_RESERVE', defaultContextDeviceReserveBytes).error ?? '', /integer byte count/);
  assert.match(resolveContextReserve(String(Number.MAX_SAFE_INTEGER + 1), 'DEVICE_RESERVE', defaultContextDeviceReserveBytes).error ?? '', /safe integer/);

  const parsed = parseLlamaAllocationLog(allocationLog);
  assert.equal(parsed.contextTokens, 32_768);
  assert.equal(parsed.modelPath, runtime.modelPath);
  assert.equal(parsed.sequenceSlots, 1);
  assert.equal(parsed.speculativeMode, 'mtp');
  assert.equal(parsed.speculativeSlots, 1);
  assert.equal(parsed.kvTypeK, 'f16');
  assert.equal(parsed.kvTypeV, 'f16');
  assert.equal(parsed.speculativeKvTypeK, 'f16');
  assert.equal(parsed.speculativeKvTypeV, 'f16');
  assert.ok(Math.abs(parsed.allocations.weights.device! - 15_339.44 * 1024 ** 2) <= 1);
  assert.equal(parsed.allocations.weights.host, Math.ceil(682.03 * 1024 ** 2) + Math.ceil(887.99 * 1024 ** 2));
  assert.equal(parsed.allocations.kv.device, 2048 * 1024 ** 2, 'zero-sized dry-run cache must not replace final allocation');
  assert.ok(Math.abs(parsed.allocations.ssm.device! - 598.5 * 1024 ** 2) <= 1, 'recurrent-state reservation was not accounted');
  assert.ok(Math.abs(parsed.allocations.compute.device! - 154.02 * 1024 ** 2) <= 1, 'duplicate target reservations were summed or draft compute was merged');
  assert.ok(Math.abs(parsed.allocations.speculativeCompute.device! - 130.02 * 1024 ** 2) <= 1, 'MTP compute reservation was not kept distinct');
  assert.equal(parsed.allocations.compute.host, Math.ceil(52.02 * 1024 ** 2) + Math.ceil(248.10 * 1024 ** 2), 'host compute and vision reservation were omitted');
  assert.ok(Math.abs(parsed.allocations.speculativeCompute.host! - 52.02 * 1024 ** 2) <= 1);
  assert.equal(parsed.allocations.speculativeKv.device, 128 * 1024 ** 2);
  assert.equal(parsed.allocations.output.host, 2 * Math.ceil(0.95 * 1024 ** 2), 'target and draft output allocations were not counted separately');
  assert.equal(parsed.visionPresent, true);
  assert.equal(parsed.unknownReasons.length, 0, 'complete allocation log should not be marked incomplete');

  const response = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime,
    hostReserveBytes: 8 * 1024 ** 3,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: allocationLog }));
  assert.equal(response.status, 'estimated');
  assert.equal(response.observedContextTokens, 32_768);
  assert.equal(response.hardwareSafeTokens, 32_768, 'safe result must be bounded to the successfully loaded context');

  const minimalRuntimeLog = `
I srv load_model: loading model '/models/target.gguf'
I srv initializing, n_slots = 1, n_ctx_slot = 32768, kv_unified = 'false'
I common_speculative_init_result: creating MTP draft context
`;
  const observedOnly = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime,
    hostReserveBytes: 8 * 1024 ** 3,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: minimalRuntimeLog }));
  assert.equal(observedOnly.status, 'observed', 'a working runtime is useful evidence even when projection data is missing');
  assert.equal(observedOnly.observedContextTokens, 32_768);
  assert.equal(observedOnly.hardwareSafeTokens, null, 'minimal logs must not be extrapolated');
  assert(observedOnly.unknownReasons.some((reason) => reason.includes('K/V cache precisions')));

  const oldLogForOtherContext = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime: { ...runtime, activeContextTokens: 65_536 },
    hostReserveBytes: 8 * 1024 ** 3,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: allocationLog }));
  assert.equal(oldLogForOtherContext.hardwareSafeTokens, null, '32K allocation evidence was extrapolated to a different loaded context');
  const otherModelWithSameContext = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime: { ...runtime, modelPath: '/models/another-model.gguf' },
    hostReserveBytes: 8 * 1024 ** 3,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: allocationLog }));
  assert.equal(otherModelWithSameContext.hardwareSafeTokens, null, 'same-context allocation evidence for another model was accepted');

  const unavailableHardware = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [32_768],
    hardware: { ...hardware, available: false },
    runtime,
    hostReserveBytes: 8 * 1024 ** 3,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: allocationLog }));
  assert.equal(unavailableHardware.hardwareSafeTokens, null, 'stale hardware snapshot was used for a safe estimate');
  assert(unavailableHardware.unknownReasons.some((reason) => reason.includes('memory snapshot is unavailable')));

  const invalidReserve = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [32_768],
    hardware,
    runtime,
    hostReserveBytes: null,
    deviceReserveBytes: defaultContextDeviceReserveBytes,
    reserveErrors: ['LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES is invalid'],
  }, async () => ({ text: allocationLog }));
  assert.equal(invalidReserve.hardwareSafeTokens, null);
  assert.deepEqual(invalidReserve.unknownReasons, ['LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES is invalid']);

  const noRuntime = await collectRuntimeContextEstimate({
    backend: 'ollama',
    modelId: 'not-loaded',
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768],
    hardware,
    runtime: null,
  });
  assert.equal(noRuntime.status, 'unknown');
  assert.equal(noRuntime.observedContextTokens, null);
  assert(noRuntime.unknownReasons.some((reason) => reason.includes('Ollama')));
}

if (require.main === module) void runContextEstimateRegression();
