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
