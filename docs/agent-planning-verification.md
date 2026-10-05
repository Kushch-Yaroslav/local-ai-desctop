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
script counts only if it mentions a changed file. If code files changed, the required class is Functional (tests or a
script that runs the code); otherwise Readback, which the runtime already provides. A failed check is recorded, shown as
`FAIL` in `<verification_state>`, annotated on the deliverable, and blocks `verify` until the same check passes after a fix.

`deliverables verify` is refused unless fresh passing evidence of the required class exists. Fast attaches the best one;
Deep requires the model to cite `ev-…` ids. A later change demotes every `verified` item back to `implemented`.

## Completion gate

When a run that changed the project and can run commands tries to end with a tool-free answer and items are implemented
but unverified (or a check is failing, or Deep's project test command has not passed), the answer is withheld and the model
is told what is missing and what to run. Fast reviews once, Deep twice; checks after a review are budgeted (6/12), after
which the gate closes and `<verification_state>` says to report exactly what is and is not verified. Pause, finalizing,
doc-only changes and runs without `run_terminal` are never gated, so the gate cannot deadlock a run.

## Tools, less bureaucracy

- `write_file` to a previously read path really writes (the repeated-read guard in `reads.rs` now applies to `read_file` only).
  Writing over a file that changed since the last read is refused once with "read the latest version"; unread files are allowed.
- `apply_patch` is tolerant (fences, CRLF, missing End Patch, `@@` separators, trailing-whitespace-insensitive matching),
  all-or-nothing with rollback, and refuses a hunk that matches several places.

## Known limits

- Terminal-driven edits (sed, mv, redirects) do not advance the change epoch.
- Whether a cited check is relevant to a given deliverable is the model's claim; a vacuous script touching a changed file can count.
- Partial reads record the whole-file revision.
- A change demotes all verified items (run-level epoch, deliberately conservative).
