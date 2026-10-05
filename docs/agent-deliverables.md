# Execution contract: deliverables

## What went wrong

A real Qwen Deep run was asked to do two things to a game: add a "with a friend / with a bot" mode with a strong bot, and
add a theme switch based on another project's palette. It ran for 128 turns, wrote a capable bot engine, and ended with
neither requirement visible to the user: no mode selector, the bot wired into nothing, no theme switch, and scratch
files left in the project. Its final answer was honest (it said both tasks were unfinished), so this was not a
false-success problem. The run simply never got to the work.

The persisted evidence journal shows why:

- **Task Memory held findings, not outstanding work.** Its single entry was marked `confirmed` and began "everything for
  the implementation is confirmed". It was a research digest plus a free-text `implication` mentioning broken tests.
  Task Memory only keeps four ranked entries in the prompt, and the Deep convergence review only reacts to entries
  marked `unknown` or `contradicted`, so nothing in the runtime could notice that the user-visible deliverables did not exist.
- **The turn budget ended the run with no signal beforehand.** At turn 128 the loop switched to FINALIZING ("the
  investigation budget is exhausted and tools are unavailable"). Nothing told the model, while it still could act, that it
  was spending its last turns on tests of the first deliverable.
- **A compaction checkpoint preserved nothing.** The last of three compactions asked the model for a handoff and got raw
  `<tool_call>` markup back, which was accepted as the "procedural and factual continuation state".
- One reasoning turn used its whole 32 K-token output budget without producing a tool call or an answer.

## Design

Task Memory records what the run has *learned*; a separate list records what the user *expects*. The model keeps that
list through a `deliverables` tool; the runtime stores it, shows all of it on every turn, and will not let an unfinished
list pass silently. The runtime never invents entries and never decides what the user wanted.

`rust-agent/src/agent/deliverables.rs`:

- Item: `id`, optional `task` (the user's task it belongs to), `text`, `status` (`pending | implemented | verified | blocked | dropped`; the legacy `done` is read as `implemented`),
  `evidence`, `reason`. At most 24 items, one short line each; re-adding the same wording returns the existing item.
- Tool actions: `add` (optional `check`: readback | static | build | test | runtime | browser; `functional` is an old alias of `runtime`), `implemented` (the work was written; `done` is accepted as an alias), `verify` (only with fresh runtime-recorded evidence, see [planning and verification](agent-planning-verification.md)), `block` (concrete reason required), `drop` (the user
  withdrew it; reason required), `view`. The schema is flat, in declaration order, like the other tools.
- Stored inside the Task Memory JSON, so it is persisted with it (`agent_plans`), restored on Continue after an
  interruption, discarded with it on Regenerate or Edit, and survives restarts. Saved memory without the field still loads.

Prompt (rebuilt from durable state every turn, so a compaction summary is never the only place the requirements live):

- `<deliverables>` lists every pending and blocked item and the latest finished ones, grouped by task.
- `<run_budget>` appears only while items are pending and half the turn budget is used, and becomes urgent at 85 %: it
  names what is unfinished and says to deliver what the user will use first and to mark anything impossible as blocked.
- `<deliverables_hint>` appears while no list exists, for the first 25 turns only: when the request itself enumerates two or
  more items (numbered or bulleted lines; purely structural, no words or subjects are matched), or once the run has
  started changing the project without one. It costs no turn and never forces anything.
- `<files_created_this_run>` lists project files the run created and has not deleted, so scratch files stay visible.

Completion gate: when the model tries to end the run with items still pending, the answer is withheld and the model is
told exactly which items are unfinished (and which files it created, so diagnostics it no longer needs can be removed).
Fast gives one such review, Deep two; afterwards the answer is accepted, so the gate can never deadlock a run. Marking an
item `blocked` with a concrete reason is a valid way to finish, and the answer must then say so. When the budget runs out
anyway, the FINALIZING prompt lists the pending items and requires the report to state each as not completed.

Guidance (all modes): use the tool when the request has two or more separate things to produce or change, or one result
that must work end to end; record only what the user asked for, never the model's own ideas; do not use it for a
single-step or analysis-only request; produce what the user will see or use first and refine afterwards; a part is not
finished until it is reachable the way the user will use it; delete scratch files before finishing. The tool is not offered
for read-only requests.

## Fast and Deep

- Neither mode creates a list on its own, so trivial and analysis-only prompts cost nothing extra; a run that never
  records deliverables is never reviewed.
- Fast: evidence for `implemented` is free text, one completion review.
- Deep: `implemented` needs evidence that cites an observation ID or an exact source path inspected in this run (the same
  rule as a confirmed Task Memory finding), two completion reviews, and the Deep guidance asks it to compare each
  deliverable with what it observed rather than what it intended to build.

## Compaction

A summary that is empty, or that is or starts with tool-call markup, is not a summary. It is retried once with an
explicit instruction and otherwise replaced with a neutral note; Task Memory and the deliverables remain authoritative in
the prompt.

## What the user sees

The `deliverables` calls appear in the timeline as "Требуемый результат", with a one-line progress summary
(`проверено 1 из 3 · реализовано, не проверено 1 · осталось 1`) and, when expanded, the checklist (`✓ verified`, `◐ implemented, not verified`, `○ pending`, `⊘ blocked — reason`). Only `verified` ever shows as checked.

## Not done on purpose

No turn or tool limit was raised, and nothing forces a plan on a trivial prompt. The 32 K-token reasoning turn is a
separate model-behaviour issue that already has a "think less" reminder.

## Task Memory and pause interaction

Deliverables are saved with Task Memory, so a graceful pause (see `deep-fast-modes.md`) records each deliverable's true
status through the checkpoint tools and Continue restores it. In Deep, marking a deliverable implemented is validated with the
same evidence normalization as a `confirmed` Task Memory entry: unpadded or compact references (`obs-15`,
`obs-00000015/0016`) resolve to real ids, and a bad reference is named in the error together with valid ones.
