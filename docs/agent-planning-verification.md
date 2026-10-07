# Planning, verification and honest reporting

Principle: make actions cheap and claims expensive. Editing and checking cost nothing extra; saying "works" requires evidence
the runtime recorded itself. Nothing here depends on a model, language or project.

## Plan is not Deliverables

- **Plan** (`plan` tool, `rust-agent/src/agent/plan.rs`): the model's own ordered steps (`pending | in_progress | completed |
  blocked`), one active at a time, optional, shown on every turn as `<plan>`. Finishing steps never completes deliverables.
- **Deliverables**: what the user asked for. Statuses: `pending → implemented → verified` (or `blocked`, `dropped`).
- **Task Memory**: what was learned. All three live in the saved Task Memory JSON, so they persist and return on Continue,
  are discarded on Regenerate/Edit, and a fresh run starts empty. Old saves without the fields load.

## Evidence (`verification.rs`)

Evidence is created only by runtime hooks, never from model arguments:

| Kind | Class | Created when |
|---|---|---|
| readback | Readback | the runtime re-reads a file after every successful write (size/revision) |
| static / build / test / run / browser | Static or Functional | a plain terminal command that is recognised as a check ran to completion (`exit_code` known) |

Rules: any change makes non-readback records stale (a readback is stale only if that file changed after it). Compound
commands (pipes, `;`, `&`, redirects, `$(…)`) are never evidence because their exit code is ambiguous. An inline `-e`/`-c`
script counts only if it mentions a changed file. A failed check is recorded and shown as `FAIL` in `<verification_state>`. It blocks and annotates the deliverables it covers; unselected project checks remain visible warnings. The same check must pass again to resolve a fresh relevant failure.

### Evidence capabilities

"Some command exited 0" does not prove every claim, so a deliverable (or the run's changes) requires a capability, and only
evidence of a kind that can show it counts. `check` on `deliverables add` names it; unset, it follows the changes.

| Need (`check`) | Accepted evidence kinds | Typical claim |
|---|---|---|
| `readback` | any (the runtime reads every write back) | "file was created" |
| `static` | static, build, test, run, browser | "lints / type-checks" |
| `build` | build | "project builds" |
| `test` | test, browser | "tests pass" |
| `runtime` | test, run, browser | "the code works" |
| `browser` | browser | "the button works when clicked" |

Defaults when `check` is unset: readback; `runtime` once a code file changed; and a changed HTML page raises `runtime` to
`browser`. A model can ask for more, never less than the page rule gives. Old saves with `functional` load as `runtime`.

A command is `browser` evidence when it is a headless browser or driver invocation (`chromium --headless …`, `playwright`,
`cypress`, `puppeteer`) or a script whose own import lines load a browser driver. A jsdom or hand-written DOM script is a
plain `run`: it exits 0 but cannot satisfy `browser`. Browser availability is detected once per run (a driver in
`node_modules` or a browser/driver binary on `PATH`; the host or a test may override it through `browser_capability`).

When the required capability is unavailable, `verify` is refused with an instruction to leave the item implemented, the item
is excluded from the completion gate (no review loop, no substitute hunt), and `<verification_state>` tells the model to
report it as implemented, not checked in a browser. If a browser exists, the gate asks once for a browser run (bounded as below).

### Terminal commands and the change epoch

Terminal edits invalidate verification the same way file tools do, without parsing shell:

- **Check** (a recognised test/build/lint/run): its result is evidence. Before it counts, tracked files are compared with the
  revision the runtime last saw; if the check itself rewrote one (e.g. `--fix`), those files are marked changed and the
  result is not recorded as evidence.
- **Read-only**: a single command or a `|` pipeline whose every stage is an allow-listed inspector (`ls cat head tail wc grep rg
  find git status/log/diff/show… stat file du tree diff jq` …) with no flag that writes or executes (`find -delete/-exec`,
  `rg --pre`, `git --output`). Nothing is invalidated, so inspecting after verifying keeps the verification.
- **Mutating**: everything else, including anything with `;`, `&&`, `||`, redirects, substitutions or backslashes, and
  any program not on the list (`sed`, `mv`, `cp`, `rm`, `touch`, `mkdir`, `npm install`, `git commit`, `awk`, `sort` …).
  The epoch advances (all run/test/static/browser evidence goes stale, verified items return to implemented), and every code file
  the command names is marked changed (re-hashed, or recorded as deleted/moved). A readback of an untouched file stays valid.

The classifier errs toward Mutating; its worst case is one unnecessary re-check, never a stale `verified`. The tokenizer
treats backslashes, backticks and `$(` as non-simple, which also closes an escaped-quote bypass in compound-command detection.

`deliverables verify` is refused unless fresh passing evidence of the required capability exists. Fast attaches the best
relevant one; Deep requires the model to cite `ev-…` ids. A later change demotes every `verified` item back to `implemented`.

## Completion gate

When a run that changed the project and can run commands tries to end with a tool-free answer and items are implemented
but unverified (or a relevant check is failing, or a required project test command has not passed), the answer is withheld and the model
is told what is missing and what to run. Fast reviews once, Deep twice; checks after a review are budgeted (6/12), after
which the gate closes and `<verification_state>` says to report exactly what is and is not verified. Pause, finalizing,
doc-only changes and runs without `run_terminal` are never gated, so the gate cannot deadlock a run.

## Tools, less bureaucracy

- `write_file` to a previously read path really writes (the repeated-read guard in `reads.rs` now applies to `read_file` only).
  Writing over a file that changed since the last read is refused once with "read the latest version"; unread files are allowed.
- `apply_patch` is tolerant (fences, CRLF, missing End Patch, `@@` separators, trailing-whitespace-insensitive matching),
  all-or-nothing with rollback, and refuses a hunk that matches several places.

## Known limits

- A recognised check (test, build, run, script) that modifies files the task never touched is not detected; only tracked files are re-hashed. Mutating terminal commands that name no code file only advance the epoch.
- The read-only allow-list is deliberately short; harmless commands outside it (`date`, `sort`, `curl`) count as mutating and cost one re-check.
- Browser evidence means a browser or driver actually ran; the runtime cannot tell whether the script clicked the right element.
- The runtime enforces durable check associations and capabilities. It still cannot judge whether the chosen acceptance check adequately exercises the natural-language claim; a vacuous script touching a changed file can count.
- Partial reads record the whole-file revision.
- A change demotes all verified items (run-level epoch, deliberately conservative).
- The runtime cannot judge whether a model-written check is adequate: in a live run a jsdom check passed although the page's `<script>` in `<head>` (no `defer`) fails at load time. Guidance asks for checks through the real entry path and for stating what a stand-in does not cover. For pages the ledger now refuses a jsdom/node stand-in as browser evidence (see capabilities); it still only guarantees that a real browser ran, after the last change, with that exit code.
- Legacy saved deliverables without a verification scope remain conservatively project-wide; they are not automatically narrowed after failures have been observed.


## Scoped acceptance evidence

The old gate treated every fresh failure of sufficient class as a contradiction of every item. Failure synchronization
also demoted every verified item, and Deep demanded project-suite success independently of recorded acceptance criteria.
Those three decisions now use the same durable relationships instead of a global failure assumption.

New deliverables have runtime-owned `verification_scope: acceptance`. `check: test` means a broad full-test requirement
and creates `project` scope; every fresh failing check blocks it, even a pre-existing one. Named build requirements cover
build checks structurally. Legacy saves missing scope default to `project`, preserving their conservative contract.
The tool exposes no scope override or ignore/unrelated action.

For an acceptance check, select its existing deliverable IDs before execution:

```json
{"command":"node browser-check.cjs","deliverable_ids":["d-001"]}
```

The runtime validates the IDs, persists `verification.bindings[exact_command]` before running the command, and captures
`deliverable_ids` on the evidence. The relationship is additive and permanent for the lineage: omitting IDs on a retry
cannot erase it. Exact `check_key` is separate from the shortened display subject, preventing identity collisions.
A check can cover several deliverables. Unselected checks are project observations, not acceptance proof for an item.
Readback retains its existing per-file freshness semantics without requiring terminal selection.

A `verify` citation also attaches the evidence's exact check identity **before** examining its result. Failed citations
remain attached even when `verify` is refused; all earlier results of that check are associated too. The relationship is
saved and emitted on rejected calls as well as successful calls. Re-implementing an item clears its proof, never its
bindings. There is no model-facing way to remove a relationship. A different passing check cannot cancel a relevant
failure; a successful fresh retry of the failing check can.

Verification needs fresh relevant passing evidence of the required capability, with no active relevant failure. Only
relevant failures can demote a scoped item or earn a completion review. A verified acceptance item plus unrelated suite
failures therefore finishes with warnings rather than another debugging assignment. Deep retains its broad-suite review
when no deliverable contract exists or an unverified item explicitly requires tests. Fast and Deep use identical scope
rules; Deep still requires evidence IDs. Browser capability checks, mutation detection and the bounded review budgets
are unchanged. Any later mutation stales functional evidence and demotes verified items conservatively. Continue also
demotes statuses when it advances the epoch; bindings survive compaction, saved Task Memory and restart. No database
migration is needed. Regenerate/Edit discard this lineage with the existing Task Memory behavior.

The ledger normally retains 24 records, evicting stale or nonblocking observations first. Active failures cannot be
evicted by accumulating passes; if all retained records are fresh failures they are preserved beyond that soft limit
until superseded or stale (the run's existing tool budget bounds new observations). Bindings are small append-only
metadata for this task lineage and are never evicted; Regenerate/Edit reset them with Task Memory.

### Baseline provenance

Checks recorded at epoch zero, before the lineage's first mutation, are marked `baseline`. A post-change failure of the
same exact command and kind with an identical hash of exit code, completion status and complete stdout/stderr receives
`baseline_failure: ev-…`. This records an identical **observed** pre-existing failure; it does not assert that the current
change cannot affect the behavior. Relevant and full-test requirements still block on it. No model can supply baseline
flags, outcome hashes or exemptions. Different output is conservatively not recognized as identical; there is no parser
for individual assertions inside broad suites. Baseline comparison is available while the baseline record is retained.

The compact composer panel retains current evidence and displays passing proof under verified items plus a separate
project-warning list (check, detail, evidence ID, selected deliverables, and baseline provenance). Evidence updates flow
through the same Task Memory state and survive chat switches/Continue. Successful plan/deliverable snapshots still stay
out of the timeline. Active failures remain in the provider prompt even when newer passes exceed its five-check preview.

### Regression coverage

Ledger and deliverable tests cover scoped PASS/FAIL, unselected warnings, full-test blocking, baseline provenance,
mutation staleness, immutable failed selections/citations, persistence, command identity and active-failure retention.
Existing tests retain capability, browser-vs-stand-in, false completion, mutation detection and budget protections.
Production-loop tests exercise the incident structure and inverse in Fast and Deep. The optional real-Chrome regression
uses a scripted provider and isolated temporary projects, asserts three human actions with automatic browser responses,
and keeps a separate failing baseline suite visible:

```sh
cargo test --manifest-path rust-agent/Cargo.toml --test agent_loop live_scoped_browser_acceptance_with_project_warning_and_inverse -- --ignored --nocapture
```

This regression requires installed desktop dependencies and Chrome (`LOCAL_AI_TEST_BROWSER` can override its path).
The renderer tests cover passing proof, baseline warnings, evidence updates and preservation across lifecycle events.
