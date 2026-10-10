#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture="$(mktemp -d)"
trap 'rm -r -- "$fixture"' EXIT
export LOCAL_AI_RUNTIME_ROOT="$fixture"
mkdir -p "$fixture/app-data" "$fixture/sqlite" "$fixture/logs" "$fixture/attachments"
node dist/shared/model-language.test.js
node dist/main/services/vision-device-controller.test.js
node dist/shared/locale.test.js
node dist/shared/localization.test.js
node dist/shared/localization-coverage.test.js
node dist/main/services/application-menu.test.js
node dist/main/services/runtime-settings.test.js
node dist/main/web/public-network.test.js
node dist/main/services/attachment-pipeline.test.js
node dist/main/backends/llama-cpp-backend.test.js
node dist/main/services/rust-agent-runtime.test.js
bash scripts/llama-launch-config.test.sh
bash scripts/vision-device-switch.test.sh
cargo test --locked --manifest-path rust-agent/Cargo.toml image
cargo test --locked --manifest-path rust-agent/Cargo.toml web
node scripts/agent-web-browser.test.mjs
node scripts/agent-status-renderer.test.mjs
