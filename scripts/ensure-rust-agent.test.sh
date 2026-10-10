#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/ensure-rust-agent.sh"
fixture="$(mktemp -d --tmpdir 'rust launch.XXXXXX')"
trap 'rm -r -- "$fixture"' EXIT
mkdir -p "$fixture/app/rust-agent/src" "$fixture/cargo/bin"
touch "$fixture/app/rust-agent/Cargo.toml" "$fixture/app/rust-agent/Cargo.lock" "$fixture/app/rust-agent/src/main.rs"
export CARGO_HOME="$fixture/cargo" RUST_LAUNCH_FIXTURE="$fixture"
cat > "$CARGO_HOME/bin/cargo" <<'SH'
#!/bin/bash
set -eu
[[ "$PWD" == "$RUST_LAUNCH_FIXTURE/app" ]]
[[ "$*" == 'build --locked --manifest-path rust-agent/Cargo.toml --target-dir rust-agent/target' ]]
printf 'build\n' >> "$RUST_LAUNCH_FIXTURE/builds"
[[ ! -f "$RUST_LAUNCH_FIXTURE/fail" ]] || exit 1
mkdir -p rust-agent/target/debug
printf '#!/bin/bash\nexit 0\n' > rust-agent/target/debug/local-ai-agent-runtime
chmod +x rust-agent/target/debug/local-ai-agent-runtime
SH
chmod +x "$CARGO_HOME/bin/cargo"
# Exercise desktop PATH without rustup, another CWD, and paths with spaces.
export PATH=/usr/bin:/bin
cd /tmp
ensure_rust_agent "$fixture/app"
binary="$fixture/app/rust-agent/target/debug/local-ai-agent-runtime"
[[ -x "$binary" && "$(wc -l < "$fixture/builds")" == 1 ]]
ensure_rust_agent "$fixture/app"
[[ "$(wc -l < "$fixture/builds")" == 1 ]]
touch -d '2 seconds ago' "$binary"
ensure_rust_agent "$fixture/app"
[[ "$(wc -l < "$fixture/builds")" == 2 ]]
chmod -x "$binary"
ensure_rust_agent "$fixture/app"
[[ -x "$binary" && "$(wc -l < "$fixture/builds")" == 3 ]]
chmod -x "$binary"
touch "$fixture/fail"
if ensure_rust_agent "$fixture/app"; then echo 'Accepted failed build' >&2; exit 1; fi
LOCAL_AI_AGENT_RUNTIME="$fixture/custom-runtime" ensure_rust_agent "$fixture/app"
ensure_rust_agent "$fixture/packaged-app"
[[ "$(wc -l < "$fixture/builds")" == 4 ]]
echo 'Rust source launcher: missing/stale/non-executable builds, fresh reuse, desktop PATH, failure, override and packaged skip passed'
