# Additive Max Context with an absolute background VRAM budget

Discovery **adds** FP16/Q8 choices to the normal model/backend context selector; it never removes ordinary choices. Ordinary choices express capability, not a memory-fit guarantee. The prior 16K/32K truncation came from Toolbar hardware filtering with a 32K fallback, compounded by 64K preset/profile caps and confusing loaded `n_ctx` with capability. These architectural fixes remain unchanged: normal presets use the backend/profile limit clamped by bounded GGUF trained-context metadata, and fitting evidence is separate.

Selecting a discovered choice atomically configures context, main/draft cache precision and existing KV offload, persisting only after effective launcher confirmation. An ordinary choice resets default F16/GPU KV. Model changes invalidate discovery and reset custom contexts/cache overrides to a normal target-model configuration.

## Effective VRAM policy

All byte accounting uses MiB = 1048576 bytes. The policy is LLM-first:

```text
T = NVIDIA memory.total (actual reported value)
U = NVIDIA memory.used
F = NVIDIA memory.free (not T - U)
L = used_gpu_memory attributed to the owned llama-server PID
N = U - L                         # current non-LLM usage
R = T - U - F                     # unavailable driver-reserved memory
B = 1550 MiB                      # TOTAL non-LLM budget, not added to N
M = 384 MiB                       # single additional estimator margin

llmBudget = T - B - M
availableLlmBudget = min(llmBudget, L + F - M)
                  = min(T - B - M, T - N - R - M)
offered candidate must satisfy: measured/predicted L <= availableLlmBudget
```

Thus 1100 MiB of current desktop usage leaves only 450 MiB within the 1550 MiB background budget, **not another 1550 MiB**. Driver-reserved memory is never presented as free; when background plus unavailable driver memory binds more tightly, the actual free-memory formulation takes precedence. If `N > B`, diagnostics explicitly flag background over budget. On this measured 24576 MiB device, the nominal LLM budget is **22642 MiB**; neither device size nor discovered context values are hardcoded.

The measured LLM process allocation includes target/draft weights, KV, compute/output, device projector/state allocations, CUDA context and other unlogged residency. It comes from `nvidia-smi --query-compute-apps=pid,used_gpu_memory`, matched to the current owned server. Discovery is unavailable if this accounting or single-device free-memory telemetry cannot be verified. It does not subtract process allocations from a host-only log or assume a model-specific KV formula.

**Why 384 MiB:** in the final live run, process VRAM minus logged device allocations was 311.50–315.63 MiB across Qwen MTP and GLM modes/contexts; its variation was approximately 4.13 MiB. Qwen measured KV/context increments were about 280 MiB per 4K F16 and 184–186 MiB per 4K Q8; GLM F16 increments were approximately 214–216 MiB per 4K. The fixed residual is already included in measured `L`, not silently added as another reserve. A 384 MiB contingency can absorb roughly one additional measured unlogged context/graph footprint, exceeds the observed residual variation and one context bucket's incremental allocation, and remains within the requested 150–800 MiB range. It is conservative against short-workload uncertainty, not a guarantee for every full-context workload.

There is no 2 GiB device reserve or extra 256 MiB VRAM forecast margin. The old device-reserve environment override no longer modifies discovery's VRAM policy. The only startup guard is **150 MiB actually free**: it is an emergency floor during the search, not added to the 384 MiB final margin. Search may use the pre-margin LLM budget, while final offered candidates must satisfy the full equation above. Host policy remains unchanged: 8 GiB final available RAM, 4 GiB emergency host reserve and 256 MiB host forecast uncertainty.

## Bounded search, verification and invalidation

The existing binary-style architecture is retained. Each mode establishes a real base up to 16K, estimates growth from actual target/draft KV and compute/output/state allocations, then searches upward/downward in 4K buckets with 8K resolution and at most eight search iterations. Every real probe must remain alive, pass `/health`, match effective context/main-and-draft cache types/offload, and return non-empty assistant content. Reasoning-only output does not count. Predicted candidates beyond the absolute budget or actual-free startup floor are recorded as **skipped**, not as observed allocation failures.

The final candidate applies the single VRAM margin and unchanged RAM policy. If its exact measured allocation fails the budget, at most one lower retry is calculated from that new measurement, rather than unnecessarily halving a known working context. Failed startup/inference, incorrect effective context/cache, and invalid allocation evidence never produce options. Q8 must be verified and improve at least 8K over F16.

Progress is explicit and stable; concurrent discovery, runtime changes and generation are excluded. The exact preceding runtime is restored before any staged options are published. Failed restoration clears all staged options. The launcher owns/reaps each tested server and rolls back failed switches.

Results expire after 30 minutes. Model/projector/server file identities, backend limits, normalized effective runtime/draft/slot/offload arguments invalidate fitting evidence; context/cache selection alone does not invalidate its sibling option. Background VRAM changes exceeding **256 MiB** invalidate results without reserving that amount. Even smaller changes invalidate a candidate if the budget equation no longer fits. VRAM validation no longer uses the old 512 MiB reconstructed allocation-baseline rule. The existing 2 GiB host-baseline tolerance and host reserve checks are retained. Opening the dropdown does not invalidate results.

UI details expose GPU total, observed and currently polled non-LLM usage/free memory, total 1550 MiB background budget, 384 MiB margin, nominal and actual-availability LLM budgets, measured LLM usage/free memory/driver reserve, highest tested boundary/reason, and offered Max. The main readout remains compact.

## Primary-checkout acceptance, 2026-10-03

The rebuilt primary Electron UI/IPC and installed real llama.cpp `d1d3c3396aa13a5f239109a822666c4870490ad5` ran sequential tests on an RTX 3090, reported total **24576 MiB**, with **62.699 GiB RAM**. Preflight: NVIDIA used 941 MiB, actually free 23178 MiB; ports 8081 and 18081 were unoccupied. Tests used an isolated read-only `VACUUM INTO` database snapshot and port **18081**. No user app/server was terminated and the original DB was not modified.

| Model | Trained / effective hard limit | Normal choices before AND after | Offered FP16 | Offered Q8 |
|---|---|---|---:|---:|
| Qwen 3.8 27B + MTP + host projector | 262144 / 262144 | 16K,32K,64K,128K,256K | 88K (90112) | 132K (135168) |
| GLM-4.7-Flash, no draft/projector | 202752 / 131072 | 16K,32K,64K,128K | 88K (90112) | 128K (131072) |

Both offered modes were selected through the actual UI selector, verified in launcher state and isolated conversation persistence, and completed real inference returning visible `"2"`. Selecting ordinary 16K restored F16/GPU KV. Qwen also completed a real Agent turn. GLM's ordinary 128K and discovered 128K Q8 remain distinct because their cache configurations differ.

### Full chronological probe sequences

Values are tokens. All real probes passed startup, `/health`, exact effective context/cache checks and content inference. `skip` is a forecast-only rejection; it did not start a process. "Final rejected" means inference succeeded but measured VRAM failed the final policy, not a CUDA OOM.

| Model / cache | Sequence | Highest successful startup/inference | Boundary conclusion | Offered |
|---|---|---:|---|---:|
| Qwen F16 | 16384 base; 57344; 159744 skip; 106496 skip; 81920; 94208; 98304 skip; 90112 final | 94208 | budget/free guard; no physical OOM proved | 90112 |
| Qwen Q8 | 16384 base; 77824; 172032 skip; 122880; 147456 skip; 135168; 139264; 135168 final | 139264 | budget/free guard; no physical OOM proved | 135168 |
| GLM F16 | 16384 base; 90112; 110592 skip; 98304; 102400 skip; 94208 final rejected; 90112 final | 98304 | exact 94208 final failed current budget; retry passed | 90112 |
| GLM Q8 | 16384 base; 131072 | 131072 | **model/backend hard limit reached first** | 131072 |

### Per-probe measured memory

VRAM values are MiB; GPU total is 24576 MiB, non-LLM budget 1550 MiB, margin 384 MiB, nominal LLM budget 22642 MiB for every row. RAM values are GiB. RAM used means total minus Linux available RAM, not process RSS; used/free telemetry is sampled sequentially, not atomically. NVIDIA driver reserve was approximately 457–458 MiB.

| Model | Cache | Context | Phase | Non-LLM | LLM process | Actually free | RAM used | RAM available | Process minus logged VRAM |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Qwen | F16 | 16384 | base | 1119 | 17590 | 5410 | 16.107 | 46.599 | 312.02 |
| Qwen | F16 | 57344 | search | 1118 | 20390 | 2611 | 16.210 | 46.482 | 312.02 |
| Qwen | F16 | 81920 | search | 1085 | 22040 | 995 | 16.269 | 46.434 | 312.02 |
| Qwen | F16 | 94208 | search | 1061 | 22880 | 178 | 16.274 | 46.411 | 312.02 |
| Qwen | F16 | 90112 | final | 1061 | 22600 | 458 | 16.077 | 46.618 | 312.02 |
| Qwen | Q8 | 16384 | base | 1077 | 17148 | 5894 | 16.032 | 46.699 | 311.50 |
| Qwen | Q8 | 77824 | search | 1060 | 19916 | 3143 | 16.150 | 46.504 | 312.00 |
| Qwen | Q8 | 122880 | search | 1072 | 21946 | 1101 | 16.244 | 46.457 | 312.50 |
| Qwen | Q8 | 135168 | search | 1053 | 22500 | 566 | 16.307 | 46.388 | 313.00 |
| Qwen | Q8 | 139264 | search | 1051 | 22684 | 384 | 16.168 | 46.535 | 312.50 |
| Qwen | Q8 | 135168 | final | 1051 | 22500 | 568 | 16.253 | 46.440 | 313.00 |
| GLM | F16 | 16384 | base | 1050 | 18474 | 4596 | 15.845 | 46.825 | 314.13 |
| GLM | F16 | 90112 | search | 1050 | 22354 | 716 | 15.762 | 46.923 | 315.13 |
| GLM | F16 | 98304 | search | 1066 | 22784 | 269 | 15.587 | 47.114 | 314.13 |
| GLM | F16 | 94208 | final rejected | 1182 | 22570 | 367 | 15.406 | 47.275 | 315.63 |
| GLM | F16 | 90112 | final | 1269 | 22354 | 496 | 15.206 | 47.497 | 315.13 |
| GLM | Q8 | 16384 | base | 1155 | 18104 | 4860 | 15.106 | 47.598 | 313.80 |
| GLM | Q8 | 131072 | model limit | 1155 | 21488 | 1476 | 15.171 | 47.556 | 313.74 |

GLM's rejected final had only 367 MiB actually free, below the 384 MiB margin; the recalculated 88K retry had 496 MiB free. At that retry, current background plus driver reserve bound the LLM budget below the nominal 22642 MiB. There was no extra 1550 MiB deduction on top of observed background.

### Exact final server commands

Other real probes used the same arguments with only `--ctx-size` changed to their listed context. Qwen target/draft cache precision matched; GLM has no draft cache.

```sh
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf --alias qwen3.8:27b-q4_K_M --mmproj /media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf --no-mmproj-offload --host 127.0.0.1 --port 18081 --ctx-size 90112 --gpu-layers 999 --flash-attn on --parallel 1 --spec-type draft-mtp --cache-type-k f16 --cache-type-v f16 --cache-type-k-draft f16 --cache-type-v-draft f16 --kv-offload
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf --alias qwen3.8:27b-q4_K_M --mmproj /media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf --no-mmproj-offload --host 127.0.0.1 --port 18081 --ctx-size 135168 --gpu-layers 999 --flash-attn on --parallel 1 --spec-type draft-mtp --cache-type-k q8_0 --cache-type-v q8_0 --cache-type-k-draft q8_0 --cache-type-v-draft q8_0 --kv-offload
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf --alias glm-4.7-flash:q4_k --host 127.0.0.1 --port 18081 --ctx-size 90112 --gpu-layers 999 --flash-attn on --cache-type-k f16 --cache-type-v f16 --kv-offload --batch-size 512 --ubatch-size 512 --parallel 1 --jinja --reasoning on --no-warmup
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --log-verbosity 5 -m /media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf --alias glm-4.7-flash:q4_k --host 127.0.0.1 --port 18081 --ctx-size 131072 --gpu-layers 999 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --kv-offload --batch-size 512 --ubatch-size 512 --parallel 1 --jinja --reasoning on --no-warmup
```

### Real failed-startup cleanup and rollback

After the acceptance launcher was stopped, a sequential isolated copy of the same launcher injected an invalid cache argument for one 20480-token GLM request only. It still executed the real installed llama-server, not a fake server. The exact failure was:

```text
--ctx-size 20480 ... --cache-type-k deliberate-invalid-cache-for-owned-rollback-test
error while handling argument "--cache-type-k": Unsupported cache type: deliberate-invalid-cache-for-owned-rollback-test
```

The process exited before `/health` and before model allocations. Failed PID **148512** was confirmed absent; preceding owned PID **148383** was also absent. The controller returned `ok:false`, `rolledBack:true`, restored GLM 16384/F16/GPU on owned PID **148556**, `/health` returned `{"status":"ok"}`, and real inference returned visible `"2"`. This verifies cleanup and rollback for a genuine server-startup failure without intentionally exhausting desktop VRAM. The launcher error field was generic; its diagnostics log retained the exact parser failure shown above.

### Builds, sidecar and limits

`npm run test:max-context` passed primary build/typecheck, absolute-budget equation/margin/invalidation tests, normal/additive context tests, exact-context search/failure/model-limit regressions, allocation/metadata/backend/controller/database tests and launcher/sandbox checks. Rust tests (98 + 16) and Agent bridge regressions also passed. Changed policy surfaces passed ESLint; IPC retains only its two confirmed pre-existing unused-symbol errors (`homedir`, `inlineConfirmation`). Primary Rust/Agent artifacts are rebuilt by the build script.

During real Agent inference, `/proc/146583/exe` resolved to `/media/yaroslav/DATA/local-ai-desktop/rust-agent/target/debug/local-ai-agent-runtime`; the Agent emitted visible `"2"`, a final event and exit 0. The primary binary remained 22124624 bytes, mtime `2026-10-03 16:19:53.632880314 +03:00`, SHA-256 `81e1be032246cf010692a308087756d380efcfebcb16a76af7282d9b73dfdf5f`. Rust sources were unchanged; Cargo verified the existing primary artifact rather than using a worktree sidecar.

**Boundary limitation:** Qwen and GLM F16 reached budget/actual-free guard boundaries, not intentionally induced CUDA OOM. There is no claim that their next bucket would physically fail startup. GLM Q8 reached its model/backend hard limit. The controlled failing-startup test is not an OOM test. This is a bounded aggressive safe-budget maximum, not proof of a physical OOM boundary; short inference does not stress a completely filled context. GPU-heavy apps opened afterward may invalidate it.

All owned Electron/launcher/server processes exited, including the failed PID and restored fixture server. Ports 18081/19223 were closed and the inspected isolated root, copied DB and controlled fixture were removed. Post-cleanup NVIDIA telemetry: 24576 MiB total, 1088 MiB used, 23031 MiB actually free.

Single-slot, single-GPU GPU-KV was live-tested. CPU-KV, multiple GPUs and other models are not live-validated; incomplete process/availability evidence is rejected. Host protection remains unchanged. No runtime logs, copied DB/user content or test-only fixtures are committed. Work stays on `feat/max-safe-context-discovery`; `v2-migration` remains at `5a46482e3d4d740d9cab92acc558c252875ea06f`, with no merge or push.
