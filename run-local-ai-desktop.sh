#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/media/yaroslav/DATA/local-ai-desktop"
LOG_DIR="$APP_DIR/runtime/logs"
LOG_FILE="$LOG_DIR/launcher.log"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
SANDBOX_HELPER="/opt/google/chrome/chrome-sandbox"
OLLAMA_URL="http://127.0.0.1:11434"
ELECTRON_PID=""
CLEANUP_REASON="normal exit"

mkdir -p "$LOG_DIR"

# A GNOME launcher does not read shell profiles. Keep command lookup predictable;
# Electron itself is addressed by an absolute path below.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NPM_CONFIG_CACHE="$APP_DIR/local-cache/npm"
export XDG_CACHE_HOME="$APP_DIR/runtime/cache"
export XDG_CONFIG_HOME="$APP_DIR/runtime/app-data"
export LOCAL_AI_BACKEND="ollama"

unset LOCAL_AI_DEV_SERVER_URL
unset VITE_DEV_SERVER_URL

cd "$APP_DIR"

{
  echo
  echo "===== $(date) ====="
  echo "USER=${USER:-}"
  echo "HOME=${HOME:-}"
  echo "PWD=$(pwd)"
  echo "PATH=${PATH:-}"
  echo "DISPLAY=${DISPLAY:-}"
  echo "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}"
  echo "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}"
  echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-}"
  echo "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}"
} >> "$LOG_FILE" 2>&1

if [[ ! -x "$ELECTRON_BIN" || ! -f dist/main/index.js || ! -f dist/preload/index.js || ! -f dist/renderer/index.html ]]; then
  echo "launcher.error: production build or Electron binary is missing" >> "$LOG_FILE"
  exit 1
fi

if [[ ! -u "$SANDBOX_HELPER" || ! -x "$SANDBOX_HELPER" ]]; then
  echo "launcher.error: valid system Chrome sandbox helper is missing" >> "$LOG_FILE"
  exit 1
fi
export CHROME_DEVEL_SANDBOX="$SANDBOX_HELPER"

export ELECTRON_ENABLE_LOGGING=1

log() { printf '%s %s\n' "$(date --iso-8601=seconds)" "$*" >> "$LOG_FILE"; }
release_ollama_models() {
  # The UI only exposes these local models. This wrapper remains alive while
  # Electron runs, so it also releases them if Electron terminates abnormally.
  local running
  running="$(curl --silent --show-error --max-time 4 "$OLLAMA_URL/api/ps" 2>/dev/null)" || { log "ollama.models.inspect.failed reason=$CLEANUP_REASON"; return; }
  for model in "qwen3.8:27b-q4_K_M" "gpt-oss:20b"; do
    grep -Eq "\"(name|model)\"[[:space:]]*:[[:space:]]*\"$model\"" <<< "$running" || continue
    if curl --silent --show-error --max-time 4 --request POST "$OLLAMA_URL/api/generate" --header 'content-type: application/json' --data "{\"model\":\"$model\",\"keep_alive\":0}" >/dev/null 2>&1; then
      log "ollama.model.unload model=$model reason=$CLEANUP_REASON"
    else
      log "ollama.model.unload.failed model=$model reason=$CLEANUP_REASON"
    fi
  done
}
cleanup() {
  local status=$?
  log "launcher.cleanup reason=$CLEANUP_REASON status=$status electron_pid=${ELECTRON_PID:-none}"
  release_ollama_models
  log "launcher.exit status=$status"
}
trap cleanup EXIT
trap 'CLEANUP_REASON="SIGINT"; exit 130' INT
trap 'CLEANUP_REASON="SIGTERM"; exit 143' TERM

# The bundled helper is kept as chrome-sandbox.disabled because DATA is nosuid.
# This root-owned system helper preserves Chromium's SUID sandbox.
echo "launcher.sandbox_helper: $SANDBOX_HELPER" >> "$LOG_FILE"
echo "launcher.electron: $ELECTRON_BIN" >> "$LOG_FILE"
"$ELECTRON_BIN" "$APP_DIR" >> "$LOG_FILE" 2>&1 &
ELECTRON_PID=$!
log "electron.started pid=$ELECTRON_PID"
set +e
wait "$ELECTRON_PID"
electron_status=$?
set -e
CLEANUP_REASON="electron exited status=$electron_status"
exit "$electron_status"
