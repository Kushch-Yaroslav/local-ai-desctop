# Local model refresh — 2026-10-05

Baseline: clean `v2-migration`, commit `65666cda0d5d6477cd2cd3a9c0b3a12049dc8dcd`. Implementation branch: `feat/local-model-refresh`. No merge or push. No model inference, benchmark, VRAM loading, or Max Context discovery was performed. Application tests use mocks and fixtures.

## Ollama audit and preservation

Searches covered both projects, hidden configuration, runtime sources, package dependencies, shell launchers, user desktop launchers, `/etc/systemd/system`, user systemd/autostart configuration, and shell startup files. Git history, dependencies' vendored documentation, and historical validation documents were not treated as active project dependencies.

- Local AI Desktop has no Ollama client, HTTP inference integration, SDK dependency, or CLI invocation. Historical documentation mentions the migration. The old desktop entry named “Ollama” actually invokes `run-local-ai-desktop.sh`, which delegates to the llama.cpp launcher; its name/comment are obsolete.
- `Мой переводчик` has no Ollama/11434 references in the searched project files. `core/translation/translation_service.py` loads `MarianMTModel` and `MarianTokenizer` with `Helsinki-NLP/opus-mt-en-ru` / `opus-mt-ru-en`. `app_config.json` selects `whisper_cpp` STT; backend management also supports NIM. No translator migration was needed or performed.
- Host `ollama.service` is **active and enabled**, PID 2006 at audit time, running `/usr/local/bin/ollama serve`. `/etc/systemd/system/ollama.service.d/zz-local-ai-data.conf` sets `OLLAMA_MODELS=/media/yaroslav/DATA/ollama`. Whether other clients currently call that daemon was not established. No package/service was removed or stopped.
- Most decisively, the **baseline llama.cpp model and projector are symlinks into that directory**. Thus the data directory is actively required by Local AI Desktop's baseline even without an Ollama inference dependency:

| Preserved link | Resolved target | Target bytes |
|---|---|---:|
| `/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf` | `/media/yaroslav/DATA/ollama/blobs/sha256-f5f1dd8920d417aac2718b0bda3403da274301efdd6760b4f0f4b864ff2ad57d` | 16,810,714,464 |
| `/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf` | `/media/yaroslav/DATA/ollama/blobs/sha256-ac3714bfdddeca31351f2752bf1a63f266f4df87c0b68c895e44945ca704448e` | 931,146,016 |

`/media/yaroslav/DATA/ollama` was **not deleted**, and no blobs were removed. This satisfies the conservative deletion rule. Its apparent directory size before cleanup was **49,779,509,991 bytes** (`du -sb`), approximately 47 GiB allocated (`du -sh`). The baseline symlinks were initially absent from a `find -type f` inventory; they were subsequently inspected and resolved explicitly.

## Removed files

Only these two exact regular files were unlinked. Each parent and file resolved to the intended `llama-models` location, neither file nor parent was a symlink, and host `fuser` returned 1 with no process IDs before deletion. No wildcard deletion was used.

| Exact removed filename under `/media/yaroslav/DATA/llama-models` | Bytes freed (file payload) |
|---|---:|
| `gpt-oss-20b-MXFP4.gguf` | 12,109,566,624 |
| `GLM-4.7-Flash-Q4_K.gguf` | 18,244,193,920 |
| Total | 30,353,760,544 |

The normal Qwen files and their blob targets were preserved.

## Sources, quantization and static metadata

All six downloaded files passed exact byte-length and full-file SHA-256 verification against their pinned repository LFS identities. The accompanying [JSON manifest](local-model-refresh-2026-10-05.json) records exact pinned repository revisions, filenames, byte sizes, SHA-256 values, GGUF metadata, template hashes and projector identities. All three are single GGUF files; no split shards are required.

| Model / exact repository | Exact GGUF filename | Quantization | Bytes | Architecture / tensor parameters |
|---|---|---|---:|---|
| [Huihui author release](https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF) | `Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf` | Author's `UD-DW-Q4_K_M` mixed quant | 16,551,316,384 | `qwen35`; 27,320,697,856 including MTP tensors |
| [Unsloth Devstral conversion](https://huggingface.co/unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF) | `Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf` | conventional `Q4_K_M` | 14,334,446,752 | `mistral3`; 23,572,403,200 |
| [Unsloth Gemma conversion](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF) | `gemma-4-31B-it-Q4_K_M.gguf` | conventional `Q4_K_M` | 18,323,733,440 | `gemma4`; 30,697,345,596 |

Tensor parameter totals describe tensors in the text GGUF, not a different marketed model version. Projector parameters are separate.

Huihui's card explicitly identifies the Qwen3.8-27B base and says the selected UD-DW series derives from Unsloth's Qwen3.8 GGUF, ablating layers 22–52 (0-based). This is the closest author-provided literal Q4_K_M tier, rather than the author's larger Q4_K_L or unrelated Swift/GSQ/ternary releases. The selected GGUF has `general.file_type=15` (MOSTLY_Q4_K_M), with a mixture of Q4_K, Q5_K, Q6_K, Q8_0, IQ types and unquantized tensors. It is **not uniform conventional Q4_K_M**, and no quality superiority was measured. All tensor types are supported by the existing stock llama.cpp source. The “DW” label is retained verbatim; no unsupported interpretation is assigned to it.

Devstral is specifically [Mistral's Devstral Small 2 24B Instruct 2512](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512), not Small 1 or the larger Devstral 2. The original author declares Apache-2.0. Unsloth's card metadata says `other`, but its description identifies the same Apache-2.0 model. Gemma is specifically [Google's Gemma 4 31B instruction-tuned model](https://huggingface.co/google/gemma-4-31B-it), whose current card declares Apache-2.0. Huihui's card also declares Apache-2.0. Selected GGUF repositories report `gated=false`; no authentication, access acceptance, or access workaround was required.

## Capability table

Capabilities below are **verified by embedded GGUF templates/metadata and author documentation**, except actual runtime behavior, which remains untested by instruction. Normalized mappings are direct semantic matches, not guessed extra levels.

| Model | Thinking | Native effort | Russian UI normalized effort | Agent Быстрая/Глубокая | Context ceiling | Vision | MTP/speculative | Requirements |
|---|---|---|---|---|---:|---|---|---|
| Normal Qwen3.8-27B | `enable_thinking` on/off | `low`, `medium`, `xhigh` | Низкая, Средняя, Максимальная | Both, independent | 262,144 | Existing projector | Existing built-in MTP preserved | `qwen35`, Jinja, Qwen reasoning parser, draft-mtp |
| Huihui Qwen3.8-27B | `enable_thinking` on/off | `low`, `medium`, `xhigh`; `high` aliases `xhigh` | Низкая, Средняя, Максимальная; no extra high level | Both, independent | 262,144 | Author BF16 projector | One `nextn_predict` layer / MTP tensors present; enabled; not runtime-tested | Same Qwen family; stock mixed-quant support; draft KV types |
| Devstral Small 2 24B | No native Thinking control | None | Unavailable; no fabricated levels | Both, independent | 262,144 | Pixtral F16 projector | None in selected text GGUF; disabled; no draft downloaded | `mistral3`, Pixtral/mtmd, embedded instruction/tool template |
| Gemma 4 31B IT | `enable_thinking` on/off (`<\|think\|>` system token) | None | Unavailable; no fabricated levels | Both, independent | 262,144 | Gemma4v F16 projector | No MTP tensors in this file; disabled; optional assistant/drafter not downloaded | `gemma4`, Gemma4v/mtmd, Jinja and Gemma reasoning/tool parser |

Huihui and normal Qwen reuse the same reasoning capability object. The embedded Huihui template additionally accepts `high` as an alias; that is not a separate effort level. The combination Thinking On + Medium effort + Deep strategy remains available in both Qwen variants. Gemma's template accepts a Thinking toggle but no `reasoning_effort`; token budgets are not misrepresented as native effort settings. Devstral's embedded template exposes neither `enable_thinking` nor `reasoning_effort`.

GGUF context metadata is 262,144 for Qwen/Huihui/Gemma. Devstral's GGUF says **393,216**, while the author advertises 256K; the app conservatively caps it at **262,144**. No rope extension or altered Max Context arithmetic was introduced. Safe context discovery remains dynamic and was not invoked.

The installed CUDA build is `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`, commit **d1d3c3396aa13a5f239109a822666c4870490ad5**, dated 2026-09-15 (generated build-info reports build number 1). Its source includes all three architectures, Qwen MTP, Jinja reasoning effort forwarding, Gemma4 reasoning/tool parsing and corresponding projector graph builders. No exact earliest supported release is claimed: this inspected revision is the compatibility reference. No llama.cpp upgrade was necessary or performed; no server was started to verify it. [Upstream multimodal support](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md) and [Gemma parser](https://github.com/ggml-org/llama.cpp/blob/master/common/parsers/gemma4.cpp) document the relevant integrations.

Launcher settings use embedded chat templates (`--jinja`), `--reasoning on --reasoning-format auto`, `--parallel 1`, `--flash-attn on`, `--no-warmup`, and the matching projector with existing CPU projector policy (`--no-mmproj-offload`). Only Qwen/Huihui use `--spec-type draft-mtp`; others use `none`. Family EOS/turn termination comes from GGUF token metadata and templates; no Qwen-specific stop strings are injected into Devstral or Gemma.

## Projectors

The app already routes native image payloads through llama.cpp and advertises vision for the active runtime. Therefore compatible projectors were downloaded and configured, rather than leaving supported image attachments unusable. They are optional for text-only inference, but useful to this app's normal image workflow. No audio or draft model was downloaded.

| Local filename | Source filename (same pinned repository as text model) | Bytes | Projector type |
|---|---|---:|---|
| `huihui-qwen3.8-27b-mmproj-bf16.gguf` | `mmproj-model-bf16.gguf` | 931,145,888 | `qwen3vl_merger` |
| `devstral-small-2-24b-mmproj-f16.gguf` | `mmproj-F16.gguf` | 878,054,048 | `pixtral` |
| `gemma-4-31b-mmproj-f16.gguf` | `mmproj-F16.gguf` | 1,198,957,024 | `gemma4v` |

## Application changes and compatibility

- `src/main/models/model-registry.ts`: four local entries; baseline ID preserved; distinct Huihui ID; correct native reasoning availability and 256K ceilings. GPT-OSS/GLM descriptions remain generic lookup support, outside the local registry.
- `src/main/models/llama-runtime-policy.ts`: shared Qwen reasoning profile; correct native subsets; projector paths; MTP only where present. Generic GPT-OSS/GLM profiles retain reasoning capabilities but no deleted file paths.
- `src/main/backends/llama-cpp-backend.ts`: generic profile lookup retained for externally managed runtime selection. Local listing contains only the four configured models.
- `run-local-ai-desktop-llama-cpp-mtp.sh`: new selections; deleted models removed from launcher and persisted local startup query; per-model projectors; generic Jinja/reasoning flags. Startup restores the newest remaining local conversation or defaults to baseline Qwen.
- `src/main/models/model-capabilities.test.ts`, backend regression and `package.json`: static registration/capability/launcher-path regressions, including medium + Deep independence and unsupported controls.
- README, strategy documentation, this report and manifest: current configuration and validation evidence.

No database schema changes or history deletion. Existing conversations and confirmed/pending reasoning migration semantics remain intact. Conversations referring to a removed model retain their historical ID; select a remaining model to continue them. Removed models are not offered in the picker or startup restore query. The existing baseline paths, model ID, MTP policy and native effort mapping remain intact. Rust strategy policy and Stage A tests were not changed.

## Validation

Executed application commands:

- `cargo fmt --manifest-path rust-agent/Cargo.toml --check`: passed.
- `cargo test --manifest-path rust-agent/Cargo.toml`: final host run **164 unit + 39 integration = 203 passed, 0 failed**, 0 ignored; binary/doc targets had 0 tests. Initial sandbox run: 164 unit passed, 39 integration failed because mock localhost bind was denied. Rerun outside sandbox resolved those environmental failures.
- `npm run typecheck`: passed.
- `npx tsc -p tsconfig.electron.json --noEmit`: passed.
- `npm run lint`: passed, 0 lint errors.
- `bash -n run-local-ai-desktop-llama-cpp-mtp.sh`: passed.
- `git diff --check`: passed.
- Post-download installed-file validation: **18 assertions passed, 0 failed** (all four GGUF/projector paths present; app context ceilings correct; baseline link destinations and target sizes unchanged; obsolete files absent). Final GGUF header/tensor-descriptor scan: **8 files passed**, no model inference. New capability suite rerun against final build: passed.
- All **29 current-source compiled TypeScript regression suites**, executed as `node dist/<source-relative-test>.test.js`: **29 passed, 0 failed**. This includes every JS test underlying existing npm test scripts, plus the new capability suite. Build was shared instead of rebuilding once per npm alias. These bespoke suites do not expose individual assertion/test-case totals, so no invented case count is reported.
- `bash scripts/electron-sandbox.test.sh` and `bash scripts/llama-launcher-failure.test.sh`: **2 passed, 0 failed**. The latter stops at missing sandbox preflight and explicitly verifies no model server start.
- Embedded templates were rendered with Python Jinja2 3.1.2, without weights: **16 static assertions passed, 0 failed**, covering three distinct Qwen effort renderings, Thinking off, rejection of invalid native effort, Gemma on/off and absence of native effort, Devstral instruction formatting and absence of native controls.

The broad initial scan also executed five pre-existing orphaned `dist` test files whose TypeScript sources no longer exist: 4 passed, 1 failed (`agent-context-manager.test.js`, missing deleted `project-chat` module). Initial broad scan totals: **35 suite executables passed, 1 failed**. Current-source totals, including the two shell suites: **31 passed, 0 failed**. Those generated stale files were not counted as current npm gates or repaired through unrelated source restoration.

Current-source suite inventory is included in [validation results](local-model-refresh-tests-2026-10-05.json). Test mocks and fixtures were used throughout; no inference or actual Max Context calibration occurred.

## Build

Final `npm run build`: exit **0**, successful Rust debug runtime build, frontend TypeScript check, Vite production assets and Electron TypeScript compilation. Artifacts: `dist/renderer`, `dist/main`, `dist/preload`, `dist/shared`, and `rust-agent/target/debug/local-ai-agent-runtime`. Vite reports its existing chunk-size advisory (no build failure). The application was not launched.

## Disk accounting and limitations

Apparent sizes use `du -sb`; payload delta uses exact file bytes. Directory allocation, build outputs and unrelated filesystem writes can make whole-volume `df` differences slightly different. The two baseline symlinks count as links in `llama-models`; their 17.742 GB targets belong to Ollama and are not double-counted.

| Category | Before / removed / added bytes |
|---|---:|
| Ollama before cleanup; preserved | 49,779,509,991 |
| llama-models before cleanup | 30,353,760,754 |
| Ollama freed | 0 |
| GPT-OSS freed | 12,109,566,624 |
| GLM freed | 18,244,193,920 |
| Huihui added, text + projector | 17,482,462,272 |
| Devstral added, text + projector | 15,212,500,800 |
| Gemma added, text + projector | 19,522,690,464 |
| Total added | 52,217,653,536 |
| Net model payload growth | **21,863,892,992** |
| llama-models after cleanup/download | 52,217,653,746 |
| Ollama after cleanup/download | 49,779,509,991 |

Implementation/test commit: `df8b068` (followed by the audit/documentation commit; final HEAD is reported to the user). The working tree is intended to be clean after those commits; no GGUF or download partial is tracked by Git.

No claim is made about runtime generation quality, VRAM fit, MTP speed/acceptance, vision quality, or safe context sizes. Those require the user's manual launch and testing. Native control/token/template compatibility is statically verified; actual end-to-end runtime behavior remains unverified.

Explicitly: normal Qwen was not deleted; new models were not launched; no inference benchmark was performed; no Max Context calibration was run; nothing was merged into main.
