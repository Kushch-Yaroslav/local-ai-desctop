# Standalone baseline Qwen migration

2026-10-05, starting HEAD `20a2eeb6b502bc46b74fd790227ecf91aac71309`, clean `feat/local-model-refresh`; dedicated fix branch `fix/max-context-standalone-qwen`.

The model-refresh audit was rechecked. Baseline model/projector links still resolved into `/media/yaroslav/DATA/ollama/blobs`; no separate draft is required because MTP is embedded in the main GGUF. Local AI Desktop source, launchers, dependencies and the translator project have no Ollama runtime/client/data path dependency after those links are replaced. Translator still uses MarianMT and Whisper/NIM. Historical documentation and this one-shot migration script are audit references, not inference dependencies.

Only 8.37 GB was free, so a 17.74 GB full copy could not fit. The checked script stages hard links on the same filesystem, validates full SHA-256 and size, then atomically replaces each symlink. The source remains intact until the standalone files are verified and all model/projector paths are checked. Removing the original directory completes the move; the standalone regular files remain independently readable. Their mtimes remain unchanged. Paths/IDs/default restoration already used stable names under `llama-models`, so no registry path change was needed and the migration itself preserves persisted size/mtime/config keys.

| Standalone file | Bytes | SHA-256 / old blob suffix |
|---|---:|---|
| `/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf` | 16,810,714,464 | `f5f1dd8920d417aac2718b0bda3403da274301efdd6760b4f0f4b864ff2ad57d` |
| `/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf` | 931,146,016 | `ac3714bfdddeca31351f2752bf1a63f266f4df87c0b68c895e44945ca704448e` |

Both old paths were `/media/yaroslav/DATA/ollama/blobs/sha256-<suffix above>`. Both file hashes were verified before migration, in staging, after replacement, and again after source directory deletion. No registered model/projector is symlinked into Ollama anymore.

Administrator authentication was required because the blobs and install files belonged to the system Ollama user/root. `pkexec /usr/bin/python3 scripts/migrate-ollama-baseline.py --migrate-and-remove` completed successfully. It stopped and disabled `ollama.service`, removed its enablement link, and removed only these audited paths:

- `/media/yaroslav/DATA/ollama`
- `/usr/local/bin/ollama`
- `/usr/local/lib/ollama` (Ollama's private bundled libraries, not system dependencies)
- `/etc/systemd/system/ollama.service.d`
- `/etc/systemd/system/ollama.service`

`systemctl daemon-reload` completed. No dpkg package owns the manual `/usr/local` install, so no package/dependency was uninstalled. User CLI keys/history, the system user account, and unrelated user-home files were preserved. Exact deletion sizes and migration evidence: [JSON record](qwen-standalone-migration-2026-10-05.json).

The baseline files retain their original names, content and timestamps and are now owned by the local model directory owner. The later regression report records actual runtime startup/discovery after removal of Ollama.
