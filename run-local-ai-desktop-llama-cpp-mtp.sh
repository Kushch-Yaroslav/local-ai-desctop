#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/media/yaroslav/DATA/local-ai-desktop"
LLAMA_BIN="/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server"
MODEL="/media/yaroslav/DATA/llama-models/qwen3.8-27b-q4_K_M.gguf"
MMPROJ="/media/yaroslav/DATA/llama-models/qwen3.8-27b-mmproj.gguf"
PORT="8081"
URL="http://127.0.0.1:${PORT}"
LOG_DIR="$APP_DIR/runtime/logs"
LOG_FILE="$LOG_DIR/llama-cpp-mtp-launcher.log"
SERVER_LOG="$LOG_DIR/llama-cpp-mtp-server.log"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
SANDBOX_HELPER="/opt/google/chrome/chrome-sandbox"
SERVER_PID=""

mkdir -p "$LOG_DIR"
fail() {
  local message="$1"
  echo "launcher.error: $message" | tee -a "$LOG_FILE" >&2
  command -v notify-send >/dev/null 2>&1 && notify-send "Local AI Desktop — llama.cpp MTP" "$message" || true
  exit 1
}
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

[[ -x "$LLAMA_BIN" ]] || fail "llama-server с CUDA не найден: $LLAMA_BIN"
[[ -f "$MODEL" ]] || fail "Qwen GGUF не найден: $MODEL"
[[ -f "$MMPROJ" ]] || fail "Qwen vision projector не найден: $MMPROJ"
[[ -x "$ELECTRON_BIN" && -f "$APP_DIR/dist/main/index.js" && -f "$APP_DIR/dist/preload/index.js" && -f "$APP_DIR/dist/renderer/index.html" ]] || fail "Production build или Electron binary отсутствует"
[[ -u "$SANDBOX_HELPER" && -x "$SANDBOX_HELPER" ]] || fail "System Chrome sandbox helper отсутствует"

# Never attach to or terminate a server we did not create.
if curl --silent --fail "$URL/health" >/dev/null 2>&1; then
  fail "Порт $PORT уже занят работающим llama-server; этот launcher не будет управлять чужим процессом"
fi

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NPM_CONFIG_CACHE="$APP_DIR/local-cache/npm"
export XDG_CACHE_HOME="$APP_DIR/runtime/cache"
export XDG_CONFIG_HOME="$APP_DIR/runtime/app-data"
export CHROME_DEVEL_SANDBOX="$SANDBOX_HELPER"
export ELECTRON_ENABLE_LOGGING=1
export LOCAL_AI_BACKEND="llama-cpp"
export LOCAL_AI_LLAMA_CPP_URL="$URL"
export LOCAL_AI_LLAMA_SERVER_PATH="$LLAMA_BIN"
export LOCAL_AI_LLAMA_CPP_VISION="1"
unset LOCAL_AI_DEV_SERVER_URL VITE_DEV_SERVER_URL

echo "===== $(date) llama.cpp MTP =====" >> "$LOG_FILE"
: > "$SERVER_LOG"
"$LLAMA_BIN" -m "$MODEL" --mmproj "$MMPROJ" --no-mmproj-offload --host 127.0.0.1 --port "$PORT" --ctx-size 65536 --gpu-layers 999 --flash-attn on --spec-type draft-mtp >> "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 45); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -n 40 "$SERVER_LOG" >> "$LOG_FILE" || true
    fail "llama-server завершился до готовности; детали: $SERVER_LOG"
  fi
  if curl --silent --fail "$URL/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl --silent --fail "$URL/health" >/dev/null 2>&1 || fail "llama-server не стал готов за 90 секунд; детали: $SERVER_LOG"
grep -q 'creating MTP draft context' "$SERVER_LOG" || fail "llama-server запустился без подтверждения MTP; детали: $SERVER_LOG"

cd "$APP_DIR"
echo "launcher.server_pid=$SERVER_PID mtp=draft-mtp" >> "$LOG_FILE"
# Qwen + MTP intentionally occupies almost all 24 GB of VRAM. The desktop UI
# itself does not need CUDA, so avoid Chromium creating a competing GPU process.
"$ELECTRON_BIN" --disable-gpu "$APP_DIR" >> "$LOG_FILE" 2>&1
