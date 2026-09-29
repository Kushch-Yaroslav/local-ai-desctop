# Jan vs Local AI Desktop runtime gap

Research date: 2026-09-28. This is a source inspection only. No runtime, model, build, test, cache, or production source was changed. Local was inspected at `feat/harness-stabilization` including its uncommitted runtime/cache changes. Jan was inspected at `9925f8b6d9fab968284b4dd11566b9435229b690`.

## Scope and important distinction

Jan currently has two agent implementations in this checkout:

1. The production Rust orchestration path in `jan-git/src-tauri/src/core/agent/`, entered through `run_orchestration_streamed` and used by the desktop/core agent infrastructure. This is the primary comparison below.
2. The Web Cowork path in `jan-git/web-app/src/lib/coworkRunner.ts` and `coworkTransport.ts`. It mirrors several Rust semantics but is not byte-for-byte the same. In particular its context manager is simpler (`web-app/src/lib/context-manager.ts`) and its runner dispatches tools sequentially. It should not be treated as proof of the Rust path's exact behavior.

The important result is that Local did port some individual primitives from Jan, but not Jan's complete model-facing behavioral contract or its context economy.

## 1. Current Local call graph and state ownership

### Execution path

```
Renderer request
  -> src/main/ipc/register-ipc.ts: chat:stream handler
  -> src/main/services/rust-agent-runtime.ts: RustAgentRuntime.stream
       splitAgentRunHistory(history); latest persisted UI plan
  -> rust-agent/src/main.rs (NDJSON run request)
  -> rust-agent/src/agent/loop_runtime.rs: run(Config)
       Transcript::default + historical messages + RunUser
       AgentState { GoalPlan, mutation/plan/cache counters }
       stable_prefix + tool_schemas (once)
       each turn:
         dynamic_tail(state, root)
         context::projection::project(...)
         request_payload -> POST streaming OpenAI chat/completions
         stream_call -> validate_calls
         Transcript::assistant_tool_turn / tool_result
         run_tool -> filesystem/shell/knowledge/task_plan
         loop to next provider turn
       compact_once -> summarize_span -> Transcript::compact
       tool-free answer -> optional closeout reminder -> Final
  -> NDJSON Event stream -> RustAgentRuntime.stream mapping
  -> IPC stores assistant response and persisted AgentPlan in database
```

Exact Local owners:

| Kind | Owner | What it owns |
|---|---|---|
| Canonical in-run conversation | `rust-agent/src/agent/transcript.rs: Transcript` | append-only `Entry::{Message, RunUser, Compaction, Steering, Reminder}`; assistant calls and `role: tool` results |
| Canonical in-run planning | `rust-agent/src/agent/state.rs: AgentState.plan: GoalPlan` and `agent/todo.rs` | milestones, one active milestone, work tasks, status, stable IDs, revisions |
| Ephemeral run control | `AgentState` and locals in `loop_runtime.rs: run` | mutation counters, reminder latches, cache diagnostics, continuation text/count, compaction counters, cancellation/steering handles |
| Persisted user/session data | Electron SQLite via `src/main/services/database.ts`, reconstructed by `latestPlan` in `rust-agent-runtime.ts` | historical chat messages and last `taskPlan`; the Rust `Transcript` itself is not persisted verbatim |
| Persistent project knowledge | `<selected-project>/.ai-framework`, `tools/knowledge.rs` | manifest, overview/module/source/task Markdown; it is outside the Local app repository |
| Model-visible state | `context/projection.rs: project` | one system message, rolling summary, retained raw transcript/tool pairs, exact current user request, dynamic planning/cache/reminder tail |
| UI-only state | renderer timeline/tool cards/context telemetry | events, diffs, activity labels and diagnostics; not intentionally part of prompt except ordinary historical assistant text sent by Electron on a later user request |

`src/main/services/rust-agent-runtime.ts:112-118` supplies a very short base system string, current user, prior chat history with only `{role, content}`, the persisted plan, root, context window and output cap. Therefore Local loses historical tool-call/result structure between separate Electron runs; within the one Rust run the `Transcript` does retain it.

### Local provider payload actually sent

`loop_runtime.rs:137-158` emits OpenAI-compatible JSON:

```json
{
  "model": "...",
  "messages": ["system", "optional runtime summary", "retained messages", "runtime guidance"],
  "tools": [9 schemas with a project root],
  "tool_choice": "auto",
  "stream": true,
  "stream_options": {"include_usage": true},
  "max_tokens": "dynamic ceiling",
  "reasoning_effort or chat_template_kwargs": "mode dependent"
}
```

The system message is `Config.system` plus `AGENT_GUIDANCE` plus `<working_directory>` (`loop_runtime.rs:274-282`). The last user message is a synthetic `[RUNTIME GUIDANCE — NOT USER CONTENT]` block containing, on every turn:

* serialised complete `GoalPlan` if any;
* `<project_knowledge_index>` (manifest-derived JSON, capped at 8,000 characters);
* `<materialized_project_knowledge>` (up to 12,000 characters);
* transient reminders.

The latter is not a small pointer. `tools/knowledge.rs:322-388` automatically selects the first task document, overview, and label-matching project/module documents. It does not automatically select cached source documents unless a matching module points to them. The explicit cache tools can add up to 48 KB of documents into a tool result.

### Local tool and completion behavior

The model can issue several tool calls in a streamed completion. `validate_calls` accepts the complete batch, then `run` executes it in source order (`loop_runtime.rs:2057-2144`) and appends each result. One provider request follows each whole batch. There is no model turn per individual call, but independent calls are not parallelized. A failed, rejected, unavailable or cancelled call becomes a verbose literal `ERROR: ...` tool result and is replayed until compacted. Approval is not an interactive continuation: `policy::requires_approval` immediately records `ERROR: approval required`.

A tool-free answer is not always final. `add_soft_closeout_if_needed` adds one synthetic reminder when any milestone is open or changed files lack validation, preserves the assistant answer, and forces one further provider turn (`loop_runtime.rs:1614-1632`, `2038-2055`). Length responses use a separate up-to-32-turn continuation protocol with up to 12,000 characters of prior final text in a tail reminder.

## 2. Current Jan Rust call graph and state ownership

### Execution path

```
agent request body / desktop session
  -> src-tauri/src/core/agent/loop.rs: run_orchestration_streamed
  -> run_orchestration_steered -> orchestrate_inner
       parse_openai_messages -> Transcript::from_history (repairs invalid pairs)
       build_run_system_prompt / compose_system_prompt (once per run)
       advertise_local_tools + MCP tools (once per run)
       create volatile tail: date, git state, query memory recall, plan/todo addendum
  -> run_turn_cycle
       Transcript::project(volatile_system, send_reasoning)
       build_completion_request -> HttpModelInvoker::invoke streaming provider
       record accepted volatile tail in exact sent position
       record assistant tool-call message
       CompositeToolInvoker::invoke batch
       record standard role:tool results
       next model turn
       preflight or reactive compact -> compaction::summarize_span
       no tools -> Todo closeout retry or natural return
  -> StreamEvent::Done/Error plus projected MessagesUpdated session history
```

Exact Jan state owners:

| Kind | Owner | What it owns |
|---|---|---|
| Canonical transcript | `src-tauri/src/core/agent/transcript.rs: Transcript` | append-only `Event::{Message, Prompt, Reminder, PromptTail, Compaction}`; a pure projection creates wire messages |
| Todo | `src-tauri/src/core/agent/todo.rs: TodoRegistry = Arc<Mutex<TodoList>>` | canonical session phased todo, single active task and persistence/UI updates; children cannot read/mutate it |
| Prompt construction | `context.rs`, `prompt.rs` and `loop.rs:2474-2595` | named prompt composers, placement policy, stable prefix, volatile tail and deterministic ordering |
| Tools/permissions | `loop.rs: CompositeToolInvoker`, `tauri_plugin_agent_tools` and MCP dispatch | advertised set, capability/plan-mode gating, session grants, approval waits, tool outcomes |
| Persisted knowledge | Jan project context/JAN.md, skills and memory store | the system prompt gets a small skills/memory catalog; full note bodies require an explicit read/retrieve path |
| Model-visible state | `Transcript::project`, `build_completion_request` | system prefix, projected record/summary/tail, request `tools`, `tool_choice` and provider options |
| UI-only state | `StreamEvent` receiver | tool cards/diffs/usage/progress; transcript is updated separately with the message shape the model actually received |

`Transcript::from_history` is materially stronger than Local's Electron handoff. It removes malformed calls, drops orphaned results and creates error results for dangling valid calls at the single ingress point. `Transcript::project` is explicitly a pure function and stores an accepted volatile prompt tail at the position where the model saw it; Local re-renders changing dynamic state at the end of every request.

### Jan provider payload actually sent

`loop.rs:3493-3499` builds an OpenAI chat-completions request from `project(...)`, fixed `openai_tools`, body sampling fields and an optional first-turn forced tool choice. The model receives:

1. stable system prompt at message 0, assembled once using named composers;
2. any prior accepted prompt-tail messages and transcript in chronological order;
3. a compaction summary in a marked `system` message plus structural retained tail;
4. one current volatile tail only if it has not already been accepted;
5. a fixed run tool schema array; and
6. the usual `tool_choice: auto`, except a `/goal` first turn can force `todo`.

The stable prompt has more feature categories than Local (identity, concise guidelines, working directory, runtime environment, skill guide, web guide, project `JAN.md`, skill catalog, memory catalog, and optional subagent guide), but it is intentionally progressive-disclosure. `context.rs:98-117` advertises skill names/descriptions rather than bodies; `context.rs:229-251` advertises memory names/summaries rather than source dumps. Query recall is a separate volatile block, not every memory/source note.

The actual current Jan Rust system prompt does include explicit behavioral instructions in `context.rs:21-25`: concise responses, use Todo only when work needs tracking, keep it current once used, ask only for material decisions, and a verification-oriented guideline. The Web Cowork prompt is even clearer on verification (`web-app/src/lib/coworkPrompt.ts:18-23`: read-before-write, targeted edits, verify by run/readback, adapt after errors, keep Todo current). These are source facts, not claims that every Jan surface has identical wording.

## 3. Model-facing comparison

| Payload component | Jan Rust behavior | Local behavior | Consequence |
|---|---|---|---|
| System prompt | named, stable composers; richer but mostly static/catalog-only | short base system plus ~8-line `AGENT_GUIDANCE` and root | Jan has a deliberate cache boundary; Local stable system is smaller but not enough to offset the dynamic tail |
| Tool schemas | frozen/advertised once per run, permission/mode gated; may include built-ins/MCP/subagents | always 9 sorted project schemas: plan + 8 file/shell/knowledge tools | Local's plan schema is unusually large and explanatory; Jan tool count can be larger with MCP, so count alone is not a Jan advantage |
| Plan/Todo | only present through Todo tool results plus a short changing upkeep instruction; `/goal` can force first `todo` | full hierarchical JSON plan injected every turn, plus plan schema and regular reminders | Local makes planning a permanent cognitive object; Jan makes it an action list |
| Project memory | project instructions + catalog/retrieval; explicit/full data on demand | every request gets 8K manifest index and automatic materialized documents up to 12K | Local pays memory cost before the model decides it needs it |
| Current request | transcript user message | exact `RunUser`, always retained even after compaction | broadly equivalent |
| Summary | factual brief, marked system message, only replaces dropped history | semantic handoff plus XML/JSON cache-update contract, inserted as synthetic user runtime summary | Local compaction asks the same model to perform two jobs and relies on exact tagged output |
| Retained tool history | structural tail, standard assistant/tool pairs | same structural pair replay, with emergency projection truncation only when it cannot fit | partially equivalent |
| Dynamic instructions | date/git/query memory/Todo or plan-mode only; accepted tail becomes history | plan + cache index + cache content recreated each turn; reminders expire after one request | Local changes more content every turn and repeatedly recency-biases infrastructure metadata |
| Final instruction | no-tool is natural completion; one Todo closeout retry only if open | no-tool answer often gets an additional plan/validation closeout turn | both nudge; Local's condition is broader because an open milestone remains open during exploration |

Local is not simply "more verbose" in system text. It is materially more verbose in *changing prompt state*: full plan JSON, cache index, automatic cache contents, planning descriptions, compaction output format and post-tool error text. This matters more for a 32K local model than a few extra static guidelines.

## 4. Context composition and the 32K evidence

### Known Local fixed/dynamic costs

Local's own estimator is `JSON characters / 3 + 8` (`loop_runtime.rs:161-170`), which is only a heuristic; llama.cpp provider-reported prompt tokens are authoritative. It nevertheless accounts for stable prefix, schemas, transcript and dynamic tail separately in `request_budget` and emits those values in compaction diagnostics.

The audited project cache at `/media/yaroslav/DATA/Projects/AEM-DAYS/Online-Shop/.ai-framework` contains 19 source entries, one task, no modules and an overview. Its measured relevant values are:

* total cache disk size: 77,913 bytes;
* manifest projection JSON before wrapper: 3,596 bytes (not 77 KB);
* first task document: 898 bytes;
* overview: 3,883 bytes;
* automatic materialized projection for this state: about 4.8 KB plus XML headings/wrapper, because no module is selected;
* automatic dynamic knowledge: roughly 8.4 KB of index + selected docs before plan/reminders and JSON/envelope overhead, approximately 2.8K Local-estimator tokens before wrapper overhead.

The 12K cap is real, but it is a cap per request, not an amortized cache. A larger overview/task/module selection can consume it fully. The 19 cached source files are useful only through the cache index, explicit `project_knowledge_read`, or future label-matched modules; most are not automatically injected in this particular observed cache.

| Component | Jan approximate size/behavior | Local approximate size/behavior at 32K | Important difference |
|---|---|---|---|
| Stable system | varies by JAN.md/skills/catalog; stable once per run | base system + guidance + path; stable once per run | neither is inherently the main pressure |
| Tool schemas | variable; frozen per run | 9 schemas, with a large two-layer plan schema | Local schema explains policy/state details the model repeatedly sees |
| Todo/plan | concise upkeep sentence; list snapshot normally only tool history | complete JSON GoalPlan on every turn | Local changes after each plan mutation and stays visible forever |
| Memory/context | catalog and query-relevant recall; no automatic raw project-source injection | 3.6K index + ~4.8K current materialization in inspected audit cache; cap 8K+12K | Local reserves a significant slice before transcript work |
| Summary | one marked summary, target prompt is dense factual brief | summary can be up to 2,048 output tokens and is coupled to cache-promotion tags | Local's summary itself can be a large stable burden |
| Retained tail | 8 messages, tool pairs preserved | target 8 messages, tries 4/2/1 only when needed | same number does not mean same byte size |
| Raw tool output | retained recent results; Jan has no Local-style automatic source-cache duplicate | retained recent result plus cache may contain the same read/source observation | Local can pay raw source result and a persistent observation/overview in one request |

### Why 30,351 -> 30,209 can save only 142 tokens

This trace cannot be attributed to the summary algorithm alone. In Local `compact_once` computes `after` from the *entire projected provider request* after `Transcript::compact`, including unchanged system prefix, tool schemas, retained structural tail, rolling summary, full dynamic planning state, 8K index and materialized cache. It removes only raw entries before a valid structural boundary.

Therefore a 142-token reduction means the chosen eligible dropped span was about the same size as the summary that replaced it, while the post-compaction floor was already dominated by content compaction cannot remove. The code makes that possible in two direct ways:

1. `DEFAULT_KEEP_RECENT = 8` retains message entries, not token budget. A single assistant tool-call message followed by several large `read_file`/terminal results can be the whole structural tail. It cannot be cut through because `Transcript::compaction_plan` protects tool pairing.
2. `dynamic_tail` is reattached after every compaction and is outside the summarized transcript. At the inspected cache's current minimum it is already roughly 2.8K estimator tokens before plan/reminders; at maximum materialization it can be roughly 6.7K estimator tokens before those additions. Tool schemas and system prompt are also non-removable.

`CompactionReport` already has the decisive fields: `stable_prefix_tokens`, `tool_schemas_tokens`, `transcript_history_tokens`, `dynamic_tail_tokens`, `estimated_retained_tokens`, summary size and selected tail candidate attempts (`loop_runtime.rs:1148-1207`). The supplied before/after totals alone do not identify which of retained raw result, dynamic cache/plan, or summary dominated that exact event. Claiming a single dominant source from those six pairs would be speculation. The next forensic read should use the report attached to that run, not another model run.

Jan has the same 8-message structural-tail failure mode: a huge last batch can dominate a 32K request. It does not have Local's always-injected project-source/cache floor, and its compaction does not add a large task/overview index on every projected request.

### 128K normalization

Both current algorithms use the same nominal policy: 80% trigger and preferred 8 recent messages. That is 102,400 tokens at 128K and 25,600 at 32K.

| Scenario | Trigger | Headroom at trigger | Meaning |
|---|---:|---:|---|
| Jan at 128K | 102,400 | 25,600 | large room for an 8-message tail, summary and new tool turn |
| Jan semantics at 32K | 25,600 | 6,400 | it would compact around the same nominal point as Local and can rapidly compact after large results |
| Local at 32K | 25,600 | 6,400 before Local's output reserve; dynamic cache/plan is re-added | the usable transcript budget is smaller than the nominal window suggests |

Jan has no source-level hard-coded requirement for 128K. But 8 messages are an unbounded byte policy, and the policy behaves much more forgivingly at 128K. At 32K Jan would also compact frequently on many large reads. Thus context size is a necessary contributor, but it does not explain Local's recurrent orientation loop by itself.

## 5. Compaction, orientation and cache stability

### Jan compaction

`compaction.rs` sets `DEFAULT_KEEP_RECENT = 8`, 80% trigger and 48,000-character summary input clamp. `Transcript::compaction_plan`/`tail_start` keeps valid assistant/tool groups; `compact` records a marked system summary boundary without deleting raw record. It preflights if a context budget is known (`loop.rs:3480-3547`) and otherwise compacts reactively on provider overflow, reducing tail 8 -> 4 -> 2 on retries. It does not impose an explicit post-compaction low-water target: it relies on the retained tail being reasonable and, in practice, benefits substantially from larger windows.

The Jan summary instruction explicitly asks for user's goal/constraints, decisions, files and commands/outcomes, unresolved questions, and no redundant tool output (`compaction.rs:173-176`). This is a single factual brief; no required XML and no durable-source-cache promotion is requested from that same model call.

### Local compaction

Local copies the append-only boundary concept and summary input cap, but changes the operating environment:

* it runs proactive 80% compaction even though it also reduces output dynamically;
* it reserves 2,048 summary output tokens in fit selection (`SUMMARY_FIT_RESERVE_CHARS = 6,144`), which makes it more aggressive selecting a smaller tail;
* it asks the compactor for an information-dense handoff *and* a strict `project_knowledge_updates` JSON block;
* it promotes compaction text into task cache and repeatedly reinjects cache afterward;
* it evaluates fit against a prompt containing Local's dynamic plan/cache tail;
* it can emergency-truncate only the largest retained tool result in the outgoing projection, leaving canonical transcript unchanged.

This can produce good shrinkage when old transcript raw output dominates (e.g. 28,043 -> 10,169), and negligible shrinkage when the retained structural tail plus non-transcript floor dominates (e.g. 30,351 -> 30,209). That is an expected outcome of this implementation, not evidence that `Transcript::compact` failed to record a boundary.

### Why Local re-enters Orientation

The model sees a mixture that is poorly shaped for resumption:

1. compaction removes the earlier tool evidence it used to form orientation, while the semantic handoff quality is dependent on the same small model that is already struggling;
2. Local automatically adds project metadata, task cache and overview every turn, including raw runtime observations with empty `Semantic findings`/`Open gaps` sections (`knowledge.rs:391-480`). This tells the model repeatedly that files were inspected but does not necessarily supply the conclusion or current decision;
3. the complete Goal/Milestone/Work JSON remains highly salient even when no work plan has been created; it tells the model it is still in an active Orientation milestone;
4. no Jan-equivalent eager goal Todo forcing exists. Local merely advises not to create a detailed work plan before understanding the active milestone, which rewards prolonged orientation;
5. after a no-tool answer, Local's open-milestone closeout reminder says to update plan or continue. An orientation milestone with open work creates another investigation turn instead of allowing synthesis;
6. early tool source output can be present both as recent raw tool results and cache-derived text/index, wasting space without a concise, task-progress-oriented state.

Jan's current continuation signal is simpler: a factual summary, preserved current user request, valid tail, a single active Todo promoted automatically, the always-on Todo-upkeep instruction when a list exists, and a one-shot final closeout request. Jan does not magically know research is sufficient; it gives the model a less competing representation of what is done and what one action is next.

### Prompt-cache stability

Jan treats placement as a first-class invariant in `prompt.rs`: only session-constant contributors may be above the cache line; tools are frozen; dynamic date/git/memory recall/Todo instructions are assembled deterministically at the tail. After a successful request the exact tail is recorded as `PromptTail`, so it does not move relative to accepted history next turn.

Local has a byte-stable system message and sorts tools deterministically, which is a real partial port. Its dynamic tail is indeed after history, so it should not invalidate a provider that caches a leading prefix. However it is regenerated before every turn and can change from plan updates, cache revisions, task selection and reminders. A compaction rewrites the early projected summary/history boundary. These changes lower cache reuse across the portion after the stable system, and can change model behavior through recency even when a provider's prefix cache remains valid. Cache percentage variation therefore affects latency/cost and can also accompany changed model-visible context; it is not merely a speed statistic.

## 6. Tool loop comparison

| Question | Jan Rust | Local Rust |
|---|---|---|
| Multiple calls in one response | yes | yes |
| Execution | `CompositeToolInvoker::invoke` receives batch; auto-allowed read-only built-ins are deferred and run concurrently; writes/exec/prompts remain sequential | all calls execute in source order sequentially |
| Provider turns per batch | one completion, then results, then one next completion | same |
| Results | standard `role: tool`, id paired; images as multimodal parts; malformed calls are kept out of record | standard `role: tool`, id paired; JSON-stringified values; malformed batch produces reminder and no execution |
| Errors | recoverable result strings; permission can await explicit decision/session grants | `ERROR:` string, including approval-required without an interaction path |
| Tool availability | per-run advertised/gated by project, permission, plan mode, allowlist, subagent state | fixed project-root suite every turn, except no root means only plan |
| Tool output compression | normal compaction; no per-request Local cache duplication | normal compaction plus only emergency largest-retained-result truncation |
| Read-only distinction | can be concurrent; Plan mode hides mutating tools | no concurrency; no phase-specific tool suppression |

Local does not necessarily require more *provider turns* per batch, but it can take longer per useful batch because it serializes independent reads and does not provide Jan's subagent/context-offloading mechanism. Its nine tools are fewer than a fully configured Jan run, so schema count is not the main explanation. The heavy plan schema and lack of tool-mode narrowing are still cognitive costs.

## 7. Todo versus Local hierarchy

Jan `TodoList` is a flat set of phased content labels. `done`/`drop` automatically promotes the next pending task; the model normally only needs `init`, then `done` as it finishes. With a `/goal` request and no existing list, Jan both tells the model to create a phased plan and forces `tool_choice` to `todo` for turn one (`loop.rs:2373-2403`, `2597-2600`). With a list it injects the explicit upkeep contract every turn. It nudges after 12 mutation actions at most twice, and on a no-tool completion asks once to either close completed items, drop skipped items, or continue actual work.

Local's `GoalPlan` has good invariants, but it is not equivalent. It makes the model choose goal versus work scope, action, milestone/task IDs, and operations such as refine/split/start/done/drop. It prohibits milestone completion while open child work remains. Full state including historical milestones is injected every turn. The model must first choose when orientation is sufficient to create a Work Plan, and Local explicitly tells it not to create one before it understands the milestone. For a small model this adds bookkeeping decisions at the exact point where it needs a simple next-action signal.

Local copied Jan's 12-action nudge and one closeout turn, but `mutations_since_plan_update` counts terminal/write operations, not read exploration. The observed failure is primarily reads during Orientation, so the mid-run nudge does not fire. This is one direct reason useful findings can coexist with `0/6` milestones: there is no lifecycle forcing an orientation milestone into a concrete next work item or finished research stage.

## 8. Testing, verification and finalization

Jan’s production prompt includes verification-oriented guidelines; the Web Cowork variant makes it explicit: "Verify your work: run it, or read back what you wrote." Jan's tool descriptions and capability set expose `bash`, read/edit/write and checks in a normal project run. Its Todo contract and closeout request turn finishing an implementation task into an obvious next action: mark completion, verify, then answer. The Jan model's observed testing behavior is therefore best explained by the combined behavioral contract (prompt + Todo maintenance + ordinary tools + closeout), not an autonomous verifier hidden in the runtime.

Local says after modifying files to run relevant validation when practical and exposes `run_terminal`. That instruction is present, so it has not wholly omitted verification. The practical difference is state focus: Local spends early capacity on Orientation/cache/plan mechanics, and its validation closeout occurs only after a mutation. In a repository audit with no requested code change, it cannot help the model decide when investigation is complete. Jan’s terse Todo lifecycle more readily lets the model reach a no-tool synthesis turn.

## 9. Strict equivalence audit

| Feature | Jan implementation | Local implementation | Verdict |
|---|---|---|---|
| Transcript | append-only event record, ingress repair, pure projection | append-only entries, pure projection within a Rust run | PARTIALLY EQUIVALENT — Local Electron restarts flatten old history to role/content |
| Projection | stable/accepted prompt placement plus transcript | stable system, summary/tail and regenerated dynamic user guidance | PARTIALLY EQUIVALENT |
| Stable prefix | explicit composer registry and enforced cache-line policy | stable system string, sorted schemas | PARTIALLY EQUIVALENT |
| Compaction | 80%, 8 structural messages, summary boundary, reactive 8/4/2 | same concepts plus fit-aware 8/4/2/1 and emergency result truncation | PARTIALLY EQUIVALENT |
| Retained tail | structural tool-pair-safe 8 messages | same | EQUIVALENT in boundary idea, not effective byte budget |
| Summary | one factual continuation brief | handoff plus required cache-update format/promotions | NOT EQUIVALENT |
| Todo upkeep | forced first Todo in goal mode, per-turn upkeep, mutation nudge, one final closeout | hierarchy, 12 write/action nudge, closeout | NOT EQUIVALENT |
| Tool loop | batched, concurrent safe reads, plan-mode/gated suite | batched but all sequential, always same root tool suite | NOT EQUIVALENT |
| Tool batching | permits parallel auto-allowed reads | sequential | NOT EQUIVALENT |
| Reminder lifecycle | pending reminder attaches at tail; accepted volatile tail is recorded in position | one-turn reminders cleared before next request | PARTIALLY EQUIVALENT |
| Cancellation/approval | cancellation and interactive permissions/session grants | cancellation; approval converts to error and continues | NOT EQUIVALENT |
| Final completion | natural no-tool plus bounded Todo closeout/background park | natural no-tool plus broader plan/validation closeout and length continuation | PARTIALLY EQUIVALENT |
| Continuation | prompt/transcript turn continuation and steering | long final textual continuation with 12K tail | LOCAL EXTENSION |
| Verification behavior | explicit behavioral contract plus Todo lifecycle | validation guidance/terminal, but no research-to-synthesis lifecycle | PARTIALLY EQUIVALENT |
| Prompt caching | formal placement policy, frozen tools, accepted tail positional stability | stable system/tool order but regenerated plan/cache tail and compaction rewriting | PARTIALLY EQUIVALENT |
| Context accounting | provider usage plus source policy; compaction estimate | request-budget categories + heuristic and provider telemetry | PARTIALLY EQUIVALENT |
| Project memory | instructions/catalog/explicit recall, progressive disclosure | automatic index + materialized documents every request | LOCAL EXTENSION |

## 10. Ranked root causes

1. **Local reserves a recurring dynamic-memory/plan floor inside a 32K window.**
   Evidence: `dynamic_tail` always inserts full plan, 8K index and up to 12K materialized documents. The actual audit cache contributes about 8.4K characters before wrappers and plan/reminders. Jan catalogs memory and retrieves it on demand.
   Effect: less space for raw evidence and useful post-tool reasoning; compaction cannot remove this floor.
   Jan difference: progressive disclosure, not automatic source/cache projection.

2. **The Goal/Milestone/Work Plan is not Jan Todo behavior.**
   Evidence: Local injects full hierarchy every turn and advises delayed work-plan creation; Jan force-initializes Todo in goal mode and repeatedly states the simple done/drop upkeep contract.
   Effect: small model remains in Orientation/bookkeeping and has no strong research-complete transition.
   Jan difference: one automatically promoted active task, not two planning layers with IDs/history.

3. **The shared 8-message retained-tail policy implicitly assumes room that 128K supplies; Local additionally has a large non-tail floor.**
   Evidence: both source trees define 80%/8. At 32K trigger is 25.6K, leaving 6.4K; 8 messages can be several huge results. Local’s cache/plan reappears after compaction.
   Effect: frequent compaction and occasional near-zero reduction. This explains pressure but not all orientation behavior.
   Jan difference: at 128K it has 25.6K headroom and generally no automatic raw-cache floor.

4. **Local compaction is overloaded: semantic handoff and persistent-cache production are one fragile model output.**
   Evidence: `SUMMARY_GUIDANCE` requires two tagged sections and JSON updates; promotion then changes the next dynamic tail. Jan requests one concise factual summary.
   Effect: a weak model can spend output budget satisfying tags or generate thin cache prose rather than a decisive continuation state.
   Jan difference: summary does one job.

5. **Local lacks Jan’s tool-loop throughput and phase gating.**
   Evidence: Local serializes all calls and advertises one fixed tool suite; Jan batches and concurrently runs safe reads, with plan-mode/capability-specific availability and subagents.
   Effect: fewer useful observations per wall-clock/model turn and a noisier permanent tool surface.
   Jan difference: concurrent reads/context offloading and fewer irrelevant tools in constrained modes.

6. **Local terminal behavior can turn attempted synthesis into further investigation.**
   Evidence: `add_soft_closeout_if_needed` triggers whenever any milestone is open; Jan's closeout is tied to open Todo and occurs once with clear done/drop/continue wording.
   Effect: an unfinished Orientation milestone becomes a recurring command to continue instead of a criterion for synthesis.
   Jan difference: Todo status is simpler and closer to the user's visible notion of progress.

## 11. Recommended port order (no implementation in this research)

1. **PORT JAN LITERALLY: Todo behavioral contract.** Use Jan's single active Todo representation, goal-mode first-turn forced initialization, per-turn upkeep, and one-shot closeout semantics before retaining any Local hierarchy.
2. **ADAPT JAN: provider request/prompt construction.** Port named contributor placement, frozen schemas and accepted volatile-tail positional recording. Keep only project-specific stable instruction blocks above the cache boundary.
3. **REMOVE LOCAL: unconditional cache materialization from every request.** Retain a tiny stable/catalog index and explicit cache retrieval; do not auto-inject task + overview/source observations on every turn.
4. **PORT JAN LITERALLY then adapt: compaction summary as one factual brief.** Separate durable cache promotion from the continuation summary; preserve Jan structural tail and progressive retry, then establish a 32K post-compaction target based on actual provider tokens.
5. **PORT JAN LITERALLY: tool-loop classification.** Batch calls, parallelize safe read-only calls, and gate/hide tools by mode/capability. Preserve standard tool-result protocol.
6. **REMOVE LOCAL: Goal/Milestone/Adaptive Work Plan from the model-facing default.** If UI needs hierarchy, derive it outside the prompt or add it only after Todo behavior is demonstrably stable.
7. **KEEP LOCAL selectively: exact provider token instrumentation, append-only record, emergency safety, and final textual continuation.** These are useful Local extensions once they are not competing with the basic Jan loop.

## 12. Critical answer

**PARTIALLY.** If Local used Jan's exact runtime/prompt/tool-loop semantics with a 32K Qwen context, this audit would still compact much more often than Jan at 128K: Jan's own 80% trigger becomes 25.6K and its 8-message structural tail can still dominate a small window after large file results. It could still lose details after repeated compaction.

It would not likely fail in the *same way*. Jan semantics remove Local's automatic cache/plan floor, simplify the current-task representation to an automatically advancing Todo, provide an explicit goal-mode Todo lifecycle, keep prompt/cache placement deterministic, avoid compaction-as-cache-production, and increase read-tool throughput. Those changes directly address the repeated `compaction -> orientation -> reread` cycle. A 32K context remains a hard limitation, but it is not sufficient to explain Local's observed 0/6 Orientation stall.

## Source map

Local: `rust-agent/src/agent/{loop_runtime,state,transcript,todo,events}.rs`, `rust-agent/src/context/projection.rs`, `rust-agent/src/tools/knowledge.rs`, `src/main/services/rust-agent-runtime.ts`, `src/main/ipc/register-ipc.ts`, `src/main/backends/llama-cpp-backend.ts`.

Jan Rust: `src-tauri/src/core/agent/{loop,transcript,compaction,todo,context,prompt,session,plan}.rs`.

Jan Web Cowork cross-check: `web-app/src/lib/{coworkRunner,coworkTransport,coworkPrompt,coworkTodo,coworkTools,coworkDispatch,context-manager}.ts`.

## Migration status (2026-09-28)

The behavioral-core migration has implemented the report's primary runtime
recommendations: a canonical compact `ModelTodo` with a UI GoalPlan adapter;
an eager first-turn Todo for substantial requests; deterministic stable prefix
and tool ordering; accepted volatile-tail transcript placement; catalog-only
`.ai-framework` injection with explicit reads; a factual one-job compaction
summary; a 32K low-water selection target; concurrent safe reads with ordered
replay; bounded closeout; and safe-policy tool gating. The llama.cpp MTP
launcher/application context path now accepts 16K/32K/64K/128K for Qwen and
passes the selected capacity to both `--ctx-size` and Agent accounting.

This status records implementation scope only. It does not replace the
forensic evidence above, and no real Qwen, Ollama, llama.cpp, or Jan Agent
benchmark was run as part of the migration.
