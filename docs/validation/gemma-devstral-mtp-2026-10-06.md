# Gemma / Devstral speculative decoding — 2026-10-06

Gemma 4 31B IT now uses its authoritative, separately trained MTP assistant through the shared runtime capability profile. Six matched generations measured **30.79 → 58.13 decode tok/s median (+88.8%)**, costing **602 MiB additional server VRAM** at 32K / FP16 KV. The projector, complete Max Context discovery, saved-result selection and baseline Qwen embedded MTP passed real runtime validation.

**Devstral MTP was not implemented because no authoritative compatible drafter for Devstral Small 2 24B Instruct 2512 was found, and its published checkpoint and installed llama.cpp architecture have no embedded MTP heads.** No unrelated Mistral model, conversion experiment or inactive UI control was substituted.

Numerical results, exact launch arguments, probe records, budgets, cache identities, UI observations and automated commands are in [the evidence JSON](gemma-devstral-mtp-2026-10-06.json). Raw local evidence remains under `runtime/validation/mtp/` (ignored by Git).

## Repository baseline

- Initial branch: `feat/v2-planning-verification`; HEAD `c1b1ce75773f27903e244d41305efa4ba3d901ce`; working tree clean.
- Previous `v2-migration`: `a585ac51eed600469164e5d8293007da04e6e17b`, an ancestor of the accepted Planning/Verification branch. Its ten intervening commits affected planning, deliverables, verification/evidence and terminal safety; they did not change model/runtime launch code.
- Consolidated with `git merge --no-ff feat/v2-planning-verification`, preserving both parents: `579b2525f7742d4121f57d039d54a940b626a304`.
- The consolidated baseline passed Rust formatting, 201 Rust unit tests, 65 integration tests, all then-current 29 TypeScript test files, lint and `npm run build` before feature work.
- Feature branch: `feat/gemma-devstral-mtp`, from that updated V2 baseline.
- Implementation and regression tests: `42e0311e1ac86543aca4225eb75963b21f2889f6` (`feat(runtime): support verified external MTP assistants`). This report and the repeatable benchmark harness are committed separately.
- `main` remains `44f2c6ba4dd63fb6d620a08956f013e8df5a7751`. Nothing was merged into main or pushed. Model files remain outside Git.

The earlier model/runtime branches are all ancestors of updated `v2-migration`: `feat/local-model-refresh` at `20a2eeb`, `fix/max-context-standalone-qwen` at `ded1a3f`, `feat/llama-only-gpt-oss` at `d9930ac`, and `feat/max-safe-context-discovery` at `bdbc001`. Accepted Planning/Verification remains at `c1b1ce7`, also now an ancestor; this feature does not rewrite those branches.

## Upstream evidence and compatibility decisions

[Google's exact 31B IT assistant](https://huggingface.co/google/gemma-4-31B-it-assistant) is trained for the corresponding 31B instruction model, rather than being a generic smaller chat model. [Google's MTP documentation](https://ai.google.dev/gemma/docs/mtp/mtp) describes the separate assistant and speculative verification pipeline. The inspected official revision was `627c5ec1458b9086b841a91e0512fd31fd2fbbf1`; access is ungated and the published license is Apache 2.0.

[llama.cpp PR #23398](https://github.com/ggml-org/llama.cpp/pull/23398), merged on 2026-06-07, added Gemma 4 MTP. The installed Linux/CUDA server at `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server` reports `b1-d1d3c33`; its source is `d1d3c3396aa13a5f239109a822666c4870490ad5`. It already contains the `gemma4-assistant` architecture, MTP context initialization and target-KV sharing. No llama.cpp update/rebuild was needed.

The GGUF came from the same maintained converter as the existing main model. [Unsloth's pinned MTP instructions](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/blob/c1ac76e99d5513b141e8adde7288b85c3f9c32ec/MTP/README.md) identify the exact installed `gemma-4-31B-it-Q4_K_M.gguf` as a verified target and recommend the Q8_0 assistant with `--model-draft`, `--spec-type draft-mtp`, and four proposed tokens. This is the regular IT pairing, not an unrelated QAT target. Its shared KV path supports quantized KV; both FP16 and Q8 were validated locally. The assistant relies on target hidden representations and KV; it is not a standalone chat model.

For Devstral, the [official exact-version card](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512) and [pinned configuration](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512/blob/55c5b41e98c2dbd21b0c8afffc540dcfc9eb5128/config.json) describe `Mistral3ForConditionalGeneration` / `ministral3`, with ordinary target layers and no next-token prediction heads. The installed `src/models/mistral3.cpp` contains no embedded MTP implementation. Public model searches restricted to Mistral AI, Red Hat AI and NVIDIA found main/quantized Devstral releases but no reliable exact-version assistant/speculator; the API responses are saved locally. This establishes the absence of a suitable configuration in the inspected sources, not a claim that external speculation could never be developed for the architecture. Matching a vocabulary alone would not establish a trained, reliable pairing.

## Artifact and static verification

| Property | Verified value |
|---|---|
| Repository | `unsloth/gemma-4-31B-it-GGUF` |
| Revision | `c1ac76e99d5513b141e8adde7288b85c3f9c32ec` |
| Remote artifact | `MTP/mtp-gemma-4-31B-it-Q8_0.gguf` |
| Local path | `/media/yaroslav/DATA/llama-models/mtp-gemma-4-31B-it-Q8_0.gguf` |
| Quantization | `Q8_0`, recommended for the small assistant |
| Size | 514,687,104 bytes |
| SHA-256 | `5ae8b0117bed601e8924c6305bd5b0585de361d51f0e77091bcb4252cf1f27de` |
| Architecture | `gemma4-assistant`; four blocks / four next-token prediction layers |
| Metadata size label | `470M` |
| Context metadata | 262,144 tokens |
| Target representation | Output width 5,376; matches the main model |
| Tokenizer | 262,144 token texts, BPE merges, scores and BOS policy match the main GGUF |
| KV | All four assistant layers share target tensors |

The complete download was SHA-256/size verified against Hugging Face's published LFS identity before atomic installation. GGUF metadata and tokenizer arrays were inspected without inference. The file is readable and a regular standalone file. No main GGUF or projector was replaced. Added disk usage is 514,687,104 bytes; no model was deleted or placed in Ollama storage.

The assistant has no chat template and its EOS/type annotations differ from the main GGUF (assistant EOS 1, target EOS 106). Those fields do not replace the target's chat template or termination policy. The exact trained pairing, matching token texts/merges/BOS, target representation, checksum and real inference were validated; arbitrary similarly tokenized models are not accepted as substitutes.

The existing projector `/media/yaroslav/DATA/llama-models/gemma-4-31b-mmproj-f16.gguf` is reused. No second projector or extra speculative model was downloaded.

## Generic implementation

`LlamaRuntimeProfile` retains its existing mechanism (`mtp`, `eagle3`, `none`) and adds an optional external draft profile: path, published checksum/size, expected architecture/target representation, KV sharing and draft-token count. The shell launcher reads the compiled shared profile instead of maintaining a second model-name/path table. Saved startup selection also derives supported IDs from that registry.

The optional `ModelInfo.speculative` describes a supported configuration; it does not assert that an offline model is running. Launcher state publishes the **effective** mechanism after health, alias/context, draft-load and implementation confirmation. The toolbar shows `MTP` only for a ready runtime with confirmed MTP state. Missing/corrupt/incompatible assistants fail preflight; unsupported runtime flags or loading failures produce the existing startup/configuration error and rollback behavior. There is no silent ordinary-decoding fallback advertised as MTP.

No new UI switch was introduced. `LOCAL_AI_LLAMA_SPECULATIVE=0` disables speculation; `1` or the default enables a model's supported mechanism. The setting applies to the launcher and requires restart. Devstral still resolves to `none` even when the global setting is `1`.

Changed application files:

- `src/main/models/llama-runtime-policy.ts`, `llama-launch-config.ts`: central assistant metadata and launch selection/verification.
- `src/main/services/gguf-speculative.ts`: bounded metadata/tokenizer inspection.
- `run-local-ai-desktop-llama-cpp-mtp.sh`: generic arguments, draft preflight and confirmed runtime state.
- `src/main/backends/llama-cpp-backend.ts`, `src/shared/types.ts`, `src/main/services/llama-runtime-controller.ts`, `src/renderer/components/Toolbar.tsx`: capability and actual-state propagation.
- `src/main/services/context-estimate.ts`: external draft load boundaries and verified shared-KV allocation evidence.
- `src/main/services/context-discovery-persistence.ts`, `src/main/ipc/register-ipc.ts`: effective mechanism and draft file identity in discovery keys.
- Capability, launch, backend, allocation, persistence and shell failure tests; `package.json` includes the new configuration regression in the model-capability gate.

The Max Context compatibility fixes are confined to evidence/configuration identity. A second model's final offload previously would hide the target's final allocations; its loader metadata also could replace the target path. A shared assistant prints KV *view* sizes but owns no additional KV buffer. The parser now separates target/draft phases and recognizes zero owned memory only when a completed startup proves sharing for every layer of a partition. Missing or partial evidence stays unsafe. Existing independent Qwen draft KV remains additive.

No VRAM/discovery policy changed: B=1550 MiB, M=384 MiB, emergency floor=150 MiB, invalidation tolerance=256 MiB, original bounded search/granularity, manual Max selection and known-good persistence behavior are preserved. `context-discovery.ts`, `vram-budget.ts` and the estimator arithmetic were not changed. The new external-draft fingerprint is omitted when absent, preserving embedded-Qwen key serialization; a same-path assistant replacement invalidates its saved calibration.

## Exact production launch

The validated Gemma ON invocation was:

```bash
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server \
  --log-verbosity 5 \
  -m /media/yaroslav/DATA/llama-models/gemma-4-31B-it-Q4_K_M.gguf \
  --alias gemma4:31b-it-q4_k_m --host 127.0.0.1 --port 8084 \
  --ctx-size 32768 --gpu-layers 999 --flash-attn on \
  --cache-type-k f16 --cache-type-v f16 \
  --cache-type-k-draft f16 --cache-type-v-draft f16 --kv-offload \
  --parallel 1 --jinja --reasoning on --reasoning-format auto \
  --mmproj /media/yaroslav/DATA/llama-models/gemma-4-31b-mmproj-f16.gguf \
  --no-mmproj-offload --spec-type draft-mtp \
  --model-draft /media/yaroslav/DATA/llama-models/mtp-gemma-4-31B-it-Q8_0.gguf \
  --gpu-layers-draft 999 --spec-draft-n-max 4
```

Port 8084 and separate runtime roots isolated validation from the user's normal runtime. The production default port remains 8081. OFF uses `--spec-type none` and omits external-draft arguments. Discovery switches both target/draft K/V flags together to `q8_0`. Projector warmup remains enabled; `--no-warmup` is still reserved for text-only profiles.

The actual production launcher, health/model API, process arguments and log confirmed main/projector/assistant loading. Logs report the `draft-mtp` implementation and all four target-KV aliases. The six ON generations proposed **3,753 tokens and accepted 2,124 (56.59%)**; OFF exposed no draft counts. This is inference evidence, not just command construction.

## Measured generation and memory

Same main Q4_K_M GGUF, RTX 3090, 32,768 context, FP16 target/draft KV, full GPU layers, CPU projector, temperature 0, seed 42, thinking off, no native effort override, prompt caching disabled. Two representative prompts: TypeScript background-queue implementation (59 input tokens) and review of actual repository discovery source (2,945 input tokens). Each mode received two 128-token warmups, then three repetitions per prompt, each producing exactly 512 tokens. Raw responses confirmed zero cached prompt tokens.

| Measurement | OFF | ON | Change |
|---|---:|---:|---:|
| Median decode tok/s, all six runs | 30.790 | 58.134 | +88.81% |
| Mean decode tok/s | 30.980 | 57.898 | +86.89% |
| TypeScript prompt median decode tok/s | 31.626 | 61.418 | +94.20% |
| Repository-review median decode tok/s | 30.435 | 54.050 | +77.59% |
| Mean full HTTP request seconds | 19.235 | 11.876 | +61.96% throughput |
| Server VRAM before workload, MiB | 21,734 | 22,336 | +602 |
| Peak server VRAM, MiB | 21,752 | 22,354 | +602 |
| Peak total GPU usage, MiB | 22,770 | 23,649 | Includes varying desktop usage |
| Peak process RSS, KiB | 7,325,892 | 7,939,916 | +614,024 KiB (~599.6 MiB) |
| Initial server model-loaded seconds | 4.361 | 5.514 | One observed pair |
| Initial launcher-ready seconds | 9 | 10 | Includes preflight and release waits |

Process VRAM was sampled through `nvidia-smi --query-compute-apps`, not inferred from GGUF bytes. Total GPU samples include unrelated desktop allocations, so the process-specific +602 MiB is the attributable comparison. At the 16K discovery base, observed OFF/ON server allocations were **20,448/21,034 MiB with FP16 (+586)** and **19,322/20,036 MiB with Q8 (+714)**: context and cache precision affect workspace overhead even with shared KV.

No generation/startup crash or ordinary-decoding fallback occurred in the measured runs. Repeated output was deterministic within each mode, but OFF and ON texts were not byte-identical. This experiment does not establish quality equivalence or diagnose the source of those differences. Startup timings are not a repeated cold-load benchmark.

The repeatable harness is `scripts/benchmark-speculative.py`; it measures an already running isolated production server and never launches one. Saved prompts and raw measurements are in `runtime/validation/mtp/`.

## Max Context, restoration and vision

| Configuration | Offered FP16 | Offered Q8 | Actual successful startup/inference probes |
|---|---:|---:|---:|
| Gemma MTP OFF | 40,960 (40K) | 81,920 (80K) | 7 |
| Gemma MTP ON | 28,672 (28K) | 57,344 (56K) | 7 |

Each complete discovery recorded 14 candidate records: seven real startup/health/inference probes and seven candidates rejected before launch by the existing prediction guard. Final results satisfy `L <= availableLlmBudget`; original 32K/FP16 runtime configuration was restored after each discovery. The assistant's weights and compute are included, shared KV views are not double-counted, and projector weights/compute evidence remains complete.

These are bounded-search results, not exhaustive physical limits. In particular the matched 32K FP16 ON benchmark also ran safely; the existing conservative forecast and 8K stopping granularity offered 28K. No policy was changed to increase the reported maximum.

Fresh Electron processes restored both modes' results with zero new probes. The real renderer/preload displayed the saved FP16/Q8 options, retained the manual 32K selection, selected each saved Q8 result, and persisted it. The ON UI displayed confirmed MTP. Stopping the launcher removed valid Max options; a fresh renderer showed “Максимальный контекст: не измерен”.

Real configuration keys differed:

- OFF: `f0c848f542b5df422a4e49628d5142370f8c599ed0191afca5cd0688706038c5`.
- ON: `46af5ac1bc13b01dbef1429ab2fa198e1c9562b18a3c3cfb4dde3f2f395a5e8e`.

Both sets of actual rows were combined into one validation database; the production database loader returned only the corresponding configuration's values. Tests additionally cover draft replacement, launch-parameter changes, KV independence and Qwen relocation/key stability.

A synthetic red/blue PNG was submitted through the production chat/image endpoint with Gemma MTP ON. The model correctly identified red on the left and blue on the right; it generated 31 tokens, proposing 28 and accepting 24. The projector actually processed the image while MTP remained active. Server VRAM stayed 22,354 MiB before/after that request. The assistant did not disable vision or startup allocation evidence.

One first OFF restoration harness timed out on an overly broad “backend not running” label expectation after selecting the saved value; the actual saved selection and API invalidation had passed. The existing manually managed-runtime fallback can retain a generic `llama.cpp` label. A separate stopped-renderer check against an unused port passed with no valid Max options. The ON harness verified saved selection and cleared Max after reload. No unrelated runtime-status semantics were rewritten.

## Qwen regression and automated gates

Normal Qwen loaded with embedded MTP and its existing projector. A 128-token sanity request proposed 105 / accepted 91 tokens. Production `LlamaCppBackend.chatWithTools` then generated successfully in FP16 and Q8 at 32K; the real context-estimate IPC returned `estimated` with no unknown evidence in both modes. The Q8 log reports 34 accepted / 36 drafted tokens. For matching context/KV/port, its complete invocation is byte-for-byte the accepted V2 invocation. Huihui retains the same embedded family behavior and is covered by capability/launch tests; it was not unnecessarily benchmarked again.

| Gate | Final result |
|---|---|
| `cargo fmt --manifest-path rust-agent/Cargo.toml --check` | Pass |
| `cargo test --manifest-path rust-agent/Cargo.toml` | 201 unit + 65 integration passed, 0 failed; 0 doc tests |
| Every current compiled `*.test.ts` entry under `src` | 30 files passed, 0 failed |
| `scripts/llama-launch-config.test.sh` | Pass (four profiles, external shared KV, OFF, future/text-only runtime) |
| `scripts/electron-sandbox.test.sh` | Pass |
| `scripts/llama-launcher-failure.test.sh` | Pass (offline failure must not claim MTP) |
| `npm run lint` | Pass |
| Frontend `npm run typecheck`, inside `npm run build` | Pass |
| `npx tsc -p tsconfig.electron.json --noEmit` | Pass |
| Shell syntax / Python AST checks / `git diff --check` | Pass |
| `npm run build` | Pass; `dist/` plus Rust debug runtime artifact |

The TypeScript commands are listed individually in the evidence JSON; this executes every existing npm test entry's underlying test files, plus the new configuration regression, without rebuilding for each alias. Coverage includes missing/corrupt/truncated/incompatible draft data, checksum/architecture/tokenizer/context validation, no-MTP models, external and embedded MTP, effective OFF/ON state, registry metadata, launch/projector behavior, independent KV modes, external/shared allocation evidence and saved-key identity. Existing Rust/Stage A tests were unchanged.

The build's existing Vite large-chunk advisory and Node SQLite experimental notice remain; neither is a failing gate. All inference models, validation launchers and owned test wait processes were stopped. No application/model was started after the final production build. No working main model or projector was modified, main was untouched, and nothing was pushed.

## Remaining scope limits

Measured gains apply to these prompts/settings and this exact Linux/CUDA runtime. Other sampling, thinking, generation lengths and context occupancy may change acceptance and performance. Full 262K Gemma inference was not attempted on the 24GB card. Devstral has no newly validated MTP configuration and remains ordinary decoding. No draft-failure inference was forced with corrupted real files: isolated fixtures test preflight rejection, and real supported startup/inference confirms the valid path. Max Context keeps its existing bounded conservative behavior. The new capability is supported by the tested configuration; future upstream/artifact changes require their own validation.
