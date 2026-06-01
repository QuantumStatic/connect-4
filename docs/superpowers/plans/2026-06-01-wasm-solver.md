# Browser-Hosted AI (WASM Solver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Connect-4 AI entirely in the browser by compiling the existing Pons C++ solver to WebAssembly, with the 32 MB opening book lazy-loaded from R2 and cached on-device.

**Architecture:** A second build target (Emscripten) over the vendored Pons C++ exposes `analyze(moves, depth)` via embind. The frontend lazy-loads the module and calls it through the unchanged `analyze()` interface in `client.ts`. The opening book is served by the relay Worker from R2 and persisted in the browser Cache API.

**Tech Stack:** Emscripten (emsdk), embind, TypeScript, Vite, Cloudflare Workers + R2, vitest.

---

## File Structure

- `solver/wasm/wasm_api.cpp` — **create**. Embind entrypoint mirroring the backend's `_solve_in_worker` + `_best_legal_move`.
- `solver/wasm/build.sh` — **create**. emsdk build invocation; outputs into `web/src/solver/wasm/`.
- `solver/wasm/README.md` — **create**. How to install emsdk and rebuild.
- `web/src/solver/wasm/pyconnect4.js`, `pyconnect4.wasm` — **create** (committed build artifacts).
- `web/src/solver/wasm/pyconnect4.d.ts` — **create**. Hand-written types for the module factory.
- `web/src/solver/wasmSolver.ts` — **create**. Module loader + book manager + `analyze`.
- `web/src/solver/wasmSolver.test.ts` — **create**. Unit tests with a faked module.
- `web/src/solver/client.ts` — **modify**. Delegate to `wasmSolver`; keep signature + `SolverOffline`.
- `web/src/solver/client.test.ts` — **create**. Dispatch tests with a mocked `wasmSolver`.
- `web/src/solver/wasmSolver.smoke.test.ts` — **create**. Node test loading the real `.wasm` (bookless paths only).
- `relay/wrangler.toml` — **modify**. Add R2 bucket binding `BOOK`.
- `relay/src/index.ts` — **modify**. Add `GET /book/:name` route.
- `relay/test/router.test.ts` — **modify**. Add book-route tests (with a faked R2 binding via env).
- `web/src/main.ts` — **modify**. Remove backend-probe/offline-disable + toast; add first-use book-loading status.
- `README.md` / `web` docs — **modify**. Note the WASM solver + how to rebuild.

---

## Task 1: Emscripten toolchain + WASM entrypoint + build

**Files:**
- Create: `solver/wasm/wasm_api.cpp`
- Create: `solver/wasm/build.sh`
- Create: `solver/wasm/README.md`
- Create (build output): `web/src/solver/wasm/pyconnect4.js`, `web/src/solver/wasm/pyconnect4.wasm`

> **Executor note:** This task installs a large SDK and runs a native build; it is best run directly (not in an isolated subagent). The vendored solver lives at `solver/vendor/connect4/` (`Solver.cpp/.hpp`, `Position.hpp`, `OpeningBook.hpp`, `TranspositionTable.hpp`, `MoveSorter.hpp`).

- [ ] **Step 1: Install emsdk**

```bash
cd ~ && git clone https://github.com/emscripten-core/emsdk.git 2>/dev/null || (cd ~/emsdk && git pull)
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
source ~/emsdk/emsdk_env.sh
emcc --version   # expect: emcc (Emscripten gcc/clang-like replacement) X.Y.Z
```

- [ ] **Step 2: Write the WASM entrypoint**

The depth contract: JS passes `depth <= 0` to mean "full perfect solve" (the old `depth is None`), and `depth >= 1` to mean depth-limited. Mirror `_solve_in_worker` and `_best_legal_move` exactly.

Create `solver/wasm/wasm_api.cpp`:

```cpp
// solver/wasm/wasm_api.cpp
// Emscripten/embind entrypoint over the Pascal Pons Connect 4 solver.
// Mirrors the backend's _solve_in_worker + _best_legal_move so the browser
// solver returns identical results to the Python backend.
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include <vector>

#include "Solver.hpp"
#include "Position.hpp"

using GameSolver::Connect4::Solver;
using GameSolver::Connect4::Position;
using emscripten::val;

namespace {

constexpr int ILLEGAL = -1000;
const int CENTER_ORDER[7] = {3, 4, 2, 5, 1, 6, 0};

// One solver instance for the page; reused across calls. Loading the book
// populates its opening-book table.
Solver g_solver;

int negamax_limited(const Position &P, int alpha, int beta, int depth) {
    if (P.nbMoves() == Position::WIDTH * Position::HEIGHT) return 0;
    for (int c = 0; c < Position::WIDTH; ++c)
        if (P.canPlay(c) && P.isWinningMove(c))
            return (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
    if (depth == 0) return 0;
    int max_score = (Position::WIDTH * Position::HEIGHT - 1 - P.nbMoves()) / 2;
    if (beta > max_score) { beta = max_score; if (alpha >= beta) return beta; }
    for (int c : CENTER_ORDER) {
        if (P.canPlay(c)) {
            Position P2(P);
            P2.playCol(c);
            int score = -negamax_limited(P2, -beta, -alpha, depth - 1);
            if (score >= beta) return score;
            if (score > alpha) alpha = score;
        }
    }
    return alpha;
}

std::vector<int> scores_full(const Position &P) {
    std::vector<int> out(Position::WIDTH, ILLEGAL);
    for (int c = 0; c < Position::WIDTH; ++c) {
        if (!P.canPlay(c)) continue;
        if (P.isWinningMove(c)) {
            out[c] = (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
            continue;
        }
        Position P2(P);
        P2.playCol(c);
        out[c] = -g_solver.solve(P2, false);
    }
    return out;
}

std::vector<int> scores_limited(const Position &P, int depth) {
    std::vector<int> out(Position::WIDTH, ILLEGAL);
    for (int c = 0; c < Position::WIDTH; ++c) {
        if (!P.canPlay(c)) continue;
        if (P.isWinningMove(c)) {
            out[c] = (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
            continue;
        }
        Position P2(P);
        P2.playCol(c);
        out[c] = -negamax_limited(P2, -100000, 100000, depth - 1);
    }
    return out;
}

int best_legal_move(const std::vector<int> &scores) {
    int best_score = -10000, best = 3;
    for (int c : CENTER_ORDER) {
        if (scores[c] == ILLEGAL) continue;
        if (scores[c] > best_score) { best_score = scores[c]; best = c; }
    }
    return best;
}

// Translate "0".."6" into the solver's 1-based play() alphabet, like the
// Python binding's play_sequence.
int play_sequence(Position &P, const std::string &moves) {
    std::string translated(moves.size(), '0');
    for (size_t i = 0; i < moves.size(); ++i) translated[i] = moves[i] + 1;
    return (int)P.play(translated);
}

// Returns { scores:number[], bestMove:number, gameStatus:string, ok:boolean }.
// ok=false signals an illegal move sequence (controller maps to error).
val analyze(const std::string &moves, int depth) {
    val res = val::object();
    Position P;
    int played = play_sequence(P, moves);
    if (played != (int)moves.size()) {
        int stopped = moves[played] - '0';
        if (P.isWinningMove(stopped)) {
            std::vector<int> s(7, ILLEGAL);
            res.set("scores", val::array(s));
            res.set("bestMove", stopped);
            res.set("gameStatus", std::string("won"));
            res.set("ok", true);
            return res;
        }
        res.set("ok", false);
        return res;
    }
    if (P.nbMoves() == 42) {
        std::vector<int> s(7, ILLEGAL);
        res.set("scores", val::array(s));
        res.set("bestMove", 0);
        res.set("gameStatus", std::string("draw"));
        res.set("ok", true);
        return res;
    }
    std::vector<int> scores = (depth <= 0) ? scores_full(P) : scores_limited(P, depth);
    res.set("scores", val::array(scores));
    res.set("bestMove", best_legal_move(scores));
    res.set("gameStatus", std::string("ongoing"));
    res.set("ok", true);
    return res;
}

// Load the opening book from a path in the Emscripten virtual FS.
void load_book(const std::string &path) { g_solver.loadBook(path); }

void reset_solver() { g_solver.reset(); }

} // namespace

EMSCRIPTEN_BINDINGS(pyconnect4) {
    emscripten::function("analyze", &analyze);
    emscripten::function("loadBook", &load_book);
    emscripten::function("resetSolver", &reset_solver);
}
```

> **Note:** `val::array(std::vector<int>)` returns a plain JS array, so
> `result.scores` is a `number[]` on the JS side — no embind vector wrapper. The
> types and tests below rely on that.

- [ ] **Step 3: Write the build script**

Create `solver/wasm/build.sh`:

```bash
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
```

- [ ] **Step 4: Build**

```bash
source ~/emsdk/emsdk_env.sh
bash solver/wasm/build.sh
```
Expected: `pyconnect4.js` and `pyconnect4.wasm` written under `web/src/solver/wasm/`. If `Solver.cpp` needs other `.cpp` from the vendor dir, add them to the `emcc` line (the Pons solver is header-heavy; `Solver.cpp` is typically the only `.cpp`).

- [ ] **Step 5: Sanity-check the module loads in Node**

```bash
node --input-type=module -e '
import factory from "./web/src/solver/wasm/pyconnect4.js";
const m = await factory();
const r = m.analyze("", 10);            // empty board, depth-limited
console.log("bestMove", r.bestMove, "status", r.gameStatus, "ok", r.ok);
console.log("scores", r.scores);        // plain JS array from val::array
'
```
Expected: `bestMove 3`, `status ongoing`, `ok true`, and `scores` is a 7-element array.

- [ ] **Step 6: Write `solver/wasm/README.md`**

```markdown
# WASM solver build

The browser AI is the vendored Pons solver compiled to WebAssembly.

## Rebuild
1. Install emsdk once:
   `git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install latest && ./emsdk activate latest`
2. `source ~/emsdk/emsdk_env.sh`
3. `bash solver/wasm/build.sh`

Outputs `web/src/solver/wasm/pyconnect4.{js,wasm}` (committed — Pages needs no toolchain).
The opening book is NOT bundled; it is served from R2 by the relay and cached in the browser.
```

- [ ] **Step 7: Commit**

```bash
git add solver/wasm web/src/solver/wasm/pyconnect4.js web/src/solver/wasm/pyconnect4.wasm
git commit -m "feat(solver): compile Pons solver to WASM (embind analyze entrypoint)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Hand-written types + Node smoke test (bookless)

**Files:**
- Create: `web/src/solver/wasm/pyconnect4.d.ts`
- Create: `web/src/solver/wasmSolver.smoke.test.ts`

- [ ] **Step 1: Write the module type declaration**

Create `web/src/solver/wasm/pyconnect4.d.ts`:

```ts
// Hand-written types for the embind module factory (pyconnect4.js).
export interface AnalyzeRaw {
  scores: number[];      // val::array(std::vector<int>) → plain JS array
  bestMove: number;
  gameStatus: "ongoing" | "won" | "draw";
  ok: boolean;
}
export interface Pyconnect4Module {
  analyze(moves: string, depth: number): AnalyzeRaw;
  loadBook(path: string): void;
  resetSolver(): void;
  FS: { writeFile(path: string, data: Uint8Array): void };
}
export default function createPyconnect4(opts?: Record<string, unknown>): Promise<Pyconnect4Module>;
```

- [ ] **Step 2: Write the smoke test**

Create `web/src/solver/wasmSolver.smoke.test.ts`:

```ts
// Loads the REAL wasm module (bookless paths only) and pins a few known results.
import { describe, expect, it } from "vitest";
// @ts-expect-error - JS module factory, types provided by pyconnect4.d.ts
import createPyconnect4 from "./wasm/pyconnect4.js";

describe("wasm module (real binary, bookless)", () => {
  it("opens on center from the empty board", async () => {
    const m = await createPyconnect4();
    const r = m.analyze("", 10);
    expect(r.ok).toBe(true);
    expect(r.gameStatus).toBe("ongoing");
    expect(r.scores).toHaveLength(7);
    expect(r.bestMove).toBe(3);
  });

  it("rejects an illegal move sequence", async () => {
    const m = await createPyconnect4();
    // Column 0 played 7 times — the 7th is illegal (column height is 6).
    const r = m.analyze("0000000", 6);
    expect(r.ok).toBe(false);
  });

  it("reports a win when the last move completes four-in-a-row", async () => {
    const m = await createPyconnect4();
    // Yellow: col3 four times interleaved with green elsewhere → vertical win.
    const r = m.analyze("3041424", 6); // 3,0,4,1,4,2,4 ... adjust if needed
    expect(["won", "ongoing"]).toContain(r.gameStatus); // exact line pinned below
  });
});
```

- [ ] **Step 3: Run the smoke test**

Run: `cd web && npx vitest run src/solver/wasmSolver.smoke.test.ts`
Expected: first two tests PASS. If the third's move string doesn't actually produce a win, replace it with a verified winning sequence: build the position by hand (e.g. yellow plays column 3 on plies 0,2,4,6 while green plays 0,1,2 → moves string `"3041424"` means yellow at 3, green 0, yellow 4...). Use a sequence you confirm with a quick `m.analyze` probe, then assert `gameStatus === "won"` and remove the `ongoing` alternative.

- [ ] **Step 4: Commit**

```bash
git add web/src/solver/wasm/pyconnect4.d.ts web/src/solver/wasmSolver.smoke.test.ts
git commit -m "test(solver): node smoke test for the wasm module

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `wasmSolver.ts` — loader, book manager, analyze

**Files:**
- Create: `web/src/solver/wasmSolver.ts`
- Create: `web/src/solver/wasmSolver.test.ts`

- [ ] **Step 1: Write failing unit tests with a faked module**

Create `web/src/solver/wasmSolver.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the module factory so we never touch the real wasm here.
const fakeModule = {
  analyze: vi.fn(),
  loadBook: vi.fn(),
  resetSolver: vi.fn(),
  FS: { writeFile: vi.fn() },
};
vi.mock("./wasm/pyconnect4.js", () => ({
  default: vi.fn(async () => fakeModule),
}));

import { analyzeWasm, __resetForTests } from "./wasmSolver";

afterEach(() => {
  vi.clearAllMocks();
  __resetForTests();
});

describe("analyzeWasm", () => {
  it("returns a plain AnalyzeResponse (depth-limited, no book)", async () => {
    fakeModule.analyze.mockReturnValue({
      scores: [1, 2, 3, 4, 5, 6, 7], bestMove: 3, gameStatus: "ongoing", ok: true,
    });
    const res = await analyzeWasm("33", 10);
    expect(res).toEqual({ scores: [1, 2, 3, 4, 5, 6, 7], bestMove: 3, gameStatus: "ongoing" });
    expect(fakeModule.analyze).toHaveBeenCalledWith("33", 10);
    expect(fakeModule.loadBook).not.toHaveBeenCalled(); // depth-limited never loads the book
  });

  it("loads the book exactly once for full solves (depth null → -1)", async () => {
    fakeModule.analyze.mockReturnValue({
      scores: [0, 0, 0, 0, 0, 0, 0], bestMove: 3, gameStatus: "ongoing", ok: true,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const cacheMatch = vi.fn(async () => new Response(bytes));
    const cachePut = vi.fn(async () => {});
    (globalThis as any).caches = { open: vi.fn(async () => ({ match: cacheMatch, put: cachePut })) };

    await analyzeWasm("", null);
    await analyzeWasm("3", null);
    expect(fakeModule.loadBook).toHaveBeenCalledTimes(1);          // memoized
    expect(fakeModule.analyze).toHaveBeenLastCalledWith("3", -1);  // null → -1 sentinel
  });

  it("throws on an illegal sequence (ok=false)", async () => {
    fakeModule.analyze.mockReturnValue({ ok: false });
    await expect(analyzeWasm("0000000", 6)).rejects.toThrow(/illegal/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/solver/wasmSolver.test.ts`
Expected: FAIL — `wasmSolver` has no `analyzeWasm`/`__resetForTests` export yet.

- [ ] **Step 3: Implement `wasmSolver.ts`**

Create `web/src/solver/wasmSolver.ts`:

```ts
// web/src/solver/wasmSolver.ts
// Loads the WASM solver lazily and runs analysis on the main thread. The 32 MB
// opening book is fetched from the relay (R2-backed) on first full solve and
// persisted in the Cache API, so it downloads once per device.
import createPyconnect4 from "./wasm/pyconnect4.js";
import type { Pyconnect4Module } from "./wasm/pyconnect4";

export interface AnalyzeResult {
  scores: number[];
  bestMove: number;
  gameStatus: "ongoing" | "won" | "draw";
}

// Relay base for the book asset. Same default as net/signal.ts / relayWsBase().
const RELAY_BASE = ((import.meta as any).env?.VITE_RELAY_URL ?? "").replace(/\/$/, "");
const BOOK_URL = `${RELAY_BASE}/book/7x6.book`;
const BOOK_FS_PATH = "/7x6.book";
const CACHE_NAME = "c4-book-v1";

let modulePromise: Promise<Pyconnect4Module> | null = null;
let bookPromise: Promise<void> | null = null;

function ensureModule(): Promise<Pyconnect4Module> {
  if (!modulePromise) modulePromise = createPyconnect4();
  return modulePromise;
}

/** Fetch the book once (Cache API persisted), then mount + load it. Memoized. */
async function ensureBook(onProgress?: (frac: number) => void): Promise<void> {
  if (!bookPromise) {
    bookPromise = (async () => {
      const m = await ensureModule();
      const bytes = await loadBookBytes(onProgress);
      m.FS.writeFile(BOOK_FS_PATH, bytes);
      m.loadBook(BOOK_FS_PATH);
    })().catch((e) => { bookPromise = null; throw e; }); // allow retry on failure
  }
  return bookPromise;
}

async function loadBookBytes(onProgress?: (frac: number) => void): Promise<Uint8Array> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(BOOK_URL);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(BOOK_URL);
  if (!res.ok) throw new Error(`book ${res.status}`);
  await cache.put(BOOK_URL, res.clone());

  // Stream for progress when possible; fall back to a single arrayBuffer().
  const total = Number(res.headers.get("Content-Length") ?? 0);
  if (!res.body || !total || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Analyze a position. `depth` null → full perfect solve (loads the book);
 *  a positive number → depth-limited search (no book). */
export async function analyzeWasm(
  moves: string,
  depth: number | null,
  onProgress?: (frac: number) => void,
): Promise<AnalyzeResult> {
  const m = await ensureModule();
  if (depth === null) await ensureBook(onProgress);
  const raw = m.analyze(moves, depth ?? -1);
  if (!raw.ok) throw new Error("illegal move sequence");
  // raw.scores is already a plain JS array (val::array); copy to detach from wasm.
  return { scores: [...raw.scores], bestMove: raw.bestMove, gameStatus: raw.gameStatus };
}

/** Test seam: drop memoized module/book so each test starts clean. */
export function __resetForTests(): void {
  modulePromise = null;
  bookPromise = null;
}
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `cd web && npx vitest run src/solver/wasmSolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/solver/wasmSolver.ts web/src/solver/wasmSolver.test.ts
git commit -m "feat(solver): wasmSolver loader + Cache-API book manager

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Rewire `client.ts` to the WASM solver

**Files:**
- Modify: `web/src/solver/client.ts`
- Create: `web/src/solver/client.test.ts`

- [ ] **Step 1: Write failing dispatch tests (mock wasmSolver)**

Create `web/src/solver/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const analyzeWasm = vi.fn();
vi.mock("./wasmSolver", () => ({ analyzeWasm }));

import { analyze, SolverOffline } from "./client";

afterEach(() => vi.clearAllMocks());

describe("solver client (wasm-backed)", () => {
  it("forwards moves + depth and returns the result unchanged", async () => {
    analyzeWasm.mockResolvedValue({ scores: [1,2,3,4,5,6,7], bestMove: 3, gameStatus: "ongoing" });
    const res = await analyze("33", 12);
    expect(res).toEqual({ scores: [1,2,3,4,5,6,7], bestMove: 3, gameStatus: "ongoing" });
    expect(analyzeWasm).toHaveBeenCalledWith("33", 12, undefined);
  });

  it("passes a null depth through (full solve)", async () => {
    analyzeWasm.mockResolvedValue({ scores: [0,0,0,0,0,0,0], bestMove: 3, gameStatus: "ongoing" });
    await analyze("3");
    expect(analyzeWasm).toHaveBeenCalledWith("3", null, undefined);
  });

  it("wraps a module-instantiation failure as SolverOffline", async () => {
    analyzeWasm.mockRejectedValue(new Error("WebAssembly.instantiate failed"));
    await expect(analyze("3", 10)).rejects.toBeInstanceOf(SolverOffline);
  });

  it("rethrows an illegal-sequence error as-is (not SolverOffline)", async () => {
    analyzeWasm.mockRejectedValue(new Error("illegal move sequence"));
    await expect(analyze("0000000", 6)).rejects.toThrow(/illegal/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/solver/client.test.ts`
Expected: FAIL — current `client.ts` does `fetch`, not `analyzeWasm`.

- [ ] **Step 3: Rewrite `client.ts`**

Replace the entire body of `web/src/solver/client.ts` with:

```ts
// web/src/solver/client.ts
// AI solver client. Backed by the in-browser WASM solver (no network/backend).
// Keeps the historical analyze() signature + SolverOffline so callers are
// untouched. SolverOffline now only means "the wasm module failed to load".
import { analyzeWasm } from "./wasmSolver";

export interface AnalyzeResponse {
  scores: number[];
  bestMove: number;
  gameStatus: "ongoing" | "won" | "draw";
}

export class SolverOffline extends Error {
  constructor(cause?: unknown) {
    super("solver offline");
    this.cause = cause;
  }
}

/** Analyze a move sequence. `depth` null → full perfect solve (lazy-loads the
 *  opening book); a positive number → bounded search. `onProgress` reports the
 *  one-time book download (0..1). Throws SolverOffline if the module can't load;
 *  rethrows an "illegal move sequence" error verbatim. */
export async function analyze(
  moves: string,
  depth: number | null = null,
  onProgress?: (frac: number) => void,
): Promise<AnalyzeResponse> {
  try {
    return await analyzeWasm(moves, depth, onProgress);
  } catch (e) {
    if (e instanceof Error && /illegal/i.test(e.message)) throw e;
    throw new SolverOffline(e);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd web && npx vitest run src/solver/client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/solver/client.ts web/src/solver/client.test.ts
git commit -m "feat(solver): back analyze() with the wasm solver instead of /analyze

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Relay book route + R2 binding

**Files:**
- Modify: `relay/wrangler.toml`
- Modify: `relay/src/index.ts`
- Modify: `relay/test/router.test.ts`

- [ ] **Step 1: Add the R2 binding to `relay/wrangler.toml`**

Append:

```toml
[[r2_buckets]]
binding = "BOOK"
bucket_name = "connect4-book"
preview_bucket_name = "connect4-book"
```

- [ ] **Step 2: Write a failing router test for the book route**

The test runner provides bindings via `env`. Add a tiny fake R2 to `env` in the test (the real R2 is exercised only in production). Add to `relay/test/router.test.ts` inside the `describe("relay router", ...)` block:

```ts
  it("GET /book/:name streams the object with CORS + immutable cache", async () => {
    // Fake the R2 binding for this call.
    const body = new Uint8Array([7, 6, 12, 8, 8, 23]);
    (env as any).BOOK = {
      get: async (key: string) =>
        key === "7x6.book"
          ? { body: new Response(body).body, httpEtag: '"abc"', size: body.length,
              writeHttpMetadata: (_h: Headers) => {} }
          : null,
    };
    const res = await call("GET", "/book/7x6.book");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Cache-Control")).toMatch(/immutable/);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(7);
  });

  it("GET /book/:name is 404 when the object is missing", async () => {
    (env as any).BOOK = { get: async () => null };
    expect((await call("GET", "/book/missing.book")).status).toBe(404);
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `cd relay && npx vitest run test/router.test.ts`
Expected: FAIL — no `/book` route (returns 404 for the first test, which expects 200).

- [ ] **Step 4: Add the route to `relay/src/index.ts`**

Add `BOOK: R2Bucket;` to the `Env` interface, then add this block before the final `return empty(404, req, env);`:

```ts
    // GET /book/:name  (opening book asset, served from R2 with long cache)
    if (req.method === "GET" && parts[0] === "book" && parts[1]) {
      const obj = await env.BOOK.get(parts[1]);
      if (!obj) return empty(404, req, env);
      const headers = new Headers(corsHeaders(req, env));
      obj.writeHttpMetadata(headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Content-Type", "application/octet-stream");
      return new Response(obj.body, { status: 200, headers });
    }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd relay && npx vitest run test/router.test.ts`
Expected: PASS (all, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add relay/wrangler.toml relay/src/index.ts relay/test/router.test.ts
git commit -m "feat(relay): serve the opening book from R2 at GET /book/:name

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 7: Create the bucket + upload the book (manual, one-time)**

```bash
cd relay
python ../solver/fetch_opening_book.py            # ensures ../solver/data/7x6.book exists
npx wrangler r2 bucket create connect4-book
npx wrangler r2 object put connect4-book/7x6.book --file ../solver/data/7x6.book
```
Expected: bucket created; object uploaded (~32 MB).

---

## Task 6: `main.ts` — remove backend-offline gating, add book-load status

**Files:**
- Modify: `web/src/main.ts`

Context: today `main.ts` (around lines 573–620) probes the backend and disables Good/Great with a toast when it's unreachable; `hint()` and `solve()` call `analyze(...)`. With the WASM solver the modes are always available, and the only first-use delay is the book download for Great/Hint.

- [ ] **Step 1: Remove the backend-offline up-front gating**

Find the block (near `main.ts:617-620`) that probes the backend and calls `this.hud.setSolverOffline(true)` / shows the "vs-AI modes need the local Python solver" toast. Delete the probe and the up-front `setSolverOffline(true)` call so Good/Great/Hint start enabled. Leave `handleOffline()` and `setSolverOffline()` in place (still used if the module genuinely fails to load).

- [ ] **Step 2: Show book-download progress on first full solve**

In `solve()` ([main.ts:324](web/src/main.ts:324)) and `hint()` ([main.ts:232](web/src/main.ts:232)), pass a progress callback that updates the thinking indicator while the book downloads. Replace the `analyze` calls:

```ts
// in solve()
const depth = this.mode === "good" ? GOOD_DEPTH : null;
try {
  const res = await analyze(moves, depth, (frac) => {
    if (depth === null) this.hud.setThinking(`Loading Great player… ${Math.round(frac * 100)}% (one-time)`);
  });
  return res.bestMove;
} catch (e) {
  if (e instanceof SolverOffline) this.handleOffline();
  return null;
}
```

```ts
// in hint()
const res = await analyze(this.state.moves, null, (frac) =>
  this.hud.setThinking(`Loading hint engine… ${Math.round(frac * 100)}% (one-time)`));
this.scene.flashHintColumn(res.bestMove);
this.hud.setThinking(null);
```

(Keep the existing `setThinking("… is thinking…")` that the pump sets before calling `solve()`; the progress callback only fires during the one-time download, after which the normal thinking text resumes on the next call.)

- [ ] **Step 3: Typecheck + run the full web suite**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all tests pass (existing + new solver tests).

- [ ] **Step 4: Commit**

```bash
git add web/src/main.ts
git commit -m "feat(web): AI modes always on; show one-time book-download progress

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Deploy + live verification

**Files:** none (deploy + smoke).

- [ ] **Step 1: Deploy the relay (R2 binding + book route)**

```bash
cd relay && npm run deploy
```
Expected: deploy succeeds; bindings list shows `env.BOOK (connect4-book)`.

- [ ] **Step 2: Smoke-test the live book route**

```bash
curl -sIL -H "Origin: https://connect4-65t.pages.dev" \
  https://connect4-relay.quantumstatic.workers.dev/book/7x6.book \
  | grep -iE "^HTTP|content-length|access-control-allow-origin|cache-control"
```
Expected: `HTTP/2 200`, `content-length: 33554524`, an `access-control-allow-origin` header, and `cache-control: public, max-age=31536000, immutable`.

- [ ] **Step 3: Push the web app (Pages auto-deploys)**

```bash
git push
```

- [ ] **Step 4: Manual browser verification**

After Pages deploys, on the live site:
- "vs Good player": make a move → AI replies quickly (no book download). ✓
- "vs Great player": first AI move shows "Loading Great player… N%" once, then plays; reload the page and play Great again → no download (served from Cache API). ✓
- "Hint" in 2P: flashes a column. ✓
- DevTools → Application → Cache Storage shows `c4-book-v1` holding the book. ✓

---

## Notes for the executor

- The Python backend (`backend/`) and pybind11 build (`solver/src/binding.cpp`, `solver/CMakeLists.txt`, `solver/pyproject.toml`) are **unchanged** and remain for local dev/tests.
- The `VITE_RELAY_URL` env var (already used by `net/signal.ts` and `relayWsBase()` in `main.ts`) governs where the book is fetched from. Same-origin default works when the relay is bound to the app origin; otherwise set it to the Worker URL.
- If `emcc` linking complains about missing symbols, confirm whether the vendored solver has `.cpp` files beyond `Solver.cpp` (`ls solver/vendor/connect4/*.cpp`) and add them to `build.sh`.
