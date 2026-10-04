# Primary launcher startup regression: 2026-10-03

## Failure and cause

The primary checkout was clean on `v2-migration` at
`3495c4258e615fd2e7c311618bb00ac21c4275fa`. The reported PID 67325 was
**GLM-4.7-Flash at 65,536 tokens**, not Qwen. The existing launcher log records
health success at 16:10:05, followed by Electron PID 67387 aborting:

```text
FATAL:setuid_sandbox_host.cc:166
The SUID sandbox helper binary was found, but is not configured correctly.
... node_modules/electron/dist/chrome-sandbox ... owned by root ... mode 4755.
electron.exit status=133
llama-server.stop pid=67325 signal=TERM
```

A bounded reproduction through the actual primary launcher at 16:13:12
produced the same sequence: server PID 68655, health success after three
seconds, Electron PID 68703 exit 133, then launcher-owned server termination.
There was no server configuration failure or CUDA OOM.

The reinstalled adjacent Electron helper was owned by `yaroslav`, mode 755,
mtime 16:08:00. Chromium prefers this helper over `CHROME_DEVEL_SANDBOX`;
the existing environment variable alone did not select the system helper.
Reinstalling Electron restored the file that the previous setup had retired.
`apparmor_restrict_unprivileged_userns=1` was enabled. The system helper
`/opt/google/chrome/chrome-sandbox` was root-owned, mode 4755.

## Application fix

Both production launcher scripts now use `scripts/electron-sandbox.sh`.
It validates the system helper's ownership, exact mode and executable bit,
then retires the adjacent helper as `chrome-sandbox.disabled` on every launch,
including after npm reinstalls. It does not use sudo, change ownership or
disable Chromium's sandbox. Live process inspection confirmed the system
helper launching Electron's sandboxed zygote.

The llama.cpp launcher now notifies the user when Electron exits abnormally
and publishes `offline`, retaining the exit/startup cause, instead of replacing
failure with `stopped`. Normal closing and explicit launcher signals still
publish `stopped` after releasing its server and removing PID/request files.

The launcher also honors the existing application `LOCAL_AI_RUNTIME_ROOT`
override for its database, state/request/PID files, logs and XDG paths.
Without this consistency an isolated Electron instance could not use the real
launcher/controller protocol. The default remains the primary `runtime/`.

No model arguments, context policy, MTP, KV precision, offload settings,
Safe Context estimator or controller transaction semantics were changed.

## Primary-build, actual-application acceptance

A read-only SQLite `VACUUM INTO` copied the existing conversation configuration
to `runtime/validation/startup-primary/sqlite/local-ai-desktop.db`.
The primary launcher started its saved GLM 65K selection. Real Electron model
and context controls then selected Qwen at the existing saved **65,536** size.
This used `LlamaRuntimeController`, not a custom server harness.

Exact Qwen command captured from live `/proc/<pid>/cmdline`:

```sh
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server \
  --log-verbosity 5 \
  -m /media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf \
  --alias qwen3.8:27b-q4_K_M \
  --mmproj /media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf \
  --no-mmproj-offload --host 127.0.0.1 --port 8081 \
  --ctx-size 65536 --gpu-layers 999 --flash-attn on \
  --parallel 1 --spec-type draft-mtp
```

Target/draft KV stayed at the existing f16 defaults. Server PID 70082 stayed
healthy across inference and subsequent observation. A deliberate unsupported
gpt-oss request through the application's IPC/controller rejected with the
missing GGUF/EAGLE-3 cause, restored Qwen as PID 74759 at 65K, and published
`ready`, `rolledBack=true`, the real error and requested transaction ID.
The conversation's Qwen selection was not persisted as gpt-oss.
The restored server also passed health and inference.

`npm run build` ran from primary. To ensure a fresh executable rather than a
cached Cargo result, the package-specific Cargo outputs were cleaned and the
full primary build rerun. A subsequent real **Agent** composer request,
`Reply exactly PRIMARY_LAUNCHER_OK. Do not use any tools.`, returned the exact
answer `PRIMARY_LAUNCHER_OK`. Live sidecar identity during that request:

| Item | Observed value |
| --- | --- |
| Sidecar PID / parent Electron PID | 74870 / 69566 |
| `/proc/74870/exe` | `/media/yaroslav/DATA/local-ai-desktop/rust-agent/target/debug/local-ai-agent-runtime` |
| Sidecar build mtime | 2026-10-03 16:19:53.632880314 +0300 |
| Sidecar SHA256 | `81e1be032246cf010692a308087756d380efcfebcb16a76af7282d9b73dfdf5f` |
| Server executable | `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server` |
| Server SHA256 | `d7061d202c2ee116fa826963d781cef67d2b36b18805c5d81322d11ef9f52e1b` |
| Server build mtime | 2026-09-15 17:19:39.685940584 +0300 |

The sidecar hash is unchanged because no Rust source changed; its new build
timestamp and live executable resolution were independently observed.

Playwright attached to the actual launcher-created Electron window using a
temporary local-only diagnostic preload (no launcher/server bypass).
The model/mode controls, editable visible composer, enabled send button,
returned answer and post-generation controls were observed and screenshot
inspected. X11 independently reported window `0x5400004`, Electron PID 69566,
1440x920, `Normal`, `IsViewable`. `/health` returned `{"status":"ok"}` before
and after the request.

One early automation attempt sent before the model transaction's conversation
update completed and received a model mismatch. The harness was corrected to
wait for both server readiness and persisted/UI selection before proceeding.
A separate initial diagnostic preload failed before Electron bootstrap;
the new notification/offline cleanup worked. Neither failed attempt is counted
as acceptance.

## Regression checks and cleanup

Passed: primary build/typecheck; sandbox initial setup, repeat setup, simulated
npm reinstall, invalid owner/mode and non-executable-helper regressions;
actual-launcher missing-helper preflight/offline regression; existing runtime
controller switching, rollback, offline, stale-state and serialization tests;
llama.cpp backend regression; shell syntax and `git diff --check`.
`npm run test:llama-runtime` includes the new shell regressions.
Vite retains its existing large-chunk warning.

The diagnostic application was closed normally: launcher 69458, Electron 69566
and Qwen 74759 exited; state became `stopped` with zero server/model/context
and PID/request files were removed. The diagnostic port was no longer listening.
The owned diagnostic error dialog was also dismissed.

The ordinary primary launcher was then started without diagnostic instrumentation
or runtime-root override and left usable for the user:
launcher **75307**, Electron **75414**, server **75367**; saved
**GLM-4.7-Flash at 65K**, primary runtime state `ready`, health OK, mapped native
window. This preserves the user's original saved selection. Qwen acceptance
used the copied data, not newly created test conversations in the user's database.

Local evidence (logs, screenshots, `acceptance.json`, `rollback.json`, build log)
remains under ignored `runtime/validation/startup-primary/`. The observed
inference sidecar has exited; the recorded `/proc` resolution was captured
while alive. No commits, pushes, remote merges, branch changes or unrelated
process termination were performed.
