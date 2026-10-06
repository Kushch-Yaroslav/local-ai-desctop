# Devstral Agent, terminal failure recovery and Max Context audit

2026-10-06. Baseline: clean `feat/gemma-devstral-mtp`, `e54d0425fb15ddeeda669f79c90d99e03a78ad6e`, including the accepted explicit startup-selection fix. Work branch: `fix/devstral-agent-lifecycle`. Main remains `44f2c6ba4dd63fb6d620a08956f013e8df5a7751`; no merge or push.

The accompanying JSON records production evidence, complete returned discovery probes, runtime states, memory budgets, regression results and test counts. Raw captures, screenshots and runnable validation harnesses remain under ignored `runtime/validation/devstral-agent/`. All projects used for write/tool testing were isolated fixtures there. No user projects, model files, registry profiles or saved production Max Context entries were changed.

## A. Actual Agent request failure

The renderer selected Devstral, Agent mode, and two project directories, then sent a coding task through the actual preload → `chat:send` → Rust worker → llama-server path. A transparent loopback proxy captured the request and forwarded it unchanged. The embedded GGUF template was read statically from the installed Devstral Small 2 24B Instruct 2512 Q4_K_M. Its ordinary-role parity explicitly ignores assistant messages with tool calls and tool results.

Before: `system → user(actual task) → user(runtime guidance)`. Native llama.cpp returned HTTP 500 with `After the optional system message, conversation roles must alternate user and assistant roles except for tool calls and results.`

This was a generic Agent projection defect, exposed by a strict template. The volatile plan/task-memory/evidence tail had been appended as a separate user message (`context/projection.rs`, originating in `65a03b09`; user-shaped projection predates the recent model integration). Qwen/Huihui/Gemma embedded templates do not enforce this parity, so they tolerated it. It was not caused by missing Devstral reasoning support, draft metadata or a model-name allow-list.

After: `system → user(actual task + labeled guidance)`; tool continuations are `system → user → assistant(tool calls) → tool(result + labeled continued-turn guidance) → assistant(tool calls) → tool …`. Guidance received during an unfinished tool turn stays at its latest result boundary with `[CONTINUED USER TURN — NOT TOOL OUTPUT]`; runtime guidance and steering retain their own origin labels. Call/result IDs and the raw result prefix are retained. An intermediate withheld assistant draft followed by tools is carried into the following native assistant-call envelope; it must not count as a completed reply before another ordinary assistant reply.

Normalization is generic and applied only to the wire payload. The canonical transcript, compaction/evidence journal, task memory and user history retain their original events. No fake assistant acknowledgments, Jinja override, validation disablement or Devstral-specific production conditions were added.

The real coding task completed with 19 HTTP-200 requests and 18 distinct native tool calls, including plan updates, both project reads, recoverable patch errors, the file correction and `run_terminal: node test.js`. The terminal verified numeric addition including negatives. Continue then performed project reads and a passing check, including a final-build run that reused history produced with Huihui before switching to Devstral. Plan/task-memory/evidence tools remained available; canonical memory and verification behavior are also enforced by the existing integration suite.

Files: `rust-agent/src/context/message_sequence.rs`, `context/mod.rs`, `agent/loop_runtime.rs`, and `tests/agent_loop.rs`. All integration fixtures now enforce the exact strict ordinary-role invariant. Existing Stage A semantic assertions and bounded-turn counts remain; their guidance reader follows the new labeled boundary rather than assuming guidance always has its own user role.

## B. HTTP 500 left generation owned indefinitely

The Rust worker ended and emitted `agent_error`, but the adapter yielded the error and kept reading stdout from the protocol supervisor, which still waited for another stdin command. Therefore the async generator and `chat:send` invocation never ended. Main-process `activeGenerations` did not reach `finally`, and the renderer's process-wide `generationConversationId` remained claimed. Its per-chat error state cleared `isGenerating`, but the sidebar/global Send guard still showed “Выполняется”. The adapter defect dates to `1e281383`; the background-session renderer ownership remained tied to invoke completion in `dc6be77b`.

Terminal worker error now ends stdin and the stream immediately. Process spawn/pipe errors, unexpected worker EOF/death and terminal stop are handled explicitly. IPC emits a failure if a stream ends without a final result, settles a failed run as database status `error`, handles cancellation independently, and always releases its inference slot. Stderr diagnostics are included for unexpected termination rather than throwing a second error after an already terminal result.

Renderer inference ownership now has a generation token, separate from each chat view's generation ID/state. Terminal error/done/cancelled events release that token immediately. Invoke cleanup releases only its own token, so an old promise/event cannot clear a new chat's running ownership.

Before, the native HTTP 500 left the failed chat as `● Выполняется · Devstral Small 2`; a new chat's Send button remained disabled. After, a real Agent run was fault-tested by replaying the captured pre-fix role sequence at the transparent provider boundary. Actual Devstral llama.cpp returned the same Jinja HTTP 500. The application stored `error`, displayed the failure, removed “Выполняется”, and a new chat sent successfully and returned `2 + 2 = 4`, without Stop or restart. This was repeated on the final build. Production IPC with an actual Rust HTTP-500 worker and renderer ownership-race regressions also pass.

Files: `rust-agent-runtime.ts`, `register-ipc.ts`, `app-store.ts`; regression suites `rust-agent-runtime.test.ts`, `ipc/failed-run.test.ts`, `shared/failed-generation.test.ts`; npm test entries include the new suites.

## C. Devstral memory audit and real boundaries

Both reported safe results were correct: **53,248 FP16**, **98,304 Q8_0**. Production `context:discover` was run end to end on RTX 3090, sequentially. Native GGUF context is 393,216; the existing registry ceiling is 262,144. Neither ceiling was reached. No memory policy or parser implementation was changed.

Policy remains `T=24576 MiB`, `B=1550 MiB` absolute total non-LLM cap, `M=384 MiB`, hence `llmBudget=22642 MiB`. Available budget is `min(22642, L+F-384)`. Observed desktop use is already part of B, not subtracted again. The 150 MiB emergency floor is non-additive. Existing invalidation, cache identity and FP16/Q8 independence remain unchanged.

Actual allocations:

- GPU main weights: **13,302.36 MiB**; CPU-mapped main buffer: 360 MiB.
- Projector: **837.36 MiB on CPU**, plus **64.62 MiB CPU compute**. Production keeps `--mmproj … --no-mmproj-offload` and warmup. It adds no separately offloaded GPU projector weights. Warmup/allocation evidence is present.
- Full-attention KV: 40 layers × 8 KV heads × 128 key/value dimensions. FP16 is **163,840 bytes/token (160 KiB)**; Q8_0 has 34 bytes per 32 values and is **87,040 bytes/token (85 KiB)**. Observed allocations match exactly: 8,320 MiB at 53,248 FP16; 8,160 MiB at 98,304 Q8.
- GPU compute: 272.01 MiB at 53,248 FP16, increasing by 4 MiB per next 4,096 tokens; 516.09 MiB at 98,304 Q8, increasing by 20 MiB per next 4,096 tokens.
- Total observed growth between successful adjacent buckets matches KV plus compute: **644 MiB per 4,096 tokens FP16** (640 KV + 4 compute) and **360 MiB Q8** (340 KV + 20 compute). This independently corroborates the metadata arithmetic.
- No recurrent/state buffers, draft model, speculative KV or independent SWA partition for Devstral. Initial fit passes with zero buffers and repeated reserve messages are not additional allocations. The parser's final allocations have no unknown categories.
- Measured process residency exceeds logged GPU buffers by about **317.63 MiB FP16 / 319.55 MiB Q8**, covering unlogged CUDA/runtime residency. This stays in actual per-process VRAM/free-memory accounting. Driver-reserved memory was about 456–457 MiB and is separately reported, not fabricated as another B reserve.

At equal 32K context, Qwen/Huihui have only 2,048 MiB target KV plus 128 MiB embedded-MTP KV and 598.5 MiB fixed recurrent state. Devstral has 5,120 MiB KV. Gemma has full/SWA partitions (2,560 + 1,200 MiB at 32K) and its external assistant shares target KV. Parameter count is not a measure of context cache cost; Devstral's dense full-attention cache grows considerably faster.

Manual surrounding probes used the same production runtime controller/launcher, one model at a time. Every successful row also performed a small generation:

| KV | Context | LLM MiB | Total used MiB | Non-LLM MiB | Free MiB | Result |
|---|---:|---:|---:|---:|---:|---|
| FP16 | 53,248 | 22,212 | 23,123 | 911 | 996 | startup/inference pass; policy fits |
| FP16 | 57,344 | 22,856 | 23,774 | 918 | 345 | startup/inference pass; exceeds 22,642 policy cap |
| FP16 | 61,440 | — | — | — | — | real CUDA allocation failure; automatic rollback |
| Q8 | 98,304 | 22,298 | 23,210 | 912 | 909 | startup/inference pass; policy fits |
| Q8 | 102,400 | 22,658 | 23,575 | 917 | 544 | startup/inference pass; exceeds policy cap |
| Q8 | 106,496 | 23,018 | 23,935 | 917 | 184 | startup/inference pass; exceeds policy cap |
| Q8 | 110,592 | — | — | — | — | real CUDA compute allocation failure; automatic rollback |

The first FP16 OOM attempt failed a 280.01 MiB compute allocation; a repeat failed its 9,600 MiB KV allocation. Q8 failed a 576.09 MiB compute allocation. Context allocation did not finish, so no completed process-residency snapshot exists for the failed rows. A 100 ms sampler captured startup/rollback telemetry, but nvidia-smi did not yield stable failed-process residency before teardown; rollback peaks are not misreported as OOM residency. Exact CUDA errors were preserved before the launcher restored the previous healthy model.

Returned discovery options satisfy the final budget and 4,096-token buckets. Search probes can explore the discovery margin; their exploratory `fits` is not permission to persist an over-budget Max value. Also, the existing `context.discovery.probe` log is emitted before the search assigns `record.fits`: use returned `result.probes` and final options for decisions. These diagnostic distinctions did not affect the actual safe result.

After restarting the isolated application and explicitly choosing Devstral, both cached results restored with `probeCount=0` and current fit checks. Fresh startup itself remained idle. New real FP16/Q8 allocation captures under `test-fixtures/llama-allocation/` protect final buffer accounting, CPU projector placement and repeated-reserve handling. The absolute 750-MiB-desktop/B=1550 example is asserted explicitly.

## D. Production regressions

- Devstral: normal Chat, initial two-project Agent coding task, repeated native tools/results, continuation, HTTP-500 terminal cleanup and immediately usable new Chat all pass.
- Qwen: Chat and three-request Agent tool cycle pass; embedded `draft-mtp` produces and accepts draft tokens (one completed request: 111/159 accepted).
- Gemma: Chat and two-request Agent tool cycle pass; external draft model and CPU projector loaded, draft tokens accepted (57/88 on one Agent request). Production image attachment at 16K identified red left / blue right; MTP accepted 11/12 draft tokens during that image turn.
- Huihui: Chat and two-request Agent tool cycle pass; embedded MTP accepted 68/87 draft tokens on one completed request. These statistics prove activity, not a speed benchmark.
- Fresh processes after prior model use, including the final Gemma image session, show “Выберите модель”, runtime `idle`, null active model, no server PID and empty nvidia-smi compute-process list before explicit selection. Last final restart snapshot: 980 MiB total GPU use, 23,139 MiB free; no model allocation.

Planning, deliverables/verification, Task Memory, graceful Pause/Continue, terminal safety, background chat views, reasoning controls, project isolation, cache restoration and model capabilities remain covered by the full existing suites. No model registry, launch arguments, projector/draft files, localization, startup-selection policy or Max Context policy changed.

## E. Automated validation and build

- `cargo test --manifest-path rust-agent/Cargo.toml`: **205 unit + 66 integration passed, 0 failed**; binary/doc harnesses contain 0 tests. Every integration request now validates strict ordinary-role alternation. All existing Stage A assertions remain.
- All **35 current source TypeScript test suites passed, 0 failed**, after compilation. This includes actual Rust HTTP-500 IPC recovery, ownership token races, worker spawn/death/stop/EOF, startup selection, MTP launch configuration, allocation parsing and discovery persistence.
- Four shell suites passed: `llama-launch-config.test.sh`, `electron-sandbox.test.sh`, `llama-launcher-failure.test.sh`, `llama-launcher-idle.test.sh`.
- `npm run typecheck`, `npx tsc -p tsconfig.electron.json`, `npm run lint`, `cargo fmt --manifest-path rust-agent/Cargo.toml --check`, `git diff --check`: passed.
- `npm run build`: passed; production artifacts in `dist/main`, `dist/preload`, `dist/renderer`. Existing Vite chunk-size warning remains.

The runner derives the active test inventory from `rg --files src -g '*.test.ts'`, then runs each corresponding compiled JS file. An initial dist-only scan included five obsolete compiled tests whose sources had been removed in earlier V2 work; one referenced removed `project-chat` and failed module resolution. No current test was excluded or weakened. Sandbox-only Rust HTTP/process tests could not bind sockets, so full suites were run on the host. Intermediate new-test compile/assertion issues were corrected before the final passing gates.

## F. Git, scope and limits

Implementation commits: `7b58741` (generic conversation normalization), `7a2f698` (terminal failure recovery/ownership). Allocation fixtures, policy assertions and this evidence are committed separately on the same fix branch.

No files were deleted, no model weights changed, no policy constants altered, no speculative configuration changed, nothing merged into main and nothing pushed. The isolated live application and owned model processes were closed after validation.

These are functional production-path tests, not broad coding-quality/performance benchmarks. VRAM varies with desktop workload; persisted discoveries retain current live fit checks. OOM rows lack completed residency measurements as explained above. Existing age/cache/manual-Max semantics remain intact. Raw evidence is retained locally; the checked-in JSON and focused fixtures make the findings reviewable without starting a model.
