# Jan runtime port map

Research date: 2026-09-27. Jan was inspected read-only at
`/media/yaroslav/DATA/Apps/jan-git`.

## Actual Jan lifecycle

The normal entry point is `orchestrate` in
`src-tauri/src/core/agent/loop.rs`; it creates/adopts a `Transcript`, composes
the stable prompt/tool list, then calls `run_turn_cycle`. The relevant normal
turn is:

```text
OrchestrationArgs/history
  -> Transcript::from_history
  -> run_turn_cycle
  -> Transcript::project(Projection)
  -> build_completion_request
  -> ModelInvoker::invoke (streaming events)
  -> record accepted prompt tail
  -> assistant message or assistant.tool_calls
     -> ToolInvoker::invoke
     -> role: tool messages
  -> next Transcript::project / next provider request
```

`run_turn_cycle` preflights `CompactionBudget`, uses `Transcript::compaction_plan`,
calls `compaction::summarize_span`, records `Event::Compaction`, then rebuilds
the provider array from the same transcript. Context overflow uses the same
path with progressively smaller `keep_recent`. A terminal no-tool reply gets
one optional Todo closeout reminder and is then returned; it is not blocked by
Todo state. A `length` reply carrying tool calls records error tool results and
continues, avoiding execution of truncated arguments.

## Source map

| Responsibility | Jan implementation | Local mapping/decision |
| --- | --- | --- |
| Canonical transcript | `agent/transcript.rs`: `Transcript`, `Event`, `Projection`, `CompactionPlan` | Adapt Local `agent/transcript.rs` append-only record and `context/projection.rs`; retain Local's one-leading-system invariant. |
| Transcript repair/tool pairing | `agent/upstream.rs`: `drop_malformed_tool_calls`, `drop_orphaned_tool_results`, `repair_dangling_tool_calls`, `prune_unusable_tool_calls`; `loop.rs::record_assistant_turn` | Local `validate_calls`, `assistant_tool_turn`, `tool_result`; retain strict validation before execution. |
| Provider request | `loop.rs::build_completion_request`, `strip_assistant_reasoning` | Local `request_payload` and dynamic output budget; tools remain advertised on every agent request. |
| Stable prefix | `agent/context.rs`, `agent/prompt.rs`, `agent/transcript.rs::project`, `agent/upstream.rs::set_system_prompt`/`append_prompt_tail`, `agent/prefix_stability.rs` | Local `stable_prefix` + tail projection. Stable system is message zero only; runtime/planning guidance is tail data. |
| Compaction | `agent/compaction.rs`: `CompactionBudget`, `DEFAULT_KEEP_RECENT=8`, `tail_start`, `summarize_span`; `transcript.rs::compaction_plan` | Local structural `compaction_plan`, default tail of 8, preflight plus overflow retry; simplify to Jan-style single factual summary. |
| Todo | `agent/todo.rs`: `TodoList`, `TodoStatus`, `active`, `promote_next`, `done`, `drop_target`, `open_summary` | Local `GoalPlan` keeps product hierarchy/stable IDs; its active milestone/work task is the runtime Todo adapter. |
| Todo guidance/reminders | `agent/context.rs::TODO_UPKEEP_PROMPT_ADDENDUM`; `agent/reminder.rs::attach`; `loop.rs` `MID_RUN_NUDGE_MUTATION_THRESHOLD` and closeout nudge | Local bounded tail reminders; use Jan's mutation-centric upkeep only. |
| Continuation/terminal | `loop.rs::run_turn_cycle`, `stop_reason_of`, terminal no-tool branch | Local retains length continuation/overlap dedup as required local-provider extension; normal terminal is one no-tool completion. |
| Cancellation | `loop.rs` cancellation-aware invoker/session guard | Local `stream_call` polling cancellation and tool cancellation remain product-compatible adaptation. |

## Jan semantics and limits

`Transcript` is the canonical in-memory record, not a request array. `Event::Compaction`
is a projection boundary: covered raw events remain in the record but the next
provider request sees summary plus a recent structurally valid tail. Jan's
summary prompt is a bounded dense conversation brief; it has no separate
current-task digest. `tail_start`/`compaction_plan` prevent the retained tail
from beginning with a role:tool result whose assistant call was summarized.

Stable prompts are recorded separately; accepted volatile guidance becomes a
`PromptTail` at the position it was seen. `prefix_stability.rs` verifies byte
prefix reuse. Jan may retain marked system summary/prompt nodes internally;
Local adapts projection to its stricter provider invariant of at most one
system message at index zero.

Todo has one `InProgress` item; `promote_next` advances after model-issued
`done`/`drop`. `MID_RUN_NUDGE` is advisory, bounded to two per cycle, and only
counts successful `bash`, `write`, `edit` calls since a Todo touch. Long
read-only analysis receives no Jan stall handling. Jan does not track read
files, discourage repeated reads, decide enough research occurred, or impose a
completion gate.

Jan has no separate prose continuation protocol for a no-tool `length` final:
its explicit length recovery protects truncated tool calls. Local therefore
keeps its dynamic output budgeting and logical-response continuation as a
minimal provider compatibility extension.

## Local mechanisms superseded by this port

The previous TaskResearchDigest, repeated-read hint, and read-action anti-stall
counter are removed. Jan provides no equivalent; they are intentionally not
replaced because the port objective is a coherent Jan lifecycle rather than a
new Local stall subsystem. The retained Local extensions are dynamic output
budgeting, provider-compatible length continuation with overlap dedup, strict
one-leading-system projection, hierarchical plan adapter, project tools, IPC
streaming, and cancellation.
