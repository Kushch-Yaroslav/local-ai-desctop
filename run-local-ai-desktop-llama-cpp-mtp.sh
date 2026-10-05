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
#   llama-cpp-runtime-request.env  written by Electron: REQUEST_ID, MODEL_ID, CONTEXT, KV_TYPE, KV_OFFLOAD
#   llama-cpp-runtime-state.json   written here: the only authority on what runs
set -euo pipefail

APP_DIR="/media/yaroslav/DATA/local-ai-desktop"
LLAMA_BIN="/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
PORT="${LOCAL_AI_LLAMA_PORT:-8081}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { printf 'Invalid LOCAL_AI_LLAMA_PORT: %s\n' "$PORT" >&2; exit 2; }
URL="http://127.0.0.1:${PORT}"
STATE_DIR="${LOCAL_AI_RUNTIME_ROOT:-$APP_DIR/runtime}"
LOG_DIR="$STATE_DIR/logs"
LOG_FILE="$LOG_DIR/llama-cpp-mtp-launcher.log"
SERVER_LOG="$LOG_DIR/llama-cpp-mtp-server.log"
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
ACTIVE_KV_TYPE="f16"
ACTIVE_KV_OFFLOAD="1"
LAUNCH_ERROR=""
REQUEST_CONTEXT_FOR_ERROR=""
VARIANT=""; MODEL=""; MMPROJ=""; RUNTIME_MODEL_ID=""; RUNTIME_LABEL=""; DEFAULT_LLAMA_CONTEXT=""; MAX_LLAMA_CONTEXT=""

mkdir -p "$LOG_DIR"
INITIAL_PATH="${PATH:-}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
timestamp() { date --iso-8601=seconds; }
log() { printf '%s %s\n' "$(timestamp)" "$*" >> "$LOG_FILE"; }

saved_llama_selection() {
  local database="$STATE_DIR/sqlite/local-ai-desktop.db"
  [[ -r "$database" && -x "$ELECTRON_BIN" ]] || return 0
  ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const names = new Set(db.prepare('PRAGMA table_info(conversations)').all().map(x => x.name)); const type = names.has('llama_kv_cache_type') ? 'llama_kv_cache_type' : \"'f16'\"; const offload = names.has('llama_kv_offload') ? 'llama_kv_offload' : '1'; const row = db.prepare(\"SELECT model_id, context_window, \" + type + \" AS kv_type, \" + offload + \" AS kv_offload FROM conversations WHERE model_id IN ('qwen3.8:27b-q4_K_M', 'huihui-qwen3.8:27b-ud-dw-q4_k_m', 'devstral-small-2:24b-q4_k_m', 'gemma4:31b-it-q4_k_m') ORDER BY updated_at DESC LIMIT 1\").get(); if (row) process.stdout.write([row.model_id, row.context_window, row.kv_type, row.kv_offload].join('\\t')); db.close();" "$database" 2>/dev/null || true
}

# Sets the launch variables for a model id. Fails for a model without a runtime.
select_variant() {
  case "$1" in
    qwen3.8:27b-q4_K_M)
      VARIANT="qwen-mtp"; MODEL="/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf"
      MMPROJ="/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf"
      RUNTIME_MODEL_ID="qwen3.8:27b-q4_K_M"; RUNTIME_LABEL="Qwen3.8 MTP"; DEFAULT_LLAMA_CONTEXT=32768; MAX_LLAMA_CONTEXT=262144 ;;
    huihui-qwen3.8:27b-ud-dw-q4_k_m)
      VARIANT="qwen-mtp"; MODEL="/media/yaroslav/DATA/llama-models/Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf"
      MMPROJ="/media/yaroslav/DATA/llama-models/huihui-qwen3.8-27b-mmproj-bf16.gguf"
      RUNTIME_MODEL_ID="$1"; RUNTIME_LABEL="Huihui Qwen3.8 MTP"; DEFAULT_LLAMA_CONTEXT=32768; MAX_LLAMA_CONTEXT=262144 ;;
    devstral-small-2:24b-q4_k_m)
      VARIANT="devstral-small-2"; MODEL="/media/yaroslav/DATA/llama-models/Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf"
      MMPROJ="/media/yaroslav/DATA/llama-models/devstral-small-2-24b-mmproj-f16.gguf"
      RUNTIME_MODEL_ID="$1"; RUNTIME_LABEL="Devstral Small 2 24B"; DEFAULT_LLAMA_CONTEXT=32768; MAX_LLAMA_CONTEXT=262144 ;;
    gemma4:31b-it-q4_k_m)
      VARIANT="gemma4"; MODEL="/media/yaroslav/DATA/llama-models/gemma-4-31B-it-Q4_K_M.gguf"
      MMPROJ="/media/yaroslav/DATA/llama-models/gemma-4-31b-mmproj-f16.gguf"
      RUNTIME_MODEL_ID="$1"; RUNTIME_LABEL="Gemma 4 31B IT"; DEFAULT_LLAMA_CONTEXT=32768; MAX_LLAMA_CONTEXT=262144 ;;
    *)
      LAUNCH_ERROR="Unknown Local AI llama.cpp model: $1"; return 1 ;;
  esac
}
valid_context() { [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 >= 4096 && 10#$1 <= MAX_LLAMA_CONTEXT && 10#$1 % 4096 == 0 )); }

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
  printf '{"status":"%s","requestId":"%s","modelId":"%s","contextWindow":%s,"kvCacheType":"%s","kvOffload":%s,"serverPid":%s,"launcherPid":%s,"error":"%s","rolledBack":%s,"updatedAt":"%s"}\n' \
    "$status" "$(json_escape "$request_id")" "$(json_escape "$ACTIVE_MODEL")" "${ACTIVE_CONTEXT:-0}" "$ACTIVE_KV_TYPE" "$([[ "$ACTIVE_KV_OFFLOAD" == "1" ]] && echo true || echo false)" "${SERVER_PID:-0}" "$$" \
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
# being returned to the driver.
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

# Pure argument construction, also exercised by the launcher regression tests.
build_server_args() {
  local context="$1" gpu_layers="$2"
  server_args=(--log-verbosity 5 -m "$MODEL" --alias "$RUNTIME_MODEL_ID" --host 127.0.0.1 --port "$PORT" --ctx-size "$context" --gpu-layers "$gpu_layers" --flash-attn on "${context_args[@]}" --parallel 1 --jinja --reasoning on --reasoning-format auto)
  # A projector must reserve its compute buffers at startup: Max Context
  # requires measured vision allocations before it can safely probe candidates.
  if [[ -n "$MMPROJ" ]]; then
    server_args+=(--mmproj "$MMPROJ" --no-mmproj-offload)
  else
    server_args+=(--no-warmup)
  fi
  if [[ "$VARIANT" == "qwen-mtp" ]]; then server_args+=(--spec-type draft-mtp); else server_args+=(--spec-type none); fi
}

# launch_server <model_id> <context> <kv_type> <kv_offload>
# Success means: the process is alive, /health is ok, /v1/models reports the
# requested alias with exactly the requested n_ctx, and (for MTP) the draft
# context exists. Anything else stops the process and leaves LAUNCH_ERROR.
launch_server() {
  local model_id="$1" context="$2" kv_type="${3:-f16}" kv_offload="${4:-1}"
  LAUNCH_ERROR=""; REQUEST_CONTEXT_FOR_ERROR="$context"
  select_variant "$model_id" || return 1
  valid_context "$context" || { LAUNCH_ERROR="Неподдерживаемый размер контекста llama.cpp: $context"; return 1; }
  [[ "$kv_type" == "f16" || "$kv_type" == "q8_0" ]] || { LAUNCH_ERROR="Неподдерживаемый тип KV-cache: $kv_type"; return 1; }
  [[ "$kv_offload" == "0" || "$kv_offload" == "1" ]] || { LAUNCH_ERROR="Неподдерживаемая настройка KV offload"; return 1; }
  [[ -x "$LLAMA_BIN" ]] || { LAUNCH_ERROR="Не найден исполняемый llama-server: $LLAMA_BIN"; return 1; }
  [[ -f "$MODEL" ]] || { LAUNCH_ERROR="Не найден GGUF выбранной модели: $MODEL"; return 1; }
  [[ -z "$MMPROJ" || -f "$MMPROJ" ]] || { LAUNCH_ERROR="Не найден vision projector: $MMPROJ"; return 1; }

  local context_args=(--cache-type-k "$kv_type" --cache-type-v "$kv_type") gpu_layers=999
  if [[ "$VARIANT" == "qwen-mtp" ]]; then context_args+=(--cache-type-k-draft "$kv_type" --cache-type-v-draft "$kv_type"); fi
  if [[ "$kv_offload" == "0" ]]; then context_args+=(--no-kv-offload); else context_args+=(--kv-offload); fi
  log "context.policy variant=$VARIANT ctx_size=$context kv_type=$kv_type kv_offload=$kv_offload gpu_layers=$gpu_layers"
  wait_for_gpu_release

  : > "$SERVER_LOG"
  log "llama-server.start variant=$VARIANT runtime_model_id=$RUNTIME_MODEL_ID ctx_size=$context kv_type=$kv_type kv_offload=$kv_offload model=$MODEL mmproj=${MMPROJ:-none}"
  local server_args=() printed_command
  build_server_args "$context" "$gpu_layers"
  printf -v printed_command '%q ' "$LLAMA_BIN" "${server_args[@]}"
  log "llama-server.command=${printed_command% }"
  "$LLAMA_BIN" "${server_args[@]}" >> "$SERVER_LOG" 2>&1 &
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
  local cache_line_count
  cache_line_count="$(grep -Ec "llama_kv_cache: size =.*K \\($kv_type\\):.*V \\($kv_type\\):" "$SERVER_LOG" || true)"
  if [[ "$VARIANT" == "qwen-mtp" && "$cache_line_count" -lt 2 ]] || [[ "$VARIANT" != "qwen-mtp" && "$cache_line_count" -lt 1 ]]; then
    LAUNCH_ERROR="llama-server did not confirm effective $kv_type target/draft KV cache types in its startup log"
    stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
    return 1
  fi
  local server_args
  server_args="$(tr '\0' ' ' < "/proc/$SERVER_PID/cmdline")"
  if [[ "$kv_offload" == "0" && "$server_args" != *"--no-kv-offload"* ]] || [[ "$kv_offload" == "1" && "$server_args" != *"--kv-offload"* ]]; then
    LAUNCH_ERROR="llama-server process arguments do not confirm the requested KV offload setting"
    stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
    return 1
  fi
  log "kv.effective type=$kv_type cache_lines=$cache_line_count offload=$kv_offload"
  local models
  models="$(curl --silent --fail "$URL/v1/models" 2>/dev/null || true)"
  if [[ "$models" != *"\"id\":\"$RUNTIME_MODEL_ID\""* || "$models" != *"\"n_ctx\":$context,"* ]]; then
    LAUNCH_ERROR="llama-server не подтвердил модель $RUNTIME_MODEL_ID с контекстом $context в /v1/models"
    stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
    return 1
  fi
  ACTIVE_MODEL="$RUNTIME_MODEL_ID"; ACTIVE_CONTEXT="$context"; ACTIVE_KV_TYPE="$kv_type"; ACTIVE_KV_OFFLOAD="$kv_offload"
  log "runtime.ready model=$ACTIVE_MODEL context=$ACTIVE_CONTEXT kv_type=$ACTIVE_KV_TYPE kv_offload=$ACTIVE_KV_OFFLOAD pid=$SERVER_PID"
  return 0
}

cleanup() {
  local status=$?
  log "launcher.cleanup reason=$CLEANUP_REASON status=$status launcher_pid=$$ electron_pid=${ELECTRON_PID:-none} server_pid=${SERVER_PID:-none}"
  stop_llama_server "$SERVER_PID"
  rm -f "$SERVER_PID_FILE" "$LAUNCHER_PID_FILE" "$REQUEST_FILE"
  ACTIVE_MODEL=""; ACTIVE_CONTEXT=0; SERVER_PID=""
  if (( status == 0 || status == 130 || status == 143 )); then
    write_state stopped "" "$CLEANUP_REASON" || true
  else
    write_state offline "" "$CLEANUP_REASON" || true
  fi
  log "launcher.exit status=$status"
}
trap cleanup EXIT
trap 'CLEANUP_REASON="SIGINT"; exit 130' INT
trap 'CLEANUP_REASON="SIGTERM"; exit 143' TERM

# Electron asked for another model/context. Transaction, with rollback.
switch_runtime() {
  local REQUEST_ID="" MODEL_ID="" CONTEXT="" KV_TYPE="f16" KV_OFFLOAD="1"
  if [[ ! -r "$REQUEST_FILE" ]]; then log "runtime.switch ignored=no-request-file"; return 0; fi
  # The file is written by Electron from allow-listed values; parse it as data.
  while IFS='=' read -r key value; do
    case "$key" in REQUEST_ID) REQUEST_ID="$value" ;; MODEL_ID) MODEL_ID="$value" ;; CONTEXT) CONTEXT="$value" ;; KV_TYPE) KV_TYPE="$value" ;; KV_OFFLOAD) KV_OFFLOAD="$value" ;; esac
  done < "$REQUEST_FILE"
  rm -f "$REQUEST_FILE"
  local previous_model="$ACTIVE_MODEL" previous_context="$ACTIVE_CONTEXT" previous_kv_type="$ACTIVE_KV_TYPE" previous_kv_offload="$ACTIVE_KV_OFFLOAD"
  log "runtime.switch request=$REQUEST_ID from=${previous_model:-none}/${previous_context:-0}/${previous_kv_type}/${previous_kv_offload} to=$MODEL_ID/$CONTEXT/$KV_TYPE/$KV_OFFLOAD electron_pid=${ELECTRON_PID:-none}"
  if [[ "$MODEL_ID" == "$previous_model" && "$CONTEXT" == "$previous_context" && "$KV_TYPE" == "$previous_kv_type" && "$KV_OFFLOAD" == "$previous_kv_offload" && -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null && curl --silent --fail "$URL/health" >/dev/null 2>&1; then
    write_state ready "$REQUEST_ID"
    log "runtime.switch request=$REQUEST_ID result=already-active"
    return 0
  fi
  write_state switching "$REQUEST_ID"
  stop_llama_server "$SERVER_PID"; SERVER_PID=""; rm -f "$SERVER_PID_FILE"
  ACTIVE_MODEL=""; ACTIVE_CONTEXT=0
  if launch_server "$MODEL_ID" "$CONTEXT" "$KV_TYPE" "$KV_OFFLOAD"; then
    write_state ready "$REQUEST_ID"
    log "runtime.switch request=$REQUEST_ID result=ready"
    return 0
  fi
  local failure="$LAUNCH_ERROR"
  log "runtime.switch request=$REQUEST_ID result=failed error=$failure"
  if [[ -n "$previous_model" ]]; then
    log "runtime.switch request=$REQUEST_ID rollback=$previous_model/$previous_context"
    if launch_server "$previous_model" "$previous_context" "$previous_kv_type" "$previous_kv_offload"; then
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
IFS=$'\t' read -r SELECTED_MODEL SAVED_CONTEXT SAVED_KV_TYPE SAVED_KV_OFFLOAD <<< "$(saved_llama_selection)"
SELECTED_MODEL="${LOCAL_AI_LLAMA_MODEL_ID:-${SELECTED_MODEL:-qwen3.8:27b-q4_K_M}}"
select_variant "$SELECTED_MODEL" || { printf '%s\n' "$LAUNCH_ERROR" >&2; exit 2; }
SAVED_KV_TYPE="${SAVED_KV_TYPE:-f16}"
SAVED_KV_OFFLOAD="${SAVED_KV_OFFLOAD:-1}"
if [[ "${LOCAL_AI_LLAMA_CONTEXT_EXTERNAL:-}" == "1" && -n "${LOCAL_AI_LLAMA_CONTEXT:-}" ]]; then
  LLAMA_CONTEXT="$LOCAL_AI_LLAMA_CONTEXT"; CONTEXT_SOURCE="external-env"
elif [[ -n "${LOCAL_AI_LLAMA_CONTEXT:-}" && "${LOCAL_AI_LLAMA_CONTEXT_EXTERNAL:-}" != "0" ]]; then
  LLAMA_CONTEXT="$LOCAL_AI_LLAMA_CONTEXT"; CONTEXT_SOURCE="external-env"; export LOCAL_AI_LLAMA_CONTEXT_EXTERNAL=1
elif [[ -n "${SAVED_CONTEXT:-}" ]]; then
  LLAMA_CONTEXT="$SAVED_CONTEXT"; CONTEXT_SOURCE="persisted"
else
  LLAMA_CONTEXT="$DEFAULT_LLAMA_CONTEXT"; CONTEXT_SOURCE="default"
fi
valid_context "$LLAMA_CONTEXT" || { printf 'LOCAL_AI_LLAMA_CONTEXT must be a 4096-token multiple from 4096 through %s; got %s\n' "$MAX_LLAMA_CONTEXT" "$LLAMA_CONTEXT" >&2; exit 2; }
[[ "$SAVED_KV_TYPE" == "f16" || "$SAVED_KV_TYPE" == "q8_0" ]] || SAVED_KV_TYPE="f16"
[[ "$SAVED_KV_OFFLOAD" == "0" || "$SAVED_KV_OFFLOAD" == "1" ]] || SAVED_KV_OFFLOAD="1"

log "===== launcher.started pid=$$ ====="
log "cwd=$(pwd) project_root=$APP_DIR initial_path=$INITIAL_PATH effective_path=$PATH display=${DISPLAY:-} wayland_display=${WAYLAND_DISPLAY:-} xdg_runtime_dir=${XDG_RUNTIME_DIR:-}"
log "context.resolve source=$CONTEXT_SOURCE value=$LLAMA_CONTEXT kv_type=$SAVED_KV_TYPE kv_offload=$SAVED_KV_OFFLOAD"
log "electron=$ELECTRON_BIN llama_server=$LLAMA_BIN variant=$VARIANT runtime_model_id=$RUNTIME_MODEL_ID model=$MODEL mmproj=${MMPROJ:-none} port=$PORT context=$LLAMA_CONTEXT"

[[ -x "$ELECTRON_BIN" && -f "$APP_DIR/dist/main/index.js" && -f "$APP_DIR/dist/preload/index.js" && -f "$APP_DIR/dist/renderer/index.html" ]] || fail "Не найден production build или Electron: $ELECTRON_BIN"
source "$APP_DIR/scripts/electron-sandbox.sh"
prepare_electron_sandbox "$ELECTRON_BIN" "$SANDBOX_HELPER" || fail "Не удалось настроить system Chrome sandbox helper: $SANDBOX_HELPER"
log "electron.sandbox helper=$CHROME_DEVEL_SANDBOX bundled=retired"
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
export XDG_CACHE_HOME="$STATE_DIR/cache"
export XDG_CONFIG_HOME="$STATE_DIR/app-data"
export ELECTRON_ENABLE_LOGGING=1
export LOCAL_AI_LLAMA_CPP_URL="$URL"
export LOCAL_AI_LLAMA_SERVER_PATH="$LLAMA_BIN"
export LOCAL_AI_LLAMA_SERVER_LOG="$SERVER_LOG"
unset LOCAL_AI_DEV_SERVER_URL VITE_DEV_SERVER_URL
cd "$APP_DIR"
printf '%s\n' "$$" > "$LAUNCHER_PID_FILE"
write_state starting

# The server owns the GPU before Electron's GPU process exists.
launch_server "$RUNTIME_MODEL_ID" "$LLAMA_CONTEXT" "$SAVED_KV_TYPE" "$SAVED_KV_OFFLOAD" || fail "$LAUNCH_ERROR. См. $SERVER_LOG"
write_state ready
export LOCAL_AI_LLAMA_MODEL_ID="$ACTIVE_MODEL"
export LOCAL_AI_LLAMA_CONTEXT="$ACTIVE_CONTEXT"
export LOCAL_AI_LLAMA_KV_TYPE="$ACTIVE_KV_TYPE"
export LOCAL_AI_LLAMA_KV_OFFLOAD="$ACTIVE_KV_OFFLOAD"
export LOCAL_AI_LLAMA_CPP_VISION=$([[ -n "$MMPROJ" ]] && echo 1 || echo 0)

if [[ "${LOCAL_AI_LAUNCHER_HEADLESS:-}" == "1" ]]; then
  # Test seam: supervise the server and answer runtime-switch requests without
  # opening a window. Ends on SIGTERM/SIGINT like the normal launcher.
  log "headless=true state=ready electron=skipped"
  while true; do
    sleep 3600 &
    wait $! || true
  done
fi

log "electron.start command=$ELECTRON_BIN cwd=$(pwd) runtime=llama.cpp"
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
if (( electron_status != 0 )); then
  log "launcher.error=$CLEANUP_REASON"
  show_failure "Окно Local AI Desktop не удалось запустить: Electron завершился с кодом $electron_status. См. $LOG_FILE"
fi
exit "$electron_status"
