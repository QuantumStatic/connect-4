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
