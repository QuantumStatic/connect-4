// web/src/solver/client.ts

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

export async function analyze(moves: string, depth: number | null = null): Promise<AnalyzeResponse> {
  let res: Response;
  try {
    res = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves, depth }),
    });
  } catch (e) {
    throw new SolverOffline(e);
  }
  if (!res.ok) throw new SolverOffline(`HTTP ${res.status}`);
  return (await res.json()) as AnalyzeResponse;
}
