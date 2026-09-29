# Jan behavioral core migration

## Purpose

The former Local Agent prompt carried the product Goal/Milestone hierarchy,
Adaptive Work Plan history, cache index, materialized cache documents, and
several runtime policies on most turns. A small-context model could therefore
spend its working capacity reconstructing orientation instead of progressing.

This migration preserves Local's Rust sidecar, append-only transcript,
cancellation, provider telemetry, final-text continuation, filesystem-backed
`.ai-framework`, and rich plan UI. It replaces the model-facing orchestration
contract with the parts of Jan that make a long tool task tractable: a compact
Todo, stable prompt placement, explicit memory reads, factual compaction, and
clear completion semantics.

## Canonical model Todo and UI adapter

`ModelTodo` in `rust-agent/src/agent/todo.rs` is the canonical working state.
It has ordered phases, stable internal item IDs, and exactly one active item.
The model sees only compact lines, for example:

```text
[done] Orientation: Understand project layout
[active] Product: Analyze the user flow
[pending] Architecture: Trace the runtime
[pending] Synthesis: Produce the report
```

The `todo` tool accepts `init`, `append`, `start`, `done`, `drop`, and `view`.
`done` and `drop` automatically promote the earliest pending item. The initial
high-level Todo is forced for substantial multi-step requests; the runtime then
gives one concise upkeep instruction rather than the implementation policy.

`GoalPlan` remains persisted product state. `sync_from_model_todo` derives its
Milestones and Work Plan tasks from the Todo after each mutation, retaining UI
IDs where labels match. Existing legacy plans are converted once on resume.
The renderer can therefore continue to show milestones, active work, and
history without making the model maintain two planning systems. The old full
GoalPlan JSON never enters the provider prompt.

## Prompt contributors and accepted volatile tails

The stable prefix is assembled once per run from the configured identity,
concise Agent guidance, working directory, and fixed project/cache behavior.
Tool schemas are sorted deterministically and frozen for the run, except for a
real policy capability change.

The request order is:

1. stable system prefix;
2. factual compaction summary, if present;
3. preserved user, assistant, and tool history;
4. one volatile runtime tail containing the compact Todo/upkeep and small
   project-knowledge catalog, when it has changed.

After the provider accepts a request, that exact volatile tail is appended to
the transcript at the point the model saw it. Later projections replay it
rather than regenerate an equivalent synthetic message on every turn. A
changed Todo or catalog can create a later tail; its newer state is therefore
recency-correct. One-shot reminders are retired after acceptance.

The concise behavioral contract asks the model to use tools for concrete
evidence, avoid broad rereads, keep Todo current, verify focused changes when
practical, and synthesize once the active analysis has enough evidence.

## Progressive project knowledge

`.ai-framework` remains the persistent filesystem cache. Source fingerprints,
redaction, exact read-range observations, freshness, and runtime observation
ingestion are unchanged.

The normal prompt now contains only `prompt_catalog`: available project
documents, a bounded module list, task paths, and source-observation counts.
It is limited to roughly 1.8K characters. It never includes cache document
bodies or a raw source snapshot.

`project_knowledge_index` exposes freshness and available paths.
`project_knowledge_read` retrieves selected bounded paths, including batches.
`project_knowledge_update` remains available for deliberate durable semantic
facts. This is a lexical/catalog retriever boundary: a future
`MemoryRetriever` can select the same explicit reads semantically without
changing the prompt or persistence contract. No embedding model, vector
database, helper model, or RAG service is part of this migration.

## Compaction and the 32K adaptation

Compaction creates one factual continuation brief. It preserves the user goal
and constraints, decisions, concrete findings/files/tool outcomes, active and
relevant completed Todo work, open questions, and exact next direction. It
does not emit cache-update JSON, runtime mechanics, generic continuation
boilerplate, or raw tool dumps.

The default trigger remains 80 percent of the selected context. The target is
55 percent, bounded by the safety reserve and useful output minimum. Before
calling the summarizer, the runtime chooses a structural assistant/tool-safe
tail candidate from the preferred eight messages down to one. It evaluates the
full projected request against the target. It then issues one semantic summary.
A physically impossible retained tool result is projection-truncated only as
an emergency; the canonical append-only transcript remains verbatim.

This deliberately adapts Jan's large-window tail semantics for 32K rather than
assuming that eight messages always fit. Dynamic output budgeting is retained:
a useful smaller provider output does not by itself force another compaction.

## Tool execution and completion

Independent safe reads run concurrently when emitted in the same assistant
turn: `read_file`, `list_directory`, `project_knowledge_index`, and
`project_knowledge_read`. Their results are joined, observed, displayed, and
recorded in original call order, so tool-call IDs and assistant/tool pairs stay
valid. Writes, patches, deletes, terminal commands, Todo updates, and
permission-sensitive actions remain sequential and order-safe. Tool failures
return bounded actionable JSON errors instead of repeatedly replaying large
infrastructure strings.

`RunPolicy::Safe` advertises only Todo and read-only inspection/knowledge
tools. It leaves the model a complete analysis contract without dangling
mutation capabilities.

A normal no-tool answer is final. If the Todo still has open work, the runtime
issues exactly one closeout reminder to mark completed work done, drop skipped
work, or continue the active item. After the Todo is clean, the answer is
accepted. Focused verification is requested after a mutation when practical;
read-only analysis instead gets the evidence-and-synthesis contract.

## llama.cpp MTP context path

The launcher chooses a valid `LOCAL_AI_LLAMA_CONTEXT` and passes it directly
to `llama-server --ctx-size`. Qwen 3.8 MTP accepts 16K, 32K, 64K, and 128K
(131072) and defaults to 128K in the dedicated MTP launcher. The MTP flags
remain intact. The GLM launcher profile defaults to and caps at 64K.

At application startup `register-ipc.ts` reads the same environment setting,
constructs `LlamaCppBackend` with that maximum, and exposes only presets no
larger than it. `LlamaCppBackend` also intersects the requested value with the
actual llama-server model metadata (`n_ctx`). The resolved active context is
passed through the Agent invocation as `Config.context_limit`, so the Rust
projection/accounting window cannot claim 128K while the backend is running at
32K. The renderer receives backend-supported presets through the normal model
capability path.

128K is an MTP capability, not a global Agent default or a silent fallback. If
llama.cpp cannot initialize the selected capacity, its startup error remains
visible. VRAM feasibility remains the user's selected backend configuration.

## Observability and remaining differences

Compaction diagnostics report stable-prefix, tool-schema, transcript, summary,
Todo/runtime-tail, memory-catalog, retained-tail, trigger, and target token
estimates, along with provider cache usage when supplied. Normal UI does not
receive cache bodies or debug dumps.

Local still differs from Jan in deliberate ways: it keeps a renderer-facing
GoalPlan adapter, persistent `.ai-framework`, Electron approvals/cancellation,
dynamic output budgeting, and textual final continuation. At 32K, a single
large retained tool pair can still require emergency projection truncation, and
repeated genuinely different cache/Todo tails consume some history. Those are
bounded context risks, not reasons to reintroduce the old hierarchy or cache
materialization into every request.
