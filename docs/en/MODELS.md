# Model observations

[English](MODELS.md) · [Русский](../ru/MODELS.md) · [Home](../../README.md)

These are author-reported observations, not independently verified benchmark results. The author's development and Agent testing centered on Qwen3.8-27B; other listed models were also run, but generally received less extensive testing. The author's development and test configuration was Linux with llama.cpp, an NVIDIA RTX 3090 (24 GB VRAM), AMD Ryzen 7 5700X3D, and 64 GB DDR4 RAM. This is not a minimum hardware requirement. Workloads, runtime builds, prompts, and measurement conditions were not standardized across rows.

| Model as reported | Configuration / observation | Generation speed |
| --- | --- | ---: |
| GPT-OSS 20B | GPT-OSS-20B MXFP4 GGUF (about 12.1 GB on disk in the historical record); reported to fit in GPU memory. “Full precision” was imprecise shorthand and does not mean FP16 weights. | ~150–170 tok/s |
| GLM-4.7-Flash | Q4_K GGUF; approximately 64K context. KV-cache type was not recorded here. | ~100 tok/s |
| Qwen3.6-35B-A3B | Q4 weights; approximately 75K context with Q8 KV cache. | ~100–115 tok/s |
| Qwen 80B Coder | Q8 KV cache; model layers split between RAM and VRAM. Exact model identifier/weight quantization needs confirmation. | ~45 tok/s |
| Gemma 4 | Approximately 64K context with FP16 KV cache. Weight precision/quantization needs confirmation. | ~35–45 tok/s |
| Devstral Small 2 24B | Q4 weights; approximately 56K context with FP16 KV cache. | ~45 tok/s |
| Qwen3.8-27B | Q4 weights; approximately 64K with FP16 KV, up to approximately 108K with FP8 KV. | ~33–38 tok/s standard; up to ~55 tok/s with MTP in some tests |

When a model is larger than available VRAM, llama.cpp can be configured to run some layers on the GPU and others on the CPU, with model data held in system RAM. This can make larger models usable, usually with a substantial speed cost.

Partial offloading is an intentional setup, distinct from a memory-exhaustion failure. The author has not tested total VRAM/RAM exhaustion, and there is no verified recovery path; model loading, memory allocation, or another runtime operation may fail.

Basic text Chat was successfully used with other supported models before Rich Responses was introduced, but not every model has been retested against all recent changes. Agent workflows, tool calling, context management, and long-running tasks received the most extensive development and testing with Qwen3.8-27B. Results with other models can vary because of model capability, tool-call compatibility, prompt templates, runtime configuration, and the amount of model-specific application optimization.

The renderer implements KPI cards, charts, tables, Mermaid diagrams, and image galleries, but the author has not comprehensively tested every format with every listed model. Renderer support does not guarantee that a model will produce valid structured content. Generation speed benchmarks measure throughput; they do not measure Agent reliability or reasoning quality.

Speed and maximum usable context vary with hardware, model architecture, weight quantization, KV-cache type, offload split, context, MTP, and workload. The Qwen3.8-27B MTP result is an observed upper case from some tests, not a guaranteed speedup. No missing hardware utilization figures are inferred here.

Weight quantization and KV-cache quantization are separate settings. For example, “Q4 weights + Q8 KV” means quantized model weights and a separately quantized KV cache. “FP16 KV” describes the cache, not necessarily the model weights. GPT-OSS precision shorthand and several incomplete model configuration details require author confirmation before making stronger claims.

These historical author tests are not the same as models currently built into the application. The current catalog IDs are `qwen3.8:27b-q4_K_M` (Qwen3.8-27B Q4_K_M), `qwen3.6:35b-a3b-ud-q4_k_m` (Qwen3.6-35B-A3B UD-Q4_K_M), and `huihui-qwen3.8:27b-ud-dw-q4_k_m` (Huihui Qwen3.8-27B UD-DW-Q4_K_M). Custom GGUFs can be configured. Built-in profiles and tested models do not imply equal depth of Agent testing; hands-on Agent development has been heavily Qwen-oriented. Tool calling, reasoning, and vision depend on model templates and runtime support.

See [Getting started](GETTING_STARTED.md) for configuration and [Features](FEATURES.md) for capability boundaries.
