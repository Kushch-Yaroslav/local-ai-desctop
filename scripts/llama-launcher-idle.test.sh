#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
launcher_pid=""
cleanup() {
  if [[ -n "$launcher_pid" ]]; then kill -TERM "$launcher_pid" 2>/dev/null || true; wait "$launcher_pid" 2>/dev/null || true; fi
  # The fixture is created here and contains only this test's artifacts.
  rm -r -- "$fixture"
}
trap cleanup EXIT
mkdir -p "$fixture/sqlite"
node - "$fixture/sqlite/local-ai-desktop.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
db.exec('CREATE TABLE conversations (model_id TEXT, context_window INTEGER, llama_kv_cache_type TEXT, llama_kv_offload INTEGER, updated_at TEXT)');
db.prepare('INSERT INTO conversations VALUES (?,81920,\'q8_0\',1,\'2026-10-06\')').run('gemma4:31b-it-q4_k_m');
db.close();
NODE
# Instrument only the server executable: any attempted launch fails the test.
cat > "$fixture/server" <<SHIM
#!/bin/bash
printf 'unexpected model allocation\n' > "$fixture/unexpected-launch"
exit 1
SHIM
chmod +x "$fixture/server"
sed "s|^LLAMA_BIN=.*|LLAMA_BIN=\"$fixture/server\"|" "$root/run-local-ai-desktop-llama-cpp-mtp.sh" > "$fixture/launcher.sh"
for previous_model in qwen3.8:27b-q4_K_M huihui-qwen3.8:27b-ud-dw-q4_k_m devstral-small-2:24b-q4_k_m gemma4:31b-it-q4_k_m; do
  LOCAL_AI_RUNTIME_ROOT="$fixture" LOCAL_AI_LAUNCHER_HEADLESS=1 LOCAL_AI_LLAMA_PORT=18091 \
    LOCAL_AI_LLAMA_MODEL_ID="$previous_model" LOCAL_AI_LLAMA_CONTEXT=81920 \
    bash "$fixture/launcher.sh" > "$fixture/stdout" 2> "$fixture/stderr" &
  launcher_pid=$!
  for _ in {1..100}; do
    if [[ -f "$fixture/llama-cpp-runtime-state.json" ]] && grep -q '"status":"idle"' "$fixture/llama-cpp-runtime-state.json"; then break; fi
    sleep 0.05
  done
  kill -0 "$launcher_pid"
  node - "$fixture/llama-cpp-runtime-state.json" <<'NODE'
const assert = require('node:assert/strict'); const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(state.status, 'idle'); assert.equal(state.modelId, '');
assert.equal(state.contextWindow, 0); assert.equal(state.serverPid, 0);
assert.equal(state.speculativeMode, 'none'); assert.equal(state.error, '');
NODE
  [[ ! -e "$fixture/unexpected-launch" && ! -e "$fixture/llama-cpp-mtp-server.pid" ]]
  ! grep -q 'llama-server.start ' "$fixture/logs/llama-cpp-mtp-launcher.log"
  kill -TERM "$launcher_pid"; wait "$launcher_pid" || [[ "$?" == 143 ]]; launcher_pid=""
done
echo 'fresh launcher remains idle with persisted 81920 context and all four inherited model IDs (4/4 passed)'
