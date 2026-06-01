# WASM solver build

The browser AI is the vendored Pons solver compiled to WebAssembly.

## Rebuild
1. Install emsdk once:
   `git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install latest && ./emsdk activate latest`
2. `source ~/emsdk/emsdk_env.sh`
3. `bash solver/wasm/build.sh`

Outputs `web/src/solver/wasm/pyconnect4.{js,wasm}` (committed — Pages needs no toolchain).
The opening book is NOT bundled; it is served from R2 by the relay and cached in the browser.
