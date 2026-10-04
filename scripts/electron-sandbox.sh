#!/usr/bin/env bash

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
