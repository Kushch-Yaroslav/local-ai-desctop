# Jan compaction port: forensic trace

Research and implementation date: 2026-09-28. Jan was read only from
`/media/yaroslav/DATA/Apps/jan-git`; Local source is this repository.

## Jan's exact path

1. `src-tauri/src/core/agent/loop.rs::run_turn_cycle` builds a completion
   request from `Transcript::project`. Before dispatch, it estimates the whole
   request and compares it with `CompactionBudget::trigger_tokens`. The normal
   preflight branch calls its local `compact`, records a `Compaction` event,
   publishes the transcript, and dispatches on the next preflight iteration.
   It preflights once; `preflighted` prevents a second proactive compaction of
   the same request.
2. `src-tauri/src/core/agent/loop.rs::compact` asks
   `Transcript::compaction_plan(keep_recent)`, passes `plan.summarize` to
   `compaction::summarize_span`, and records the returned summary at
   `plan.covers` as `Event::Compaction`. The initial retained-tail count is
   `compaction::DEFAULT_KEEP_RECENT`, which is 8.
3. `src-tauri/src/core/agent/transcript.rs::Transcript::conversation` creates
   a message array with source event indexes. `compaction_plan` invokes
   `compaction::tail_start(&messages, messages.len() - keep_recent)` and returns
   both the raw message span and the source event boundary.
4. `src-tauri/src/core/agent/compaction.rs::tail_start` starts at that target.
   It first advances across consecutive `role: tool` messages; if that would
   run past the end, it instead walks back to the assistant call that owns the
   tool-result batch. It requires a cut of at least two messages. Thus the
   tail never starts with an orphaned tool result, while normally retaining no
   more than eight recent non-system messages.
5. `compaction::summarize_span` calls `summarize`. `render_transcript` flattens
   exactly the dropped wire-message span, including tool names/arguments and
   text results. `clamp_middle` limits that input to `SUMMARY_INPUT_CHARS =
   48_000` characters (head and tail with a middle elision). Jan does not add a
   duplicate current user request, Todo state, or volatile prompt to this
   summarizer input. `summary_message` returns a marked system summary.
6. `Transcript::project` emits the current summary and all raw events after
   its boundary, preserves accepted prompt-tail placement, and appends pending
   volatile guidance at the tail. The next `build_completion_request` receives
   that projection and the stable tool declarations.
7. A provider context-overflow response follows the same `compact` path. Jan
   starts at 8 retained messages and halves its tail on subsequent retries:
   8, 4, 2. It permits at most four attempts. This is recovery after a real
   provider rejection, not an ordinary output-headroom policy.

### Jan thresholds and limits

`compaction.rs::trigger_tokens` defaults to `floor(context_window * 0.80)`.
An explicitly configured reserve wins over the ratio; otherwise there is no
separate output reservation in this threshold. `estimate_request_tokens`
counts strings recursively across the complete request body, so prompt,
messages, tool schemas and tool-call arguments contribute. Jan has no token
budget for the retained tail, no minimum tail token budget, no individual
tool-result truncation, and no explicit summary-output `max_tokens` here.

Jan's hysteresis is structural rather than percentage-target based: a request
past 80% normally drops the whole eligible prefix and keeps eight messages plus
one summary. This often leaves much more space than a shallow percentage
reduction, but an unusually large eight-message tail can still remain large.
It does not guarantee a numerical post-compaction target and it does not track
files that were read.

## Local before this port correction

The checkpoint's Local runtime had already adopted a Jan-shaped transcript but
still differed in the critical details:

| Step | Jan | Local before 2026-09-28 | Consequence |
| --- | --- | --- | --- |
| Trigger | 80% of context unless an explicit reserve is configured | `min(80%, context - 2,048)` | At 32K both evaluate to 26,214 tokens, so this was not the primary six-compaction cause. |
| Proactive pass | One compaction, then dispatch | Up to four compactions while trying to restore the preferred 1,024 output tokens | A small but useful output could cause additional transcript loss and repeated summary calls. |
| Reactive tail | 8, then 4, then 2 | First retry began at 4 and could reach 1 | The first retry discarded more recent detail than Jan. |
| Boundary | `tail_start`: forward across tools, then fallback backward | Always moved backward from a tool result | Local retained a different, sometimes larger tail. |
| Retained tool result | Verbatim in projection | `compact_tool_payload` rewrote every retained result above 6,000 chars | Exact source detail was removed precisely when the tail was intended to protect it. |
| Summary source | Dropped span only, clamped to 48,000 characters | Dropped span plus copies of current user request and serialized plan | The copies consumed the 48K source budget that should have contained older research findings. |
| Summary output | Provider decides | Requested 2,048 then truncated again to 8,192 characters | A second, approximate cap could lose findings even when the provider obeyed the requested budget. |
| Output headroom | Not part of compaction trigger | Could itself force preflight compaction | Dynamic output budgeting was coupled to compaction instead of accepting a smaller useful output. |

The 32K failure therefore has a concrete plausible accounting path. A broad
read produces a large raw tool result. Local's tail either preserved that large
result only after rewriting it, or moved it into a summary whose input had
already spent up to 18K characters duplicating live state. Then the output
headroom retry compacted again. The next model request had a short summary and
truncated exact reads, which matches the observed defensive reorientation.
Six compactions in fourteen minutes cannot be attributed to the nominal 80%
trigger alone: the removed proactive output-headroom loop and repeated large
reads were additional pressure. The new diagnostic event records the actual
numbers on the next run rather than inferring them from behavior.

## Local after the correction

`rust-agent/src/agent/transcript.rs::Transcript::compaction_plan` now follows
Jan's `tail_start` rule exactly at the message level. Its new internal
`conversation` projection starts at the latest compaction boundary and puts
the prior summary ahead of that raw tail, matching Jan's
`Transcript::conversation`. Consequently a second compaction summarizes the
first handoff plus new work rather than counting covered raw history or
discarding the first summary. `loop_runtime.rs::run` performs one normal
preflight compaction with `DEFAULT_KEEP_RECENT = 8`; a smaller dynamic output
is accepted down to `MIN_USEFUL_OUTPUT_TOKENS = 32`. Provider-overflow retries
use 8, 4, 2. The normal Local `CompactionBudget` now also uses Jan's reserve
precedence (`None` means the 80% ratio); Local retains the dynamic output
reserve separately for provider compatibility.

`summarize_span` receives only `Transcript::render_span(covers, 48_000)`. It
keeps Local's explicit `max_tokens = 2,048` because local providers need a
bounded side request; there is no post-generation character truncation.
`context/projection.rs::project` replays the selected raw tail, including tool
results, verbatim. It still translates compact summaries and Local volatile
state into tail-positioned user messages because Local providers require zero
or one system message, and that system message must be first.

The authoritative record remains `Transcript`. Compaction only appends a
boundary event; it does not destroy the raw record or make a second context
state. The current run user turn is projected exactly once even when the
boundary covers its original entry.

## Diagnostic telemetry

`agent/events.rs::Event::CompactionDiagnostics` emits no transcript text. It
contains compaction index/reason, window, before/after projected input, stable
prefix/tool/transcript/runtime-tail/planning estimates, output availability,
boundary, summarized and retained event/message counts, retained-tail estimate,
summary input/output size, and active Local milestone/work IDs. Summary output
tokens use provider usage when supplied and otherwise a documented local
estimate. `Event::RapidRecompaction` reports a new compaction within three
agent turns, including newly accumulated tool-result tokens. Both are
observability only.

## Intentional deviations that remain

Local keeps one leading system message for provider compatibility, dynamic
output budgeting, a 2,048-token summary side-request ceiling, stable
Goal/Milestone/Adaptive Work Plan tail projection, strict local tool validation,
and continuation overlap de-duplication. Jan does not implement Local's
hierarchical product plan or its provider-specific continuation behavior.

Neither runtime implements read-file memory, repeated-read prevention, a
research digest, or a semantic stall detector. This change deliberately does
not add any of them.

## 2026-09-28 retained-tail fit correction

A real 32K diagnostic exposed a separate preflight defect: the preferred
eight-message tail alone measured 46,854 estimated tokens, so the resulting
49,047-token request could not leave even Local's 32-token useful-output
minimum. The earlier 8 → 4 → 2 sequence was reachable only after a provider
returned a context-overflow error. Preflight compaction ran once with eight
messages and returned the local `context_budget` error before any provider
request, so the reactive fallback never executed.

`loop_runtime.rs::select_fit_aware_compaction_plan` now evaluates structural
tail candidates before calling `summarize_span`: preferred 8, then 4, then 2,
then the smallest one-message structural boundary only if required. Each
candidate uses `Transcript::compaction_plan`, so an assistant tool-call and its
tool-result batch cannot be split. The complete projected request is estimated
with a conservative 2,048-token summary reserve plus Local prefix, schemas,
dynamic planning tail, safety reserve, and the 32-token minimum. Exactly one
summary is generated after selection; smaller preferred output still does not
cause another semantic compaction.

Jan preserves retained tool results verbatim and has no per-result fit fallback
for a tail larger than a provider context. Local therefore adds one constrained
provider-compatibility exception:
`truncate_retained_tool_result_to_fit` only runs if the smallest valid tail
still cannot fit. It truncates the largest retained `role: tool` content by a
binary search to the maximum fitting head-plus-tail projection, with an explicit
marker and (when JSON provides it) source path telemetry. It never edits the
append-only `Transcript`, never drops the tool message or its owning assistant
call, and the normal path remains verbatim.

`CompactionDiagnostics` now includes the preferred/selected tail size, each
candidate's retained and complete-request estimates with fit outcome, and the
emergency tool-result projection details. A reactive overflow stores that one
fitted projection for the immediate retry, avoiding a second semantic
compaction merely because canonical history remains unmodified.
