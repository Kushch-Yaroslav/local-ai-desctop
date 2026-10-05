#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# Evaluate only pure configuration functions, never launcher lifecycle/inference.
eval "$(sed -n '/^select_variant() {/,/^}/p' "$root/run-local-ai-desktop-llama-cpp-mtp.sh")"
eval "$(sed -n '/^build_server_args() {/,/^}/p' "$root/run-local-ai-desktop-llama-cpp-mtp.sh")"
context_args=(--cache-type-k f16 --cache-type-v f16 --kv-offload)
PORT=8083
APP_DIR="$root"
ELECTRON_BIN="$(command -v node)"
for id in qwen3.8:27b-q4_K_M huihui-qwen3.8:27b-ud-dw-q4_k_m devstral-small-2:24b-q4_k_m gemma4:31b-it-q4_k_m; do
  select_variant "$id"
  server_args=()
  build_server_args 32768 999
  args=" ${server_args[*]} "
  [[ "$args" == *" --alias $id "* && "$args" == *" --ctx-size 32768 "* ]]
  [[ "$args" == *" --mmproj $MMPROJ "* && "$args" != *" --no-warmup "* ]]
  if [[ "$SPECULATIVE_MODE" == mtp ]]; then
    [[ "$args" == *" --spec-type draft-mtp "* ]]
  else
    [[ "$args" == *" --spec-type none "* ]]
  fi
  echo "PASS launcher/projector evidence: $id"
done
select_variant gemma4:31b-it-q4_k_m
build_server_args 32768 999
[[ " ${server_args[*]} " == *" --model-draft $DRAFT_MODEL "* && " ${server_args[*]} " == *" --spec-draft-n-max 4 "* ]]
[[ "$DRAFT_KV_SHARED" == 1 ]]
LOCAL_AI_LLAMA_SPECULATIVE=0 select_variant gemma4:31b-it-q4_k_m
build_server_args 32768 999
[[ " ${server_args[*]} " == *" --spec-type none "* && " ${server_args[*]} " != *" --model-draft "* ]]
echo 'PASS external shared-KV draft and MTP OFF'
# A future projector runtime needs no family-name allow-list to reserve compute.
VARIANT=future-family; MODEL=/models/future.gguf; MMPROJ=/models/future-projector.gguf; RUNTIME_MODEL_ID=future
SPECULATIVE_MODE=none; DRAFT_MODEL=""; DRAFT_KV_SHARED=0; DRAFT_N_MAX=""
build_server_args 16384 999
[[ " ${server_args[*]} " != *" --no-warmup "* ]]
[[ " ${server_args[*]} " == *" --spec-type none "* ]]
# A text-only runtime can still skip warmup, without fabricated vision allocations.
MMPROJ=""
build_server_args 16384 999
[[ " ${server_args[*]} " == *" --no-warmup "* ]]
[[ " ${server_args[*]} " != *" --mmproj "* ]]
echo 'PASS future runtime and text-only launch configuration'
