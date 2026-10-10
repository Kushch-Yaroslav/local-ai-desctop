# Local AI Desktop — Local LLM Chat & Coding Agent for Linux

[English](README.md) · [Русский](README.ru.md)

Local AI Desktop is an experimental Linux AI desktop application for chatting with local LLMs and working with code through an AI Agent. It provides local inference for GGUF models through llama.cpp, with an Electron interface and a Rust coding Agent runtime.

**Download:** Get the Linux x86_64 `.deb` for **v0.1.0 — Experimental Alpha (Pre-release)** from [GitHub Releases](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases). See the [Getting Started guide](docs/en/GETTING_STARTED.md) for installation and the required external `llama-server` and GGUF model files.

![Local AI Desktop main interface](docs/img/interface/1-e.png)

Use **Chat** for everyday questions and **Agent** for project-aware research and coding tasks. Choose up to two projects, reference files with `@`, manage context, attach documents or images, and optionally enable read-only web search. For a one-off location, you can provide an absolute path in chat; eligible paths add a filtered Agent file-tool scope but do not become a selected project or gain `@` suggestions. Agent tools can inspect files and Git state, propose changes, and run commands under runtime scope and approval policies.

## Screenshots

**Chat and model controls**

![Chat interface, selected model and toolbar](docs/img/interface/2-e.png)

**Rich Responses with cards and an interactive chart**

![Rich response example](docs/img/interface/4-e.png)

**Agent progress and context details**

![Active Agent run](docs/img/interface/6-e.png)

## Recommended settings

- **Model:** Start with **Qwen3.8-27B Q4_K_M**. It is the author's primary development and testing model, not a universal best choice.
- **Context:** For complex Agent work, a larger window can keep more history, source files, and tool results in view. That can reduce repeated investigation and compaction, but it does not increase token generation speed. It uses more RAM/VRAM and can take longer to process prompts. Pick the largest practical size that remains stable for your hardware and workload. **Find Maximum Context** can measure a bounded, safe configuration; see the [User Guide](docs/en/USER_GUIDE.md#find-maximum-context).
- **Reasoning:** Start with moderate Thinking / Reasoning effort where the model supports it, and use the Agent's **Fast** strategy for routine work. Thinking controls model-specific behavior; Fast/Deep controls a separate part of Agent execution. Increase effort or choose Deep when a task needs it; maximum effort is not necessary every time.

> **Qwen3.8 xHigh note:** The author has seen Qwen3.8-27B with Thinking and xHigh reasoning spend a very long time reasoning; complex tasks have taken about an hour in some cases. This is an observation, not a benchmark or expected duration. Long reasoning alone does not mean the app is frozen, but check progress, tool activity, and runtime status. xHigh does not guarantee a better answer. Use lower or medium effort for ordinary requests. [Details](docs/en/USER_GUIDE.md#qwen38-and-xhigh-reasoning).

## Model testing and limitations

Development and Agent optimization have focused most heavily on Qwen3.8-27B. Basic text chat has also worked with other supported models since before Rich Responses, but not every model has been retested against recent changes.

Agent reliability varies with model capability, tool-call compatibility, prompt template, runtime settings, and how extensively the app has been tuned for that model. Rich Responses is newer: the renderer supports charts, KPI cards, tables, Mermaid diagrams, and image galleries, but the author has not tested every format with every listed model. Rendering support does not guarantee that a model will produce valid structured content. Generation speed figures do not measure Agent reliability or reasoning quality. See [model observations](docs/en/MODELS.md) and [feature details](docs/en/FEATURES.md).

Agent is not fully isolated: file changes and approved terminal commands can affect real data. Use version control and backups. Local models and web content can also be inaccurate or malicious.

## Requirements and quick start

**Verified:** The Local AI Desktop v0.1.0 Linux amd64 `.deb` was successfully installed and first-run smoke-tested on the developer's Ubuntu 24.04 x86_64 machine. After setup and UI fixes, the installed application was repeatedly tested with fresh, isolated XDG configuration, data, and cache profiles. The final test confirmed installation and launch, initial configuration, selecting and validating the `llama-server` executable, model selection, and successful application startup.

**Not verified:** Installation on a completely fresh operating system, other Linux distributions, other hardware configurations, or general compatibility. A compatible `llama-server` and local GGUF weights are required; neither is bundled with the package. If a model does not fit in VRAM, configured CPU/RAM offloading may let it run more slowly. Total memory exhaustion can instead cause a model or runtime failure; recovery is not guaranteed.

The author's development and test machine is an NVIDIA RTX 3090 (24 GB VRAM), AMD Ryzen 7 5700X3D, and 64 GB DDR4 RAM on Linux with llama.cpp. This is not a minimum hardware requirement.

[Getting started](docs/en/GETTING_STARTED.md) · [User guide](docs/en/USER_GUIDE.md) · [Features](docs/en/FEATURES.md) · [Models](docs/en/MODELS.md) · [Roadmap](docs/en/ROADMAP.md)

## Project status

Local AI Desktop is an actively developed personal project that I use and test on my own computer. The core workflows work in my tested setup, where Qwen3.8-27B is my primary development and testing model. I have tested other models too, but less extensively. Compatibility and stability across other models, hardware setups, and Linux distributions still need broader testing, and bugs or unexpected behavior are possible. Some newer features, especially Rich Responses across different models, need more testing. Feedback is welcome.

Found a bug or have an idea for improvement? Feel free to open a [GitHub Issue](https://github.com/Kushch-Yaroslav/local-ai-desktop/issues).

## Acknowledgements

Parts of Local AI Desktop's transcript and context-compaction implementation were adapted from [Jan](https://github.com/janhq/jan) by Menlo Research (Apache-2.0). [Qwen-Agent](https://github.com/QwenLM/Qwen-Agent) was also studied as a reference for agent and tool-calling behavior. Local AI Desktop is an independent project and is not affiliated with or endorsed by either project. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Author

**Yaroslav Kushch** — Independent Developer, Zaporizhzhia, Ukraine. · [LinkedIn](https://www.linkedin.com/in/yaroslav-kushch-5b937b378) · [Telegram](https://t.me/fivElemen) · [Email](mailto:malborodo123@gmail.com)

## License

Original Local AI Desktop code is licensed under the [MIT License](LICENSE). Adapted Jan portions are subject to Apache-2.0; see [third-party notices](THIRD_PARTY_NOTICES.md). Third-party components may have separate terms; see [attribution](assets/ATTRIBUTION.md) and their respective license notices.
