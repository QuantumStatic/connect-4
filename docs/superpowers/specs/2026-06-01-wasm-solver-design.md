# Browser-Hosted AI (WASM Solver) — Design

**Goal:** Compile the existing Pascal Pons Connect-4 solver to WebAssembly so all
AI modes (Good, Great, Hint) run entirely on the user's device. Eliminates the
backend dependency for AI play — free, no servers, infinite scale — and removes
the current "vs-AI modes need the local Python solver" limitation.

**Date:** 2026-06-01

---

## Background

The solver is Pascal Pons' C++ Connect-4 solver, vendored under
`solver/vendor/connect4/`, wrapped for Python via pybind11 in
`solver/src/binding.cpp`. The FastAPI backend (`backend/pyconnect4_backend/app.py`)
exposes a single `POST /analyze` endpoint. The frontend talks to it through one
chokepoint: `analyze(moves, depth)` in `web/src/solver/client.ts`, returning
`{ scores: number[], bestMove: number, gameStatus: "ongoing"|"won"|"draw" }`.

Modes map to depth:
- **Good** → `depth = GOOD_DEPTH` → `analyze_limited` (bounded search, **no book needed**).
- **Great** and **Hint** → `depth = null` → full perfect `analyze` (**needs the 32 MB opening book** to be fast in the opening).

The opening book `7x6.book` is 33,554,524 bytes. It is **not** committed; it is
fetched from a public GitHub release by `solver/fetch_opening_book.py`.

## Constraints discovered

- **GitHub release CORS:** The release asset (`release-assets.githubusercontent.com`)
  returns the bytes but sends **no `Access-Control-Allow-Origin`** header, so a
  browser `fetch()` from the app origin is CORS-blocked. The book must be
  self-hosted with CORS.
- **Cloudflare Pages per-file limit:** 25 MiB. The 32 MB book cannot live in the
  Pages deploy. → Serve from **R2** (free tier, 10 GB, no egress fees) through
  the existing relay Worker.
- **WASM filesystem:** Pons' `OpeningBook::load` reads via `std::ifstream`. In
  WASM the fetched book bytes are written into Emscripten's in-memory FS
  (MEMFS) and `loadBook("/7x6.book")` reads from there. Requires
  `FORCE_FILESYSTEM`.

## Decisions

1. **Great/Hint:** Lazy-load the full 32 MB book on first use for true perfect play.
2. **Book hosting:** R2 bucket served via the relay Worker (`GET /book/7x6.book`,
   CORS + immutable cache + range support).
3. **WASM artifacts:** Built locally with emsdk and **committed** to the repo so
   Cloudflare Pages needs no build toolchain.
4. **Python backend:** Kept in the repo for local dev / tests / reference. The
   deployed app no longer depends on it.

## Architecture

The vendored C++ gets a second build target alongside the pybind11 module: an
Emscripten/WASM build with a thin `wasm_api.cpp` entrypoint. The frontend loads
the module lazily and calls it through the **same `analyze(moves, depth)`
interface** that `client.ts` exposes today. Everything above the `client.ts`
line (`main.ts`, pump loop, Hint, mode handling) is unchanged.

### Components

1. **`solver/wasm/wasm_api.cpp`** — entrypoint mirroring the backend's
   `_solve_in_worker` + `_best_legal_move`:
   - Parse `moves` (chars `0`–`6`); play the sequence.
   - If the sequence is illegal → signal error (maps to the offline/illegal path).
   - If 42 moves → `draw`. If a stopped move is winning → `won`.
   - `depth >= 1` → `analyze_limited`; `depth == 0/null` → full `analyze` (needs book).
   - Compute `bestMove` via center-order `[3,4,2,5,1,6,0]`, skipping illegal (`-1000`).
   - Return `{ scores, bestMove, gameStatus }` to JS (embind or JSON string).
   - Expose `loadBookBytes(ptr,len)` / FS-based `loadBook` so JS can install the book.

2. **`solver/wasm/build.sh`** — emsdk build invocation. Flags: `-O3`,
   `-sFORCE_FILESYSTEM=1`, `-sALLOW_MEMORY_GROWTH=1`, `-sINITIAL_MEMORY≈64MB`
   (grows for book + transposition tables, ~256 MB ceiling), `-sMODULARIZE=1`
   `-sEXPORT_ES6=1`, `--bind` (embind). Outputs `pyconnect4.js` + `pyconnect4.wasm`.

3. **WASM artifacts** committed at `web/src/solver/wasm/pyconnect4.js` and
   `.wasm`.

4. **`web/src/solver/wasmSolver.ts`** — lazy module loader + book manager:
   - `ensureModule()` — dynamic-import + instantiate once (memoized promise).
   - `ensureBook(onProgress?)` — fetch `${relayBase}/book/7x6.book` once, with
     Cache API persistence; write into FS; `loadBook`. Memoized.
   - `analyze(moves, depth)` — `ensureModule()`; if `depth == null` also
     `ensureBook()`; call into C++; return `AnalyzeResponse`.

5. **`web/src/solver/client.ts`** — keep the exported `analyze()` signature and
   `SolverOffline`. Body now delegates to `wasmSolver`. `SolverOffline` is thrown
   only if module instantiation fails.

6. **Relay Worker book route** (`relay/src/index.ts` + new R2 binding in
   `relay/wrangler.toml`): `GET /book/:name` → stream from R2 with
   `Access-Control-Allow-Origin`, `Cache-Control: public, max-age=31536000, immutable`,
   and HTTP range support. Book uploaded to R2 via `wrangler r2 object put`.

### Data flow

`main.ts` → `client.analyze(moves, depth)` → `wasmSolver.analyze` →
(ensure module; if Great/Hint ensure book) → C++ `analyze`/`analyze_limited` →
scores → `bestMove` → `AnalyzeResponse`. Identical above `client.ts`.

### UX / error handling

- First Great/Hint shows "Loading Great player… (one-time 32 MB)" with download
  progress via the existing HUD thinking indicator; cached forever after.
- The current backend-probe that disables Good/Great up front and its toast are
  removed; AI modes are always available once the module loads.
- Module-load failure → `SolverOffline` → existing offline handling.

### Testing

- C++ search logic is already golden-tested via the Python binding (same source).
- Add a Node smoke test (`solver/wasm/` or `web`) that instantiates the WASM
  module and asserts a few known results: empty-board best move is center (3); a
  one-move-from-win position returns a winning score for the right column; an
  illegal sequence is rejected. Book-dependent perfect-solve depth is covered by
  the existing Python golden tests.
- `client.ts` stays thin so its dispatch to `wasmSolver` is unit-testable with a
  mocked module.

## Out of scope

- Removing or redeploying the Python backend (kept as-is).
- Multiplayer/relay changes beyond the new `GET /book/:name` route.
- A web-worker thread for the solver (current solves are fast enough on the main
  thread with overlap; revisit only if the UI janks).
