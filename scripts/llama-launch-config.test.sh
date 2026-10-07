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
for id in qwen3.8:27b-q4_K_M qwen3.6:35b-a3b-ud-q4_k_m huihui-qwen3.8:27b-ud-dw-q4_k_m; do
  select_variant "$id"
  server_args=()
  build_server_args 32768 999
  args=" ${server_args[*]} "
  [[ "$args" == *" --alias $id "* && "$args" == *" --ctx-size 32768 "* ]]
  if [[ -n "$MMPROJ" ]]; then
    [[ "$args" == *" --mmproj $MMPROJ "* && "$args" != *" --no-warmup "* ]]
  else
    [[ "$args" == *" --no-warmup "* && "$args" != *" --mmproj "* ]]
  fi
  if [[ "$SPECULATIVE_MODE" == mtp ]]; then
    [[ "$args" == *" --spec-type draft-mtp "* ]]
    if [[ "$id" == qwen3.6:* ]]; then [[ "$args" == *" --spec-draft-n-max 2 "* ]]; fi
  else
    [[ "$args" == *" --spec-type none "* ]]
  fi
  echo "PASS launcher/projector evidence: $id"
done
# Generic external assistant launch remains covered without pinning a removed local model.
VARIANT=future-family; MODEL=/models/future.gguf; MMPROJ=/models/projector.gguf; RUNTIME_MODEL_ID=future
SPECULATIVE_MODE=mtp; DRAFT_MODEL=/models/compatible-assistant.gguf; DRAFT_KV_SHARED=1; DRAFT_N_MAX=4
build_server_args 32768 999
[[ " ${server_args[*]} " == *" --model-draft $DRAFT_MODEL "* && " ${server_args[*]} " == *" --spec-draft-n-max 4 "* ]]
[[ "$DRAFT_KV_SHARED" == 1 ]]
SPECULATIVE_MODE=none; DRAFT_MODEL=""; DRAFT_KV_SHARED=0; DRAFT_N_MAX=""
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
PROFILE_SERVER_ARGS=(--fit off --n-cpu-moe 28 --threads 8 --load-mode none)
build_server_args 65536 999
[[ " ${server_args[*]} " == *" --ctx-size 65536 "* && " ${server_args[*]} " == *" --n-cpu-moe 28 "* ]]
[[ " ${server_args[*]} " == *" --load-mode none "* && " ${server_args[*]} " == *" --fit off "* ]]
context_args=(--cache-type-k q8_0 --cache-type-v q8_0 --kv-offload)
select_variant qwen3.6:35b-a3b-ud-q4_k_m
build_server_args 65536 999
[[ " ${server_args[*]} " == *" --ubatch-size 128 "* && " ${server_args[*]} " == *" --batch-size 1024 "* ]]
[[ " ${server_args[*]} " == *" --cache-type-k q8_0 "* && " ${server_args[*]} " == *" --cache-type-v q8_0 "* ]]
[[ " ${server_args[*]} " == *" --spec-type draft-mtp "* && " ${server_args[*]} " == *" --spec-draft-n-max 2 "* && " ${server_args[*]} " == *" --no-warmup "* ]]
select_variant qwen3.8:27b-q4_K_M
build_server_args 32768 999
[[ " ${server_args[*]} " != *" --n-cpu-moe "* && " ${server_args[*]} " == *" --spec-type draft-mtp "* ]]
LOCAL_AI_LLAMA_SPECULATIVE=0 select_variant qwen3.6:35b-a3b-ud-q4_k_m
build_server_args 32768 999
[[ "$MMPROJ" == *"mmproj-BF16.gguf" && " ${server_args[*]} " == *" --mmproj $MMPROJ "* && " ${server_args[*]} " == *" --spec-type none "* ]]
echo 'PASS generic CPU expert placement and unchanged Qwen switching'
