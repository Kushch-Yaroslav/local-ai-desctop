# Third-party notices

Original Local AI Desktop code is licensed under the [MIT License](LICENSE), copyright (c) 2026 Yaroslav Kushch. The Jan-derived portions identified below remain subject to the applicable Apache-2.0 terms. The root MIT license does not replace those terms.

## Jan — adapted transcript and context-compaction portions

- Project: [Jan](https://github.com/janhq/jan), by Menlo Research.
- Inspected reference revision: `9925f8b6d9fab968284b4dd11566b9435229b690`.
- License: [complete Apache License 2.0 text](licenses/Apache-2.0.txt).
- Original copyright and attribution: **Copyright 2025 Menlo Research**. **This product includes software developed by Menlo Research (https://menlo.ai).**
- Jan's original license and attribution notice is preserved verbatim in [licenses/Jan-LICENSE.txt](licenses/Jan-LICENSE.txt), including its request for attribution in user-facing documentation and materials where appropriate. No separate NOTICE file was found in the inspected reference checkout.

The adaptation scope is limited to these implementations:

| Local AI Desktop implementation | Jan reference implementation | Adaptation and Local modifications |
| --- | --- | --- |
| `rust-agent/src/agent/transcript.rs`: `compaction_plan` | `src-tauri/src/core/agent/compaction.rs`: `tail_start`; `transcript.rs`: `compaction_plan` | Structural tail selection advances past tool-result batches, falls back to their owning assistant call, and requires at least two dropped messages. Local integrates this into its own compaction plan and excludes the current run's user message from the summarized span. |
| `rust-agent/src/agent/transcript.rs`: `conversation` and compaction boundary mapping | `src-tauri/src/core/agent/transcript.rs`: `conversation`, `compaction_plan` | Projects the latest summary and uncovered transcript entries with parallel source indexes. Local adds run-user and steering entries, accepted-message projection, and runtime-state delta handling. |
| `rust-agent/src/agent/loop_runtime.rs`: `CompactionBudget::trigger_tokens`, `retry_keep_recent`, and related summary-input configuration | `src-tauri/src/core/agent/compaction.rs`: `trigger_tokens`, summarization configuration; `loop.rs`: context-overflow recovery | Adapts reserve-over-ratio budgeting, the 80% default, the 48,000-character summary-input limit, and ordinary 8 → 4 → 2 recovery. Local uses its own checkpoint instructions, dynamic output ceiling and emergency fitting behavior. |

These portions were adapted and modified for Local AI Desktop by Yaroslav Kushch. This notice does not describe the entire Rust Agent V2 runtime as copied from Jan. Jan also informed the runtime's broader architectural design.

## Qwen-Agent — studied reference

[Qwen-Agent](https://github.com/QwenLM/Qwen-Agent) was studied as an architectural and tool-calling reference. The provenance audit compared local revision `31a4d36d123688581a9e9744427272b33ce940e0`, whose repository license is Apache-2.0. The compared source files identify the Qwen team, Alibaba Group as their copyright holder. No direct Qwen-Agent source-code reuse was established; this acknowledgement does not assert such reuse.

Local AI Desktop is an independent project and is not affiliated with or endorsed by Jan, Menlo Research, or Qwen-Agent.

## Other components

See also [asset attribution](assets/ATTRIBUTION.md) and the license notices accompanying bundled dependencies and Electron. This file supplements those notices and does not replace them.
