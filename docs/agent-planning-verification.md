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
script counts only if it mentions a changed file. A failed check is recorded, shown as `FAIL` in `<verification_state>`,
annotated on the deliverable, and blocks `verify` until the same check passes after a fix.

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
one; Deep requires the model to cite `ev-…` ids. A later change demotes every `verified` item back to `implemented`.

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

- A recognised check (test, build, run, script) that modifies files the task never touched is not detected; only tracked files are re-hashed. Mutating terminal commands that name no code file only advance the epoch.
- The read-only allow-list is deliberately short; harmless commands outside it (`date`, `sort`, `curl`) count as mutating and cost one re-check.
- Browser evidence means a browser or driver actually ran; the runtime cannot tell whether the script clicked the right element.
- Whether a cited check is relevant to a given deliverable is the model's claim; a vacuous script touching a changed file can count.
- Partial reads record the whole-file revision.
- A change demotes all verified items (run-level epoch, deliberately conservative).
- The runtime cannot judge whether a model-written check is adequate: in a live run a jsdom check passed although the page's `<script>` in `<head>` (no `defer`) fails at load time. Guidance asks for checks through the real entry path and for stating what a stand-in does not cover. For pages the ledger now refuses a jsdom/node stand-in as browser evidence (see capabilities); it still only guarantees that a real browser ran, after the last change, with that exit code.
- An unrelated failing project check blocks `verify` of other items; the item must be reported as implemented, or blocked with the reason.
