import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  vramTotalBytes: 24_576 * 1024 ** 2,
  vramAvailableBytes: 4_411 * 1024 ** 2,
  gpuUtilization: 0,
  available: true,
};
const runtime: RuntimeContextEvidence = {
  backend: 'llama-cpp',
  modelId: 'runtime-model',
  modelPath: '/models/target.gguf',
  activeContextTokens: 32_768,
  modelFileSizeBytes: 17_000_000_000,
  kvCacheType: 'f16',
  kvOffload: true,
};

export async function runContextEstimateRegression(): Promise<void> {
  assert.deepEqual(resolveContextReserve(undefined, 'HOST_RESERVE', defaultContextHostReserveBytes), { bytes: 8 * 1024 ** 3 });
  assert.deepEqual(resolveContextReserve(undefined, 'DEVICE_RESERVE', defaultContextDeviceReserveBytes), { bytes: 384 * 1024 ** 2 });
  assert.deepEqual(resolveContextReserve(String(12 * 1024 ** 3), 'HOST_RESERVE', defaultContextHostReserveBytes), { bytes: 12 * 1024 ** 3 });
  assert.match(resolveContextReserve(String(7 * 1024 ** 3), 'HOST_RESERVE', defaultContextHostReserveBytes).error ?? '', /не меньше/);
  assert.match(resolveContextReserve('invalid', 'DEVICE_RESERVE', defaultContextDeviceReserveBytes).error ?? '', /целым числом байт/);
  assert.match(resolveContextReserve(String(Number.MAX_SAFE_INTEGER + 1), 'DEVICE_RESERVE', defaultContextDeviceReserveBytes).error ?? '', /допустимым целым числом/);

  // Actual production Devstral startup captures, including the zero-sized
  // initial fit pass, final GPU allocation, CPU projector and warmup.
  for (const [context, mode, bytesPerToken, computeMiB] of [[53248, 'f16', 163840, 272.01], [98304, 'q8_0', 87040, 516.09]] as const) {
    const log = readFileSync(resolve(process.cwd(), 'test-fixtures/llama-allocation', `devstral-${context}-${mode}.txt`), 'utf8');
    const dev = parseLlamaAllocationLog(log);
    assert.deepEqual(dev.unknownReasons, [], 'all real Devstral allocation classes must be understood');
    assert.equal(dev.contextTokens, context);
    assert.equal(dev.kvTypeK, mode); assert.equal(dev.kvTypeV, mode);
    assert.equal(dev.visionPresent, true);
    assert.equal(dev.speculativeMode, 'none');
    assert.equal(dev.allocations.kv.device, context * bytesPerToken, '40 layers × 8 KV heads × 128 dimensions × K/V precision');
    assert.equal(dev.allocations.kv.host, 0);
    assert.equal(dev.allocations.weights.device, Math.ceil(13302.36 * 1024 ** 2));
    assert.equal(dev.allocations.weights.host, Math.ceil(360 * 1024 ** 2) + Math.ceil(837.36 * 1024 ** 2), 'projector is host allocated, not additional GPU weights');
    assert.equal(dev.allocations.compute.device, Math.ceil(computeMiB * 1024 ** 2));
    assert.equal(dev.allocations.ssm.device, 0);
    assert.equal(dev.allocations.speculativeKv.device, 0);
    const repeated = log.replace(/(I srv\s+load_model: initializing)/, `I sched_reserve: CUDA0 compute buffer size = ${computeMiB} MiB\n$1`);
    assert.deepEqual(parseLlamaAllocationLog(repeated).allocations, dev.allocations, 'repeated reserve logging is not another allocation');
  }
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
  const externalLog = allocationLog.replace("I common_speculative_init_result: creating MTP draft context against the target model 'target.gguf'", `I common_speculative_init_result: loading draft model '/models/assistant.gguf'
I llama_model_loader: loaded meta data with 20 key-value pairs from /models/assistant.gguf (version GGUF V3)
I load_tensors: offloaded 5/5 layers to GPU
I load_tensors: CPU_Mapped model buffer size = 3.00 MiB
I load_tensors: CUDA0 model buffer size = 490.00 MiB`).replace('I srv load_model: initializing', "T spec common_specu: adding speculative implementation 'draft-mtp'\nI srv load_model: initializing");
  const external = parseLlamaAllocationLog(externalLog);
  assert.equal(external.modelPath, runtime.modelPath, 'external assistant must not overwrite target identity');
  assert.equal(external.allocations.weights.device, parsed.allocations.weights.device, 'external offload must not hide main weights');
  assert.equal(external.allocations.kv.device, parsed.allocations.kv.device, 'external offload must not hide main KV');
  assert.equal(external.allocations.speculativeWeights.device, 490 * 1024 ** 2);
  assert.equal(external.allocations.speculativeWeights.host, 3 * 1024 ** 2);
  assert.equal(external.allocations.speculativeKv.device, parsed.allocations.speculativeKv.device, 'independent assistant KV is still counted');
  assert.equal(external.speculativeMode, 'mtp');
  assert.deepEqual(external.unknownReasons, []);
  const sharedLog = externalLog.replace('I llama_kv_cache: CUDA0 KV buffer size = 128.00 MiB', 'W llama_kv_cache: layer 0: sharing with layer 65. k = 0x100, v = 0x200')
    + '\nI srv llama_server: model loaded';
  const shared = parseLlamaAllocationLog(sharedLog);
  assert.deepEqual(shared.allocations.speculativeKv, { host: 0, device: 0 }, 'verified alias views do not allocate duplicate KV');
  assert.equal(shared.allocations.kv.device, parsed.allocations.kv.device);
  assert.deepEqual(shared.unknownReasons, []);
  assert(parseLlamaAllocationLog(sharedLog.replace('I srv llama_server: model loaded', '')).unknownReasons.length > 0, 'partial startup must not manufacture zero draft memory');
  assert(parseLlamaAllocationLog(sharedLog.replace('layer 0: sharing with layer 65.', 'layer 0: filtered')).unknownReasons.length > 0, 'missing sharing evidence remains unknown');
  assert.equal(parseLlamaAllocationLog(sharedLog.replaceAll('(f16)', '(q8_0)')).speculativeKvTypeK, 'q8_0', 'shared KV still verifies its precision');
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

  const q8AllocationLog = allocationLog
    .replaceAll('K (f16): 1024 MiB, V (f16): 1024 MiB', 'K (q8_0): 512 MiB, V (q8_0): 512 MiB')
    .replaceAll('K (f16): 64 MiB, V (f16): 64 MiB', 'K (q8_0): 32 MiB, V (q8_0): 32 MiB')
    .replace('CUDA0 KV buffer size = 2048.00 MiB', 'CUDA0 KV buffer size = 1024.00 MiB')
    .replace('size = 2048.00 MiB (32768 cells', 'size = 1024.00 MiB (32768 cells')
    .replace('CUDA0 KV buffer size = 128.00 MiB', 'CUDA0 KV buffer size = 64.00 MiB')
    .replace('size = 128.00 MiB (32768 cells', 'size = 64.00 MiB (32768 cells');
  const q8Parsed = parseLlamaAllocationLog(q8AllocationLog);
  assert.equal(q8Parsed.kvTypeK, 'q8_0');
  assert.equal(q8Parsed.speculativeKvTypeK, 'q8_0');
  assert.equal(q8Parsed.allocations.kv.device, 1024 * 1024 ** 2);
  assert.equal(q8Parsed.unknownReasons.length, 0, 'complete Q8 allocation evidence was not accepted');

  const response = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime,
    hostReserveBytes: defaultContextHostReserveBytes,
    deviceReserveBytes: defaultContextDeviceReserveBytes,
  }, async () => ({ text: allocationLog }));
  assert.equal(response.status, 'estimated');
  assert.equal(response.observedContextTokens, 32_768);
  assert(response.hardwareSafeTokens !== null && response.hardwareSafeTokens > 32_768, 'measured allocation evidence should discover beyond the loaded context');
  assert.equal(response.hardwareSafeTokens! % 4_096, 0, 'discovered context must be a valid runtime bucket');
  assert.deepEqual(response.memoryHeadroom, {
    hostBytes: hardware.ramTotalBytes - hardware.ramUsedBytes,
    deviceBytes: hardware.vramAvailableBytes!,
  }, 'discovery diagnostics must report live post-load memory headroom');
  const kvOnlyLog = `
I srv load_model: loading model '/models/target.gguf'
I load_tensors: offloaded 47/47 layers to GPU
I load_tensors: CPU_Mapped model buffer size = 170.16 MiB
I load_tensors: CUDA0 model buffer size = 17219.86 MiB
I llama_context: n_seq_max = 1
I llama_context: n_ctx = 32768
I llama_context: CUDA_Host output buffer size = 0.59 MiB
I llama_kv_cache: CUDA0 KV buffer size = 1692.00 MiB
I llama_kv_cache: size = 1692.00 MiB (32768 cells, 47 layers, 1/1 seqs), K (f16): 1692.00 MiB, V (f16): 0.00 MiB
I sched_reserve: CUDA0 compute buffer size = 94.01 MiB
I sched_reserve: CUDA_Host compute buffer size = 24.01 MiB
I srv load_model: initializing, n_slots = 1, n_ctx_slot = 32768
I spec common_specu: no implementations specified for speculative decoding
I srv llama_server: model loaded
`;
  const kvOnly = parseLlamaAllocationLog(kvOnlyLog, ['llama-server', '-m', '/models/target.gguf']);
  assert.equal(kvOnly.speculativeMode, 'none', 'real no-implementation message must establish disabled speculative decoding');
  assert.equal(kvOnly.visionPresent, false, 'actual no-projector arguments must establish text-only runtime');
  assert.deepEqual(kvOnly.allocations.ssm, { host: 0, device: 0 });
  assert.deepEqual(kvOnly.unknownReasons, [], 'complete non-recurrent/non-vision allocation evidence was rejected');
  // A backend can split one context into independent full/SWA caches. Do not
  // treat the smaller allocation as a repeated summary of the larger one.
  const partitionedLog = kvOnlyLog.replace(
    'I llama_kv_cache: CUDA0 KV buffer size = 1692.00 MiB\nI llama_kv_cache: size = 1692.00 MiB (32768 cells, 47 layers, 1/1 seqs), K (f16): 1692.00 MiB, V (f16): 0.00 MiB',
    `I llama_kv_cache_iswa: creating full KV cache, size = 32768 cells
I llama_kv_cache: CUDA0 KV buffer size = 2560.00 MiB
I llama_kv_cache: size = 2560.00 MiB (32768 cells, 10 layers, 1/1 seqs), K (f16): 1280 MiB, V (f16): 1280 MiB
I llama_kv_cache_iswa: creating SWA KV cache, size = 1536 cells
I llama_kv_cache: CUDA0 KV buffer size = 1200.00 MiB
I llama_kv_cache: size = 1200.00 MiB (1536 cells, 50 layers, 1/1 seqs), K (f16): 600 MiB, V (f16): 600 MiB`,
  ).replace('I srv load_model: initializing', `I clip_model_loader: has vision encoder
I load_hparams: model size: 1143.39 MiB
I reserve_compute_meta: CPU compute buffer size = 248.10 MiB
I srv load_model: initializing`);
  const partitioned = parseLlamaAllocationLog(partitionedLog, ['llama-server', '-m', '/models/target.gguf', '--mmproj', '/models/projector.gguf']);
  assert.equal(partitioned.allocations.kv.device, 3760 * 1024 ** 2, 'independent caches must be summed');
  assert.equal(partitioned.allocations.kv.host, 0, 'matching aggregate summaries establish absent host KV');
  assert.deepEqual(partitioned.unknownReasons, []);
  const partitionedEstimate = await collectRuntimeContextEstimate({ backend: 'llama-cpp', modelId: runtime.modelId,
    configuredMaxTokens: 262_144, contextPresets: [16_384, 32_768], hardware, runtime,
    runtimeArguments: ['llama-server', '--mmproj', '/models/projector.gguf'],
    hostReserveBytes: defaultContextHostReserveBytes, deviceReserveBytes: defaultContextDeviceReserveBytes }, async () => ({ text: partitionedLog }));
  assert.equal(partitionedEstimate.status, 'estimated', 'a projector and partitioned KV must not disable discovery');
  const missingVisionCompute = await collectRuntimeContextEstimate({ backend: 'llama-cpp', modelId: runtime.modelId,
    configuredMaxTokens: 262_144, contextPresets: [16_384, 32_768], hardware, runtime,
    runtimeArguments: ['llama-server', '--mmproj', '/models/projector.gguf'],
    hostReserveBytes: defaultContextHostReserveBytes, deviceReserveBytes: defaultContextDeviceReserveBytes },
  async () => ({ text: partitionedLog.replace('I reserve_compute_meta: CPU compute buffer size = 248.10 MiB', '') }));
  assert.equal(missingVisionCompute.status, 'observed', 'missing projector allocation must remain unsafe, not invented');
  assert(missingVisionCompute.unknownReasons.some((reason) => reason.includes('проектора')));
  const repeatedPartitions = partitionedLog.replace('I srv load_model: initializing',
    partitionedLog.slice(partitionedLog.indexOf('I llama_kv_cache_iswa:'), partitionedLog.indexOf('I sched_reserve:')) + '\nI srv load_model: initializing');
  assert.equal(parseLlamaAllocationLog(repeatedPartitions).allocations.kv.device, 3760 * 1024 ** 2, 'repeat summaries must not double count');
  const mixedCacheTypes = partitionedLog.replace('K (f16): 600 MiB', 'K (q8_0): 600 MiB');
  const mixedEstimate = await collectRuntimeContextEstimate({ backend: 'llama-cpp', modelId: runtime.modelId,
    configuredMaxTokens: 262_144, contextPresets: [16_384, 32_768], hardware, runtime,
    hostReserveBytes: defaultContextHostReserveBytes, deviceReserveBytes: defaultContextDeviceReserveBytes }, async () => ({ text: mixedCacheTypes }));
  assert.equal(mixedEstimate.status, 'observed', 'conflicting partition precision cannot validate one KV mode');
  const partialKvOnly = parseLlamaAllocationLog(kvOnlyLog.replace('I srv llama_server: model loaded', ''), ['llama-server']);
  assert(partialKvOnly.unknownReasons.some((reason) => reason.includes('рекуррентному состоянию')), 'partial startup must not manufacture an absent recurrent allocation');
  const q8Response = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime: { ...runtime, kvCacheType: 'q8_0' },
    hostReserveBytes: defaultContextHostReserveBytes,
    deviceReserveBytes: defaultContextDeviceReserveBytes,
  }, async () => ({ text: q8AllocationLog }));
  assert.equal(q8Response.status, 'estimated');
  assert(q8Response.hardwareSafeTokens !== null && q8Response.hardwareSafeTokens > response.hardwareSafeTokens!, 'measured Q8 KV cost should yield a materially larger safe option');
  const mismatchedPrecision = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime: { ...runtime, kvCacheType: 'q8_0' },
    hostReserveBytes: defaultContextHostReserveBytes,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: allocationLog }));
  assert.equal(mismatchedPrecision.hardwareSafeTokens, null, 'a cache estimate must not borrow another precision mode allocation log');
  const mismatchedPlacement = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime: { ...runtime, kvOffload: false },
    hostReserveBytes: defaultContextHostReserveBytes,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: allocationLog }));
  assert.equal(mismatchedPlacement.hardwareSafeTokens, null, 'a GPU KV allocation log must not support a RAM-placement option');
  const trainLimit = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime: { ...runtime, modelTrainContextTokens: 24_576 },
    hostReserveBytes: defaultContextHostReserveBytes,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: allocationLog }));
  assert.equal(trainLimit.configuredMaxTokens, 24_576, 'discovery must honor model train metadata below the configured ceiling');
  assert(trainLimit.hardwareSafeTokens === null || trainLimit.hardwareSafeTokens <= 24_576);

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
    hostReserveBytes: defaultContextHostReserveBytes,
    deviceReserveBytes: 4 * 1024 ** 3,
  }, async () => ({ text: minimalRuntimeLog }));
  assert.equal(observedOnly.status, 'observed', 'a working runtime is useful evidence even when projection data is missing');
  assert.equal(observedOnly.observedContextTokens, 32_768);
  assert.equal(observedOnly.hardwareSafeTokens, null, 'minimal logs must not be extrapolated');
  assert(observedOnly.unknownReasons.some((reason) => reason.includes('точность K/V-кэша')));

  const oldLogForOtherContext = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId: runtime.modelId,
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768, 65_536, 131_072],
    hardware,
    runtime: { ...runtime, activeContextTokens: 65_536 },
    hostReserveBytes: defaultContextHostReserveBytes,
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
    hostReserveBytes: defaultContextHostReserveBytes,
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
  assert(unavailableHardware.unknownReasons.some((reason) => reason.includes('снимок системной памяти недоступен')));
  const missingFreeMemory = await collectRuntimeContextEstimate({
    backend: 'llama-cpp', modelId: runtime.modelId, configuredMaxTokens: 131072,
    contextPresets: [32768], hardware: { ...hardware, vramAvailableBytes: null }, runtime,
    hostReserveBytes: defaultContextHostReserveBytes, deviceReserveBytes: defaultContextDeviceReserveBytes,
  }, async () => ({ text: allocationLog }));
  assert.equal(missingFreeMemory.hardwareSafeTokens, null, 'total minus used must not replace missing available VRAM (driver reserves are not free)');
  assert.equal(missingFreeMemory.memoryHeadroom, null);

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
    backend: 'llama-cpp',
    modelId: 'not-loaded',
    configuredMaxTokens: 131_072,
    contextPresets: [16_384, 32_768],
    hardware,
    runtime: null,
  });
  assert.equal(noRuntime.status, 'unknown');
  assert.equal(noRuntime.observedContextTokens, null);
  assert(noRuntime.unknownReasons.some((reason) => reason.includes('не сообщён активный контекст')));
}

if (require.main === module) void runContextEstimateRegression();
