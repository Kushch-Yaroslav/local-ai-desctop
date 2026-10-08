#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -f "$fixture/launcher.sh" "$fixture/llama-cpp-runtime-state.json" "$fixture/logs/llama-cpp-mtp-launcher.log" "$fixture/stderr"; rmdir "$fixture/logs" "$fixture"' EXIT

# Exercise a failed explicit runtime dependency without loading a model or
# requiring a particular host Chrome installation.
sed '/^rm -f "$REQUEST_FILE"/i fail "Missing required runtime dependency fixture"' "$root/run-local-ai-desktop-llama-cpp-mtp.sh" > "$fixture/launcher.sh"
set +e
LOCAL_AI_APP_DIR="$root" LOCAL_AI_RUNTIME_ROOT="$fixture" LOCAL_AI_LAUNCHER_HEADLESS=1 \
  LOCAL_AI_LLAMA_CONTEXT=32768 bash "$fixture/launcher.sh" 2>"$fixture/stderr"
status=$?
set -e
[[ "$status" == 1 ]]
! grep -q 'llama-server.start ' "$fixture/logs/llama-cpp-mtp-launcher.log"
node - "$fixture/llama-cpp-runtime-state.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(state.status, 'offline', 'EXIT cleanup must not hide startup failure as stopped');
assert.equal(state.modelId, '');
assert.equal(state.contextWindow, 0);
assert.equal(state.serverPid, 0);
assert.equal(state.speculativeMode, 'none', 'a failed startup must never claim active speculation');
assert.match(state.error, /startup failure:.*Missing required runtime dependency/);
NODE
[[ ! -e "$fixture/llama-cpp-mtp-server.pid" && ! -e "$fixture/llama-cpp-mtp-launcher.pid" ]]
echo 'llama launcher failure/offline regression passed'
