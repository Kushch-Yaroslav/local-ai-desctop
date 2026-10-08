#!/usr/bin/env bash

# Prefer a correctly installed bundled helper or user namespaces. A trusted
# system helper is an optional fallback for restricted Ubuntu installations.
# Never disable Chromium's sandbox or require Google Chrome to be installed.
select_electron_sandbox() {
  local electron="$1" helper bundled="$(dirname "$1")/chrome-sandbox"
  if [[ -z "${LOCAL_AI_CHROME_SANDBOX:-}" && -x "$bundled" && "$(stat -Lc '%u:%a' "$bundled")" == "0:4755" ]]; then return 0; fi
  if [[ -n "${LOCAL_AI_CHROME_SANDBOX:-}" ]]; then prepare_electron_sandbox "$electron" "$LOCAL_AI_CHROME_SANDBOX"; return; fi
  for helper in /usr/lib/chromium/chrome-sandbox /usr/lib/chromium-browser/chrome-sandbox /opt/google/chrome/chrome-sandbox; do
    if [[ -x "$helper" && "$(stat -Lc '%u:%a' "$helper")" == "0:4755" && -w "$(dirname "$electron")" ]]; then prepare_electron_sandbox "$electron" "$helper"; return; fi
  done
}

# Chromium prefers an adjacent helper over CHROME_DEVEL_SANDBOX. npm restores
# that user-owned helper, so select the trusted system helper on every launch.
prepare_electron_sandbox() {
  local electron="$1" helper="$2" bundled
  if [[ ! -x "$helper" || "$(stat -Lc '%u:%a' "$helper")" != "0:4755" ]]; then
    printf 'Invalid system Chrome sandbox helper (requires root:4755): %s\n' "$helper" >&2
    return 1
  fi
  bundled="$(dirname "$electron")/chrome-sandbox"
  if [[ -e "$bundled" || -L "$bundled" ]]; then
    if ! mv -f -- "$bundled" "$bundled.disabled"; then
      printf 'Cannot retire bundled Chrome sandbox helper: %s\n' "$bundled" >&2
      return 1
    fi
  fi
  export CHROME_DEVEL_SANDBOX="$helper"
}
