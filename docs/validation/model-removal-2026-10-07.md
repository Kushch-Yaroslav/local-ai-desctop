# Removal of local Gemma and Devstral choices

Performed on `feat/large-qwen-moe` after accepted V2 consolidation and validated Agent Status UI were
merged into clean `v2-migration` (`394d499e65265d89a1899f072956f0e3db3bee94`).

| Exact artifact under `/media/yaroslav/DATA/llama-models` | Bytes removed |
| --- | ---: |
| `gemma-4-31B-it-Q4_K_M.gguf` | 18,323,733,440 |
| `gemma-4-31b-mmproj-f16.gguf` | 1,198,957,024 |
| `mtp-gemma-4-31B-it-Q8_0.gguf` | 514,687,104 |
| `Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf` | 14,334,446,752 |
| `devstral-small-2-24b-mmproj-f16.gguf` | 878,054,048 |
| **Total** | **35,249,878,368** |

Immediately before deletion, each exact path resolved to itself inside the ordinary model directory;
none was a symlink. GGUF identities were inspected statically: `gemma4`, `gemma4-assistant`, `mistral3`
and their matching `clip` projectors. No wildcard or directory-tree deletion was used.

The separate user's Gemma server PID 71663 was running before this task. Before unloading, live `/slots`
reported `is_processing=false`, no Rust Agent sidecar existed, and the application's newest persisted Agent
run was completed. Its exact executable/main-model arguments were rechecked, then only that idle server
received SIGTERM. It exited gracefully. The desktop window and history stayed intact. Stale state/PID
metadata for that exact stopped server were cleared; no other process was stopped.
`fuser` then reported no use of any of the five files, including a final recheck immediately before unlink.

Preserved files have unchanged inode and byte size:

| Preserved artifact | Bytes |
| --- | ---: |
| `qwen3.8-27b-q4_K_M.gguf` | 16,810,714,464 |
| `qwen3.8-27b-mmproj.gguf` | 931,146,016 |
| `Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf` | 16,551,316,384 |
| `huihui-qwen3.8-27b-mmproj-bf16.gguf` | 931,145,888 |

Local catalog/runtime entries and their pinned Gemma/Devstral reasoning/draft metadata were removed.
Generic external-draft validation/launching, allocation fixtures from retired architectures, Max Context
policy/cache semantics, conversation normalization and failed-run cleanup remain supported.
Tests retain generic no-reasoning/toggle-only/external-draft cases instead of pinning a deleted local choice.
Historical removed-model IDs remain in startup tests to ensure stale settings/history cannot auto-load them.
Real HTTP-500/plan-update/failure-recovery tests now use the retained baseline Qwen registry identity.

Validation: all 36 current TypeScript suites and four launcher/sandbox suites passed; production build,
ESLint and both TypeScript typechecks passed. No runtime policy constants changed. The new large MoE
will be registered only after separate 64K/Q8 resource and inference measurements pass.
The model artifacts and raw filesystem audit are not tracked in Git.
