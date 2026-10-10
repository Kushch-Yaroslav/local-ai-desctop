#!/usr/bin/env bash
# Source-launch prerequisite only; packaged apps use their bundled runtime.
ensure_rust_agent() {
  local app_dir="$1" binary cargo_bin changed
  [[ -f "$app_dir/rust-agent/Cargo.toml" ]] || return 0
  # An explicitly configured runtime is owned by the caller.
  [[ -z "${LOCAL_AI_AGENT_RUNTIME:-}" ]] || return 0
  binary="$app_dir/rust-agent/target/debug/local-ai-agent-runtime"
  if [[ -x "$binary" && -f "$binary" ]]; then
    changed="$(find "$app_dir/rust-agent/src" "$app_dir/rust-agent/Cargo.toml" "$app_dir/rust-agent/Cargo.lock" -type f -newer "$binary" -print -quit)" || return 1
    [[ -n "$changed" ]] || return 0
  fi
  cargo_bin="$(command -v cargo || true)"
  # Desktop sessions often omit rustup's bin directory from PATH.
  if [[ -z "$cargo_bin" && -x "${CARGO_HOME:-$HOME/.cargo}/bin/cargo" ]]; then
    cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin/cargo"
  fi
  if [[ -z "$cargo_bin" ]]; then
    printf 'Rust Agent Runtime V2 needs a build. Install Rust/Cargo, then run npm run build:rust-agent.\n' >&2
    return 1
  fi
  printf 'Building Rust Agent Runtime V2 for local development…\n' >&2
  # Keep Cargo's output aligned with Electron even with CARGO_TARGET_DIR set.
  (cd "$app_dir" && "$cargo_bin" build --locked --manifest-path rust-agent/Cargo.toml --target-dir rust-agent/target) || return 1
  # Cargo may reuse an unchanged artifact whose executable bit was lost.
  if [[ -f "$binary" && ! -x "$binary" ]]; then chmod u+x "$binary" || return 1; fi
  [[ -f "$binary" && -x "$binary" ]] || {
    printf 'Cargo did not produce the expected executable: %s\n' "$binary" >&2
    return 1
  }
}
