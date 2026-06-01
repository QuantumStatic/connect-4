import { afterEach, describe, expect, it, vi } from "vitest";

const { analyzeWasm } = vi.hoisted(() => ({ analyzeWasm: vi.fn() }));
vi.mock("./wasmSolver", () => ({ analyzeWasm }));

import { analyze, SolverOffline } from "./client";

afterEach(() => { vi.clearAllMocks(); });

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
