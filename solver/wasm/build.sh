#!/usr/bin/env bash
# Build the WASM solver. Requires emsdk on PATH (source ~/emsdk/emsdk_env.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
vendor="$here/../vendor/connect4"
out="$here/../../web/src/solver/wasm"
mkdir -p "$out"

emcc -O3 -std=c++17 \
  -I"$vendor" \
  "$here/wasm_api.cpp" "$vendor/Solver.cpp" \
  --bind \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sFORCE_FILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 \
  -sEXPORT_NAME=createPyconnect4 \
  -sINVOKE_RUN=0 \
  -sEXPORTED_RUNTIME_METHODS='["FS"]' \
  -o "$out/pyconnect4.js"

echo "Built: $out/pyconnect4.js + pyconnect4.wasm"
ls -l "$out/pyconnect4.js" "$out/pyconnect4.wasm"
