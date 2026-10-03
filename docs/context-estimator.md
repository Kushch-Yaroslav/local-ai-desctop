# Additive runtime Max Context discovery

**Discovery augments the normal context selector. It never reduces normal model/backend choices.** An ordinary option means "request this supported context", not "this configuration is guaranteed to fit available memory". A discovered `(FP16)` or `(Q8)` option additionally has exact-context startup, health, effective cache/context, completed inference, and post-inference memory evidence.

## Capability and fitting are separate

The previous 16K/32K GLM dropdown was caused by Toolbar filtering ordinary presets against the hardware estimate/discovered ceiling, with a 32K fallback when evidence was unavailable. Independently, `llamaContextPresets` imposed a 64K ceiling and GLM's registry profile was 64K despite its backend profile supporting 128K. Backend model information could also mistake the currently allocated server `n_ctx` for model capability.

Normal presets now derive only from model/backend capability, clamped by the installed GGUF's architecture-specific trained-context metadata. A bounded GGUF metadata reader does not inspect tensor payloads or infer capacity from model names. Backend model information no longer substitutes the loaded context for capability. Hardware results enter a separate additive choice builder; equal ordinary/discovered configurations are annotated rather than duplicated. Results above a changed capability are rejected, never silently offered as an unverified clamped candidate.

Selecting a discovered option sends context, main/draft K/V precision, and KV offload atomically through the launcher transaction. Conversation settings are persisted only after effective startup confirmation; failures roll back. Selecting an ordinary context resets F16/GPU-KV defaults, including after Q8. Changing models resets cache overrides and moves a custom context to a normal preset of the new model instead of reusing the previous model's discovery. An explicitly invalid llama.cpp context request is rejected rather than silently changed.

## Bounded fitting search

`Найти Max Context` is an explicit, mutually exclusive operation on the selected launcher-managed model. It refuses concurrent generation, switching, and duplicate discovery, displays stable restart/probe progress, and restores the exact preceding model/context/cache/offload configuration before publishing any results. A restoration failure clears all staged options.

For F16 and then Q8_0, the service:

1. Bounds context by the actual GGUF trained limit and backend limit.
2. Establishes a verified base at up to 16K, sampling fresh RAM/VRAM and logged allocations.
3. Predicts a region using measured target/draft KV cost and compute/output/recurrent allocation growth. Before a second point exists, it conservatively budgets non-KV buffers as context-proportional; subsequent points measure growth. Shared draft weights, projector, fixed buffers, CUDA/runtime/desktop residency and sequence slots remain included in the measured allocation/free-memory baseline.
4. Searches upward/downward with bounded binary-style candidates: at most six search iterations per mode, 4K buckets and an 8K stopping resolution. Predicted unsafe candidates are recorded but **not started**.
5. Requires each real probe to remain alive, pass `/health`, match effective per-sequence context and target/draft cache types/placement, and return non-empty assistant content. Reasoning-only output is insufficient.
6. Applies one final reserve policy, starts the resulting exact context if it differs from the last verified point, and checks remaining memory. At most one lower midpoint retry is allowed; unverified or reserve-failing candidates are not offered.

The emergency search guard is 4 GiB available host RAM / 1 GiB available device memory, plus 256 MiB forecast uncertainty. The final default reserve is **8 GiB host / 2 GiB device**, with the same small forecast uncertainty when choosing the final bucket. Environment reserve overrides may increase, not decrease, these defaults. There is no former 25% KV multiplier or 20% context reduction. Q8 is offered only after matching real startup/inference evidence and a verified improvement of at least 8K over FP16.

Allocation parsing distinguishes an incomplete log from a fully loaded KV-only runtime. The actual "no implementations specified for speculative decoding" message establishes disabled draft decoding; verified process arguments establish absence of a projector; a completed verbose KV-only startup without a recurrent module establishes zero recurrent allocation. Enabled modules still require their allocation evidence. MLA's reported zero-byte V cache is valid evidence, not a reason to manufacture a V allocation.

VRAM availability uses NVIDIA's reported `memory.free`, **not total minus used**: driver-reserved memory is not available for allocation. This machine reserved approximately 458 MiB outside its used-memory figure; earlier preliminary results that counted that space were optimistic and are superseded by the final acceptance below. Missing/invalid free-memory telemetry cannot validate a maximum. Multiple GPUs require per-device accounting and currently produce unavailable discovery evidence rather than an unsafe combined estimate.

Results include exact probe arguments, outcomes, memory and diagnostics. Identity includes model/projector/server file identities, normalized effective runtime arguments, trained/backend limits and speculative configuration, excluding only context/cache precision so sibling modes survive selection. Results expire after 30 minutes. Status polling and selection re-sample memory: a reconstructed baseline change exceeding 2 GiB host or 512 MiB device, or even a smaller change that consumes the final reserves, invalidates discovery. Model/backend/draft/offload changes invalidate it; merely opening the dropdown does not. Failed/unsupported discovery retains diagnostics and leaves all normal choices intact.

## Primary-checkout live acceptance, 2026-10-03

Final acceptance used the rebuilt primary Electron/IPC/UI flow and real llama.cpp commit `d1d3c3396aa13a5f239109a822666c4870490ad5`, with an isolated copied database/runtime root and port **18081**. The user's default port 8081 was free; no external process was signalled and the user database was not modified. Hardware was RTX 3090, 24 GiB VRAM, 62.699 GiB total system RAM. Initial no-model sampling showed approximately 0.933 GiB GPU used / 22.622 GiB free and 49.608 GiB available RAM.

| Model | GGUF trained limit | Effective hard limit | Normal before discovery | Normal after discovery | Added verified values |
|---|---:|---:|---|---|---|
| Qwen 3.8 27B, MTP + host projector | 262144 | 262144 | 16K, 32K, 64K, 128K, 256K | unchanged | 60K FP16, 92K Q8 |
| GLM-4.7-Flash, no draft/projector | 202752 | 131072 | 16K, 32K, 64K, 128K | unchanged | 56K FP16, 104K Q8 |

These are measured values from this run, not constants or universal model maxima. Both discovered configurations were selected through the real DOM context selector, confirmed in launcher state and persisted in the isolated conversation, and each completed another real inference returning `"2"`. Selecting ordinary 16K afterward restored F16/GPU KV. Qwen also completed a real Agent turn.

### Exact search sequences

Values below are tokens, in chronological order. `skip` means the forecast rejected the candidate without starting a process; it is not an observed OOM failure. All non-skipped probes passed startup, health, reported context/cache matching, and completed assistant-content inference. No startup/inference failure or OOM was encountered.

| Model / cache | Probe sequence | Highest tested search point | Final offered context |
|---|---|---:|---:|
| Qwen F16 | 16384 base; 49152; 155648 skip; 102400 skip; 73728; 86016 skip; 77824; 61440 final | 77824 | 61440 |
| Qwen Q8_0 | 16384 base; 65536; 163840 skip; 114688; 139264 skip; 126976 skip; 118784; 94208 final | 118784 | 94208 |
| GLM F16 | 16384 base; 73728; 102400 skip; 86016 skip; 77824; 57344 final | 77824 | 57344 |
| GLM Q8_0 | 16384 base; 122880; 126976; 106496 final | 126976 | 106496 |

### Measured memory after each real probe

All values are GiB. RAM "used" is total minus Linux available RAM, not a process RSS. Samples of used and available memory are taken immediately after inference but are not atomic; small differences can occur. Device total is 24 GiB and host total is 62.699 GiB. GPU used plus free does not equal total because driver-reserved memory is excluded from actual free memory.

| Model | Cache | Context | Phase | RAM used | RAM available | VRAM used | VRAM free |
|---|---|---:|---|---:|---:|---:|---:|
| Qwen | F16 | 16384 | base | 15.491 | 47.231 | 18.157 | 5.396 |
| Qwen | F16 | 49152 | search | 15.616 | 47.080 | 20.326 | 3.228 |
| Qwen | F16 | 73728 | search | 15.890 | 46.810 | 21.938 | 1.615 |
| Qwen | F16 | 77824 | search | 15.731 | 46.979 | 22.212 | 1.342 |
| Qwen | F16 | 61440 | final | 15.612 | 47.080 | 21.124 | 2.430 |
| Qwen | Q8_0 | 16384 | base | 15.432 | 47.264 | 17.712 | 5.842 |
| Qwen | Q8_0 | 65536 | search | 15.732 | 46.974 | 19.875 | 3.680 |
| Qwen | Q8_0 | 114688 | search | 15.519 | 47.169 | 22.043 | 1.512 |
| Qwen | Q8_0 | 118784 | search | 15.484 | 47.202 | 22.227 | 1.327 |
| Qwen | Q8_0 | 94208 | final | 15.408 | 47.290 | 21.146 | 2.408 |
| GLM | F16 | 16384 | base | 14.990 | 47.723 | 19.029 | 4.524 |
| GLM | F16 | 73728 | search | 15.203 | 47.489 | 21.989 | 1.564 |
| GLM | F16 | 77824 | search | 14.599 | 48.124 | 22.195 | 1.359 |
| GLM | F16 | 57344 | final | 14.307 | 48.392 | 21.122 | 2.433 |
| GLM | Q8_0 | 16384 | base | 14.252 | 48.440 | 18.654 | 4.899 |
| GLM | Q8_0 | 122880 | search | 14.333 | 48.366 | 21.740 | 1.813 |
| GLM | Q8_0 | 126976 | search | 14.222 | 48.478 | 21.822 | 1.731 |
| GLM | Q8_0 | 106496 | final | 14.266 | 48.438 | 21.244 | 2.311 |

### Exact final commands

Within each model/cache sequence above, other real probes used these same arguments with only `--ctx-size` replaced by the listed exact context. Qwen's target and draft caches both used the reported precision; GLM has no draft cache to configure.

```sh
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf --alias qwen3.8:27b-q4_K_M --mmproj /media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf --no-mmproj-offload --host 127.0.0.1 --port 18081 --ctx-size 61440 --gpu-layers 999 --flash-attn on --parallel 1 --spec-type draft-mtp --cache-type-k f16 --cache-type-v f16 --cache-type-k-draft f16 --cache-type-v-draft f16 --kv-offload
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf --alias qwen3.8:27b-q4_K_M --mmproj /media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf --no-mmproj-offload --host 127.0.0.1 --port 18081 --ctx-size 94208 --gpu-layers 999 --flash-attn on --parallel 1 --spec-type draft-mtp --cache-type-k q8_0 --cache-type-v q8_0 --cache-type-k-draft q8_0 --cache-type-v-draft q8_0 --kv-offload
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf --alias glm-4.7-flash:q4_k --host 127.0.0.1 --port 18081 --ctx-size 57344 --gpu-layers 999 --flash-attn on --cache-type-k f16 --cache-type-v f16 --kv-offload --batch-size 512 --ubatch-size 512 --parallel 1 --jinja --reasoning on --no-warmup
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf --alias glm-4.7-flash:q4_k --host 127.0.0.1 --port 18081 --ctx-size 106496 --gpu-layers 999 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --kv-offload --batch-size 512 --ubatch-size 512 --parallel 1 --jinja --reasoning on --no-warmup
```

The primary Rust Agent sidecar completed an Agent turn with visible `"2"`, final event and exit 0. During inference, `/proc/129438/exe` resolved to `/media/yaroslav/DATA/local-ai-desktop/rust-agent/target/debug/local-ai-agent-runtime`. Cargo verified/rebuilt the primary target; unchanged Rust sources retained binary mtime `2026-10-03 16:19:53.632880314 +03:00`, size 22124624 bytes, SHA-256 `81e1be032246cf010692a308087756d380efcfebcb16a76af7282d9b73dfdf5f`. This was not a worktree sidecar.

`npm run test:max-context` passed the primary build/typecheck, option/capability/metadata/estimator/search/backend/controller/database regressions and launcher/sandbox checks. Rust tests and Agent protocol regressions passed. Changed-file ESLint had only two pre-existing unused-symbol errors (`homedir`, `inlineConfirmation` in `register-ipc.ts`); the preceding commit has those same findings. No unrelated lint fixes were made.

## Limits and operational safety

This is a bounded, exact-candidate-verified **safe-search maximum**, not a proof of the physical OOM boundary. Unsafe forecasts are not launched, external memory use may change between samples, and short inference does not stress a completely filled context or every workload. Larger ordinary capability options remain available but carry no fitting guarantee. The configured reserve and launch confirmation/rollback reduce risk; they cannot eliminate concurrent allocation or unexpected nonlinear runtime growth.

Qwen did run 64K F16 successfully in an earlier exact-context probe with 2.071 GiB genuinely free VRAM, and the final search ran 76K F16 with 1.342 GiB free. The final offered 60K is lower because it must preserve the 2 GiB policy plus forecast uncertainty under freshly sampled resources; it is not a model/selector cap or a claim that 64K cannot run. Ordinary 64K remains selectable.

Results are measured independently for the existing offload/slots/draft/projector setup. This acceptance covered single-slot, single-GPU KV only; CPU-KV placement, multiple devices, other models/backends and different slot counts were not live-validated. Ollama does not expose the required allocation evidence and offers no hardware-discovered precision options. Both tested llama.cpp modes require effective runtime evidence; there is no unconditional Q8 control.

All owned Electron, launcher and server processes were stopped; ports 18081/19223 were closed and the inspected isolated runtime/database directory was removed. Post-cleanup NVIDIA telemetry showed 1063 MiB used / 23056 MiB actually free. No orphan model server remained.

The experimental branch remains `feat/max-safe-context-discovery`, based on the Branch 1 merged `v2-migration` commit `5a46482e3d4d740d9cab92acc558c252875ea06f`. No merge into that branch or push is part of this work. Runtime logs, copied user data and test-only processes are not committed.
