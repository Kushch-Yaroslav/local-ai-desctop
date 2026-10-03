# Agent investigation state and completion

This document records where the Agent runtime draws the line between what the
runtime owns and what the model owns during long, evidence-heavy work (for
example a repository audit). It replaces the earlier research controller,
model-facing evidence grading and finalization lifecycle.

## The principle

**The runtime owns facts it can verify mechanically. The model owns every
semantic judgement.**

## Task Memory evidence contract

Task Memory is structured JSON: prose such as "status is confirmed" inside
`finding` does not set the `status` field. An omitted status on a new entry
retains legacy, unclassified semantics; on an update it retains the previous
status. No status is inferred from the finding text.

The advertised schema has an object root with all parameters exposed directly.
Native tool grammars in the supported llama.cpp runtime enumerate object-root
properties; a root `oneOf` hides those parameters from its XML tool parser.
Runtime validation remains authoritative: `action` is required, record/update
needs a nonempty string `finding`, and invalidate needs a known `id`.
Malformed calls return recoverable errors without memory mutation.

An effective `confirmed` status requires nonempty `evidence` with a resolvable
observation ID or an exact source path present in the transcript's observation
store (including cited paths with spaces or Unicode). Paths must match at
reference boundaries, not as substrings of other paths. Unknown observation
references are rejected even when accompanied by a
valid path. Numeric observation-ID spelling is resolved by the same helper as
observation recovery; sentence punctuation and `obs-... .. obs-...` references
are accepted when each cited ID resolves. The check happens against the normalized candidate entry,
before committing any memory revision, replacement, superseded-entry
invalidation, write-cap consumption, or checkpoint-cadence reset. Failed writes
return a recoverable tool error; view calls do not reset the write cadence.
Observation references remain resolvable after compaction and durable replay.
Restored active confirmed entries are checked against that durable store before
any provider request. Invalid saved memory produces an explicit Agent error,
not a silently discarded or relabeled entry; invalidated historical entries and
unclassified legacy entries retain their meaning.

This is a structural check, not semantic entailment. A real failed operation
may support a confirmed blocker, but does not prove file contents. Likewise a
valid source reference does not prove that it supports a model's sentence.
Inferred, unknown, contradicted, and unclassified entries are not silently
promoted or relabeled, and no tool call is forced.

| Runtime owns (mechanical, verifiable) | Model owns (semantic) |
| --- | --- |
| Tool-call validity and call/result pairing | What to read, in what order, and why |
| Immutable storage of every tool result and exact recovery (`observation_read`) | Whether the evidence is enough to answer |
| Refusing an *exact unchanged* repeat read (same path, range, file revision) | Whether a finding is supported by a source |
| Whether a read/listing was complete or truncated, and whether an operation failed | Whether an absence claim is justified, and its scope |
| Which listed entries and statically referenced local files were never opened | Whether an unopened file matters to the question |
| Compaction, context fit, output budget, restart/resume | Planning, task memory contents, the final answer |
| Never leaving the user without an answer (turn budget → synthesis-only turn) | When the work is done |

Anything that needs to decide *meaning* — "is this claim about the backend?",
"does this observation support that sentence?", "is this requested area
covered?" — is not decidable by the runtime without a lexical proxy. The
previous design used such proxies (keyword lists naming areas, term-overlap
grading of claims, negation word lists). They produced both false coverage
(prose naming an area counted as investigating it; a claim "there is no API"
counted as covering the backend) and unsatisfiable gates (a final answer
blocked for gaps the runtime could not name). The proxies were removed rather
than patched.

## Investigation state (`agent/ledger.rs`)

`Ledger::build` is a pure function of the run's transcript plus a bounded index
of the project's files. It is recomputed every turn, so it needs no storage of
its own and survives compaction and restart. It is projected in the dynamic tail
as `<investigation_state>` and contains:

- **Files read** with their observation IDs, marking partial reads. This is the
  source → observation map that makes recovery one hop and prevents rereads
  after the original result has left the context. It spans the whole
  conversation lineage.
- **Requests**: unopened local files that a source calls or submits to
  (`fetch`, `axios`, `action=`, …). A string literal in a read file that
  resolves structurally (relative to the file, relative to the project root, or
  by unique path suffix, which covers import aliases and directories served
  from a sub-folder) to an existing project file. Ambiguous literals resolve to
  nothing. They stay visible until opened.
- **Working-set neighbourhood**: unopened local files referenced by the
  sources read in the last few provider turns, grouped by referencing source
  (target names stay visible so the model can judge relevance itself), and
  unopened entries of recently listed directories (dependency/build
  directories, lock files, assets and `.env*` are not offered). These fade
  after `WORKING_SET_TURNS` turns. A permanent list of every unopened import
  and entry reads as a task list and drives breadth-first crawling; locality
  gives "what did the file I just read point to?" without maintaining a
  frontier for the model to drain. Nothing is lost — the facts stay derivable.
- **Failed operations** and **commands run** with their outcome, so an absence
  claim can name the scope that was actually covered.

The ledger never says that something is relevant, missing, or required. The
stable guidance states this explicitly and states the grounding principles the
model applies itself: a source that was not opened is unknown, not absent; an
absence claim must name the scope it covers; a failed or approval-blocked
operation is a blocker, not evidence.

## Completion

A tool-free response completes the run. The only exceptions, both bounded:

1. the existing post-mutation validation reminder;
2. one reminder, per run, naming concrete unopened *request* targets when a
   draft answer arrives while such targets exist. The draft is withheld once;
   whatever the model answers next is accepted.

Neither can repeat, so neither can block a final answer.

A response with neither content nor a structured tool call (for example a tool
call written inside the reasoning stream, which is never executed) is not an
answer: it gets a reminder and the turn is retried. After
`MAX_CONSECUTIVE_EMPTY_TURNS` such turns tools are withdrawn so the next turns
can only be an answer.

When the turn budget (`MAX_INVESTIGATION_TURNS`) is exhausted the runtime does
not end in an error: it withdraws tools, marks the transcript as synthesis-only
and gives the model up to `MAX_SYNTHESIS_TURNS` turns to answer, telling it to
state what remained unexamined.

## Context safety (mechanical, window-relative)

- **Tool results are bounded by the window at creation.** One result may use
  about a quarter of the window in raw characters and a whole provider turn
  about two thirds (roughly 15% and 40% of the window in estimated tokens once
  serialization overhead is counted); parallel results share the turn budget
  (small results take what they need, large ones split the rest). A cut result
  is reported as truncated with its continuation offset exactly like one cut by
  the tool maximum. The model's call is stored unchanged; the limit is an
  internal argument. Without this, a burst of large reads at a small window (or
  recovered observations, which are exact by contract and therefore cannot be
  folded) could not be made to fit and ended the run in a `context_budget`
  error.
- **The compaction summarizer sees the whole span.** Its input is every message
  of the span with tool results shown as bounded excerpts (their exact bodies
  are recoverable by observation ID), clamped in the middle if still too long.
  It previously stopped at the first message that exceeded the budget, so after
  a burst of large results the summary never saw most of the span.
- **The summary request uses the run's protocol options** (context size and
  model-specific finalization controls).

## Provider contract (what the model is shown, and what comes back)

- **Reasoning is part of the record.** The assistant entry stores the model's
  own reasoning (`reasoning_content`) next to its content and tool calls, as the
  provider streamed it. A turn that produced only reasoning is recorded too, so
  a retry continues from it instead of regenerating it. Whether the field is
  sent is   a projection decision: the OpenAI-compatible llama.cpp endpoint receives
  `reasoning_content`, and a model without reasoning support receives neither.
  Thinking chat templates (GLM-4.7, Qwen3.x)
  render prior reasoning back into the prompt; a history without it is rendered
  with empty or bare-`</think>` assistant turns and the model re-derives its plan
  on every step. This matches Jan (`send_reasoning`, default on) and Qwen-Agent
  (assistant outputs, reasoning included, are appended to the message list).
- **Display and record differ.** Thinking shown to the user hides provider
  tool-call markup written inside the reasoning stream; the record keeps the
  exact stream. Such markup is never executed. When a turn consists of nothing
  else, the run reports a protocol notice and the retry sees the reasoning.
- **The size estimate is learned from the provider.** The character estimate is
  pessimistic for JSON-escaped tool output. After every request the runtime
  compares its projection with the prompt size the provider reported and scales
  later estimates by that ratio (bounded, smoothed). Folding and compaction
  triggers are therefore relative to the real window, which keeps the cached
  prefix stable for long stretches instead of rewriting one old result per turn.
- **Safety fallback, not a fix:** after the runtime has withdrawn tools and asked
  for a final answer, hidden reasoning is switched off for that request.

## Memory

Task Memory remains the model-authored semantic handoff (findings, decisions,
blockers, next steps). Entries cite the observation IDs they rest on; the
runtime resolves nothing semantically from the prose. Project Knowledge is
unchanged.

## Journal compatibility

Journals written by earlier runtimes contain `Evidence`, `EvidenceRejection`,
`Frontier`, `FrontierDisposition` and `CloseoutRequested` entries. They are
still deserialized (as opaque values) and ignored, so old conversations resume
intact; an unparseable line would otherwise be treated as a torn tail.
