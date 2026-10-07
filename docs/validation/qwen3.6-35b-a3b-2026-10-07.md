# Qwen3.6-35B-A3B local runtime validation — 7 October 2026

This report supersedes the retired Qwen3-Coder-Next 80B selection in
[large-qwen-moe-research-2026-10-07.md](large-qwen-moe-research-2026-10-07.md).
Qwen3.8-27B and Huihui Qwen3.8-27B remain installed and selectable.

## Artifact and runtime

- Base model: [Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B), 35B total / 3B active,
  262,144-token native context, Apache 2.0.
- Local GGUF: `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`, 22,652,396,032 bytes,
  SHA-256 `0b21525e972670ed59e1812e170b27c26355381f0656ecc4e25617ece7dac58b`.
- Vision projector: `mmproj-BF16.gguf`, 902,822,528 bytes,
  SHA-256 `da63cb47a76763c712393f8a017070188a304fa39f8aeea6edc629ed7b975cfa`.
- GGUFs are pinned to `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` revision
  `5bc3e238d916f48a861bac2f8a1990a0e9b7e98d`; installed llama.cpp is
  `d1d3c3396aa13a5f239109a822666c4870490ad5`.
- Validation host: RTX 3090 24 GiB, Ryzen 7 5700X3D, 64 GiB RAM.

At the normal 65,536-token Q8_0 profile, llama.cpp reported all 42 model layers on
CUDA; `--n-cpu-moe 4` keeps expert weights for four MoE layers on the host. The
measured target allocations were 19,231.70 MiB of GPU weights, 2,371.31 MiB of
CPU-host weights, 680 MiB of target KV, 188.44 MiB of recurrent state and 210 MiB of
target compute. Embedded MTP allocated a further 68 MiB of Q8 KV and 156.27 MiB of
GPU compute. The profile also uses eight CPU threads, one sequence, flash attention,
GPU KV offload and `--fit off`; it left about 2.2 GiB free on the GPU.

MTP is embedded in the target GGUF and is confirmed by the runtime as `draft-mtp`;
the launcher supplies `--spec-draft-n-max 2`. The MTP projector limitation in the
installed llama.cpp path is handled explicitly: MTP-on does not load or advertise
vision, while MTP-off loads the verified BF16 projector. A real 128×128 red-square
image sent through the production attachment pipeline was classified as “Red” with
MTP disabled. The thinking toggle is exposed; no unsupported reasoning-effort values
are advertised.

## Prompt and decode throughput

Each row is one production-server run with a tokenizer-confirmed prompt near the
selected context size. Prompt text is the same repeated validation fixture; outputs
use the normal 70-word instruction and can have different lengths. These are
observations, not multi-run medians.

| Context | Prompt tokens | MTP-on prompt tok/s | MTP-on decode tok/s | Draft / accepted | MTP-off prompt tok/s | MTP-off decode tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16K | 15,357 | 1,241 | 99.5 | 94 / 41 | 1,275 | 101.6 |
| 32K | 31,737 | 1,219 | 98.9 | 68 / 38 | 1,254 | 93.2 |
| 64K | 64,512 | 1,164 | 86.5 | 82 / 45 | 1,208 | 78.2 |

A separate matched 64K run used the same 64,508-token prompt, temperature 0, seed
123 and a 160-token output ceiling. MTP-off decoded at 78.49 tok/s; MTP-on decoded
at 94.27 tok/s (about 20% faster), with 144 proposed and 87 accepted draft tokens.
The on/off prompt rates were 1,159.5 and 1,195.8 tok/s respectively. MTP is retained
as the default for its meaningful long-context decode gain, with the documented
vision tradeoff.

## Max Context discovery

The production app's Max Context IPC was run with live restart, health, inference,
allocation and restore checks. FP16 and Q8 results were stored independently for
each speculative configuration and survived an Electron restart. The restored
MTP-on Q8 maximum was selected again from the persisted result.

| Runtime mode | KV | Verified maximum | GPU headroom at final probe |
| --- | --- | ---: | ---: |
| Embedded MTP, vision off | FP16 | 110,592 | 500 MiB |
| Embedded MTP, vision off | Q8_0 | 167,936 | 441 MiB |
| MTP disabled, BF16 vision projector loaded | FP16 | 159,744 | 475 MiB |
| MTP disabled, BF16 vision projector loaded | Q8_0 | 258,048 | 504 MiB |

Every accepted final option passed a real inference probe and respected the runtime
memory safety policy. The MTP-off Q8 result is below the model's 262,144-token
training limit; it is not extrapolated to the full limit.

## Application checks

- A fresh isolated production Electron process rendered the empty-state “Модель не
  выбрана” and did not select the launcher's idle state as a loaded model.
- Production Chat generated `2` for `1 + 1`; production Agent used `read_file` on
  `package.json` and returned the package name and version.
- Chat Stop emitted cancellation during a long response; a subsequent Continue
  request completed with `CONTINUE_OK`.
- Production model switching succeeded through Qwen3.8 → Qwen3.6 → Huihui Qwen3.8
  → Qwen3.6, with each server healthy and the expected speculative mode reported.
- Model discovery lists exactly Qwen3.8, Qwen3.6 and Huihui Qwen3.8 as installed.

The retired 80B local directory was removed as requested. Qwen3.8 and Huihui model
files remain in place; the Qwen3.6 GGUFs are installed outside the Git repository.
