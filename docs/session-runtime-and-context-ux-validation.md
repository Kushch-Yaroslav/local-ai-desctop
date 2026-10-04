# Session runtime and context UX: implementation and validation

Historical validation record for the commits below. Backend references describe
that snapshot, not the current llama.cpp-only application support.

Validation date: 2026-10-03. All code work took place in the isolated
`kushch-yaroslav-special-sniffle` worktree. No primary-checkout edits, pushes,
or feature merge-back were performed.

## Git history

The initial isolated checkout was clean at `d693757`, rather than containing
the primary checkout's uncommitted stabilization. Its owner supplied
`b8a187605d74bde0c66a03540f7d54d4dd88a011`:
`fix: stabilize provider/runtime contract for llama.cpp and Ollama agents`.
That exact commit was fast-forward integrated into local `v2-migration`.
Independent feature drafts were temporarily stashed during the integration
and restored without discarding the stabilization.

Feature branch: `kushch-yaroslav-session-runtime-and-context-ux`, based on
updated `v2-migration`. Feature commits:

| Commit | Scope |
| --- | --- |
| `92036bc` | Bundled Mermaid, themes, readable natural-scale diagrams, zoom/pan/expanded/source controls |
| `dc6be77` | Single generation ownership, durable steering, Project 2 routing, answer projection, context evidence transport and regressions |
| `57a8f49` | Context settings, allocation logging, estimator documentation |

Runtime features share IPC/types/transcript code and were committed together
to avoid non-compiling intermediate states. The validation report follows
these implementation commits. Stabilization remains the head of
`v2-migration`; the feature branch is not merged into it.

## Phase results

| Phase | Root cause and change | Key files | Result |
| --- | --- | --- | --- |
| 0 | Stabilization existed outside the initial isolated baseline; integrate the owner's exact commit, retaining runtime-state reconciliation and transactional switching | Stabilization commit, launcher, backend/runtime services, Rust agent | Integrated and checked |
| 1A | Canonical evidence IDs were being rendered as final-answer references; project only known references into paths/descriptions without altering canonical records, paths, unknown IDs or fenced code | `rust-agent/src/agent/presentation.rs`, `loop_runtime.rs`, `transcript.rs` | Presentation and durable-history regressions pass |
| 1B | Existing Mermaid presentation lacked bundled rendering and readable navigation; preserve standard source and provide responsive themed rendering with natural-width protection, zoom, pan, expansion and secondary source/copy | `Markdown.tsx`, `app.css`, package manifest/lock | Actual Electron rendering and controls pass |
| 2 | Selecting a conversation stopped its run; main admission was not process-wide; preserve conversation-specific renderer views and synchronously claim one main-owned generation slot | `register-ipc.ts`, `app-store.ts`, `Sidebar.tsx`, `App.tsx`, Rust `main.rs` | Real A/B/C navigation and second-send rejection pass |
| 3 | Rust steering lacked UI/IPC acknowledgment and durable history integration; connect bounded text steering at safe boundaries, including the final-response race | `Composer.tsx`, `rust-agent-runtime.ts`, IPC/preload/types, Rust events/loop/transcript | Real instruction incorporation and reload pass |
| 4 | Model/configured limits did not establish hardware safety; collect matching allocations and live memory, budget both tiers and expose uncertainty and conservative selection | `context-estimator.ts`, `context-estimate.ts`, backend collectors, `Toolbar.tsx`, launcher | Real 16K/32K selections and inference pass; stale log rejected |
| 5 | Rust discarded the secondary root and routed tools to Project 1; preserve both stable identities, validate scoped tool arguments and check secondary evidence in the correct root | Rust `main.rs`, `loop_runtime.rs`, `evidence.rs`, TS runtime system context | Real two-root tools, references, reload and Edit/Regenerate pass |

Provider reasoning replay, reasoning-only turns, llama.cpp telemetry/token
calibration, sticky folding/checkpoint summaries, Ollama capability discovery,
transactional switching/rollback, runtime-state reconciliation and the
single-slot Qwen launch from stabilization were preserved. No agent architecture,
reasoning-mode redesign, concurrent LLM inference, model-facing Todo gates,
semantic evidence gates or benchmark-specific behavior was added.

## Live runtime and executable identity

Server: `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`.
Model: `/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf`.
Projector: `/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf`.
Isolated endpoint: `http://127.0.0.1:18081`.

Separate launches used `--ctx-size 16384` and `--ctx-size 32768`, with
`--gpu-layers 999 --flash-attn on --spec-type draft-mtp --parallel 1 --jinja`,
the supplied projector, `--no-mmproj-offload`, and `--log-verbosity 5`.
Target and MTP KV were f16; one target slot and one speculative slot.
Electron validation used isolated `LOCAL_AI_RUNTIME_ROOT` directories.

Final rebuilt sidecar:

```text
/home/yaroslav/.copilot/repos/copilot-worktrees/local-ai-desktop/kushch-yaroslav-special-sniffle/rust-agent/target/debug/local-ai-agent-runtime
Build mtime: 2026-10-03 15:43:13.912383633 +0300
UTC: 2026-10-03T12:43:13.912Z
SHA256: b22be467156027e5ddb1e58378a078ebb072e675357f31a5c304d8da87a37275
```

While alive, `/proc/56028/exe` (32K), `/proc/59404/exe` (16K context/Agent)
and `/proc/60994/exe` (final styled-UI 16K acceptance) resolved to that exact
worktree binary. The harness recorded the resolution, build mtime and SHA.
These processes have completed; this is captured live evidence, not a claim
that their `/proc` entries remain present. The supplied stabilization SHA
`4336ea8dd673a4233f30cb2fb3d065478e8b7b911595e3111b469fbb8ef9ca16`
is not the binary used for final feature acceptance.

The owned validation servers were stopped; Electron harnesses close their
applications in `finally`.

## Exact background and steering acceptance

Both final 16K and 32K Electron trials performed the following:

1. Start a real multi-tool, read-only Agent request in A.
2. Open B; its UI explains that A continues generating.
3. Attempt a second send through IPC; it is rejected with
   `Уже выполняется генерация ...`, without canceling A.
4. Create C; the sidebar still marks A as running.
5. Return to A; its owning live assistant placeholder/state is retained.
6. Submit the instruction below through Composer, without Stop.
7. Observe accepted and applied events, subsequent locale-file tools and a
   final answer containing `STEERING_APPLIED`; no cancellation event occurs.
8. Reload and verify initial user, steering user, final answer and references.
   Edit the initial user, retain both project references and actually
   Regenerate; both project files are reread.

Exact follow-up:

> Additional instruction: also inspect Project 2 src/Locales/text.json with project=2 and explain how its locale text relates to the prize page. Include the marker STEERING_APPLIED in your final answer. Still read-only.

At 32K, message `3f7d9eaa-a426-495b-a57e-f10a301e8fbf` was accepted at
epoch ms `1791031430177` and applied at `1791031434769`. At final 16K,
message `d055c417-776a-4c80-9a67-fbbb23647232` was accepted at
`1791031998275` and applied at `1791032003220`. The later file read and
explanation of the prize page's Italian locale fields demonstrate actual
model incorporation, not merely UI acceptance.

Steering is text-only, at most 16,000 characters, with four pending
instructions. It does not mutate token-level inference or bypass the
original tool policy. Chat does not accept in-flight steering: wait or Stop.
SQLite preserves the accepted follow-up user message before the flattened
final assistant answer; the canonical journal preserves actual boundary/
assistant/tool ordering. Regression tests cover the finalization race and
steering-inclusive replay hash.

## Context estimates and measured hardware

The estimator distinguishes model training maximum (262,144), configured
application maximum (131,072), live loaded context, and estimated hardware-safe
context. It uses logged host/device target weights, projector residency,
compute/output buffers, target/MTP KV bytes per token and precision, MTP
weights/buffers/slots, hybrid recurrent state, live RAM/VRAM and reserves:
8 GiB host and 2 GiB device. Invalid or smaller reserve overrides suppress
the safety estimate.

Hardware: RTX 3090, VRAM total **25,769,803,776 bytes (24 GiB)**;
RAM total **67,321,864,192 bytes (about 62.7 GiB)**.

| Loaded context | Hardware-safe estimate | VRAM used bytes | RAM used bytes | Actual inference |
| --- | --- | --- | --- | --- |
| 16,384 | 16,384, `estimated` | 19,463,667,712 | 14,369,910,784 | `CONTEXT16384_OK`; real P2 Agent read with `AGENT16_OK`; full A/B/C/steering/project trial |
| 32,768 | 32,768, `estimated` | 20,684,210,176 | 17,648,726,016 | `CONTEXT32768_OK`; full A/B/C/steering/project trial |

At 32K the startup evidence includes approximately 1,570.02 MiB host weights,
15,339.44 MiB device weights, 2,048 MiB target device KV, 128 MiB MTP device
KV and 598.50 MiB recurrent device state. Compute/output/projector allocations
are also included; total logged allocations are approximately 1,924.06 MiB
host and 18,397.98 MiB device. Shared MTP weights add zero separate bytes in
this runtime; that is observed evidence, not a model-specific assumption.

The estimate is capped at the evidenced loaded configuration. This is a
conservative validated bound, **not an experimentally determined absolute
hardware maximum**. Higher contexts or different offload/cache/draft settings
require fresh observations. Neither 64K nor 128K was called hardware-safe or
stress-launched. Supplying the 32K log against the running 16K server produced
`hardwareSafeTokens=null`, status `observed`, and the explicit context-mismatch
reason. Missing allocation categories likewise do not produce a safe estimate.
See [context-estimator.md](context-estimator.md) for details.

## Exact cross-project task and scope

Project 1 root:
`/media/yaroslav/DATA/Projects/AEM-DAYS/СвипСтейк/колесо`.
Project 2 root:
`/media/yaroslav/DATA/Projects/AEM-DAYS/СвипСтейк/Призы`.

The real initial task required listing `src` in both project slots, separately
reading P1 `src/Module/WheelFortune/WheelFortuneMulti.tsx` and P2
`src/Module/Home/Home.tsx`, explaining each flow and one difference with correct
attribution, using explicit project slots and no edits or terminal commands.
This comparison cannot be correctly answered by reading only one root.
Steering additionally required P2 `src/Locales/text.json`.

Both distinct TSX references were selected from actual `@` autocomplete.
Model context contained both stable project identities/root labels. Tool
events show both explicit scopes, P2-qualified output paths and the subsequent
locale read. The answer distinguished the wheel's CustomEvent-based flow
from the prize page's local React state and related locale JSON to page copy.
Existing TS reference identity/persistence was retained; the discarded Rust
secondary-root routing required the minimal fix described above.

Reads were bounded and some TSX output was truncated; this was not an exhaustive
audit of either project. Edit/Regenerate validation retained both reference
identities and performed fresh real reads from both roots.

## Automated and visual checks

Final relevant results: 98 Rust unit tests and 16 Rust integration tests pass;
15 compiled TypeScript regression scripts pass; `npm run build` (including
Rust build/typecheck/Vite/Electron compilation), Rust formatting, launcher shell
syntax and whitespace checks pass. Targeted lint for the final modified UI passes.
Tests include background token/thinking routing, B/C navigation, second-send
blocking, duplicate steering acknowledgments, regeneration/navigation races,
unrelated deletion, steering replay/finalization, secondary evidence freshness,
known-reference/fenced-code projection and allocation/unknown/reserve handling.

Actual Electron Mermaid checks cover standard TD and wide LR diagrams,
zoom/reset/expanded/source/copy controls, dark and simulated light theme changes,
a 900px viewport and malformed-source fallback. A readability assertion
initially exposed long LR diagrams collapsing to tiny text; natural-width
protection fixed it. Final wide diagram rendered at 2,856px for a 2,856px
intrinsic width, with scrolling rather than unreadable shrinking. Screenshots
of final steering status and both context configurations were also inspected.

Full ESLint remains failing on three verified pre-existing unused variables:
`homedir` and `inlineConfirmation` in `register-ipc.ts`, and `liveRun` in
`App.tsx`. They were not changed. Vite reports large-chunk warnings for the lazy
Mermaid/ELK dependency graph. Mermaid adds 117 dependency nodes without changing
existing dependency versions.

Early harness failures (ambiguous new-chat locator, incomplete intermediate
preload wiring, assuming a safe-selection button when the preset was already
selected) were corrected before the successful final runs; failed attempts
are not reported as acceptance.

## Evidence and remaining limitations

Ignored local `runtime/validation/` contains final
`session-live-16384-evidence.json`, `session-live-32768-evidence.json`,
`context-16384-evidence.json`, `context-32768-evidence.json`,
`context-stale-log-evidence.json`, allocation logs, Mermaid metrics and
screenshots. Session artifacts contain the standalone Electron acceptance,
context and Mermaid harnesses. These private-project artifacts were not uploaded.

Navigation persistence is not renderer-crash/restart recovery; shutdown still
stops inference. There is only one active generation, no queue or concurrent
inference. Ollama received automated backend checks, not a live model matrix;
missing cache/slot allocation evidence remains observed/unknown. Memory use
can change after measurement, reserves are conservative policy rather than
absolute guarantees, and safe estimates require matching verbose runtime
evidence. Expanded Mermaid is in-page, not a new editor or fullscreen redesign.
