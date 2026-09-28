# Jan research continuity audit

Audit date: 2026-09-27. The Jan tree was inspected read-only at
`/media/yaroslav/DATA/Apps/jan-git`.

## What Jan implements

- `src-tauri/src/core/agent/compaction.rs`: `DEFAULT_KEEP_RECENT` is 8. Its
  `compact_conversation`, `summarize_span`, and `summarize` replace a safely
  selected middle span with one model-produced, dense factual summary. The
  summary prompt asks for goals, constraints, decisions, files/commands and
  outcomes, unresolved questions, while omitting redundant tool output.
  `tail_start` avoids an orphaned tool result. Automatic compaction is
  preflight at `CompactionBudget::trigger_tokens()` (default 80%); overflow
  retry remains as a fallback.
- `src-tauri/src/core/agent/transcript.rs`: Jan retains an append-only event
  record. A `Compaction { summary, covers }` is a projection boundary, not
  deletion. `Transcript::conversation` projects the latest summary plus the
  uncompressed tail. Thus raw tool results remain in Jan's record/UI, but are
  not normally visible to the next model request once covered.
- `src-tauri/src/core/agent/reminder.rs`: `attach` folds hidden reminders into
  the latest eligible user message, or emits its own user turn after tool or
  assistant turns. This makes reminders late in the request without breaking
  tool-call/result pairs.
- `src-tauri/src/core/agent/todo.rs`: a canonical todo has one active item.
  `TodoList::promote_next` promotes the earliest pending item after
  `done`/`drop`; `active`, `next_pending`, and `open_summary` render upkeep
  state. Completion is still a model `todo` mutation, not a runtime judgment.
- `src-tauri/src/core/agent/context.rs`: `TODO_UPKEEP_PROMPT_ADDENDUM` tells
  the model to mark an item `done` or `drop` as soon as it finishes.
- `src-tauri/src/core/agent/loop.rs` (around lines 3389 and 3945):
  `MID_RUN_NUDGE_MUTATION_THRESHOLD = 12` and maximum two nudges per cycle.
  Successful `bash`, `write`, and `edit` calls increment
  `mutations_since_todo_touch`; any `todo` touch resets it. If open todos
  remain, Jan records an advisory reminder to update progress. A separate
  closeout nudge runs once if the loop is stopping with open todos.

## What Jan does not implement

Jan has no separate current-task/research digest, no inventory of investigated
files, no repeated-read detection, and no repeated-read suppression/hint. It
does not identify a concrete missing fact after long research. Its mid-run
nudge does **not** count read, search, list, web retrieval, or other read-only
work, so it does not detect “same todo + many read actions + no progress”.
It has no semantic no-progress/stall detector and no automatic semantic test
for “enough work”; a model may continue research indefinitely. Jan's compacted
summary is conversation-level, though it explicitly asks for concrete file and
command outcomes. Retained raw tool results are record-retained, not
post-compaction model-retained.

## Comparison with Local AI Desktop

Local's `rust-agent/src/agent/transcript.rs` is append-only and
`context/projection.rs` sends the latest summary and retained tail after a
compaction. Since the 2026-09-28 correction it follows Jan's structural tail
selection and projects retained tool results verbatim; the former
`compact_tool_payload` rewrite was deleted because it lost exact source detail.

The observed task-13 loop is therefore consistent with repeated broad reads,
the former Local summary-input duplication and repeated proactive compactions,
and the former retained-tool truncation. Jan's mutation-only nudge is
intentionally not a read-only research completion mechanism. Detailed measured
parameters and the corrected port are in `jan-compaction-port.md`.

## Port outcome

The strategy changed to a Jan-style coherent execution slice. The temporary
Task Research Digest, repeated-read hint, and read-only anti-stall counter were
removed. Local now follows Jan's mutation-centric advisory upkeep semantics;
the retained-tail, dense-summary, tool-pair and model-owned completion rules
are documented in `jan-runtime-port-map.md`. No evidence IDs, checkpoints,
completion gates, saturation, or exploration budgets were introduced.
