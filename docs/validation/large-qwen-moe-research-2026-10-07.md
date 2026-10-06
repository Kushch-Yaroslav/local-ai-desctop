# Large Qwen MoE selection — 7 October 2026

Selection was made before downloading the chosen weights and before registering a new local model.
Hardware: RTX 3090 24 GiB, 64 GB RAM (62.7 GiB usable), Ryzen 7 5700X3D.
The requirement is usable 65,536-token context with Q8 KV and adequate resources for ordinary desktop use.
Decode throughput is measured separately; active parameter count is not a throughput guarantee.

| Candidate | Release | Total / active | Assessment |
| --- | --- | --- | --- |
| [Qwen3-Coder-Next](https://huggingface.co/Qwen/Qwen3-Coder-Next) | February 2026 | 80B / 3B | Selected: official coding/Agent checkpoint, fits target class, supported hybrid architecture and author GGUF. |
| [Qwen3-Next-80B-A3B](https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct) | September 2025 | 80B / 3B | Older general-purpose predecessor; Coder-Next is the coding-focused choice. |
| [Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) | April 2026 | 35B / 3B | Newer coding-capable alternative, substantially easier to fit, but outside requested 70–90B class. Approximately 22.13 GB UD-Q4 weights. |
| [Qwen3.5-122B-A10B](https://huggingface.co/Qwen/Qwen3.5-122B-A10B) | February 2026 | 122B / 10B | Approximately 76.54 GB Q4 weights; insufficient safe RAM headroom after GPU placement and desktop reserves. |
| [Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) | August 2026 | 125B core + 51B n-gram embeddings / 6B active | Newer coding/Agent model; total storage is well beyond the requested class and this machine's practical Q4 capacity. |
| [ISTA-DASLab GSQ/RCO Coder conversion](https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF) | September 2026 | 117B retained total | Research conversion: pruned experts, mixed approximately 3.5-bit main weights and a separate disk-mapped n-gram table. 58.41 GB combined. Interesting alternative, but introduces pruning/quality and runtime complexity beyond the official 80B target. Not benchmarked here. |

Community `MidnightCoder-80B` and `mudler/Qwen3-Coder-Next-APEX-GGUF` were also inspected.
Their available cards did not establish a better independently validated coding successor;
the latter is a conversion of the same Coder-Next base, not a newer architecture.
Release dates above come from author announcements/cards or repository creation history where no explicit release announcement exists.

## Chosen artifact and verified capabilities

[Official Qwen GGUF](https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF), pinned revision
`b82fb7382639d97b38fa7672e526c760c2fb358e`, conventional **Q4_K_M**, four split GGUF files,
48,410,992,032 bytes total (45.09 GiB). Apache 2.0. Text-only; no projector.
Native context: 262,144; 48 hybrid blocks, 12 full-attention blocks, 36 recurrent blocks;
512 routed experts, 10 selected per token plus shared expert; hidden size 2,048.
Non-thinking checkpoint: no Thinking or native effort control is fabricated.
Use its embedded Qwen coding/tool template and the existing generic Agent conversation normalization.

Installed llama.cpp: `d1d3c3396aa13a5f239109a822666c4870490ad5`, CUDA build.
Its help/source confirm `--n-cpu-moe`, `--cpu-moe`, `--override-tensor`, Q8 K/V,
flash attention and Qwen3Next support. These are actual installed options, not inferred flags.
[Upstream Qwen3Next MTP support](https://github.com/ggml-org/llama.cpp/pull/25589)
does not imply that every checkpoint has prediction heads. This selected GGUF's metadata
has no `nextn_predict_layers`; its original configuration likewise has no MTP configuration.
No speculative capability or unrelated draft model is added merely because the architecture can support one.

## Pre-download fit estimate (not a measurement)

For the 12 full-attention layers, two KV heads, 256-dimensional keys and values,
Q8_0 block storage is 34 bytes per 32 values:

`12 × 2 × 256 × 2 × (34 / 32) × 65,536 = 855,638,016 bytes = 0.797 GiB`.

Recurrent state and compute buffers are additional fixed/runtime allocations and must be measured.
An approximately 19–20 GiB GPU weight placement leaves approximately 25–27 GiB of weights in RAM.
This can leave useful RAM headroom on the measured 62.7 GiB host; it does not establish speed.
CPU expert fetches and memory bandwidth remain important even with only 3B active parameters.
The existing 1,550 MiB absolute non-LLM cap and 384 MiB VRAM margin remain unchanged.
Standalone tests keep context at 65,536, Q8 K/V, GPU attention/KV, and vary CPU expert placement/threads.
The model is registered only after successful real allocation and meaningful-context generation measurements.
