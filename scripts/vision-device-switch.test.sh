#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -r -- "$fixture"' EXIT
REQUEST_FILE="$fixture/request.env"
URL=http://fixture.invalid
ACTIVE_MODEL=fixture; ACTIVE_CONTEXT=32768; ACTIVE_KV_TYPE=q8_0; ACTIVE_KV_OFFLOAD=1
ACTIVE_PROJECTOR_DEVICE=cpu; SERVER_PID=111; ELECTRON_PID=777; SERVER_PID_FILE="$fixture/server.pid"
LAUNCH_ERROR=""; launches=0; stops=0; fail_gpu=0
log() { :; }
kill() { return 0; }
curl() { return 0; }
stop_llama_server() { stops=$((stops+1)); }
write_state() { status="$1"; error="${3:-}"; rolled_back="${4:-false}"; }
launch_server() {
  launches=$((launches+1))
  if [[ "$5" == gpu && "$fail_gpu" == 1 ]]; then LAUNCH_ERROR='fixture GPU failure'; return 1; fi
  ACTIVE_MODEL="$1"; ACTIVE_CONTEXT="$2"; ACTIVE_KV_TYPE="$3"; ACTIVE_KV_OFFLOAD="$4"; ACTIVE_PROJECTOR_DEVICE="$5"; SERVER_PID=$((111+launches))
}
eval "$(sed -n '/^switch_runtime() {/,/^}/p' "$root/run-local-ai-desktop-llama-cpp-mtp.sh")"
request() { printf 'REQUEST_ID=fixture\nMODEL_ID=fixture\nCONTEXT=32768\nKV_TYPE=q8_0\nKV_OFFLOAD=1\nPROJECTOR_DEVICE=%s\n' "$1" > "$REQUEST_FILE"; }
request cpu; switch_runtime
[[ "$launches" == 0 && "$stops" == 0 && "$SERVER_PID" == 111 ]]
request gpu; switch_runtime
[[ "$launches" == 1 && "$stops" == 1 && "$ACTIVE_PROJECTOR_DEVICE" == gpu && "$ELECTRON_PID" == 777 ]]
request cpu; switch_runtime
[[ "$launches" == 2 && "$stops" == 2 && "$ACTIVE_PROJECTOR_DEVICE" == cpu && "$ELECTRON_PID" == 777 ]]
fail_gpu=1; request gpu; switch_runtime
[[ "$launches" == 4 && "$stops" == 3 && "$ACTIVE_PROJECTOR_DEVICE" == cpu && "$rolled_back" == true && "$error" == 'fixture GPU failure' ]]
[[ "$ACTIVE_MODEL" == fixture && "$ACTIVE_CONTEXT" == 32768 && "$ACTIVE_KV_TYPE" == q8_0 && "$ACTIVE_KV_OFFLOAD" == 1 && "$ELECTRON_PID" == 777 ]]
echo 'Managed projector switching: no-op, server-only restart, unchanged context/KV/Electron identity and rollback passed (mock lifecycle)'
