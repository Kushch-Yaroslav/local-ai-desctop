# Linux installation and runtime setup

This guide describes the portability feature built on the accepted Agent V2
baseline. The README and historical validation reports have not been rewritten.
The tested distribution is **Ubuntu 24.04 x86-64**. Other distributions, ARM,
Wayland-only sessions and other GPU vendors have not been validated here.

## Install a built package

The supported artifact is `local-ai-desktop_<version>_amd64.deb`, produced in
`release/`. No package has been uploaded by this change. On a Debian/Ubuntu
desktop, install a locally built or obtained package with:

```sh
sudo apt install ./local-ai-desktop_0.1.0_amd64.deb
local-ai-desktop
```

The desktop menu entry uses the same executable. Node.js and Rust are **not**
required to run the package. Electron, application code and a static Rust Agent
helper are included; **llama.cpp, model weights and GPU drivers are external**.
Package dependencies include Electron's desktop libraries and the Bash/curl
supervisor dependencies. Install through the package manager rather than copying
the executable alone: its libraries, resources and sandbox helper belong together.

The actual `.deb` payload was extracted and launched with Electron during
validation. A privileged package-manager installation and a fresh OS installation
were not performed; see [the validation report](linux-portability-audit.md).

## Build from source

Use Node.js **24.x** (also specified by `.nvmrc`), npm **10.x or 11.x**, a stable
Rust toolchain with Cargo, and Git. Validation used Node 24.19.0, npm 11.17.0 and
Rust 1.94.1. A C/C++ linker is required by the native development build. For a
Debian/Ubuntu desktop, the development prerequisites include:

```sh
sudo apt install git build-essential curl ca-certificates libgtk-3-0 \
  libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 \
  libsecret-1-0 libgbm1 libdrm2
```

Install Node 24 using your usual version manager and install stable Rust with
[rustup](https://rustup.rs/). ALSA/CUPS runtime libraries may also be needed on a
minimal desktop; the `.deb` declares their old and `t64` package alternatives.
Do not run npm or the application as root.

```sh
git clone https://github.com/Kushch-Yaroslav/local-ai-desctop.git
cd local-ai-desctop
npm ci
npm run build
npm start
```

The repository URL's `desctop` spelling is intentional. Use a revision containing
this feature until it is accepted into the main development branch. `npm ci`
installs the locked versions, including Electron. Allow Electron and esbuild's
installation scripts; npm 11's allow-list is recorded in `package.json`.
No special npm cache directory is required.

For development with the Vite renderer and TypeScript watcher:

```sh
npm run dev
```

Both launch methods resolve resources relative to the application, independent of
the current shell directory. The application supervises its own idle llama.cpp
launcher. Starting it does **not** load the last-used model or allocate model VRAM.

To build the Debian package on x86-64 Linux:

```sh
rustup target add x86_64-unknown-linux-musl
npm run package:linux
```

This runs the production build, builds the static Rust helper, then packages
Electron using the pinned electron-builder 26.17.0. Output is in `release/`;
publishing is explicitly disabled. The first build needs network access for npm,
Cargo and Electron/builder downloads. A fresh source-only `npm ci` and production
build were tested on the validation host.

AppImage is not a supported target in this feature. The evaluated builder's
AppImage launcher automatically disables Chromium's sandbox on some restricted
hosts; the supported `.deb` preserves sandboxing instead.

## Set up llama.cpp and models

Open **«Настройка runtime»** in the sidebar footer. Missing binaries or models
appear as setup issues while the application remains usable in an idle state.
The panel is the normal configuration entry point; no source edits or example
configuration file are needed.

1. Choose an executable `llama-server`, or leave the field blank to search `PATH`.
2. Choose an existing directory for models.
3. Choose a main GGUF for at least one of the three existing model profiles.
4. Optionally choose the matching vision projector. Leave it blank for text only.
5. Set GPU layers (`999` means all available layers; `0` requests CPU placement).
6. Save, **restart the application**, then select the installed model at the top.

Change paths while no model is loaded. Saving is rejected during generation,
model selection, context discovery or an active loaded runtime. Paths such as
`~/Runtime/llama.cpp/build/bin/llama-server` and `~/Models/Qwen weights/main.gguf`
are supported. Do not add shell quotes inside input fields. Relative per-model
paths resolve against the models directory; `~` expands to your own home.
The save operation checks executable permissions, model directory existence and
readable GGUF files/split parts. Errors identify the path to correct. It cannot
prove that arbitrary weights are compatible with a model profile.

Build or obtain a llama.cpp version supporting the selected model architecture,
its Jinja/reasoning parser, `draft-mtp` and target/draft Q8 KV flags. Earlier live
validation used revision `d1d3c3396aa13a5f239109a822666c4870490ad5`; it is a
compatibility reference, not a claim that every older/newer build works. Follow
[upstream Linux build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md).
For example, after cloning llama.cpp into a directory of your choice:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j --target llama-server
```

For NVIDIA acceleration, install a compatible NVIDIA driver and CUDA toolkit,
then configure a separate build with `-DGGML_CUDA=ON` and select that build's
`bin/llama-server`. Keep its companion shared libraries in their build/installation
layout; copying just the server may cause missing-library errors. Vulkan/ROCm
builds follow upstream instructions but were not exercised in this feature.
Local AI Desktop starts the server with the existing per-model arguments; it is
not necessary to start a second server manually.

The selector still contains exactly these supported profiles:

| Profile | GGUF setup |
| --- | --- |
| Qwen3.8-27B | Compatible Q4_K_M GGUF with the profile's embedded MTP support; optional matching Qwen projector. [Publisher's GGUF conversion](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) is a download starting point; fresh weights were not runtime-tested here. Existing installations keep their files. |
| Qwen3.6-35B-A3B | [Unsloth MTP release](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF): `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`; optional `mmproj-BF16.gguf`. |
| Huihui Qwen3.8-27B (abliterated) | [Author's GGUF release](https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF): `Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf`; matching BF16 projector if using images. |

Obtain weights from their publisher/compatible GGUF converter, keep all split
parts together, and respect their licenses. Each profile's GGUF field accepts
the downloaded filename; renaming downloads to match defaults is unnecessary.
For the baseline Qwen3.8, verify that the chosen conversion retains MTP tensors;
the previous local baseline came from an existing installation rather than a
fresh download validated in this change. This feature does not add arbitrary
models or certify other quantizations. The retired Coder-Next profile is absent.

The existing Thinking/MTP controls and restrictions remain in force. For example,
the Qwen3.6 MTP-on path is text only; its projector is used with MTP off, as recorded
in [the accepted runtime validation](validation/qwen3.6-35b-a3b-2026-10-07.md).

These are large models (roughly 16–23 GB of weights, plus runtime memory). Start
with a context appropriate for your RAM/VRAM rather than assuming another host's
maximum. GPU telemetry and measured **Max Context** discovery currently require
one NVIDIA GPU and `nvidia-smi`; CPU/non-NVIDIA inference configuration does not
provide equivalent measured discovery. Changing the CPU/GPU placement changes
memory needs. No GPU matrix or real-model benchmark was run for this feature.

## User data and existing installations

Fresh installs honor absolute XDG directory overrides, with these defaults:

| Resource | Default |
| --- | --- |
| Runtime settings | `~/.config/local-ai-desktop/runtime-settings.json` |
| SQLite conversations, plans, deliverables, context discoveries | `~/.local/share/local-ai-desktop/sqlite/local-ai-desktop.db` |
| Attachments and runtime protocol files | Under `~/.local/share/local-ai-desktop/` |
| Electron user data | `~/.local/share/local-ai-desktop/app-data/` |
| Cache | `~/.cache/local-ai-desktop/` |
| Application/server/supervisor logs | `~/.local/state/local-ai-desktop/logs/` |
| Default model directory | `~/.local/share/local-ai-desktop/models/` |

Paths are shown in the setup panel. Runtime settings have one atomic JSON file,
written by the settings UI with mode `0600`. Conversations/discovery state remain
in the existing SQLite schema. User-selected projects remain native directory
selections stored with conversations, independent of application installation.

A source installation with an existing `runtime/sqlite/local-ai-desktop.db`
continues using **that entire runtime directory** in place, preserving attachments,
evidence paths, discovery values and Electron data. An existing sibling
`llama-models` directory and `llama.cpp/build-cuda/bin/llama-server` are recognized
as legacy defaults; they are optional, not required layouts.

For an installed package to use an old checkout's data, close both applications,
back up the whole old runtime directory (including SQLite journals), and launch:

```sh
LOCAL_AI_RUNTIME_ROOT="/path/to/old checkout/runtime" local-ai-desktop
```

This explicit override keeps settings, logs, cache and data under that chosen
root. Alternatively copy the whole backed-up layout into the new data directory
while the application is closed. The package cannot discover an arbitrary old
checkout automatically. Configure executable/model paths in its setup panel.
No data files or weights are moved/deleted automatically.

Advanced overrides retained for scripting are `LOCAL_AI_RUNTIME_ROOT`,
`LOCAL_AI_LLAMA_SERVER_PATH` (default before saved settings),
`LOCAL_AI_LLAMA_PORT` (default `8081`) and `LOCAL_AI_AGENT_RUNTIME` (optional helper
override). Saved UI paths take precedence over the default server environment
value. Do not set launcher-owned internal variables for ordinary installation.

## Troubleshooting

- **Missing llama-server/models:** open the setup panel. Check executable rights
  (`chmod +x` for a binary you own), GGUF selection and every split part. Models
  are deliberately not shipped or loaded at first launch.
- **Runtime exits after selection:** inspect `llama-cpp-mtp-server.log` and
  `llama-cpp-mtp-launcher.log` in the displayed log location. Unsupported MTP/KV
  flags, missing CUDA/shared libraries and insufficient memory are runtime errors;
  install a compatible build or choose lower memory settings. The launcher still
  requires observed health/model/context/MTP confirmation.
- **Port occupied:** the supervisor preserves an unowned server. Quit that other
  service or launch with `LOCAL_AI_LLAMA_PORT=8082`; app and supervisor share this
  port. Do not run two independent launchers against the same data directory.
- **Corrupt settings:** the setup panel reports the file and permits recovery.
  With the app closed, back up/rename only `runtime-settings.json`, then reopen and
  configure it again. Do not delete the conversation database.
- **Data directory denied/read-only:** use a writable XDG location or
  `LOCAL_AI_RUNTIME_ROOT`; a startup dialog identifies directory-creation errors.
- **Chromium sandbox startup failure:** use the installed `.deb` helper or a
  distribution-supported user-namespace setup. Development launchers can use
  `LOCAL_AI_CHROME_SANDBOX=/path/to/chrome-sandbox`, which must be trusted,
  root-owned and mode `4755`. Chromium/Chrome helpers are optional fallbacks;
  Google Chrome is not an application requirement. Do not disable sandboxing.
- **Missing Agent helper in a source checkout:** run `npm run build:rust-agent`.
  The packaged app uses its included static helper, independent of current directory.
- **Unsupported host/GPU:** x86-64 Debian packaging is the tested scope. Telemetry
  unavailable on another GPU is not proof that model inference was validated there.

Historical one-shot migration scripts are development records, **not installers**.
Do not run `scripts/migrate-ollama-baseline.py` for public setup; it makes obsolete,
machine-specific changes and is excluded from the packaged application.
