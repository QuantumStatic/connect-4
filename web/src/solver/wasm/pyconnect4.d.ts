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
