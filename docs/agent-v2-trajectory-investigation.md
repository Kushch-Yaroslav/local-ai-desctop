# Agent V2 trajectory investigation

## Phase 1: recorded before behavioral changes

Baseline: `c32d7f1e6160e1932333076d9c3f737f3c57c0ca` (`v2-migration`). Incident: conversation `06d0c870-277a-437e-9eca-f83379f2b57b`, runtime run `42a59b8c-14ef-400b-ab6b-100ab84f8878`, analysis run `abb5f236-e247-4c19-b3c4-d18cd7263899`, 2026-10-07 14:49:42–15:25:25 UTC. Source: read-only SQLite, its canonical evidence journal and observations, and all 34 rendered prompts/usage records in `llama-cpp-mtp-server.log`. The real project was not changed or resumed.

| Measurement | Complete stopped run |
| --- | ---: |
| Accepted model responses | 34 |
| Actual tool calls | 51 |
| Visible Progress events | 30 |
| Plan calls | 6 (one set, five updates) |
| Deliverables calls | 7 (initial additions) |
| Runtime state snapshots / requests | 34 |
| Snapshots containing Plan / Deliverables / verification state | 28 / 29 / 30 |
| read_file | 19 (two refused duplicate reads) |
| observation_read | 3 |
| apply_patch / failures | 5 / 5 |
| Full write_file operations | 5 |
| run_terminal | 4 |
| Actual cumulative prompt / output tokens | 1,645,736 / 26,872 |
| Provider-reported cache reads | 138,138 (8.39%) |

The user's 33 turns / 1.48M snapshot was taken before the final turn. The 81 stored activity rows include 30 synthetic Progress rows; `action_count=51` counts actual tools. There was one initial user request and one late pause steering message at 15:24:19 UTC, not repeated human plan updates.

### Causes and attribution

1. `Transcript::has_active_prompt_tail` stops at the latest Message. Every assistant/tool exchange therefore makes even identical state appear unsent. `projection::project` deletes the preceding accepted tail and appends a new tail. It alters an early message on every request. There were only 14 distinct snapshots among 34 injections. All 33 requests after the first reused exactly **4,186 tokens** (the tools/system prefix), even when state was byte-identical. The server log shows why it falls this far back: context checkpoints are enabled (32, minimum spacing 8,192); rollback repeatedly restores the 4,186-token checkpoint and erases the later checkpoints. The textual common prefix is longer, but the available saved context cannot reuse it. This is a harness prefix-mutation defect interacting with the backend's checkpoint rollback, not an inference-speed problem. No checkpoint configuration change is needed.
2. `prompt_tail_message` assigns runtime state role `user`. `message_sequence::normalize` appends it to the latest tool result with **`[CONTINUED USER TURN — NOT TOOL OUTPUT]`**, followed by `[RUNTIME GUIDANCE — NOT USER CONTENT]`. The native Qwen template renders tool responses as user envelopes too. Thus saying simply “wire role user” omits the important normalization: it is specifically the explicit continued-user attribution on runtime-owned state that falsely signals human intervention. This explains the model's recurrent “user has given me a plan state update” interpretation, explicitly present on six consecutive turns (27–32). That interpretation is model-generated; the misleading attribution and moving state are harness-generated.
3. Progress is not a callable tool. `emit_status` projects the assistant's preamble from the **same** tool-calling response into the renderer. Those 30 events did not themselves cause 30 extra generations. Keep this mechanism; reduce redundant narration through correct state attribution and action-oriented Fast guidance. Existing Fast guidance principally addresses research, not implementation cadence.
4. There was **no observation compaction** in these rendered prompts: no receipts, truncated projections or compaction summaries. Read results had real newlines after JSON decoding. Two observation_read calls followed the exact-unchanged-read guard; the third recovered the earlier complete test file. Original source was still present in the prompt. The agent reread it despite having it; the guard then required another recovery call. Do not change evidence lifetime based on a nonexistent truncation problem.
5. Three patch attempts copied actual source indentation without the additional patch context marker. The parser correctly removes one space marker, leaving old lines one space too short. The last two patches contain no additions/deletions at all. Existing errors obscure these syntax errors behind generic “surrounding lines differ; read again” advice. The ensuing full rewrites duplicated large source output/input and one introduced `board[curR][curR]`, repaired by another full rewrite. Valid patches do not require fuzzy matching or a new edit tool.

### Every failed patch

| Turn / observation | Reason | Attribution |
| --- | --- | --- |
| 7 / obs-00000020 | Context has four spaces where source has four; parser consumes marker, leaving three. Same error throughout block. 27 added lines. | Invalid context encoding; semantically reasonable insertion. Tool diagnosis inadequate. |
| 8 / obs-00000021 | Same lost context-marker space, despite unchanged original source. 21 added lines. | Same model syntax error / tool feedback defect. |
| 11 / obs-00000024 | Same lost context-marker space after two targeted rereads. 19 added lines. | Same model syntax error / tool feedback defect. |
| 16 / obs-00000027 | Zero `+` or `-` lines; context retains the incorrect index. Also loses marker space. | Invalid no-op patch; should be rejected explicitly before matching. |
| 34 / obs-00000046 | New tests supplied as context without `+`; zero change lines. Also loses context-marker space. | Invalid patch; should be rejected explicitly before matching. |

Five full rewrites: rules twice (two direct patch fallbacks), bot, HTML, app. No evidence of a valid stale-free patch being rejected. No line-ending or atomic-write defect was found.

### Prompt accounting

Actual total above is provider usage, including cached input. The following breakdown tokenizes individual component strings with the same loaded GGUF tokenizer (`/tokenize`, no inference). Joining boundaries changes a few tokens, so attribution is approximate; the residual includes observation locators, native template framing and unmatched boundary text. Summing components plus residual equals actual input.

| Component | Cumulative tokens |
| --- | ---: |
| Tool schemas | 79,968 |
| Stable system, Fast and verification guidance | 62,220 |
| Actual human request replay | 42,296 |
| Assistant tool arguments and visible prose (includes full rewrites) | 272,205 |
| Retained reasoning history | 64,938 |
| File observations | 764,485 |
| Recovered observation views | 89,875 |
| Terminal results | 46,774 |
| Deliverable tool results | 51,330 |
| Plan tool results | 13,260 |
| Patch errors | 5,724 |
| Other tool results | 42,436 |
| Runtime Plan | 4,677 |
| Runtime Deliverables | 8,526 |
| Runtime verification state | 5,413 |
| Runtime investigation inventory | 8,106 |
| Runtime Project Knowledge catalog | 7,072 |
| Other runtime instructions / language | 1,567 |
| Template / locator / boundary residual | 74,864 |

Task Memory, compaction summaries and folded observation receipts contributed zero here. The state snapshots are only ~2.1% of cumulative input; removing those alone cannot remove the 1.65M input replay. The larger opportunity is preserving the accepted prefix and preventing retries/full rewrites. Full exact observations should remain available. No evidence justifies changing weights, sampling, MTP, context capacity or llama.cpp settings.

The same native log contains 34 prompt-evaluation timings totaling **1,884.21 seconds for 1,507,598 uncached tokens**, versus **184.85 seconds decoding 26,872 output tokens**. Repeated prefill, rather than the observed fast decode, consumed most of this run's time. These are summed server timings, not an estimate from the UI screenshot.

### Intended minimal fixes justified by these findings

- Distinguish runtime-owned state from real user/steering messages in provider projection.
- Record only changed accepted state; retain accepted changes at their original boundaries so subsequent projections are append-only until intentional compaction.
- Improve patch schema with a minimal replacement example and explicit context-marker rule; reject context-only hunks and report bounded expected/current mismatch diagnostics. Keep exact matching, ambiguity rejection, atomic staging and boundaries.
- Clarify Fast implementation cadence without suppressing useful visible progress or changing verification requirements.
- Test state projection/cache stability, native message ordering, persistence, patch diagnostics and existing completion/evidence behavior. Use an isolated coding fixture for live comparison.

## Phase 2: implementation and additional live evidence

### Runtime state and accepted prefixes

`context/runtime_state.rs` projects trusted runtime snapshots as section changes. An initial snapshot supplies all sections; subsequent updates supply only changed sections and explicit clears for removed sections. Plan, Deliverables, verification, Task Memory and investigation remain separate sections. Unchanged snapshots are not recorded again after assistant/tool substeps.

Accepted changes stay at their original conversation boundaries. The next request therefore retains the exact accepted prefix instead of moving the previous snapshot. Full snapshots remain in the existing `PromptTail` journal entries; deltas are a projection, not a new storage format. Older journals still load. A new user task or compaction resets the projection to a full current snapshot. Finalization retains its existing lifecycle behavior, including retiring prior investigation state.

The internal role is `runtime` and its explicit header is `[AGENT RUNTIME STATE — NOT A USER MESSAGE]`. Provider normalization attaches it to an existing tool response, or the initial request envelope. It never uses the continued-human-turn marker. Strict alternating templates still need a synthetic continuation envelope for runtime review after a completed assistant draft; that envelope is explicitly runtime-owned, not a persisted human message. This is provider-independent normalization, not a Qwen template exception. Real user turns and steering keep their existing identity.

Progress already uses the current response's assistant preamble. No Progress tool, extra model call or renderer timeline snapshot was added. Fast guidance now permits empty tool preambles and asks for progress at meaningful milestones or blockers. It explicitly tells the agent to continue from runtime state without reorienting or narrating plan updates. Deep retains its existing investigation/review policy; both strategies use the corrected state projection.

### Patch feedback and literal edits

`apply_patch` still matches exact source context using its existing parser/whitespace rules. The schema now shows a small `-old` / `+new` example and explains the extra context-marker space. A context-only hunk is rejected before matching. A mismatch reports the file, hunk, candidate file line, and bounded expected/current strings where available. No fuzzy matching, speculative normalization or stale-write exemption was added. Existing all-or-nothing multi-file staging remains intact.

The first live comparison after those improvements successfully applied four of four patches. However, its real persisted Continue run then generated **four more invalid patches**: two missing context-marker spaces, one incorrect context block, and one context-only hunk. It resorted to a full rewrite to change a few lines. This additional evidence revised the initial Phase 1 assessment that better diagnosis alone would suffice. We added the narrowly scoped generic `replace_text` tool for small edits, as allowed by the task.

`replace_text(path, old_text, new_text)` changes exactly one literal occurrence. Empty, unchanged, absent or repeated old text is refused, including overlapping matches. It uses the runtime's SHA-256 revision from an actual read or its own successful write; model-supplied hashes cannot authorize an unread or stale edit. Source must still match that revision, and bytes/path resolution are rechecked immediately before rename. The write stages in the same directory, preserves permissions and exact line endings, syncs, then atomically renames; validation/write failures preserve the original and remove staging. Project boundaries/grants apply normally. This remains an optimistic stale-write check, as with existing editing tools; it is not a filesystem lock against arbitrary external writers.

The tool participates in mutation/change epochs, readback tracking, authored-file inventory, verification demotion, read-only tool filtering, workspace tool advertising and existing renderer mutation labels. It cannot verify a deliverable or hide evidence. Larger edits can still use `apply_patch`; full `write_file` remains available for its existing purpose.

### Verification and persistence

No verification acceptance rule, browser evidence rule, deliverable-to-check association, baseline classification, completion gate or warning visibility was changed. A relevant failure remains blocking; an unselected unrelated failure remains a visible project warning; an explicit full-suite requirement remains project-wide. Explicitly selected failing evidence cannot be detached after failure. A relevant mutation still stales passing evidence and demotes Verified. Implemented remains distinct from Verified.

No database schema or evidence journal migration is required. Restart reproduces the same accepted state projection, Continue restores separate plan/deliverable/verification state, and compaction refreshes current state without replaying covered observations. Exact `observation_read` recovery remains unchanged and available. No observation lifetime/compaction adjustment was justified by the incident.

The compact Plan + Deliverables UI remains unchanged. Progress remains visible in its existing chronological renderer projection; the only UI-facing addition is the ordinary “Изменение файла” activity label for the new edit tool. No large state snapshots were added to the timeline.

## Phase 3: regression results

Final validation on the feature branch:

| Check | Result |
| --- | --- |
| Rust unit suite | 218 passed |
| Rust integration suite | 72 passed; one optional installed-browser test skipped by default |
| That optional test explicitly run with real headless Chrome | Passed: Fast and Deep, browser PASS with retained baseline project warning, inverse browser FAIL blocks verification |
| Production renderer regression | Passed: compact plan/deliverables, scoped PASS + warning, Progress chronology, collapse/expand, follow-scroll, chat switching, Continue, completion/failure, localization |
| All current source-matched compiled Node test files | 39/41 passed; two environmental baseline failures below |
| Four shell runtime/launcher/sandbox suites | All passed |
| `npm run lint` | Passed |
| `npm run typecheck` / `npm run build` | Passed, including Rust build, Vite and Electron TypeScript compilation; existing Vite large-chunk advisory |

The two failing Node suites are `src/main/backends/llama-cpp-backend.test.ts` (`coderNext?.installed`) and `src/main/ipc/startup-selection.test.ts` (ENOENT for `/media/yaroslav/DATA/llama-models/Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf`). Their unchanged accepted-baseline tests require weights that are no longer present. Model registry/weights were not changed to conceal them. Stale ignored compiled test files with no source counterpart were removed before counting current source-matched suites; source tests were not deleted.

Added/updated coverage maps directly to the requested cases:

| Requirement | Evidence |
| --- | --- |
| A: plan update is not a new human message | Scripted provider and projection tests assert internal runtime origin, one original human envelope and no continued-user marker |
| B: unchanged state does not grow canonical history | Repeated assistant/tool substeps leave one accepted snapshot; persisted reload gives identical projection |
| C: Progress visible without extra reasoning request | Scripted tool-calling response emits visible status and exactly the required provider calls; renderer chronology passes |
| D/E/F/G: fresh patch, stale patch, malformed patch, useful error | Agent-level fresh-read patch succeeds; stale/malformed edits leave source intact; incident indentation error reports hunk, line and expected/current; context-only hunks rejected |
| Safe small edits | Unique literal replacement succeeds; unread/forged-hash and externally stale replacements fail; ambiguity/overlap, no-op, missing text, CRLF, boundaries and staging cleanup tested |
| H: observation recovery | Existing exact large observation, folding/compaction/restart and actual provider rehydration tests pass unchanged |
| I: verification | Existing scoped acceptance, relevant failure, project warning, broad requirement, baseline provenance, sticky failed association, false completion, stand-in/browser and change-epoch tests pass; replacement also demotes verification |
| J: Stop/Continue/restart | Existing hard cancellation, process-group ownership, pause/checkpoint, saved plan/deliverables/evidence, compaction and restart tests pass; new state deltas round-trip identically |

## Phase 4: real isolated Agent comparisons

`scripts/agent-trajectory-live.py` copies `test-fixtures/agent-trajectory` into a new output directory, runs the chosen Rust executable through its real stdio/provider path, and records requests, events, trace, metrics and a separate executable oracle. The medium task adds priority/FIFO, cancellation (including during a worker), retry/exhaustion/concurrent-drain handling, CLI, docs and deterministic tests. The independent oracle is outside model-selected verification evidence. No real Checkers files or application database were written.

The before executable was built from exactly `c32d7f1`; all comparable medium runs used the same fixture and task, Qwen3.6 alias, Fast, thinking ON, context 110,592 and recorded inference settings. No weights, sampling, MTP, CPU/GPU offload, llama.cpp or persisted launcher settings were changed. Owned temporary servers were stopped after testing. Provider token usage includes cached tokens; uncached tokens below are total minus reported cache reads.

### Comparable medium runs

| Metric | Accepted baseline | Initial state/patch-feedback fix | Final fix, including literal edits |
| --- | ---: | ---: | ---: |
| Wall seconds | 307.21 | 297.30 | 175.12 |
| Model turns | 17 | 50 | 29 |
| Tool actions | 42 | 85 | 44 |
| Progress events | 5 | 14 | 13 |
| Plan calls | 8 | 10 | 0 |
| Deliverables calls | 16 | 16 | 16 |
| read_file / observation_read | 6 / 0 | 12 / 0 | 6 / 0 |
| apply_patch attempts / failures | 1 / 1 | 4 / 0 | 0 / 0 |
| replace_text attempts / failures | unavailable | unavailable | 5 / 0 |
| Full write_file operations | 5 | 4 | 5 |
| Cumulative input tokens | 248,201 | 1,878,120 | 649,815 |
| Output tokens | 8,993 | 27,289 | 17,714 |
| Cache reads | 65,312 (26.31%) | 1,838,044 (97.87%) | 626,977 (96.49%) |
| Uncached input tokens | 182,889 | 40,076 | 22,838 |
| Independent correctness | PASS | FAIL, then repaired through Continue | PASS |

The final medium run verified all four deliverables and passed the independent oracle. It repaired five actual failing test executions using five successful literal edits. There were also four rejected overlong deliverable labels and one refused composed terminal command. Those errors remain recorded; no terminal policy or deliverable bounds were weakened for benchmark numbers.

The final result is **43.0% shorter wall time and 87.5% fewer uncached input tokens** than the accepted baseline. It is **not** a turn/action/input-token reduction: turns rose 17→29, actions 42→44, total input 248,201→649,815 and Progress 5→13. Most incremental prompt input is now reused, but the model still makes implementation/test mistakes. One stochastic before/after task cannot establish a general speed or trajectory guarantee. The intermediate failed run is retained here, not excluded to present a favorable result.

Both baseline and final medium reasoning had zero matches for the original explicit “user supplied a plan/state update” attribution. That particular incident symptom was not reliably reproduced by this smaller task, so the diagnosis rests on the original persisted run plus deterministic origin/prefix regressions. The final model did not create an explicit plan for this task. Fast guidance permits lean action, but Progress narration is still model-generated and did not decrease in the medium comparison. We did not implement a narration throttle or force artificial task scheduling.

### Continue and second-model checks

The initial post-fix medium implementation missed priority reordering when a running worker enqueued a new high-priority job. Its own tests passed but the independent oracle failed. A real new runtime process then resumed the same durable evidence and Task Memory with that precise failing acceptance test. It recorded the selected FAIL, repaired the code, reran acceptance and project tests, and reverified all four items. **Continue: 67.45 seconds, 16 turns, 27 actions, 231,734 input / 5,215 output, 216,524 cached; final independent PASS.** Its four failed patches and full-file fallback motivated the literal-edit tool. Verification did not make the initial incorrect implementation correct; it enforces evidence provenance/scope/freshness, not exhaustive semantic test coverage.

Final-runtime small-edit smoke asks only to change queue IDs from 1 to 100, adjust tests and run `npm test`:

| Model | Wall seconds | Turns / actions | Progress | Literal edits | Input / output / cached | Correctness |
| --- | ---: | --- | ---: | --- | --- | --- |
| Qwen3.6-35B-A3B | 19.82 | 6 / 8 | 0 | 2/2 PASS | 38,480 / 827 / 31,144 | Scoped independent oracle PASS |
| Qwen3.8-27B | 42.63 | 10 / 10 | 0 | 2/2 PASS | 73,666 / 1,945 / 65,401 | Scoped independent oracle PASS; Verified |

Qwen3.8 used its existing 65,536-context model profile rather than a Qwen3.6-specific inference configuration. It attempted verification while Pending once; the existing gate refused that attempt, then accepted after Implemented + relevant PASS. These are smoke checks, not performance comparisons between models. Huihui was not run separately; deterministic registered/future-family tests pass and production changes contain no model-name exceptions.

### Accounting corrections and retained artifacts

- An earlier attempted baseline fixture lacked a standard `package.json`. `node test.cjs` was classified as Run while the model cited it as Test, creating repeated failed verification attempts. That run was stopped and excluded from the comparable table. It remains under `/tmp/agent-trajectory-baseline`: 39 turns, 66 actions, 980,465 input, 30,008 output, approximately 23m29s. Both comparable fixtures received the same explicit `npm test` entry point before running.
- The first external oracle incorrectly required one retry result ordering not specified by the task. It was corrected to compare per-job results and to include the explicitly required dynamic enqueue/priority behavior. Rechecking the accepted baseline passed; the initial post-fix run still failed on that real missed requirement. Earlier oracle outputs were retained.
- The Qwen3.6 small-edit driver initially ran the full medium oracle, which appropriately failed on features absent from the small task. The separately scoped small-edit oracle passed; the original warning/output was retained. The driver now accepts `--oracle` for custom tasks, used correctly in the Qwen3.8 smoke. This is benchmark scoping, not a runtime verification exemption.

Local raw investigation artifacts (not committed because they contain full prompts/project source and are machine-specific): `/tmp/qwen36-server-requests.json`, `/tmp/qwen36-server-usage.json`, `/tmp/qwen36-incident-patches.json`, `/tmp/agent-incident-accounting.json`; live request/event/trace/metrics/oracle files under `/tmp/agent-trajectory-before-valid`, `-after-valid`, `-after-continue`, `-final-valid`, `-small-edit`, `-qwen38-smoke`; validation logs under `/tmp/agent-trajectory-final-suite.log`, `-final-browser.log`, `-final-renderer.log`, `-source-tests-final.json`, `-shell-tests.json`, `-lint-final.log`, `-build-final.log`. The fixture, driver, independent oracles and this aggregate report are committed for reproducibility.

## Changed files and remaining limits

Production: `rust-agent/src/context/{runtime_state.rs,mod.rs,projection.rs,message_sequence.rs}`, `rust-agent/src/agent/{transcript.rs,strategy.rs,loop_runtime.rs,ledger.rs}`, `rust-agent/src/tools/filesystem.rs`, `src/main/services/{agent-workspace.ts,rust-agent-runtime.ts}`. Tests/tooling/docs: `rust-agent/tests/agent_loop.rs`, `src/main/services/agent-workspace.test.ts`, `eslint.config.mjs`, `scripts/agent-trajectory-live.py`, `test-fixtures/agent-trajectory/{queue.cjs,demo.cjs,test.cjs,README.md,package.json}`, both `test-fixtures/agent-trajectory-*-oracle.cjs`, this report. Unit regressions also live beside their production modules.

Remaining limits: canonical tool/file/reasoning history still contributes substantial total input; accepted historical state deltas stay until ordinary compaction, with the latest section authoritative. Observation reread guards, terminal composition policy, deliverable wording limits and semantic test coverage can still cause model-originated extra turns. Patch syntax mistakes remain possible; they now have diagnostics and a safer literal alternative. Provider-native templates may still encode tool/runtime envelopes using their user-role tokens, but origin is explicit and normal state updates do not introduce a new human turn. Cache efficiency can still vary with backend checkpoints, legitimate steering, compaction and finalization. This change does not guarantee a fixed turn budget, exhaustive tests or general benchmark improvements.

Git: dedicated `fix/agent-v2-trajectory-overhead` branch from accepted `v2-migration` baseline. No model-registry feature branch was incorporated. No Checkers changes, push or merge were performed. The completed feature commit is reported in the final response; generated runtime/build/log artifacts stay ignored outside the committed source changes.
