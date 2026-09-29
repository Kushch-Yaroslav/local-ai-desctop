# Experimental no-Todo agent harness

## Purpose

The `experiment/no-todo-api` branch tests whether removing externally maintained planning improves local-model autonomy and long-task continuity. The model has no Todo schema, lifecycle, plan snapshot, forced first turn, or completion gate.

## Runtime contract

The stable guidance asks the model to reason about an approach, adapt while it learns, use capabilities when needed, and continue until the user task is complete. The first request receives the normal production tool set with `tool_choice: "auto"`; no provider-specific required-function workaround is used.

Task Memory is a durable, selective semantic handoff for the current user task. It records findings, evidence, implications, blockers, unresolved questions, and useful next directions without task IDs or a plan relationship. Memory updates are persisted independently of legacy plan snapshots and are supplied to a later turn as `task_memory`, never as a model-facing plan.

Project Knowledge retains progressive disclosure. The prompt receives only its bounded catalog; selected knowledge and source remain available through their normal tools.

## Compaction and completion

Compaction remains semantic. Its continuation brief preserves the user goal, established work, findings, current focus, unresolved work or questions, blockers, and available Task Memory and Project Knowledge. It does not infer or enforce a checklist. The 80 percent trigger, 55 percent target, emergency structural fitting, and meaningful output headroom remain unchanged.

A tool-free answer completes normally. The existing focused post-mutation validation reminder remains independent of planning; there is no Todo closeout or formal completion transition.

## UI and compatibility

New runs do not emit plan snapshots and the active Task Planning surface is hidden. Existing persisted snapshots retain their renderer/database compatibility path so old conversations remain readable.
