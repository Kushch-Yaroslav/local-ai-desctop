# Agent execution scope and process safety

## 1. Why Agent could not execute anything

In Agent mode with no selected project the model received only `task_memory`,
`observation_index` and `observation_read`. The runtime offered file and terminal
tools only when a project root existed (`tool_schemas(has_project_root)`), so a
request like "create a folder in /some/path" had no tool that could do it. The
model reasoned correctly and reported that it had no terminal; the fault was the
harness.

## 2. Tool exposure after the fix

| Situation | Tools the model receives |
|---|---|
| Chat | none (`web` only when Web = Auto) |
| Agent, no project, no directory named by the user | `task_memory`, `observation_*`; the model is told that file/terminal tools are unavailable and why |
| Agent, no project, user named directories | the above + file tools + `run_terminal`, scoped to those directories |
| Agent, project selected (Project 1 and optionally Project 2) | all file tools, `run_terminal`, project knowledge tools, `observation_*`, `task_memory` |

Reasoning mode (Fast/Deep) never changes the tool set. The rule lives in the Rust
runtime (`ToolScope`, authoritative) and is mirrored by `enabledAgentTools` for the
Electron side; both are tested.

### Scope semantics

- **Selected project(s):** unchanged. File tools are confined to the project root;
  with two projects every call carries `project=1|2`.
- **Directories named by the user:** absolute paths the user typed in their own
  messages (`agent-workspace.ts`). Model output, tool results and file contents are
  never scanned, so a document cannot grant itself access. A named file or a
  not-yet-created path grants the directory that holds it. At most four
  directories, most recent first; without a project the first is the terminal's cwd.
- **Refused as grants:** `/`, system directories (`/etc`, `/usr`, `/var`, `/proc`,
  ...), the home directory itself, other users' homes, and credential directories
  (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`).
- **Enforcement** (`tools/filesystem.rs`): the path is resolved through the deepest
  existing ancestor with symlinks followed, then compared with the allowed roots,
  so `..` and symlink escapes are refused while nested creation works.
- **Terminal:** unchanged policy. Shell composition and session-affecting commands
  still need approval, which a non-interactive run reports as a refusal. The
  terminal is not path-confined (it never was); the scope decides *whether* it is
  offered and where it starts.
- A workspace run does not create `.ai-framework` knowledge caches.

## 3. The host-session termination incident (2026-10-04)

Twice, the whole Ubuntu graphical session was terminated: once during Part 3
testing, and again about five seconds after Copilot resumed and replayed the same
test command.

**Root cause.** `run_terminal` cancellation and timeout shelled out to
`kill -TERM -<pgid>`. procps-ng 4.0.4 does not pass that number to `kill(2)`: it
reduces it to its first digit. Any group id starting with `1` therefore became
`kill(-1, SIGTERM)`: SIGTERM to every process the user owns (Xorg, gnome-shell,
Copilot, llama-server, ...). Verified with `strace` injecting `EPERM` (`-12`,
`-123`, `-174604`, `-1000001` all issue `kill(-1, ...)`) and in a sandbox
container, where `kill -TERM -12345` signalled an unrelated process although group
12345 did not exist. The journal shows the matching mass SIGTERM (llama-server,
wireplumber, then "X connection broken"). The bug predates the Agent-capability
work: pressing Stop during a running terminal command could do this.

**Fix.** `rust-agent/src/process/group.rs` is now the only code that signals a
process.

- The shell is spawned as leader of its own session and process group.
- Signals are direct `kill(-pgid)` syscalls, never a `kill` utility.
- A target is refused if it is 0, 1, negative, out of range, or this process's or
  its parent's group/session, and unless the child is still the leader of its own
  session and group.
- Signalling happens only while the leader is running and unreaped, so its PID
  cannot belong to anyone else. There is no constructor from a bare PID/PGID:
  identifiers in persisted events are display-only and can never become a target,
  and after a restart an earlier command is simply no longer controllable.
- The TypeScript terminal (`tools/process-group.ts`) follows the same rules.
- Source-scan tests fail the build if any code shells out to `kill`, `pkill` or
  `killall`.

**Testing rule for anything that sends signals.** Run it first in a throwaway
container with its own PID namespace (`docker run --network none --user 1000`) or
under `strace -e inject=kill,tgkill,tkill:error=EPERM`, and read the logged
targets before running it natively. Never run a signal-sending test against the
desktop session.

Other termination sites were reviewed and left unchanged: the Electron main
process only `kill`s the Rust agent it spawned; the launcher script signals single,
verified llama-server PIDs with the shell builtin; the runtime controller sends
`SIGUSR1` only to a launcher whose `/proc/<pid>/cmdline` it has checked.
