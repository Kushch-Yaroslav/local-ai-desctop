#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d --tmpdir 'linux-launch space.XXXXXX')"
launcher_pid=""
cleanup() {
  if [[ -n "$launcher_pid" ]]; then kill -TERM "$launcher_pid" 2>/dev/null || true; wait "$launcher_pid" || true; fi
  rm -r -- "$fixture"
}
trap cleanup EXIT
# Missing dependencies open an idle setup state; an explicit selection reports
# its cause without allocating anything. Launch from outside the repository.
cd "$fixture"
LOCAL_AI_APP_DIR="$root" LOCAL_AI_LLAMA_SERVER_PATH="$fixture/missing llama server" \
  LOCAL_AI_RUNTIME_ROOT="$fixture/user data" LOCAL_AI_LAUNCHER_HEADLESS=1 LOCAL_AI_LLAMA_PORT=18092 \
  bash "$root/run-local-ai-desktop-llama-cpp-mtp.sh" >"$fixture/stdout" 2>"$fixture/stderr" &
launcher_pid=$!
for _ in {1..100}; do
  [[ -f "$fixture/user data/llama-cpp-runtime-state.json" ]] && break
  sleep 0.05
done
node - "$fixture/user data/llama-cpp-runtime-state.json" <<'NODE'
const assert=require('node:assert/strict'), fs=require('node:fs');
const state=JSON.parse(fs.readFileSync(process.argv[2]));
assert.equal(state.status,'idle'); assert.equal(state.modelId,''); assert.equal(state.serverPid,0);
NODE
printf 'REQUEST_ID=setup-test\nMODEL_ID=qwen3.8:27b-q4_K_M\nCONTEXT=32768\nKV_TYPE=f16\nKV_OFFLOAD=1\n' > "$fixture/user data/llama-cpp-runtime-request.env"
# Force a missing weight instead of the developer's optional adjacent files.
mkdir -p "$fixture/user data/app-data" "$fixture/empty models"
printf '{"modelsPath":"%s"}\n' "$fixture/empty models" > "$fixture/user data/app-data/runtime-settings.json"
kill -USR1 "$launcher_pid"
for _ in {1..100}; do
  if grep -q '"status":"offline".*setup-test\|"requestId":"setup-test".*"error":"[^\"]' "$fixture/user data/llama-cpp-runtime-state.json"; then break; fi
  sleep 0.05
done
node - "$fixture/user data/llama-cpp-runtime-state.json" <<'NODE'
const assert=require('node:assert/strict'),fs=require('node:fs');
const state=JSON.parse(fs.readFileSync(process.argv[2]));
assert.equal(state.status,'offline'); assert.equal(state.requestId,'setup-test');
assert(state.error.length>0); assert.equal(state.serverPid,0); assert.equal(state.speculativeMode,'none');
NODE
kill -TERM "$launcher_pid"; wait "$launcher_pid" || [[ "$?" == 143 ]]; launcher_pid=""
[[ ! -f "$fixture/user data/llama-cpp-mtp-launcher.pid" ]]
echo 'Portable launcher: relocated CWD, paths with spaces, missing dependencies, idle startup, explicit-selection error and graceful cleanup passed'
