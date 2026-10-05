# Agent modes: Fast and Deep

Fast and Deep select an **investigation strategy**. They share tools, context
window, evidence rules and output budget. Before this change the only
difference was the reasoning effort sent to the provider (`xhigh` vs `low`);
prompt, tools and review gates were identical.

## What differs

| | Fast | Deep |
|---|---|---|
| Reasoning effort | low | xhigh (unchanged) |
| Strategy guidance (stable prefix) | smallest sufficient evidence, batch independent reads, follow a reference only if the answer would be wrong without it, stop early | frame central questions and rank unknowns by impact, trace behavior across boundaries to the real effect, verify at the source, look for disconfirming evidence, choose by information gain, converge |
| Task Memory `status` | available | available, and the guidance asks for it |
| Open-unknowns block in each turn | no | yes (entries marked `unknown`/`contradicted`) |
| Checkpoint | no | after 6 tool calls without a Task Memory write: one consolidated update |
| Final-candidate review | existing gates only | plus one convergence review while unresolved items remain |

Code: `rust-agent/src/agent/strategy.rs`, wiring in `loop_runtime.rs`,
`task_memory.rs` (`Status`), `state.rs`.

Everything is generic. Guidance and mechanisms never name a model, language,
framework, file type, path or benchmark (a unit test checks the guidance text).

## Mechanisms and bounds

- **Task Memory status** (`confirmed | inferred | unknown | contradicted`, optional;
  an update that omits it keeps the previous value). Unresolved entries rank
  higher in the bounded memory prompt.
- **Checkpoint** (Deep): a volatile tail instruction, not a tool gate. The
  counter is reset by any Task Memory write.
- **Convergence review** (Deep): at a tool-free final candidate, if Task Memory
  still lists unresolved items, the draft is withheld once with those items. It
  cannot repeat, so it cannot deadlock.
- **Task Memory write cap** (all modes): at most 2 writes per provider turn.
  Observed failure without it: GLM answered a checkpoint with 29 one-line
  entries in one turn (60 `task_memory` calls in a run), and every call echoes
  the whole memory.

## Validation (local llama.cpp, ctx 81920, f16 KV)

Same prompt each time (a Russian open-ended "what is this project, who made it
and when, history, business purpose, strengths and weaknesses" request); each
run on a fresh copy of the project. Single runs, not statistics: local models
are non-deterministic.

Online-Shop (small SPA with a PHP backend file):

| Run | Turns | Tool calls | Time | Max ctx | Opened the form that submits to the backend |
|---|---|---|---|---|---|
| Qwen Fast, before | 6 | 26 | 200 s | 24.7K | no (never opened the backend file either) |
| Qwen Fast, after | 7 | 18 | 160 s | 22.2K | no |
| Qwen Deep, before | 13 | 34 | 339 s | 41.8K | no (read the backend file, inferred the form) |
| Qwen Deep, after (3 runs) | 9–22 | 27–44 | 366–599 s | 46–62K | yes, in 3 of 3 |
| GLM Deep, before | 15 | 55 | 159 s | 28.0K | no |
| GLM Deep, after | 13 | 43 | 148 s | 40.0K | no |

A 4th Deep run without the Task Memory write cap used 102 tool calls (60 of them
`task_memory`) on GLM; that is the failure the cap removes.

Open-ended multi-layer question on one project of a larger set (a Laravel
payment API, ~3.6K tracked files, `COLLECT-GROUP/api_collectexchange`, copied to
a temporary directory): Qwen Deep, 47 turns, 70 tool calls (26 file reads, 25
terminal, 12 Task Memory), 1048 s, max context 65K of 81.9K. It followed
route → controller → service → balance mutation → external treasury provider →
webhook, found a webhook without authentication and balance mutations without
a transaction or lock, and listed what it did not inspect. A spot check of the
webhook finding against the source confirmed it.

## Known limits

- The convergence review did not fire in the runs above: models marked
  almost everything `confirmed` and never `unknown`. The mechanism is tested
  deterministically but its effect on real runs is unproven.
- GLM did not reach the backend in either mode, before or after; its Deep run
  differs from Fast mostly in cost, not depth. The change did not regress it.
- Deep runs are slower; the long COLLECT-GROUP run issued six consecutive
  reads of one large file.
- Both Qwen modes repeated a router claim taken from commit messages that the
  current source contradicts; evidence-first guidance does not stop every
  carry-over from history.

## Deep shallowness investigation (2026-10-04)

A fresh Qwen Deep run on the Online-Shop benchmark converged in about six
minutes, said it already had enough information, and left areas unverified.
The suspicion was that the later GPT-OSS-driven fixes (confirmed-evidence
validation, transactional Task Memory, flat schema, declaration-order
serialization, saved-memory replay) made Deep shallower. They were measured, not
assumed. All runs below use the same Qwen3.8-27B llama.cpp server (81.9K context)
and the same prompt, against copies of the project.

| Run | Turns | Tool calls | Task Memory writes | Time |
|---|---|---|---|---|
| 9aeef13 Deep | 14 | 37 | 6 | 495 s |
| HEAD Deep, run 1 | 14 | 29 | 3 (1 rejected) | 716 s |
| HEAD Deep, run 2 | 18 | 38 | 8 | 692 s |
| HEAD Deep, after an interrupted run, resumed from its retained state (the old Regenerate) | 5 | 11 | 1 | 397 s |
| HEAD Deep, same interrupted run, Regenerate after this change | 19 | 37 | 4 | 820 s |

Findings:

- On a clean run the current code investigates as deeply as 9aeef13 does: same
  turn and call range, same historical evidence, same use of Task Memory. No
  prompt, schema, validation, checkpoint, convergence or final-answer change was
  found to shorten a clean Deep run, so none was reverted or tuned.
- The shallow behavior reproduces when a run starts on top of retained state from
  an abandoned run. Its first reasoning is "I've gathered a lot of information",
  and it synthesizes after five turns. Before this change, Regenerate after an
  interrupted run resumed exactly that state (see below), so the observed run was
  most likely not a clean Deep run. This is the best-supported explanation; it
  is not proven to be the only contributor, because one earlier observation
  cannot be replayed.
- Both versions use Task Memory as one growing `confirmed` entry and rarely
  record `unknown`, so the convergence review rarely fires (already listed
  under Known limits). That is a property of the model's behavior with this
  guidance in both versions, not a regression. It was left alone because no
  change to the guidance was shown to improve it.
- Qwen Fast is now less fast than at 9aeef13: with the current model profile
  (`reasoning_effort: low` plus `enable_thinking: false`) Fast took 14–21 turns
  and 29–51 calls in 220–235 s, versus 6–8 turns and 24–30 calls in ~180 s
  with the old Fast options (`reasoning_effort: low`, thinking left on). The
  profile entry is shared with plain Chat. This was fixed afterwards: see
  "Fast reasoning" below.
- GLM Deep/Fast and GPT-OSS Deep/Fast completed normally on this build.

## Interrupted runs and Regenerate

State that belongs to one assistant attempt lives in three places: the
message/run rows in SQLite, the persisted plan with its Task Memory, and the
Rust agent's evidence lineage (`agent-evidence/<hash of conversation id>/`).
Task Memory and the lineage are coupled: confirmed entries must cite
observation IDs or source paths that exist in the lineage.

- **Regenerate / Edit** forget the attempt completely: the DB rows after the
  target user message, their plans and the context meter are cleared, and the
  evidence lineage is deleted, so the new run starts as if the attempt never
  happened. This also drops Task Memory from earlier completed turns of the same
  chat. That is conservative on purpose: a surviving entry would cite
  observations that no longer exist and be rejected.
- **Interrupted runs** (application closed or killed mid-run) are detected at
  startup: `analysis_runs` still `running` are set to `interrupted`, and the chat
  shows a notice instead of silently showing only the user prompt with a stale
  context meter.
- **Continue** (the user types "continue") intentionally resumes the persisted
  lineage and plan.
- **Deleting a conversation** removes its evidence lineage.
- A crash between the DB truncation and the evidence deletion leaves a stale
  lineage; the next run is then treated as a resume. The window is tiny and the
  result is the pre-fix behavior, not corruption.

## Persisted Max Context

Discovered Max Context values survive restarts. They are stored in the
`context_discoveries` table, one row per configuration key and KV mode, and
shown again (labelled "сохранено") without probing.

The key is a hash of: the discovery policy version and its numeric margins, model
id, model-file fingerprint (size and mtime), projector, runtime binary, the
stable launch arguments (everything except `--ctx-size`, KV cache types, KV
offload, host and port), speculative mode, hard limit, GPU name, total VRAM and
host reserve. Changing any of them yields a different key, so a value is never
reused for a different model, build, flags or hardware.

- A saved value is restored only when the model's launcher-managed runtime is
  running (its identity is read from the live process).
- A failed or partial probe never writes: only valid options are saved, inside
  one transaction, and invalid or corrupt rows are ignored on load. A failed
  rerun keeps the previous value and re-adopts it.
- A fresh result replaces the saved value for its KV mode; modes the rerun did
  not establish keep their last successful value.
- Restored values skip the 30-minute freshness window but not the live safety
  checks: the live memory fit and the background-VRAM-change check still run when
  one is selected, so a stale value is rejected instead of started.
- Nothing is probed automatically. The Max button remains a manual
  recalibration, and selecting a restored value remains a manual action.

## Reasoning controls (thinking, depth, strategy)

Three independent per-conversation settings replace the old single «Рассуждение» selector:

| Control | Stored as | Meaning |
|---|---|---|
| «Размышления» Вкл./Выкл. | `conversations.thinking_enabled` (nullable) | whether the model thinks (`enable_thinking`) |
| «Глубина рассуждений» Низкая/Средняя/Высокая/Максимальная | `conversations.reasoning_effort` (nullable) | how much the model thinks (`reasoning_effort`) |
| «Стратегия агента» Быстрая/Глубокая | `conversations.reasoning_mode` (`fast`/`deep`, unchanged) | how the Agent plans, verifies and closes out; Chat guidance |

The old selector mixed the first two into the strategy: Fast silently meant low effort and Deep silently meant the
strongest effort. Those mappings no longer exist for explicit choices: changing the strategy never moves thinking or
depth, and changing depth never changes the strategy.

**Capabilities are per model** (`llama-runtime-policy.ts`, `reasoning` profile), exposed to the renderer as
`ModelInfo.reasoning = {thinkingToggle, efforts[]}` with normalized ids. Native values stay in the main process:

| Model | Thinking switch | Depth levels → native `reasoning_effort` |
|---|---|---|
| Qwen3.8 27B | yes | low→`low`, medium→`medium`, max→`xhigh` |
| GLM-4.7-Flash | yes | low→`low`, max→`xhigh` |
| gpt-oss 20B | no (always thinks) | low, medium, high |

A control a model lacks is shown as «Недоступно», never as «Выкл.». The depth control is disabled while thinking is
off, and thinking off sends **no** effort. An unsupported stored depth (after switching model) is clamped to the nearest
supported level, ties going lower, so it never silently costs more than the user chose.

**Migration.** The two new columns are added lazily; `NULL` means "legacy". A legacy conversation resolves to what it
effectively had before: thinking on, Fast → lowest supported depth, Deep → highest supported depth (never a level the
model lacks). The first time the strategy is changed, both the renderer and the main process write down the
legacy-derived thinking/depth first, so the strategy change cannot move them. Existing conversations therefore behave
exactly as before until the user touches the new controls.

**Wire format.** The main process resolves the selection for every request. Chat/web-chat receive it as a
`ReasoningInput`; Agent runs get `reasoning_options = {main, final}`. The Rust loop prefers `main` for working turns and
`final` for the tool-free closing turn (which still disables thinking), and falls back to the historical `fast`/`deep`
keys when `main` is absent. Changing a control while a generation is running is refused with the existing «Дождитесь
завершения…» message; it applies to the next request, and a refused change rolls back only its own key.

A regression test iterates every runtime profile and fails if a bare strategy disables thinking or uses a
no-reasoning effort. Models without a profile entry send no reasoning options.

## Effective modes in the Context panel

The Context popover shows the **effective** Размышления, Глубина рассуждений, Стратегия агента and Mode
(Chat/Agent), not the raw selector value. Effective means the last value the main
process confirmed in the stored conversation, which is what the next request
uses. A selection that has been sent but not confirmed is shown separately as
`→ Глубокая` and is never presented as active. A control the model does not offer shows «Недоступно». If llama.cpp is starting or serving a different
model the panel adds a runtime line.

Switching Reasoning, Mode, Web or Project does not touch llama.cpp. These
`conversations:update` patches no longer wait for (or get refused by) a runtime
switch, and a refused patch rolls back only its own keys. Previously a selection
made while a runtime switch was in flight was refused with "wait for runtime
switching" and the renderer restored an older whole-conversation snapshot, which
showed as Deep jumping back to Fast.

## Graceful pause

A pause asks the Agent to stop *working* without discarding what it knows. It is different from Stop, which hard-cancels.

- **Request.** The «Пауза» button in the composer sends a steering message with the structured intent `pause`; the model
  may also classify a just-applied clarification as a pause request through the `pause_run` tool (offered only
  right after steering was applied). The button turns into «Пауза запрошена».
- **Lifecycle.** The Rust loop applies it at the next turn boundary (a tool already running finishes first). It then
  allows only the checkpoint tools (`task_memory`, `deliverables`) for at most three bounded turns, with no
  resume/continue guidance, and asks for a short summary: what is done, what is not, that work continues on request.
  The final answer is accepted without a completion review, `RunPaused` is emitted before `Final`, and the timeline
  shows «Работа на паузе».
- **Continue** is an ordinary new user message in the same conversation: the plan is restored from the saved Task Memory
  and deliverables. **Stop** keeps its hard-cancel semantics and has priority over a pending pause.

## Steering chronology

Accepting a clarification no longer inserts a timeline entry. Previously the entry was placed when the user pressed
send, although Rust only applies steering at the top of the next turn, so more reasoning from the *old* turn landed
after the clarification ("thinking… [clarification] …more old thinking"). Now the entry is renderer-only and shown last
as «Уточнение в очереди — будет передано модели на следующем шаге» until Rust emits `steering_applied`; the main
process then closes the open reasoning entry, assigns the next position and the same entry (`steering-<messageId>`)
becomes applied in place. Only applied entries are persisted in the thinking timeline.

## Task Memory contract

- **Actions.** `record` (needs `finding`), `update` (needs an existing `id`), `invalidate`, `view`. Common aliases are accepted
  (add/create→record, revise/edit→update, delete/remove→invalidate, get/list→view), as are status words (open, unresolved,
  refuted, assumed, verified).
- **Updates merge.** Fields that are not passed keep their value; an empty string clears one. A status-only or
  next-only update no longer needs `finding` and no longer wipes the other fields. Recording an id that already exists
  updates it (with a note) instead of failing or duplicating.
- **No silent creation.** An unknown id on `update`/`invalidate`, or an unknown `supersedes`, is an error that lists the
  existing ids. Auto ids (`tm-NNN`) skip numbers already used. `supersedes` now also retires the old entry when it is
  given on an update.
- **Evidence.** `evidence` may be a string or a list; `observations` is an equivalent string-array parameter. References
  are normalized to exact ids before validation: `obs-15`, `OBS-15`, `obs-00000015/0016` and `obs-15, 16` become real
  ids. A reference that names no observation is never repaired — a `confirmed` write names the bad reference and lists
  valid ones (`Valid references include: obs-… (path)`), and nothing is changed. Deep deliverable completion uses the
  same validation and message.
- **Conflicts.** The "evidence conflict" guard only triggers when a finding or evidence is being replaced, not when only
  status/next/implication change.
- **Prompt.** The handoff still shows the four most relevant entries; remaining entries are listed by id in one line
  («also stored, not shown») so the model can find and revise them.
