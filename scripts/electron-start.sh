#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$app_dir/scripts/electron-sandbox.sh"
select_electron_sandbox "$app_dir/node_modules/electron/dist/electron"
exec "$app_dir/node_modules/electron/dist/electron" "$app_dir" "$@"
