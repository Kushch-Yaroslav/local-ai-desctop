# Agent V2 adaptive work-turn budget — 8 October 2026

Implementation base: accepted `v2-migration` commit `6e0bc2bc3ff113b198430090cb974a5d95263d09`. Work is isolated on `feat/agent-v2-adaptive-budget`. No Checkers files, model configuration, registry, MTP, context discovery or server launch parameters are changed.

## Investigation before implementation

The previous [completion audit](agent-v2-completion-audit-2026-10-08.md) established 128 work responses, 147 actual tools, six Implemented outcomes, two withheld final drafts and a tools-withdrawn final response. The hard limit, rather than a demonstrated generation loop, ended that run. This implementation uses isolated fixtures; it does not resume that historical task.

In [loop_runtime.rs](../rust-agent/src/agent/loop_runtime.rs), the old policy counted main provider attempts with a local loop index. Attempts that returned failed tools, empty responses, retries or rejected completion drafts consumed turns. Multiple tools in one response consumed one turn. Compaction summary requests were additional upstream requests but did not reset or advance the main work counter. The limit was 128 in both Fast and Deep, with up to 40 additional synthesis iterations. No dynamic extension existed, and a new worker invocation reset the local counter.

Stop uses the existing cancellation flag before iterations, while streaming (100 ms polling), between tools and inside terminal execution. Pause permits three checkpoint turns, then synthesis; Continue starts another invocation using the persisted conversation. Regenerate/truncating the conversation changes the journal identity. The evidence journal already supports interrupted-worker restoration and completed-history continuation, but did not contain a work allowance. SQLite stores the renderer's plan/task-memory projection, not authoritative runtime counters.

Context fitting, bounded context-overflow recovery/compaction, output continuation, upstream errors and terminal timeouts remain separate controls. There is no overall wall-clock deadline in the current runtime; this change does not invent one. Fast/Deep completion review counts and check budgets remain unchanged. Tool withdrawal permits an honest partial terminal answer, never a fabricated Verified transition.

## Policy

The runtime-owned [work_budget.rs](../rust-agent/src/agent/work_budget.rs) starts at **128 work turns**, grants **32 at a time**, and never allows work above **256** (at most four extensions). A work attempt is charged and durably checkpointed before the main provider request. Pause checkpoint/synthesis responses and compaction summaries do not consume this allowance. Synthesis remains independently bounded.

At a boundary, one unspent progress witness must be younger than 16 work turns. A witness requires both:

1. An actual code-file content hash changed, rather than a same-content write, claim, plan update or successful read.
2. Within 16 turns of that change, the runtime executed a fresh relevant Build/Test/Run/Browser check. Readback/static observations cannot qualify. With deliverables, the existing ledger's scope/binding rules establish relevance; browser requirements require browser evidence. Without deliverables, the ledger's existing inferred capability requirement applies. Planning and outcome registration are optional.

A passing check can authorize an extension, including a relevant FAIL → code change → PASS recovery. Check identity plus changed-code revision prevents spending a passing result twice, even if stdout/timing varies. The implementation hash fingerprint excludes read-only observations. Adding or changing a newly created file cannot qualify just by rerunning an old unrelated command: a PASS must directly name that new source. The source remains classified as newly created through subsequent edits.

There is **one verification grace extension per unfinished task**: a fresh relevant failed check after changing code that existed before the task can authorize one 32-turn block for recovery. Further failure-only work cannot authorize more blocks; subsequent extensions require a new eligible PASS. This is an allowance to attempt recovery, not evidence that implementation is correct. Three failed file edits without actual mutation/check recovery clear a pending witness. Unchanged failures, repeated tests without changed code, old witnesses, metadata, Progress, tokens and tool counts earn no time.

At 256, the absolute limit overrides even fresh progress. On denial, tools are withdrawn and the existing bounded synthesis path reports unresolved outcomes and unfinished saved plan state, now including the runtime's stop reason. The model cannot suppress that disclosure. Extending the allowance makes no provider request, creates no user message and changes no acceptance status.

## Persistence and lifecycle

`Entry::WorkBudget` checkpoints contain counters, allowance, spent identities, origin hashes and the single-use grace flag in the canonical journal. They are ignored by provider projection and context compaction. Only these runtime checkpoints restore authority; model-authored Task Memory and the UI's `workBudget` object cannot grant time. Check identities/source tracking are bounded at 256; filling the check ledger refuses further credits rather than evicting spent results.

Stop, Pause, worker restart and Continue preserve the unfinished task's used turns, extensions, grace flag and denial. A denied task does **not** regain 128 turns by repeatedly requesting Continue. An accepted normal answer with no unresolved registered outcomes or anonymous verification gap closes the allowance; the next new request receives a fresh budget. An unfinished optional plan alone does not keep an otherwise finished task open. Regeneration/a different journal lineage starts a new allowance. Legacy journals without a checkpoint start at 128; their historical local counters cannot be reconstructed safely.

Checkpointing before requests conservatively charges crashes/errors. A hard crash inside a tool may lose an uncheckpointed progress witness, but cannot recover consumed turns. Existing history matching, cancellation, verification epochs, failure scope, browser evidence and completion reviews are preserved.

## UI and files

The Agent Status panel displays `used/current allowance`, extension count and a limit marker when denied. The maximum and last extension/denial reason appear in a tooltip and one compact expanded line, even when there is no plan. No budget cards are appended to the conversation timeline.

Rust emits `work_budget` projections; the TypeScript bridge forwards them, IPC merges/persists them in existing AgentPlan JSON, and the renderer preserves them across Task Memory updates and chat restoration. No database schema migration is needed.

Changed files are the new policy module; runtime/state/event/transcript/evidence/projection wiring; the Rust agent-loop regressions; TypeScript shared types/localization/status tests; main runtime/IPC and their tests; renderer store/panel; the production-renderer fixture; and this report. Verification, deliverable and planning implementation files are unchanged.

## Validation

Eight policy tests and five agent-loop tests cover the requested cases. Existing regressions are reused for gate behavior rather than introducing duplicate implementations.

| Required behavior | Evidence |
| --- | --- |
| Productive boundary extends, including no deliverables | `adaptive_productive_fixture_extends_with_incomplete_verification_in_fast_and_deep`; four isolated Fast/Deep × registered/unregistered runs |
| Read/metadata/Progress loops denied | `adaptive_metadata_progress_and_failed_patch_loops_are_denied`; actual Plan, Task Memory, Implemented claims and visible reasoning/Progress |
| Failed patches denied | Same loop test plus policy recovery/stall tests |
| Relevant failure resolved | `resolved_relevant_failure_is_observable_progress_but_unrelated_pass_is_not` |
| Unrelated creation/old tests cannot authorize time | `irrelevant_creation_and_old_test_pass_cannot_buy_time_but_direct_new_code_check_can` |
| Maximum cannot be exceeded | `adaptive_absolute_maximum_stops_even_continuous_checked_progress`; 256 work requests, four extensions, one synthesis response |
| Stop during extension, restart, compaction | `adaptive_stop_restart_and_compaction_preserve_extended_allowance`; restores 129/160 then advances to 130/160 |
| Pause/Continue/new task/regenerate | `adaptive_pause_continue_and_new_completed_task_have_correct_budget_identity`; paused 140/160, continued 142/160, next task 1/128 |
| SQLite/UI restoration and memory updates | `stop-history.test.ts`, `rust-agent-runtime.test.ts`, `agent-status.test.ts`, production-renderer fixture |
| Partial disclosure and denied Continue | Updated existing `budget_exit_discloses_unverified_results_and_preserves_unreconciled_plan` |
| Verification, scoped warnings, stale/weak evidence, bounded Fast/Deep gate | Existing agent-loop suite plus policy browser/stale regression and opt-in real-browser inverse fixture |

The productive fixture performs several actual source revisions across a long trajectory, registers six outcomes, marks all six Implemented with inspected-source references and executes a failing selected runtime check shortly before turn 128. Both strategies retain tools at 129 and receive 160 turns; no outcome becomes Verified. A separate no-deliverables variant does the same. Metadata/failed-patch loops stop at 128. A continuous changed-code/PASS fixture reaches exactly 256 and stops regardless of progress.

Final validation passed:

- `cargo test --manifest-path rust-agent/Cargo.toml`: **227 unit tests + 79 integration tests**, no failures. The one browser test is opt-in in the normal suite.
- Opt-in `live_scoped_browser_acceptance_with_project_warning_and_inverse`: **PASS**, four actual Chrome scenarios (Fast/Deep × runtime PASS/FAIL), preserving the independent failed baseline warning.
- All **41 current compiled Node test suites**: PASS, including runtime/IPC Stop history, database persistence, status rendering and unchanged model/context suites.
- Production Chromium renderer fixture: PASS, including budget projection, no timeline cards, plan/evidence status, chat switching and Continue.
- `npm run build`: PASS, including Rust compilation, `npm run typecheck`, production Vite build and Electron TypeScript compilation. The existing large-chunk advisory remains.
- `npm run lint` and `git diff --check`: PASS.

The first sandboxed integration invocation could not open fixture sockets; rerunning with local-server access resolved that environment restriction. The expanded Deep fixture initially supplied an implementation claim without a source reference: existing evidence validation correctly refused it. The fixture was corrected to cite inspected `app.js`; the final full suite passed without weakening the gate.

Test logs remain under `/tmp/adaptive-budget-*`; source/prompts and temporary artifacts are not committed. No real-model benchmark was run: deterministic providers exercise the production loop and actual file/terminal tools, and the opt-in Chrome fixture checks real browser evidence separately.

## Limitations

- This is a conservative witness policy, not a semantic measure of how much of the user's specification is correct. The runtime cannot prove that a model-written test is meaningful or that a source edit is substantively useful. The absolute cap still bounds misleading witnesses.
- Pure implementation without an eligible recent check can stop at 128 despite real progress. Likewise, new projects checked only through opaque commands may not qualify without a directly named new source. These cases prefer safe termination over metadata-authorized extensions.
- Only one failing verification sequence gets grace. A long second failing sequence needs a successful relevant check before another extension.
- Continue preserves a denied unfinished allowance. Starting a genuinely new task uses a new/closed journal lineage; there is no implicit manual budget override.
- Work-turn bounds are not wall-clock, token or total action bounds. Existing context, cancellation, process timeout and bounded synthesis controls still apply independently. External resource failures can terminate earlier.
- No real-model performance comparison was run; this change is about deterministic bounded continuation, not inference speed or benchmark optimization.
