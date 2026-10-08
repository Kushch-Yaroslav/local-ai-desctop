# Agent V2 completion and plan audit — 8 October 2026

## Scope and read-only findings

Started from clean `v2-migration`, HEAD `b7eecb60da42891c0371bea0ed8517eca8a786cf`. Both accepted model integration and trajectory commits are present. The investigation first read SQLite in `mode=ro`, the canonical evidence journal, exact stored observations and native server/application logs. No Checkers file was edited, executed or resumed. The reviewed audit fixes are committed on `v2-migration`.

Identities:

- Conversation: `e231513a-9b1a-42f1-865f-3fab1ac4cdb5`.
- Analysis run: `2ab7d4c2-66bc-48d6-8118-b31cb142e85b`.
- Runtime/generation: `2198a7c2-c2aa-409a-9cde-9eaaa989a20e`.
- Journal: `runtime/app-data/agent-evidence/2cf0cc7e965618e2cd411df79802837ff18a1b266463c9808ef404e30c2fe0a2/2198a7c2-c2aa-409a-9cde-9eaaa989a20e/events.jsonl`.
- Model: Qwen3.6-35B-A3B, Fast, Thinking ON, context 110,592.
- Application snapshot: no selected project/working directory; an explicit `workspace_roots` grant points to the game directory.

### Actual trajectory

Times below are UTC on 7 October. Turn timestamps come from provider usage `created` (model response completion); tool observations and journal order establish the associated actions. The run began at 17:15:46.875 and ended at 17:37:43.966: 21m57s.

| Turn / time | Observed action |
| --- | --- |
| 1–33, from 17:15:54 | Reads the existing architecture. The first stored rules observation already contains the reversed Poddavki winner rule. No successful edit precedes turn 39. |
| 34, 17:17:14 | Creates a five-step plan: run baseline; add comprehensive tests; run tests; browser verification; normal-mode regression. Creation succeeds (`obs-00000039`). |
| 36, 17:17:18 | Actual baseline test run exits 1 with two failures: bot capture preference and mate-in-1 (`obs-00000041`). A composed command at turn 35 was refused and did not run. |
| 37, 17:17:23 | Marks s1 complete, automatically activating s2. Redundantly marks s2 in progress too. Both operations succeed (`obs-00000042/43`). No later plan calls occur. |
| 39–86 | Adds/rewrites tests and iteratively edits the bot. Uses a temporary debug script. There are failed edit attempts and repeated test runs. |
| After 67, 17:27:55 | One context compaction, covering journal prefix 153; UI reports 91,775 → 24,102 tokens. Plan remains revision 3 and is present in subsequent state. |
| 87–88, 17:31:34–37 | Views an empty deliverable list, then registers six items. The user listed seven outcomes; browser verification is represented as a capability on d1–d3 rather than a separate seventh item. |
| 90–107 | Attempts browser-related setup: an app.js background invocation and composed dependency search are refused; local puppeteer/jsdom directory reads fail; a foreground HTTP server times out. No browser actually runs. |
| 108–117 | Creates a script called browser_verify.js that inspects source strings. Its reported 28/28 PASS is a Node/static substitute, not browser evidence. Deletes this and the debug script. |
| 118–119, 17:33:23–30 | Marks all six outcomes Implemented. No verified proof is attached. |
| 120, 17:33:43 | First tool-free final draft. Completion gate withholds it and asks for relevant verification. |
| 121–122, 17:33:46–53 | Explicitly selects d4/d5/d6 for the broad test.js command. It exits 1. Three verify attempts are refused with relevant-failure diagnostics (`ev-030`, `obs-00000138/39/40`). |
| 123, 17:34:11 | Second tool-free final draft. A newly selected failing check earns one additional bounded review. Draft is withheld. |
| 126–128, through 17:36:06 | Changes bot.js again, staling earlier evidence. Repeats the selected suite, still FAIL (`ev-032`); three more verify attempts are refused. |
| 129, 17:37:43 | Runtime reaches the hard 128 work-turn budget, records Finalizing, withdraws tools, requests synthesis, accepts the answer and records RunComplete. SQLite stores the run as completed execution. |

Totals: **129 main model responses, 147 actual tools, 40 visible Progress projections and one context action**. The UI's 148 actions counts tools plus compaction. Tool distribution: read_file 71, run_terminal 24, replace_text 19, deliverables 19, plan 3, apply_patch 3, list_directory 2, create_file 2, delete_file 2, write_file 1, task_memory 1. No observation_read calls. All plan operations succeeded; later updates were never requested, not rejected or lost.

Native usage confirms **6,493,038 main input tokens and 101,341 main output tokens**. Including the one summary request: 6,508,777 input, 101,378 output, 6,160,086 cached input (~94.6%). This supports the previous prefix/cache improvement remaining active. Summed server prompt evaluation was 471.51s; decode was 779.81s. There is no basis here to change inference configuration or resurrect the earlier planning-heavy harness.

### Deliverables and evidence

| Item | Declared capability / scope | Final evidence/state |
| --- | --- | --- |
| d1: Poddavki available in UI | browser / acceptance | Implemented with source-description text; no browser proof; no verify call |
| d2: Poddavki PvP inverse winning conditions | browser / acceptance | Implemented with a description of the reversed winner and test references; no browser proof; no verify call |
| d3: automatic bot response | browser / acceptance | Implemented with app.js/test references; no browser proof; no verify call |
| d4: Poddavki bot strategy | test / project | Implemented; failed selected test.js command permanently bound; both verify attempts refused |
| d5: normal mode regression | test / project | Same selected failing command; both attempts refused |
| d6: new mode tests | test / project | Same selected failing command; both attempts refused |

Implementation `evidence` strings are model claims, not runtime proof. Verified proof arrays remained empty. `check: test` creates broad project scope in the accepted architecture; it does not mean a narrow behavior criterion. Furthermore, the model explicitly selected the broad command for d4–d6. Such a failure cannot later be detached merely by calling it unrelated. The last warning is a fresh scoped failure with d4/d5/d6 IDs, not a silently resurrected baseline warning. The renderer's generic “Project warnings” heading includes this relevant failure and displays its associations.

Only two failures are established by the pre-edit baseline. The final report's third “pre-existing” failure (normal stalemate) is absent from that baseline and arises with the added tests. Whole-command output changes prevent the ledger from declaring an identical baseline failure. No regression exemption was granted. This classification remains conservative and correct for the selected evidence.

### Semantic game correctness is separate

`obs-00000010`, an initial rules.js read, already says “the player losing all pieces loses” and returns the opponent on zero pieces. That contradicts the user's specification. This run never edits rules.js, app.js or index.html; its successful persistent changes are to bot.js and test.js, plus creation/deletion of diagnostic scripts. The final report's attribution of all four files to this run is not supported by its tool history.

The model wrote tests that endorse the reversed winner. A test agreeing with faulty source does not establish specification correctness. The harness did not reverse the winner, and refused to certify the relevant browser/test outcomes. This audit does not repair the game or infer when the earlier rule was introduced.

## Source-backed root causes

1. **Model plan maintenance:** s2–s5 were never reconciled. `plan::Plan::update` correctly activates the next step when s1 completes. The journal, `agent_plans.taskMemory.plan`, final prompt and UI projection all agree on 1/5. No persistence or compaction loss is demonstrated. The earlier wording “update only when the approach changes” can discourage normal milestone updates, but the evidence does not prove that wording caused this particular model choice.
2. **Expected bounded completion:** `MAX_INVESTIGATION_TURNS=128` and `run`'s turn-budget transition withdraw tools; `review_tool_free_final` accepts finalizing responses. This behavior predates `102ce787`. Fast's gate was not disabled: it withheld turns 120 and 123. Unfinished plans never determine acceptance; unverified deliverables can legitimately end with an honest partial report. `Final.complete` denotes a complete emitted response, and the database completed status denotes execution completion, not Verified task outcomes.
3. **Concrete capability-discovery bug:** `Config::work_root` uses a selected project or the first explicit workspace root. Terminal and file execution use it. Browser availability and Deep project-test discovery instead used only `config.root`. This incident has null selected project and a nonempty explicit workspace grant (`generation.snapshot` and the bridge's request construction in `src/main/services/rust-agent-runtime.ts`). Consequently browser availability was **forced false without checking project drivers or PATH**. The final prompt excluded d1–d3 as unreachable. Actual browser availability in the historical process is unknown; the runtime's claim of unavailability is not established. This mismatch also predates `102ce787`.
4. **Terminal presentation gap:** `AgentStatusPanel` displayed a persisted `in_progress` step as “current” even after execution stopped. The model's final answer disclosed browser/test limitations but omitted the hard work-turn limit and described implementation confidently. The existing bounded gate could not require truthful prose after its review allowance; the final prompt's stronger unfinished-outcomes instruction only applied to Pending, not all Implemented-but-unverified items. This is an explanation gap, not evidence that Verified status bypassed validation.

Classification: **A (model neglected plan), C only in the sense of an unexplained budget-limited terminal result, and a concrete harness capability-discovery bug plus terminal UI ambiguity.** B (failed plan tools) and D (lost/stale backend projection) are disproved. E (intentional partial completion) explains the terminal path, but the asserted browser unavailability and all-three-pre-existing explanation were not justified.

Concrete source locations (the old root-only discovery is visible in the uncommitted diff against the audit baseline):

- [loop_runtime.rs](../rust-agent/src/agent/loop_runtime.rs): `Config::work_root`, `MAX_INVESTIGATION_TURNS`, `tool_schemas`, `review_tool_free_final`, `run` capability initialization, hard-budget transition and accepted-final branch; new `terminal_status_note`.
- [plan.rs](../rust-agent/src/agent/plan.rs): `Plan::update` activation and validation rules.
- [verification.rs](../rust-agent/src/agent/verification.rs): `browser_available`, scoped evidence validation and baseline/change-epoch rules.
- [transcript.rs](../rust-agent/src/agent/transcript.rs): accepted runtime-state deltas, compaction boundaries, finalization lifecycle and `finish_durable`.
- [rust-agent-runtime.ts](../src/main/services/rust-agent-runtime.ts): selected-project versus explicit-workspace request construction, memory projection and final event handling.
- [AgentStatusPanel.tsx](../src/renderer/components/AgentStatusPanel.tsx): compact persisted-state projection; formerly unconditional current-step presentation.

### Planning cost and previous protections

The three plan calls are 2.04% of tools, spread over two main responses, with only 470 argument characters. Rendered prompts identify 48,484 characters of runtime plan sections, 141,184 characters of plan schemas and 36,872 characters of plan results: approximately 1.01% of 22.43M captured rendered-prompt characters. This is a character-based cost proxy, not a tokenizer measurement; it excludes some replayed call syntax and planning-related reasoning. It does not support planning as the dominant time cost. One redundant s2 update was unnecessary; compulsory per-action plan updates would be much more expensive.

No automatic plan creation, forced per-action update or plan-completion loop exists. User explicitly asked to use Plan/Deliverables. The automatic contract hint counted nested list markers as 59 “separate items”; that count is a crude heuristic, not a trustworthy acceptance-item count. The model ignored early hints and registered only six outcomes late. This is a remaining contract-extraction limitation, not a reason to generate 59 mandatory tools.

Optional planning, unchanged-state deduplication, runtime-origin state, sticky accepted prefixes, replace_text freshness/atomicity, patch diagnostics, scoped evidence, stale epochs, Continue and bounded Fast/Deep reviews remain active. `102ce787` did not change verification acceptance or turn budget. One intentional compaction and terminal finalization legitimately change the prefix; no per-turn pseudo-user state regression is demonstrated.

## Minimal changes after diagnosis

- Browser capability and Deep test-command discovery now use the same effective `work_root()` as terminal execution. Explicit directory grants receive capability discovery without becoming selected projects or obtaining fabricated evidence.
- Plan guidance permits updates at meaningful milestones or approach changes, retaining optional planning and explicitly avoiding per-action maintenance.
- A runtime-owned terminal disclosure is appended once to an accepted response with unresolved outcomes, an unreconciled plan, or unregistered changed behavior lacking proof. It gives actual Verified counts, Implemented/Pending/Blocked IDs, the last recorded plan fraction and the actual work-budget reason when that transition occurred. It adds no provider requests/tools and does not rewrite model prose or mutate statuses. It is included in the visible persisted answer and durable Continue history identity. For simple tasks with no unresolved state it is absent.
- The compact status panel labels idle state as saved, uses “unfinished step” for a retained active step, and removes `aria-current` when execution is inactive. Continue restores live presentation without changing the canonical plan.

No gate, capability, scope association, failure blocking or epoch rule was relaxed. No step is automatically completed and no outcome is automatically Verified. Partial/blocked completion and fixed review budgets remain available.

## Validation

Added deterministic regressions:

- Incident-shaped 129-response replay: five-step plan left at 1/5, six Implemented outcomes, selected broad FAIL, hard turn limit, model prose falsely claiming Verified. The actual persisted visible answer includes 0/6 and the budget/plan disclosure. Provider count remains exactly 129; statuses remain unverified; no loop is added. Continue with that visible answer resumes the same journal and unfinished state, resets finalization and retains bounded reviews.
- Explicit workspace without selected project discovers a local browser driver in Fast and Deep. No browser runs, so verify still fails; gate reviews exactly once/twice then accepts a partial answer.
- Terminal disclosure distinguishes Implemented/Blocked/plan state without mutation, stays absent for empty/satisfied tasks, reports the true budget transition and does not mistake exhausted review allowance for anonymous-change verification.
- Renderer projection distinguishes running/saved state and never mutates an unfinished step on terminal presentation.

Existing tests cover simple no-plan completion, efficient grouped plan updates, documented blockers, scoped PASS plus unrelated warnings, sticky relevant failures, static/stand-in rejection, stale evidence, compaction, saved plans/Continue, pause/restart and bounded Deep reviews. Coverage was extended rather than recreating these suites.

Validation results:

| Check | Result |
| --- | --- |
| Full Rust tests | 219 unit + 74 integration passed; one opt-in live-browser test excluded from the normal run |
| Opt-in live-browser evidence test | Passed separately; real Chromium fixture checks scoped PASS with unrelated warning and relevant FAIL, in Fast and Deep |
| All current compiled Node suites | 41/41 passed, including runtime, Stop/history, recovery, status, model capabilities and Max Context persistence |
| Production renderer regression | Passed; added assertions cover saved unfinished steps, no idle `aria-current`, unchanged counters, Continue becoming active and failure returning to saved state |
| Typecheck / build | Passed via `npm run build` (Rust, TypeScript, Vite, Electron compilation); final Rust binary rebuilt after capability fix |
| Lint / whitespace | Passed; build retains the existing Vite large-chunk warning |

Focused test mapping for the requested behaviours:

1. No-plan simple completion: `a_run_that_never_records_deliverables_is_never_reviewed` and `a_tool_free_answer_completes_regardless_of_plan_notes_and_area_words`.
2. Lean plan use: `runtime_plan_updates_and_visible_progress_do_not_create_human_turns_or_extra_requests` and plan tool tests.
3. Honest blockers: `blocked_with_a_reason_ends_without_a_review` plus terminal disclosure regression.
4. Missing/weak proof: `verify_is_refused_without_a_passing_check_and_a_claim_changes_nothing`, page stand-in regressions and new budget-exit replay.
5. Warning isolation: `scoped_runtime_acceptance_and_baseline_project_warning_in_fast_and_deep` plus real-browser inverse.
6. Compaction/terminal consistency: `unfinished_deliverables_are_in_every_tail_and_survive_what_compaction_discards`, transcript compaction tests and new replay/Continue assertions.
7. Lightweight Fast: single bounded review, optional plan/progress request-count tests and workspace capability regression.
8. Bounded Deep: two-review tests, new workspace capability regression and existing endless-failure budget regression.

## Limits

The runtime cannot judge semantic adequacy of a model-written test or reconstruct acceptance criteria never registered. The terminal disclosure makes unsupported completion claims visibly contradicted; it does not parse or censor arbitrary model prose. Inactive plan counters reflect the last requested updates, not independently inferred work progress. Capability discovery still uses drivers in the effective work directory and browser executables on PATH; custom/off-PATH browsers may require explicit capability configuration. A driver directory alone does not prove a launch will succeed. The exact historical PATH/browser installation was not reconstructed. No real model replay or Checkers browser/game run was performed during this audit.

Raw local extracts and logs live under `/tmp/poddavki-audit-*`; they contain source/prompts and are not repository deliverables. The commit contains only Local AI Desktop runtime/UI changes, regression coverage and this audit report.
