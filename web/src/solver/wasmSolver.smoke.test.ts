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
    // Column 0 played 7 times — the 7th overflows a height-6 column.
    const r = m.analyze("0000000", 6);
    expect(r.ok).toBe(false);
  });

  it("reports a win when the last move completes four-in-a-row", async () => {
    const m = await createPyconnect4();
    // Y0 G1 Y0 G1 Y0 G1 Y0 → yellow's 4th in column 0 wins.
    const r = m.analyze("0101010", 6);
    expect(r.ok).toBe(true);
    expect(r.gameStatus).toBe("won");
    expect(r.bestMove).toBe(0);
  });
});
