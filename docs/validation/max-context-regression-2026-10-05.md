# Max Context regression and standalone Qwen validation

2026-10-05. Initial repository: clean `feat/local-model-refresh`, HEAD `20a2eeb6b502bc46b74fd790227ecf91aac71309`. Work is on `fix/max-context-standalone-qwen`; nothing was merged or pushed. The accepted pre-refresh reference is `65666cda0d5d6477cd2cd3a9c0b3a12049dc8dcd`.

**Root causes and history.** `df8b068ae1fa25116e8cc7b0dbe8cc1097f3cfbb` replaced the launcher's per-family argument blocks with common arguments ending in `--no-warmup`. Baseline Qwen previously had projector warmup enabled. All four current installed models have projectors, so this change omitted `reserve_compute_meta: CPU compute buffer size` from their startup allocation evidence. The established estimator correctly declined to invent that missing allocation; discovery then rejected the baseline before generating/probing any candidates. Registry ceilings, reasoning capabilities, model IDs, KV configuration, and persistence code did not introduce a Max Context allow-list.

Gemma additionally exposed an older single-KV-allocation assumption. Its backend creates independent non-SWA/full and SWA caches. At 32768 tokens and FP16 they allocate 2560 + 1200 = 3760 MiB. The old parser took the maximum buffer, 2560 MiB, and compared it with the last summary, 1200 MiB. That could neither account for all GPU KV nor prove absent host KV. `git blame 20a2eeb` attributes the single-summary assignment/max aggregation to `dc6be77b7b90867e9cd6260fbeaee9b7fead5e27`, predating the refresh. The refresh introduced Gemma and exposed the limitation; it did not change the parser itself.

The relevant historical comparison is `git diff 65666cd df8b068 -- run-local-ai-desktop-llama-cpp-mtp.sh`. The offending added line was:

```bash
server_args=(... --parallel 1 --jinja --reasoning on --reasoning-format auto --no-warmup)
```

**Narrow fix.** The launcher now keeps warmup enabled whenever a projector is configured, using projector presence rather than a model-name check. Text-only launches retain their previous no-warmup behavior. Argument construction is a pure function exercised without launching a model. Allocation parsing takes maxima within each named KV partition, sums independent partitions separately for target/draft contexts, and checks aggregate summaries. Conflicting partition precision remains unsafe. Missing projector allocations still reject discovery.

No changes were made to the discovery search, candidate generation, budgeting constants/arithmetic, IPC behavior, persistence identities, Max age/live-fit validation, context registry ceilings, model reasoning controls, or Agent strategy. In particular the 1550 MiB absolute non-LLM cap, 384 MiB discovery margin, 256 MiB invalidation tolerance and independent 150 MiB startup emergency guard are unchanged. FP16/Q8 and MTP/draft behavior remain independent. A new registered runtime inherits discovery without another family allow-list.

**Before-fix reproduction.** Using the actual headless launcher, actual llama.cpp servers and Electron's registered `context:estimate` / `context:discover` handlers, all four models started at 32768 tokens/FP16. Every estimate was `observed`, every discovery failed before probing with `Нет полной allocation evidence для безопасного базового запуска.` Each reported the missing projector compute reserve; Gemma also reported incomplete RAM allocation categories. Raw logs/results are retained under `runtime/validation/max-context-regression/` (ignored by Git). The committed [compact evidence](max-context-regression-2026-10-05.json) records both failures and successful probe results.

**After-fix runtime validation.** One llama-server at a time, RTX 3090, isolated runtime/database, port 8083. All four models completed full end-to-end discovery, including health checks, brief inference probes, VRAM measurement, result persistence, and restoration of the original 32768/FP16 runtime. This was functional validation, not a quality/performance benchmark.

| Model | Offered FP16 tokens | Offered Q8 tokens | Highest FP16 / Q8 candidate with successful inference | Candidate records |
|---|---:|---:|---:|---:|
| Normal Qwen3.8 MTP | 90,112 | 135,168 | 90,112 / 139,264 | 15 |
| Huihui Qwen3.8 MTP | 94,208 | 139,264 | 98,304 / 147,456 | 17 |
| Devstral Small 2 24B | 53,248 | 98,304 | 57,344 / 102,400 | 16 |
| Gemma 4 31B IT | 40,960 | 81,920 | 40,960 / 81,920 | 14 |

All real ceilings used by discovery were 262144 tokens (registry/backend intersection); the lower discovered boundaries were VRAM-budget guards. Candidate records include values conservatively skipped before launch. Successful inference alone does not establish a safe offered maximum: the original live budget check still applies. Normal Qwen's offered values match the user's historical 90112/135168 reference without hardcoding those values.

**Renderer and restart validation.** A fresh Electron process loaded the production renderer and actual sandboxed preload. For each model it restored both saved KV options with zero probes, displayed the saved FP16/Q8 values, kept ordinary 32K context until manual selection, and successfully selected the saved Q8 maximum through the normal renderer change event/conversation IPC. Each selection passed current live fit checks and reached the corresponding running llama.cpp context/KV configuration. Model changes used the app's normal runtime IPC. Stopping the isolated launcher cleared restored Max results in both IPC and the renderer. No model was left running.

**Qwen migration and Ollama cleanup.** [Migration report](qwen-standalone-migration-2026-10-05.md) and [checksums/deletion record](qwen-standalone-migration-2026-10-05.json) contain the exact old/new paths and removal sizes. Both normal Qwen files are standalone regular files, checksum-verified after deleting the original blobs. MTP is embedded, requiring no companion draft. Registry/default restoration already referenced stable paths under `llama-models`, so replacing the symlinks required no path rename/config rewrite. Size, mtime and launcher paths stayed stable; the regression test verifies persisted key stability across this move. Changing unsafe launch arguments appropriately changes a configuration key independently of migration.

The translator was re-audited: MarianMT/Whisper/NIM, no Ollama SDK/HTTP/CLI/runtime dependency. App source/launchers/dependencies also have no Ollama runtime dependency. Remaining repository mentions are historical documents, the one-shot cleanup script, and a migration test fixture. All eight registered model/projector files exist, are readable GGUFs and are regular files. Ollama service/binary/private libraries/data are absent. CLI identity/history and unrelated service-user files were deliberately preserved. The desktop shortcut `/home/yaroslav/.local/share/applications/local-ai-desktop-ollama.desktop` now has current llama.cpp name/comment/keywords; its filename and existing wrapper `Exec` remain stable for pinned shortcuts.

Removing the 49,779,509,991-byte data directory preserved 17,741,860,480 bytes of baseline Qwen files, freeing approximately 32.04 GB on DATA. Private Ollama installation files/services removed approximately another 2.26 GB on the system filesystem. No GGUF or model data was committed.

**Regression coverage.** Current tests cover the four local profiles and a future runtime with no reasoning profile, projector/text-only launch evidence, MTP/no draft, both KV modes, model-specific ceilings, repeated/partitioned KV allocations, conflicting precision, and relocation key stability. The original budgeting, persisted-result, failed-discovery retention, restored age/live-fit, and runtime controller regressions remain in place. The added launcher test fails against the pre-fix common `--no-warmup` arguments. The added partition test fails against the pre-fix parser: actual 2684354560 bytes versus required 3942645760 bytes. Both pass with the fix. These two intentional old-code failures demonstrate regression sensitivity.

**Checks executed.**

| Command/check | Result |
|---|---|
| `cargo fmt --manifest-path rust-agent/Cargo.toml --check` | Pass |
| `cargo test --manifest-path rust-agent/Cargo.toml` | 164 unit + 39 integration passed; 0 failed; binary/doc targets 0 tests |
| Every current `src/**/*.test.ts` compiled suite, run as `node dist/<corresponding path>.test.js` | 29 test files passed; 0 failed; exact commands in evidence JSON |
| `npm run test:max-context` | Pass: 11 Node suites + 3 shell suites, 0 failed, includes production build |
| `bash scripts/llama-launch-config.test.sh` | Pass: four local launch cases plus future projector/text-only cases |
| `bash scripts/electron-sandbox.test.sh` | Pass |
| `bash scripts/llama-launcher-failure.test.sh` | Pass |
| `npm run lint` | Pass, 0 errors |
| `npm run typecheck` (also within every production build) | Pass |
| `npx tsc -p tsconfig.electron.json --noEmit` | Pass |
| `bash -n run-local-ai-desktop-llama-cpp-mtp.sh scripts/llama-launch-config.test.sh` | Pass |
| `git diff --check` | Pass |
| `npm run build` | Pass: Rust agent, renderer TypeScript, Vite production renderer, Electron TypeScript |
| Actual four-model discovery / fresh-process renderer restore and selection | 4/4 discovery + 4/4 restore/selection; stopped-runtime invalidation passed |

The 29-file runner executes each current source suite once; the Max Context gate overlaps 11 of these and additionally runs its shell checks. Individual Node assertions are not counted because these suites use plain `assert`, not a case-counting runner. Full Rust integration tests, including Stage A, were unchanged. Sandboxed socket/process mocks initially required a host-permitted rerun; final checks passed. Temporary renderer harness selectors/lifecycle synchronization were corrected before the final successful run.

Production build artifacts are `dist/main/`, `dist/preload/`, `dist/renderer/` and `rust-agent/target/debug/local-ai-agent-runtime`. Vite's existing >500 kB chunk notice is advisory; there were no build errors. The final build ran after stopping the validation runtime; the application was not launched afterward.

**Git pieces.** Migration/config audit: `070ea9de689578988119d7fa654bb0ec6ec7a201`. Software fix and regression tests: `329e87c7733ae421d8afa4fef034394f7d14d2a0`. This evidence and the historical-report follow-up notice are committed separately afterward on the same dedicated branch.

**Limits.** Values are specific to this GPU, model quantizations, llama.cpp configuration and current non-LLM use; live fit/invalidation remains mandatory. Projector startup allocation was verified, but image quality, long-context answer quality and Agent quality were not benchmarked. Validation used an isolated database and did not seed or overwrite the user's production discovery cache. The user can run Find Max Context manually in the regular application.

One additional Devstral 32K/FP16 restart during renderer restoration exhausted the existing 150-second startup timeout and safely rolled back to Huihui. Its exact cause was not established; rollback overwrote that attempt's server log, while launcher/application logs retain the timeout. A fresh-process retry with identical model/context/flags started successfully, restored both options and selected 98304/Q8 through the renderer. The prior complete Devstral discovery also succeeded. No timeout, launch resource policy or VRAM constant was changed to hide this intermittent backend startup failure. Retry startup logs are retained as `runtime/validation/max-context-regression/devstral-restoration-startup.log`.
