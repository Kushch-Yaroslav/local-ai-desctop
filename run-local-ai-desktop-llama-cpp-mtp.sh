#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/media/yaroslav/DATA/local-ai-desktop"
LLAMA_BIN="/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
saved_llama_selection() {
  local database="$APP_DIR/runtime/sqlite/local-ai-desktop.db"
  [[ -r "$database" && -x "$ELECTRON_BIN" ]] || return 0
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const row = db.prepare(\"SELECT model_id, context_window FROM conversations WHERE model_id IN ('qwen3.8:27b-q4_K_M', 'glm-4.7-flash:q4_k', 'gpt-oss:20b') ORDER BY updated_at DESC LIMIT 1\").get(); if (row) process.stdout.write(row.model_id + '\\t' + row.context_window); db.close();" "$database" 2>/dev/null || true
}

IFS=$'\t' read -r SELECTED_MODEL SAVED_CONTEXT <<< "$(saved_llama_selection)"
SELECTED_MODEL="${SELECTED_MODEL:-qwen3.8:27b-q4_K_M}"
if [[ "$SELECTED_MODEL" == "glm-4.7-flash:q4_k" ]]; then
  VARIANT="glm-4.7-flash"
  MODEL="/media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf"
  MMPROJ=""
  RUNTIME_MODEL_ID="glm-4.7-flash:q4_k"
  RUNTIME_LABEL="GLM-4.7-Flash"
  DEFAULT_LLAMA_CONTEXT=32768
elif [[ "$SELECTED_MODEL" == "qwen3.8:27b-q4_K_M" ]]; then
  VARIANT="qwen-mtp"
  MODEL="/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf"
  MMPROJ="/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf"
  RUNTIME_MODEL_ID="qwen3.8:27b-q4_K_M"
  RUNTIME_LABEL="Qwen3.8 MTP"
  DEFAULT_LLAMA_CONTEXT=32768
elif [[ "$SELECTED_MODEL" == "gpt-oss:20b" ]]; then
  printf 'gpt-oss llama.cpp runtime needs ggml-org/gpt-oss-20b-GGUF and a compatible EAGLE-3 GGUF; neither is installed.\n' >&2
  exit 2
else
  printf 'Unknown Local AI llama.cpp model: %s\n' "$SELECTED_MODEL" >&2
  exit 2
fi
PORT="8081"
URL="http://127.0.0.1:${PORT}"
LOG_DIR="$APP_DIR/runtime/logs"
LOG_FILE="$LOG_DIR/llama-cpp-mtp-launcher.log"
SERVER_LOG="$LOG_DIR/llama-cpp-mtp-server.log"
STATE_DIR="$APP_DIR/runtime"
SERVER_PID_FILE="$STATE_DIR/llama-cpp-mtp-server.pid"
LAUNCHER_PID_FILE="$STATE_DIR/llama-cpp-mtp-launcher.pid"
SANDBOX_HELPER="/opt/google/chrome/chrome-sandbox"
SERVER_PID=""
ELECTRON_PID=""
CLEANUP_REASON="normal exit"

if [[ "${LOCAL_AI_LLAMA_CONTEXT_EXTERNAL:-}" == "1" && -n "${LOCAL_AI_LLAMA_CONTEXT:-}" ]]; then
  LLAMA_CONTEXT="$LOCAL_AI_LLAMA_CONTEXT"
  CONTEXT_SOURCE="external-env"
elif [[ -n "${LOCAL_AI_LLAMA_CONTEXT:-}" && "${LOCAL_AI_LLAMA_CONTEXT_EXTERNAL:-}" != "0" ]]; then
  # First launch with an inherited value is a genuine caller override.
  LLAMA_CONTEXT="$LOCAL_AI_LLAMA_CONTEXT"
  CONTEXT_SOURCE="external-env"
  export LOCAL_AI_LLAMA_CONTEXT_EXTERNAL=1
elif [[ -n "${SAVED_CONTEXT:-}" ]]; then
  LLAMA_CONTEXT="$SAVED_CONTEXT"
  CONTEXT_SOURCE="persisted"
else
  LLAMA_CONTEXT="$DEFAULT_LLAMA_CONTEXT"
  CONTEXT_SOURCE="default"
fi
case "$LLAMA_CONTEXT" in
  16384|32768|65536|131072) ;;
  *) printf 'LOCAL_AI_LLAMA_CONTEXT must be 16384, 32768, 65536, or 131072; got %s\n' "$LLAMA_CONTEXT" >&2; exit 2 ;;
esac

mkdir -p "$LOG_DIR"
INITIAL_PATH="${PATH:-}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
timestamp() { date --iso-8601=seconds; }
log() { printf '%s %s\n' "$(timestamp)" "$*" >> "$LOG_FILE"; }
show_failure() {
  local message="$1"
  if command -v zenity >/dev/null 2>&1 && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then zenity --error --title="Local AI Desktop — llama.cpp $RUNTIME_LABEL" --text="$message\n\nЛог: $LOG_FILE" --no-wrap >/dev/null 2>&1 &
  elif command -v notify-send >/dev/null 2>&1; then notify-send "Local AI Desktop — llama.cpp $RUNTIME_LABEL" "$message\nЛог: $LOG_FILE" || true; fi
}
fail() { local message="$1"; CLEANUP_REASON="startup failure: $message"; log "launcher.error=$message"; show_failure "$message"; exit 1; }
same_llama_process() { [[ -n "$1" && -r "/proc/$1/exe" && "$(readlink -f "/proc/$1/exe")" == "$LLAMA_BIN" ]]; }
stop_llama_server() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 0
  log "llama-server.stop pid=$pid signal=TERM"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "llama-server.stop pid=$pid signal=KILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  local status=$?
  log "launcher.cleanup reason=$CLEANUP_REASON status=$status launcher_pid=$$ electron_pid=${ELECTRON_PID:-none} server_pid=${SERVER_PID:-none}"
  stop_llama_server "$SERVER_PID"
  rm -f "$SERVER_PID_FILE" "$LAUNCHER_PID_FILE"
  log "launcher.exit status=$status"
}
trap cleanup EXIT
trap 'CLEANUP_REASON="SIGINT"; exit 130' INT
trap 'CLEANUP_REASON="SIGTERM"; exit 143' TERM
trap 'CLEANUP_REASON="runtime selection changed"; [[ -n "$ELECTRON_PID" ]] && kill -TERM "$ELECTRON_PID" 2>/dev/null || true; stop_llama_server "$SERVER_PID"; [[ "${LOCAL_AI_LLAMA_CONTEXT_EXTERNAL:-}" == "1" ]] || unset LOCAL_AI_LLAMA_CONTEXT; unset LOCAL_AI_LLAMA_MODEL_ID; exec "$0"' USR1

log "===== launcher.started pid=$$ ====="
log "cwd=$(pwd) project_root=$APP_DIR initial_path=$INITIAL_PATH effective_path=$PATH display=${DISPLAY:-} wayland_display=${WAYLAND_DISPLAY:-} xdg_runtime_dir=${XDG_RUNTIME_DIR:-}"
log "context.resolve source=$CONTEXT_SOURCE value=$LLAMA_CONTEXT"
log "electron=$ELECTRON_BIN llama_server=$LLAMA_BIN variant=$VARIANT runtime_model_id=$RUNTIME_MODEL_ID model=$MODEL mmproj=${MMPROJ:-none} port=$PORT context=$LLAMA_CONTEXT"

CONTEXT_ARGS=()
GPU_LAYERS=999
KV_POLICY="gpu-f16"
if [[ "$LLAMA_CONTEXT" == "131072" ]]; then
  CONTEXT_ARGS=(--cache-type-k q8_0 --cache-type-v q8_0)
  KV_POLICY="gpu-q8"
  # Full Qwen offload has no room for its final CUDA compute buffer on the
  # 24GB 3090. Keep the Q8 KV cache on GPU and leave four target layers on CPU.
  if [[ "$VARIANT" == "qwen-mtp" ]]; then GPU_LAYERS=60; CONTEXT_ARGS+=(--spec-draft-type-k q8_0 --spec-draft-type-v q8_0); fi
fi
log "context.policy variant=$VARIANT ctx_size=$LLAMA_CONTEXT kv_policy=$KV_POLICY gpu_layers=$GPU_LAYERS"

[[ -x "$LLAMA_BIN" ]] || fail "Не найден исполняемый llama-server: $LLAMA_BIN"
[[ -f "$MODEL" ]] || fail "Не найден GGUF выбранной модели: $MODEL"
[[ -z "$MMPROJ" || -f "$MMPROJ" ]] || fail "Не найден Qwen vision projector: $MMPROJ"
[[ -x "$ELECTRON_BIN" && -f "$APP_DIR/dist/main/index.js" && -f "$APP_DIR/dist/preload/index.js" && -f "$APP_DIR/dist/renderer/index.html" ]] || fail "Не найден production build или Electron: $ELECTRON_BIN"
[[ -u "$SANDBOX_HELPER" && -x "$SANDBOX_HELPER" ]] || fail "Не найден system Chrome sandbox helper: $SANDBOX_HELPER"

if curl --silent --fail "$URL/health" >/dev/null 2>&1; then
  existing_server_pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"; existing_launcher_pid="$(cat "$LAUNCHER_PID_FILE" 2>/dev/null || true)"
  log "port.occupied port=$PORT server_pid=${existing_server_pid:-unknown} launcher_pid=${existing_launcher_pid:-unknown}"
  if same_llama_process "$existing_server_pid" && ! kill -0 "$existing_launcher_pid" 2>/dev/null; then
    log "port.stale_owned_server pid=$existing_server_pid"; stop_llama_server "$existing_server_pid"; rm -f "$SERVER_PID_FILE" "$LAUNCHER_PID_FILE"
  else
    fail "Порт $PORT уже занят. Existing llama.cpp instance не будет завершён автоматически."
  fi
fi

export NPM_CONFIG_CACHE="$APP_DIR/local-cache/npm"
export XDG_CACHE_HOME="$APP_DIR/runtime/cache"
export XDG_CONFIG_HOME="$APP_DIR/runtime/app-data"
export CHROME_DEVEL_SANDBOX="$SANDBOX_HELPER"
export ELECTRON_ENABLE_LOGGING=1
export LOCAL_AI_BACKEND="llama-cpp"
export LOCAL_AI_LLAMA_CPP_URL="$URL"
export LOCAL_AI_LLAMA_SERVER_PATH="$LLAMA_BIN"
export LOCAL_AI_LLAMA_MODEL_ID="$RUNTIME_MODEL_ID"
export LOCAL_AI_LLAMA_CONTEXT="$LLAMA_CONTEXT"
export LOCAL_AI_LLAMA_CPP_VISION=$([[ "$VARIANT" == "qwen-mtp" ]] && echo 1 || echo 0)
unset LOCAL_AI_DEV_SERVER_URL VITE_DEV_SERVER_URL
cd "$APP_DIR"
printf '%s\n' "$$" > "$LAUNCHER_PID_FILE"

: > "$SERVER_LOG"
log "llama-server.start health_wait_started=true variant=$VARIANT ctx_size=$LLAMA_CONTEXT"
if [[ "$VARIANT" == "glm-4.7-flash" ]]; then
  "$LLAMA_BIN" -m "$MODEL" --alias "$RUNTIME_MODEL_ID" --host 127.0.0.1 --port "$PORT" --ctx-size "$LLAMA_CONTEXT" --gpu-layers "$GPU_LAYERS" --flash-attn on "${CONTEXT_ARGS[@]}" --batch-size 512 --ubatch-size 512 --parallel 1 --jinja --reasoning on --no-warmup >> "$SERVER_LOG" 2>&1 &
else
  "$LLAMA_BIN" -m "$MODEL" --alias "$RUNTIME_MODEL_ID" --mmproj "$MMPROJ" --no-mmproj-offload --host 127.0.0.1 --port "$PORT" --ctx-size "$LLAMA_CONTEXT" --gpu-layers "$GPU_LAYERS" --flash-attn on --spec-type draft-mtp "${CONTEXT_ARGS[@]}" >> "$SERVER_LOG" 2>&1 &
fi
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$SERVER_PID_FILE"
log "llama-server.pid=$SERVER_PID"

for _ in $(seq 1 45); do
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -n 40 "$SERVER_LOG" >> "$LOG_FILE" || true; fail "llama-server завершился до health check. См. $SERVER_LOG"; }
  if curl --silent --fail "$URL/health" >/dev/null 2>&1; then log "health.result=ok"; break; fi
  sleep 2
done
curl --silent --fail "$URL/health" >/dev/null 2>&1 || fail "llama-server не стал готов за 90 секунд. См. $SERVER_LOG"
if [[ "$VARIANT" == "qwen-mtp" ]]; then grep -q 'creating MTP draft context' "$SERVER_LOG" || fail "MTP draft context не подтверждён. См. $SERVER_LOG"; log "mtp.confirmed=true"; fi

log "electron.start command=$ELECTRON_BIN cwd=$(pwd) backend=$LOCAL_AI_BACKEND"
"$ELECTRON_BIN" "$APP_DIR" >> "$LOG_FILE" 2>&1 &
ELECTRON_PID=$!
log "electron.pid=$ELECTRON_PID"
set +e
wait "$ELECTRON_PID"
electron_status=$?
set -e
CLEANUP_REASON="electron exited status=$electron_status"
log "electron.exit status=$electron_status"
exit "$electron_status"
