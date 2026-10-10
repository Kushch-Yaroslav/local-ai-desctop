# Features

[English](FEATURES.md) · [Русский](../ru/FEATURES.md) · [Home](../../README.md)

## Local inference and model management

The Electron main process controls a launcher-managed `llama-server` backend and user-configured GGUF paths. The runtime supports model selection, context, KV-cache settings, CPU/GPU layer offload, optional MTP where validated, and a separately selected vision projector device. Built-in profiles provide capability hints; custom GGUFs can be added. GGUF compatibility does not imply equal tool, reasoning, or vision behavior.

## Chat and persistence

SQLite stores conversations, messages, per-chat model/runtime controls, attachments, run history, and context discovery results. Streaming output, cancellation, editing user messages, and regeneration are supported. Editing truncates downstream messages. Active Agent runs are owned by the main process and can continue when the user changes chats.

## Agent V2, planning, progress, and Task Notes

Agent orchestration runs in the Rust runtime. It handles model/tool turns, task state, progress events, verification evidence, stop/pause/steer events, and bounded action budgets. Plans expose step status. Task Notes preserve a concise objective, findings, decisions, and next step through context compaction. They are working state, not durable long-term memory.

## File and project tools

Read-only project tools list directories, find files, search text, read bounded file chunks, inspect package metadata, and inspect Git status/diff. File tools use Project 1 as their relative-path root, Project 2 as a separately identified tool scope, and can also use eligible workspace roots derived from absolute paths typed by the user in chat. Up to four explicit roots are accepted after path filtering; these are additional filesystem grants, not UI-selected projects. System roots, shallow paths, selected sensitive home directories, and paths that cannot be resolved are excluded. Traversal and symlink escapes from allowed roots are rejected, and common generated directories are skipped. `apply_patch`, file creation/write, and deletion can modify real files; delete and selected terminal operations require approval under runtime policy. `@` autocomplete and badges apply only to the two UI-selected projects.

## Git inspection and patching

Git status and diff are available as project tools. Read-only Git inspection through terminal can be automatically permitted for recognized commands. Git mutation, arbitrary command composition, and redirection are approval-gated or blocked according to policy. Patch application validates paths within the active filesystem scope, including selected project roots and eligible explicit grants. These checks reduce accidental access; they are not a general OS sandbox.

## Terminal execution and approvals

The terminal starts in Project 1, or in the first explicit workspace root when no project is selected. Its working directory does not confine every command: commands may address other locations. A classifier allows recognized low-risk diagnostics, blocks prohibited forms, and asks for approval when it cannot establish a command as safe. Process groups are tied to generation cancellation. Approval is not proof that a command is harmless: inspect the exact command before approving. Explicit paths expand file-tool access only to filtered roots, and neither path mentions nor terminal approval make arbitrary access safe.

## Web search and browser tools

The conversation setting **Web: Yes / No** enables or disables those tools for that conversation. Internally these map to stored `auto`/`off` values. Web tools include search, image search, opening and reading pages, following links, and going back. The browser uses a temporary context and implements read-oriented navigation; forms and downloads are blocked. URL and page checks, timeouts, and provider failures can reject content. These measures do not make web content trustworthy or eliminate malicious instructions embedded in pages.

## Project References and cross-project workflows

The UI supports Project 1 and optional Project 2. `@` autocomplete searches within chosen roots and message references retain the selected project identity. An eligible absolute path explicitly typed in a user message can grant the Agent file tools access to that filtered workspace root, but it does not select a project or enable `@` suggestions/badges. Runtime scope rules still apply. A practical workflow is to select a source library and destination app, reference corresponding components, ask Agent to compare interfaces, then review a patch before applying it.

## Context management and compaction

The circular indicator uses llama.cpp prompt-evaluation counts when available. Detailed status can include runtime allocation evidence and memory estimates. Find Maximum Context runs bounded real server probes: supported FP16/Q8 KV modes are restarted, health-checked, sent a probe inference, measured, and the previous runtime restored. Results are tied to model/runtime configuration and checked against current memory before use. It is an estimate and bounded search, not an exhaustive failure-boundary test.

Compaction may summarize history and tool results into retained working state so a long task can continue. It is lossy: repeated compaction can drop details, weaken reasoning, repeat work, or lead to wrong decisions. Task Notes and retained state help but do not guarantee continuity. A huge repository with a 16K context is not a recommended setup for complex autonomous coding; use a context and task scope appropriate to available memory.

## Multimodal inputs and attachments

Text, DOCX, XLS/XLSX, CSV/TSV, PDF, and image attachments are supported through local extraction or model vision. Structured tables can be read in bounded row/column pages; formulas are not evaluated. Scanned PDFs may require OCR, which is unavailable. Images use a supported vision model/projector. CPU/GPU image-processing selection applies to that image path only, not LLM placement.

## Rich Responses

The renderer can display validated metric/KPI cards, Recharts bar/line/area/pie/scatter charts, structured tables, Mermaid diagrams, sourced image galleries, and combined reports. Tables can be sorted, copied, or downloaded as CSV. Charts and Mermaid diagrams can be exported as SVG. Artifact validation checks the data shape and restricts risky Mermaid content; it cannot confirm factual accuracy. Gallery images must come from current web image-search results.

Renderer support is separate from model support. A model must produce valid structured content before the renderer can show an artifact. The author has not comprehensively retested every Rich Response format with every model listed in [Model observations](MODELS.md). Do not assume every model can generate every artifact reliably.

## Runtime metrics and controls

The toolbar can show RAM, NVIDIA VRAM/GPU utilization when available, llama.cpp state, speculative mode, generation speed, context, Thinking, reasoning effort, Agent strategy, web mode, and projects. Runtime metrics depend on backend reporting and host tools. **Pause** is cooperative: a request is handled at an Agent loop boundary, so an in-flight model request or tool call can finish first. The runtime then restricts tools to checkpoint operations, saves working state, emits a pause summary, and ends that run. Continuing requires a new user message and a fresh generation; retained Task Notes may help, but continuity is not guaranteed. **Stop** cancels the active generation and related Agent, web, or terminal activity where supported; already applied file changes are not rolled back. Agent text steering can be accepted mid-run and applied at the next model-turn boundary; Chat does not offer identical steering.

Edit and Regenerate also start fresh generations. Edit changes a user message and removes everything downstream before generating from the edited point. Regenerate removes the downstream branch from the selected user turn and generates again from the applicable conversation state. Both are guarded while an incompatible generation is active; neither continues the prior run.

## Model testing and compatibility

The application and Agent were developed and optimized primarily through extensive practical testing with Qwen3.8-27B. Other models listed in [Model observations](MODELS.md) have also been run and tested, generally less extensively. Basic text Chat was successfully used with other supported models before Rich Responses was introduced; that history does not mean every model has been retested against recent changes.

Agent workflows, tool calling, context management, and long-running tasks have received the most development and testing with Qwen3.8-27B. Weaker results on another model can reflect its capabilities, tool-call format, prompt template, runtime configuration, or less extensive application optimization; it does not by itself mean that model is broken. Generation speed benchmarks measure token throughput, not Agent reliability or reasoning quality.

## Safety boundaries and limitations

Electron renderer isolation uses `contextIsolation`, disabled `nodeIntegration`, and typed preload IPC. File tools constrain paths to selected project roots plus eligible explicit workspace grants, and reject traversal/symlink escapes. Terminal policy blocks or requests approval for classified operations, and process cancellation is managed. Web tools limit navigation and use temporary browser state.

The Agent is not a fully isolated sandbox. Approved commands and file changes affect real user data. Keep projects under version control and maintain backups. Model outputs and web content can be inaccurate or malicious; tool calling reliability varies by model. Abliterated/uncensored models deserve particular caution in autonomous workflows. Inspect plans, diffs, commands, and results.
