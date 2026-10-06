# Explicit model selection at startup — 2026-10-06

Fresh application launch now opens Electron with no selected model, no llama-server, and no model context allocation. The selector shows **«Выберите модель»**. Reading a saved conversation is passive. Only explicit model selection starts the existing runtime transaction.

## Baseline and cause

Initial branch: `feat/gemma-devstral-mtp`; HEAD `78cfc0be88a8667208ff2d5c1601ffce1d50da87`; working tree clean. `main` remains `44f2c6ba4dd63fb6d620a08956f013e8df5a7751`. No merge, push or history rewrite was performed for this fix.

The shell launcher queried the most recently updated registered-model conversation in SQLite, restored its model/context/KV, and called `launch_server` **before starting Electron**. Those conversation fields did not establish compatibility with the current MTP configuration. An old Gemma MTP-OFF 81920/Q8 selection could therefore be replayed with MTP-ON and exhaust VRAM before the app window appeared.

The renderer independently treated the restored conversation's `modelId`, or the first listed model, as active selection. Main-process initialization also defaulted to Qwen/environment metadata and synthesized a `ready` state when no launcher existed. These assumptions confused saved metadata with a live session selection. The shell autoload existed in accepted pre-MTP `579b252` too (`saved_llama_selection`, initial-selection block, and startup `launch_server`); this is not a change to Gemma's context ceiling or the VRAM policy.

## Lifecycle and retained state

1. Launcher performs its application/sandbox preflight, publishes `idle` with empty model ID, zero context and server PID, clears inherited startup model/context/KV/vision variables, and opens Electron. It does not resolve/verify/load any selected GGUF or external assistant at this point.
2. Main starts with a nullable backend model and process-local selection permission unset. Environment variables, saved conversations, or a pre-existing ready launcher document cannot grant that permission. Idle model-catalog queries use installed-file metadata, not a server request.
3. The renderer opens history without selecting its model. Context, Max discovery and generation controls requiring an active model remain unavailable. Editing/regenerating cannot truncate history while no model is selected. Model-independent project/strategy/session controls retain their behavior.
4. Explicit selector selection uses the existing generic registry/profile, draft integrity checks and transactional launcher path. A first selection initializes with the existing normal 32768 context (bounded by the model's supported presets), FP16 GPU KV, rather than blindly replaying historical Max/KV. No family-specific branch was added.
5. Once the launcher confirms a healthy model/context/KV and actual speculative configuration, the backend becomes active. Matching saved Max options are restored using the unchanged stable key and live checks. Max remains a manual choice; applying it still validates live memory and configuration. Same-run switching, failure rollback and shutdown retain the established launcher transaction.

No database/schema migration or cache deletion is needed. Saved model IDs, conversation history, settings, reasoning, projects and both OFF/ON Max rows remain stored. Startup does not change historical context/KV. Explicit model/context selection may update that conversation's settings, as before. No main/projector/draft artifact or model capability profile was changed.

## Real validation

Used the production launcher, `dist/main/index.js`, sandboxed preload, real renderer and visible Electron BrowserWindow, driven over CDP on the RTX 3090. The disposable Electron executable wrapper only adds `--remote-debugging-port=9225`; model paths and server command construction remain production code. `LOCAL_AI_RUNTIME_ROOT` points at `runtime/validation/startup-selection`; port 18092 isolates the listener. The database is a copy of the earlier four-row Gemma OFF/ON discovery cache with synthetic conversations, including persisted Gemma 81920/Q8. The user's normal database was not modified.

| Check | Observed result |
| --- | --- |
| Fresh launch with saved Gemma 81920/Q8 and inherited model/context environment | `idle`; selector empty/«Выберите модель»; context disabled; server PID 0; process list contains no llama-server; no OOM |
| Explicit Gemma selection | Healthy 32768 FP16 GPU KV; correct external Gemma MTP assistant and projector loaded; generation succeeds |
| Close after using Gemma, relaunch | No selection/model process/context allocation; explicit re-selection again loads and generates correctly |
| Qwen switch within the same running app | Healthy 32768 FP16; embedded `draft-mtp` active; generation succeeds |
| Devstral switch in the same app | Healthy 32768 FP16; speculation `none`; generation succeeds |
| Restart after Devstral | Idle, empty selector, no llama-server or OOM |
| Open saved Qwen/Huihui/Gemma/Devstral histories via real sidebar | All four remain idle with empty selection and server PID 0 |
| Create new chat while idle | Stored `modelId=null`; no implicit first-model selection or runtime launch |
| Final process-local permission guard | Repeated real Gemma selection/generation/close/restart/re-selection passes |

The original live run observed total GPU use of 941 MiB at initial idle, 23308 MiB during Gemma generation, and 929 MiB after restarting without a model. The final confirmation observed 871 MiB idle, 847 MiB after restart, and approximately 23200 MiB while Gemma was loaded. These idle values are desktop/Electron/background usage, not model allocations: PID checks independently confirmed no llama-server.

Actual server logs prove speculation remained active, rather than only trusting the UI label:

- Gemma: `loading draft model '/media/yaroslav/DATA/llama-models/mtp-gemma-4-31B-it-Q8_0.gguf'`, projector `gemma4v`, `adding speculative implementation 'draft-mtp'`, and a completed generation with 6 accepted / 8 drafted tokens. Final confirmation also records 2 accepted / 4 drafted tokens.
- Qwen: projector `qwen3vl_merger`, `draft-mtp`, and 2 accepted / 3 drafted tokens in its answer request (25/27 in the preceding request).
- Devstral: projector `pixtral`, actual runtime mode `none`, and successful answer generation.

Gemma restored only the MTP-ON results **28672 FP16 / 57344 Q8**. The MTP-OFF **40960 FP16 / 81920 Q8** rows stayed stored separately. The complete four-row cache hash is identical before/after both live runs. No new calibration was needed or performed, and no VRAM arithmetic/constants or discovery-key construction changed.

Machine-readable observations, PID/state/UI snapshots, compatible saved options, cache hashes and test inventory: [startup-explicit-model-selection-2026-10-06.json](startup-explicit-model-selection-2026-10-06.json). Raw logs/screenshots and disposable harnesses are under ignored `runtime/validation/startup-selection/`.

## Changed files

| Files | Purpose |
| --- | --- |
| `run-local-ai-desktop-llama-cpp-mtp.sh` | Remove SQLite/environment/default-model autoload; idle startup; clean up only its own headless waiting child |
| `src/main/services/llama-runtime-controller.ts`, `src/shared/types.ts` | Represent/parse genuine idle state |
| `src/main/backends/llama-cpp-backend.ts` | Nullable active selection; static catalog while idle; clear inactive backend state |
| `src/main/ipc/register-ipc.ts` | Process-local explicit selection permission; remove fake environment-based ready state; normal first selection; guard inactive context/discovery/generation |
| `src/shared/model-selection.ts` | Shared active-conversation selection invariant and generic normal bootstrap settings |
| `src/renderer/components/Toolbar.tsx` | Empty selector until confirmed selection; disable model-dependent context/discovery; passive history |
| `src/renderer/components/Composer.tsx`, `src/renderer/App.tsx` | Disable send/regeneration without active selection |
| `src/renderer/store/app-store.ts` | Remove history/first-model inference fallbacks; do not truncate history before selection; await confirmed runtime refresh |
| `scripts/llama-launcher-idle.test.sh` | Instrument real launcher server executable: saved 81920 and all four inherited IDs must never launch it |
| `src/main/ipc/startup-selection.test.ts` | Exercise production IPC initialization/history/selection/switch/restart with injected runtime boundary |
| `src/shared/model-selection.test.ts`, `src/shared/startup-session.test.ts` | Four-model selection/capability/ceiling invariant and real renderer-store idle/history/generation/new-chat coverage |
| `src/main/backends/llama-cpp-backend.test.ts` | Idle catalog makes no server calls; inactive generation/vision state |
| `src/shared/generation-lifetime.test.ts`, `src/shared/streaming-load.test.ts` | Add explicitly selected ready-runtime fixture precondition; retain every existing assertion |
| `package.json` | Include startup regressions in `test:llama-runtime` |
| This Markdown and companion JSON | Evidence and validation report |

## Automated checks and build

- `cargo fmt --manifest-path rust-agent/Cargo.toml --check`: passed.
- `cargo test --manifest-path rust-agent/Cargo.toml`: **201 unit + 65 integration passed, 0 failed** (host execution).
- Every `src/**/*.test.ts` compiled test executed separately: **33 suites passed, 0 failed**; exact source inventory in JSON.
- `bash scripts/llama-launch-config.test.sh`, `bash scripts/electron-sandbox.test.sh`, `bash scripts/llama-launcher-failure.test.sh`, `bash scripts/llama-launcher-idle.test.sh`: **4 suites passed, 0 failed**. Idle launcher checks all four model IDs.
- `npm run typecheck`, `npx tsc -p tsconfig.electron.json --noEmit`, `npm run lint`, `git diff --check`: passed.
- `npm run build`: passed, including Rust build, frontend typecheck, production Vite renderer and Electron/main/preload TypeScript output. Artifacts: `dist/`; existing nonfatal Vite chunk-size advisory remains.

The initial restricted Rust integration invocation failed because mock HTTP servers could not bind (`Operation not permitted`); the host rerun passed all tests. Two existing store test fixtures initially omitted active-runtime selection and were corrected without changing their assertions. A repeated live-history fixture created duplicate synthetic titles; an unambiguous locator corrected that validation harness, and the final four-history run passed. None of these failures remains unresolved.

## Limits

This is functional selection/generation/restart validation, not a quality/performance benchmark. It does not guarantee that a user-selected arbitrary large context fits VRAM. Max discovery/persistence tests and live compatible-cache restoration passed; no full Max search was repeated. Projector loading was verified, but this focused task did not repeat image inference. Huihui received static/IPC/store/history startup coverage, not a new inference run. All validation applications and model processes were stopped.
