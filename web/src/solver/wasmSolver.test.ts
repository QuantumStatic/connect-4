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
