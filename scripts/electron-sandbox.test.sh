#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/electron-sandbox.sh"
fixture="$(mktemp -d)"
trap 'rm -f "$fixture/electron" "$fixture/system-sandbox" "$fixture/chrome-sandbox" "$fixture/chrome-sandbox.disabled"; rmdir "$fixture"' EXIT
touch "$fixture/electron" "$fixture/system-sandbox"
chmod 755 "$fixture/system-sandbox"

# Simulate a trusted system installation without requiring root in the test.
stat() { printf '%s\n' "${HELPER_METADATA:-0:4755}"; }
printf 'npm-installed helper\n' > "$fixture/chrome-sandbox"
prepare_electron_sandbox "$fixture/electron" "$fixture/system-sandbox"
[[ "$CHROME_DEVEL_SANDBOX" == "$fixture/system-sandbox" ]]
[[ ! -e "$fixture/chrome-sandbox" ]]
grep -q npm-installed "$fixture/chrome-sandbox.disabled"
prepare_electron_sandbox "$fixture/electron" "$fixture/system-sandbox"

# An npm reinstall must not reintroduce Chromium's adjacent-helper preference.
printf 'reinstalled helper\n' > "$fixture/chrome-sandbox"
prepare_electron_sandbox "$fixture/electron" "$fixture/system-sandbox"
[[ ! -e "$fixture/chrome-sandbox" ]]
grep -q reinstalled "$fixture/chrome-sandbox.disabled"

printf 'preserve on failure\n' > "$fixture/chrome-sandbox"
for HELPER_METADATA in 1000:4755 0:755 0:4777; do
  export HELPER_METADATA
  if prepare_electron_sandbox "$fixture/electron" "$fixture/system-sandbox" 2>/dev/null; then
    echo "Accepted untrusted helper: $HELPER_METADATA" >&2
    exit 1
  fi
  grep -q 'preserve on failure' "$fixture/chrome-sandbox"
done
unset HELPER_METADATA
chmod 644 "$fixture/system-sandbox"
if prepare_electron_sandbox "$fixture/electron" "$fixture/system-sandbox" 2>/dev/null; then
  echo 'Accepted non-executable helper' >&2
  exit 1
fi
echo 'Electron sandbox launcher regression passed'
