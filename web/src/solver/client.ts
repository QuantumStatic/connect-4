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
