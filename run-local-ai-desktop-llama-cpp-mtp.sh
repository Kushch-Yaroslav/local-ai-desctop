#!/usr/bin/env bash
# Local AI Desktop launcher for llama.cpp.
#
# Owns exactly two things: one llama-server and one Electron process. A model or
# context change is a transaction on the server only:
#   current healthy runtime -> stop -> start requested runtime -> verify it
#   stays alive, is healthy and reports the requested alias and n_ctx -> publish.
# A failed start is published with its real cause and the previous runtime is
# restored when possible. Electron is never restarted by a runtime change.
#
# Protocol files (runtime/):
#   llama-cpp-runtime-request.env  written by Electron: REQUEST_ID, MODEL_ID, CONTEXT
#   llama-cpp-runtime-state.json   written here: the only authority on what runs
set -euo pipefail

APP_DIR="/media/yaroslav/DATA/local-ai-desktop"
LLAMA_BIN="/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
PORT="8081"
URL="http://127.0.0.1:${PORT}"
LOG_DIR="$APP_DIR/runtime/logs"
LOG_FILE="$LOG_DIR/llama-cpp-mtp-launcher.log"
SERVER_LOG="$LOG_DIR/llama-cpp-mtp-server.log"
STATE_DIR="$APP_DIR/runtime"
SERVER_PID_FILE="$STATE_DIR/llama-cpp-mtp-server.pid"
LAUNCHER_PID_FILE="$STATE_DIR/llama-cpp-mtp-launcher.pid"
REQUEST_FILE="$STATE_DIR/llama-cpp-runtime-request.env"
STATE_FILE="$STATE_DIR/llama-cpp-runtime-state.json"
SANDBOX_HELPER="/opt/google/chrome/chrome-sandbox"
HEALTH_TIMEOUT_SECONDS=150

SERVER_PID=""
ELECTRON_PID=""
CLEANUP_REASON="normal exit"
ACTIVE_MODEL=""
ACTIVE_CONTEXT=""
LAUNCH_ERROR=""
REQUEST_CONTEXT_FOR_ERROR=""
VARIANT=""; MODEL=""; MMPROJ=""; RUNTIME_MODEL_ID=""; RUNTIME_LABEL=""; DEFAULT_LLAMA_CONTEXT=""

mkdir -p "$LOG_DIR"
INITIAL_PATH="${PATH:-}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
timestamp() { date --iso-8601=seconds; }
log() { printf '%s %s\n' "$(timestamp)" "$*" >> "$LOG_FILE"; }

saved_llama_selection() {
  local database="$APP_DIR/runtime/sqlite/local-ai-desktop.db"
  [[ -r "$database" && -x "$ELECTRON_BIN" ]] || return 0
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const row = db.prepare(\"SELECT model_id, context_window FROM conversations WHERE model_id IN ('qwen3.8:27b-q4_K_M', 'glm-4.7-flash:q4_k', 'gpt-oss:20b') ORDER BY updated_at DESC LIMIT 1\").get(); if (row) process.stdout.write(row.model_id + '\\t' + row.context_window); db.close();" "$database" 2>/dev/null || true
}

# Sets the launch variables for a model id. Fails for a model without a runtime.
select_variant() {
  case "$1" in
    glm-4.7-flash:q4_k)
      VARIANT="glm-4.7-flash"; MODEL="/media/yaroslav/DATA/llama-models/GLM-4.7-Flash-Q4_K.gguf"; MMPROJ=""
      RUNTIME_MODEL_ID="glm-4.7-flash:q4_k"; RUNTIME_LABEL="GLM-4.7-Flash"; DEFAULT_LLAMA_CONTEXT=32768 ;;
    qwen3.8:27b-q4_K_M)
      VARIANT="qwen-mtp"; MODEL="/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf"
      MMPROJ="/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf"
      RUNTIME_MODEL_ID="qwen3.8:27b-q4_K_M"; RUNTIME_LABEL="Qwen3.8 MTP"; DEFAULT_LLAMA_CONTEXT=32768 ;;
    gpt-oss:20b)
      LAUNCH_ERROR="gpt-oss llama.cpp runtime needs ggml-org/gpt-oss-20b-GGUF and a compatible EAGLE-3 GGUF; neither is installed."; return 1 ;;
    *)
      LAUNCH_ERROR="Unknown Local AI llama.cpp model: $1"; return 1 ;;
  esac
}
valid_context() { case "$1" in 16384|32768|65536|131072) return 0 ;; *) return 1 ;; esac; }

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}
# write_state <status> [request_id] [error] [rolled_back]
# The state is written to a temporary file and renamed so a reader never sees a
# partial document.
write_state() {
  local status="$1" request_id="${2:-}" error="${3:-}" rolled_back="${4:-false}"
  local tmp="$STATE_FILE.$$.tmp"
  printf '{"status":"%s","requestId":"%s","modelId":"%s","contextWindow":%s,"serverPid":%s,"launcherPid":%s,"error":"%s","rolledBack":%s,"updatedAt":"%s"}\n' \
    "$status" "$(json_escape "$request_id")" "$(json_escape "$ACTIVE_MODEL")" "${ACTIVE_CONTEXT:-0}" "${SERVER_PID:-0}" "$$" \
    "$(json_escape "$error")" "$rolled_back" "$(timestamp)" > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

show_failure() {
  local message="$1"
  [[ "${LOCAL_AI_LAUNCHER_HEADLESS:-}" == "1" ]] && return 0
  if command -v zenity >/dev/null 2>&1 && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then zenity --error --title="Local AI Desktop — llama.cpp ${RUNTIME_LABEL:-}" --text="$message\n\nЛог: $LOG_FILE" --no-wrap >/dev/null 2>&1 &
  elif command -v notify-send >/dev/null 2>&1; then notify-send "Local AI Desktop — llama.cpp ${RUNTIME_LABEL:-}" "$message\nЛог: $LOG_FILE" || true; fi
}
fail() { local message="$1"; CLEANUP_REASON="startup failure: $message"; log "launcher.error=$message"; ACTIVE_MODEL=""; ACTIVE_CONTEXT=0; write_state offline "" "$message" || true; show_failure "$message"; exit 1; }
same_llama_process() { [[ -n "$1" && -r "/proc/$1/exe" && "$(readlink -f "/proc/$1/exe")" == "$LLAMA_BIN" ]]; }

stop_llama_server() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 0
  log "llama-server.stop pid=$pid signal=TERM"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "llama-server.stop pid=$pid signal=KILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

# A new model must not be loaded while the previous process's VRAM is still
# being returned to the driver: Qwen with MTP at 64K leaves well under 1 GiB free.
wait_for_gpu_release() {
  command -v nvidia-smi >/dev/null 2>&1 || return 0
  local previous="" current=""
  for _ in $(seq 1 40); do
    current="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ' || true)"
    [[ -n "$current" && "$current" == "$previous" ]] && return 0
    previous="$current"
    sleep 0.5
  done
}

# The most informative failure lines of the last server start, as one sentence.
server_failure_reason() {
  local detail=""
  if grep -aqi 'out of memory' "$SERVER_LOG" 2>/dev/null; then
    detail="недостаточно видеопамяти (CUDA out of memory) для $RUNTIME_LABEL с контекстом ${REQUEST_CONTEXT_FOR_ERROR}; закройте приложения, использующие GPU, или выберите меньший контекст"
  else
    detail="$(grep -a ' E ' "$SERVER_LOG" 2>/dev/null | tail -n 3 | sed -E 's/^[0-9.]+ [A-Z] //' | tr '\n' ' ' || true)"
    [[ -n "$detail" ]] || detail="llama-server завершился до готовности"
  fi
  printf '%s' "$detail"
}

# launch_server <model_id> <context>
# Success means: the process is alive, /health is ok, /v1/models reports the
# requested alias with exactly the requested n_ctx, and (MTP) the draft context
# exists. Anything else stops the process and leaves LAUNCH_ERROR.
launch_server() {
  local model_id="$1" context="$2"
  LAUNCH_ERROR=""; REQUEST_CONTEXT_FOR_ERROR="$context"
  select_variant "$model_id" || return 1
  valid_context "$context" || { LAUNCH_ERROR="Неподдерживаемый размер контекста llama.cpp: $context"; return 1; }
  [[ -x "$LLAMA_BIN" ]] || { LAUNCH_ERROR="Не найден исполняемый llama-server: $LLAMA_BIN"; return 1; }
  [[ -f "$MODEL" ]] || { LAUNCH_ERROR="Не найден GGUF выбранной модели: $MODEL"; return 1; }
  [[ -z "$MMPROJ" || -f "$MMPROJ" ]] || { LAUNCH_ERROR="Не найден Qwen vision projector: $MMPROJ"; return 1; }

  local context_args=() gpu_layers=999 kv_policy="gpu-f16"
  if [[ "$context" == "131072" ]]; then
    context_args=(--cache-type-k q8_0 --cache-type-v q8_0)
    kv_policy="gpu-q8"
    # Full Qwen offload has no room for its final CUDA compute buffer on the
    # 24GB 3090. Keep the Q8 KV cache on GPU and leave four target layers on CPU.
    if [[ "$VARIANT" == "qwen-mtp" ]]; then gpu_layers=60; context_args+=(--spec-draft-type-k q8_0 --spec-draft-type-v q8_0); fi
  fi
  log "context.policy variant=$VARIANT ctx_size=$context kv_policy=$kv_policy gpu_layers=$gpu_layers"
  wait_for_gpu_release

  : > "$SERVER_LOG"
  log "llama-server.start variant=$VARIANT runtime_model_id=$RUNTIME_MODEL_ID ctx_size=$context model=$MODEL mmproj=${MMPROJ:-none}"
  if [[ "$VARIANT" == "glm-4.7-flash" ]]; then
    "$LLAMA_BIN" -m "$MODEL" --alias "$RUNTIME_MODEL_ID" --host 127.0.0.1 --port "$PORT" --ctx-size "$context" --gpu-layers "$gpu_layers" --flash-attn on "${context_args[@]}" --batch-size 512 --ubatch-size 512 --parallel 1 --jinja --reasoning on --no-warmup >> "$SERVER_LOG" 2>&1 &
  else
    "$LLAMA_BIN" -m "$MODEL" --alias "$RUNTIME_MODEL_ID" --mmproj "$MMPROJ" --no-mmproj-offload --host 127.0.0.1 --port "$PORT" --ctx-size "$context" --gpu-layers "$gpu_layers" --flash-attn on --parallel 1 --spec-type draft-mtp "${context_args[@]}" >> "$SERVER_LOG" 2>&1 &
  fi
  SERVER_PID=$!
  printf '%s\n' "$SERVER_PID" > "$SERVER_PID_FILE"
  log "llama-server.pid=$SERVER_PID"

  local waited=0 healthy=0
  while (( waited < HEALTH_TIMEOUT_SECONDS )); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      tail -n 40 "$SERVER_LOG" >> "$LOG_FILE" || true
      LAUNCH_ERROR="llama-server завершился до health check: $(server_failure_reason)"
      SERVER_PID=""; rm -f "$SERVER_PID_FILE"
      return 1
    fi
    if curl --silent --fail "$URL/health" >/dev/null 2>&1; then healthy=1; break; fi
    sleep 1; waited=$((waited + 1))
  done
  if (( healthy == 0 )); then
    LAUNCH_ERROR="llama-server не стал готов за ${HEALTH_TIMEOUT_SECONDS} секунд"
    stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
    return 1
  fi
  log "health.result=ok seconds=$waited"
  if [[ "$VARIANT" == "qwen-mtp" ]]; then
    if ! grep -q 'creating MTP draft context' "$SERVER_LOG"; then
      LAUNCH_ERROR="MTP draft context не подтверждён. См. $SERVER_LOG"
      stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
      return 1
    fi
    log "mtp.confirmed=true"
  fi
  local models
  models="$(curl --silent --fail "$URL/v1/models" 2>/dev/null || true)"
  if [[ "$models" != *"\"id\":\"$RUNTIME_MODEL_ID\""* || "$models" != *"\"n_ctx\":$context,"* ]]; then
    LAUNCH_ERROR="llama-server не подтвердил модель $RUNTIME_MODEL_ID с контекстом $context в /v1/models"
    stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
    return 1
  fi
  ACTIVE_MODEL="$RUNTIME_MODEL_ID"; ACTIVE_CONTEXT="$context"
  log "runtime.ready model=$ACTIVE_MODEL context=$ACTIVE_CONTEXT pid=$SERVER_PID"
  return 0
}

cleanup() {
  local status=$?
  log "launcher.cleanup reason=$CLEANUP_REASON status=$status launcher_pid=$$ electron_pid=${ELECTRON_PID:-none} server_pid=${SERVER_PID:-none}"
  stop_llama_server "$SERVER_PID"
  rm -f "$SERVER_PID_FILE" "$LAUNCHER_PID_FILE" "$REQUEST_FILE"
  ACTIVE_MODEL=""; ACTIVE_CONTEXT=0; SERVER_PID=""
  write_state stopped "" "$CLEANUP_REASON" || true
  log "launcher.exit status=$status"
}
trap cleanup EXIT
trap 'CLEANUP_REASON="SIGINT"; exit 130' INT
trap 'CLEANUP_REASON="SIGTERM"; exit 143' TERM

# Electron asked for another model/context. Transaction, with rollback.
switch_runtime() {
  local REQUEST_ID="" MODEL_ID="" CONTEXT=""
  if [[ ! -r "$REQUEST_FILE" ]]; then log "runtime.switch ignored=no-request-file"; return 0; fi
  # The file is written by Electron from allow-listed values; parse it as data.
  while IFS='=' read -r key value; do
    case "$key" in REQUEST_ID) REQUEST_ID="$value" ;; MODEL_ID) MODEL_ID="$value" ;; CONTEXT) CONTEXT="$value" ;; esac
  done < "$REQUEST_FILE"
  rm -f "$REQUEST_FILE"
  local previous_model="$ACTIVE_MODEL" previous_context="$ACTIVE_CONTEXT"
  log "runtime.switch request=$REQUEST_ID from=${previous_model:-none}/${previous_context:-0} to=$MODEL_ID/$CONTEXT electron_pid=${ELECTRON_PID:-none}"
  if [[ "$MODEL_ID" == "$previous_model" && "$CONTEXT" == "$previous_context" && -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null && curl --silent --fail "$URL/health" >/dev/null 2>&1; then
    write_state ready "$REQUEST_ID"
    log "runtime.switch request=$REQUEST_ID result=already-active"
    return 0
  fi
  write_state switching "$REQUEST_ID"
  stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
  ACTIVE_MODEL=""; ACTIVE_CONTEXT=0
  if launch_server "$MODEL_ID" "$CONTEXT"; then
    write_state ready "$REQUEST_ID"
    log "runtime.switch request=$REQUEST_ID result=ready"
    return 0
  fi
  local failure="$LAUNCH_ERROR"
  log "runtime.switch request=$REQUEST_ID result=failed error=$failure"
  if [[ -n "$previous_model" ]]; then
    log "runtime.switch request=$REQUEST_ID rollback=$previous_model/$previous_context"
    if launch_server "$previous_model" "$previous_context"; then
      write_state ready "$REQUEST_ID" "$failure" true
      log "runtime.switch request=$REQUEST_ID rollback=ready"
      return 0
    fi
    failure="$failure; восстановить предыдущую модель не удалось: $LAUNCH_ERROR"
  fi
  ACTIVE_MODEL=""; ACTIVE_CONTEXT=0; SERVER_PID=""
  write_state offline "$REQUEST_ID" "$failure"
  log "runtime.switch request=$REQUEST_ID result=offline"
  return 0
}
trap 'switch_runtime' USR1

# ---- initial selection ----
IFS=$'\t' read -r SELECTED_MODEL SAVED_CONTEXT <<< "$(saved_llama_selection)"
SELECTED_MODEL="${SELECTED_MODEL:-qwen3.8:27b-q4_K_M}"
select_variant "$SELECTED_MODEL" || { printf '%s\n' "$LAUNCH_ERROR" >&2; exit 2; }
if [[ "${LOCAL_AI_LLAMA_CONTEXT_EXTERNAL:-}" == "1" && -n "${LOCAL_AI_LLAMA_CONTEXT:-}" ]]; then
  LLAMA_CONTEXT="$LOCAL_AI_LLAMA_CONTEXT"; CONTEXT_SOURCE="external-env"
elif [[ -n "${LOCAL_AI_LLAMA_CONTEXT:-}" && "${LOCAL_AI_LLAMA_CONTEXT_EXTERNAL:-}" != "0" ]]; then
  LLAMA_CONTEXT="$LOCAL_AI_LLAMA_CONTEXT"; CONTEXT_SOURCE="external-env"; export LOCAL_AI_LLAMA_CONTEXT_EXTERNAL=1
elif [[ -n "${SAVED_CONTEXT:-}" ]]; then
  LLAMA_CONTEXT="$SAVED_CONTEXT"; CONTEXT_SOURCE="persisted"
else
  LLAMA_CONTEXT="$DEFAULT_LLAMA_CONTEXT"; CONTEXT_SOURCE="default"
fi
valid_context "$LLAMA_CONTEXT" || { printf 'LOCAL_AI_LLAMA_CONTEXT must be 16384, 32768, 65536, or 131072; got %s\n' "$LLAMA_CONTEXT" >&2; exit 2; }

log "===== launcher.started pid=$$ ====="
log "cwd=$(pwd) project_root=$APP_DIR initial_path=$INITIAL_PATH effective_path=$PATH display=${DISPLAY:-} wayland_display=${WAYLAND_DISPLAY:-} xdg_runtime_dir=${XDG_RUNTIME_DIR:-}"
log "context.resolve source=$CONTEXT_SOURCE value=$LLAMA_CONTEXT"
log "electron=$ELECTRON_BIN llama_server=$LLAMA_BIN variant=$VARIANT runtime_model_id=$RUNTIME_MODEL_ID model=$MODEL mmproj=${MMPROJ:-none} port=$PORT context=$LLAMA_CONTEXT"

[[ -x "$ELECTRON_BIN" && -f "$APP_DIR/dist/main/index.js" && -f "$APP_DIR/dist/preload/index.js" && -f "$APP_DIR/dist/renderer/index.html" ]] || fail "Не найден production build или Electron: $ELECTRON_BIN"
[[ -u "$SANDBOX_HELPER" && -x "$SANDBOX_HELPER" ]] || fail "Не найден system Chrome sandbox helper: $SANDBOX_HELPER"
rm -f "$REQUEST_FILE"

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
unset LOCAL_AI_DEV_SERVER_URL VITE_DEV_SERVER_URL
cd "$APP_DIR"
printf '%s\n' "$$" > "$LAUNCHER_PID_FILE"
write_state starting

# The server owns the GPU before Electron's GPU process exists.
launch_server "$RUNTIME_MODEL_ID" "$LLAMA_CONTEXT" || fail "$LAUNCH_ERROR. См. $SERVER_LOG"
write_state ready
export LOCAL_AI_LLAMA_MODEL_ID="$ACTIVE_MODEL"
export LOCAL_AI_LLAMA_CONTEXT="$ACTIVE_CONTEXT"
export LOCAL_AI_LLAMA_CPP_VISION=$([[ "$VARIANT" == "qwen-mtp" ]] && echo 1 || echo 0)

if [[ "${LOCAL_AI_LAUNCHER_HEADLESS:-}" == "1" ]]; then
  # Test seam: supervise the server and answer runtime-switch requests without
  # opening a window. Ends on SIGTERM/SIGINT like the normal launcher.
  log "headless=true state=ready electron=skipped"
  while true; do
    sleep 3600 &
    wait $! || true
  done
fi

log "electron.start command=$ELECTRON_BIN cwd=$(pwd) backend=$LOCAL_AI_BACKEND"
"$ELECTRON_BIN" "$APP_DIR" >> "$LOG_FILE" 2>&1 &
ELECTRON_PID=$!
log "electron.pid=$ELECTRON_PID"
# A runtime switch interrupts `wait`; only Electron's own exit ends the launcher.
electron_status=0
while kill -0 "$ELECTRON_PID" 2>/dev/null; do
  set +e
  wait "$ELECTRON_PID"
  electron_status=$?
  set -e
done
CLEANUP_REASON="electron exited status=$electron_status"
log "electron.exit status=$electron_status"
exit "$electron_status"
