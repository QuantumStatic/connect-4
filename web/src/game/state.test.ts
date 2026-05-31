// web/src/game/state.test.ts
import { describe, expect, it } from "vitest";
import { GameState, type Cell } from "./state";

const PLAYERS: Cell[] = ["yellow", "green"];

describe("GameState", () => {
  it("starts empty with yellow to move", () => {
    const g = new GameState();
    expect(g.toMove).toBe("yellow");
    expect(g.moves).toBe("");
    expect(g.status).toBe("ongoing");
    for (let c = 0; c < 7; c++) for (let r = 0; r < 6; r++) expect(g.grid[c][r]).toBeNull();
  });

  it("applyMove places chip at the lowest empty row and alternates players", () => {
    const g = new GameState();
    g.applyMove(3);
    expect(g.grid[3][0]).toBe("yellow");
    expect(g.toMove).toBe("green");
    g.applyMove(3);
    expect(g.grid[3][1]).toBe("green");
    expect(g.moves).toBe("33");
  });

  it("rejects out-of-range columns", () => {
    const g = new GameState();
    expect(() => g.applyMove(-1)).toThrow();
    expect(() => g.applyMove(7)).toThrow();
  });

  it("rejects moves into a full column", () => {
    const g = new GameState();
    for (let i = 0; i < 6; i++) g.applyMove(0);
    expect(() => g.applyMove(0)).toThrow();
  });

  it("detects horizontal win", () => {
    const g = new GameState();
    // Y@0, R@4, Y@1, R@5, Y@2, R@6, Y@3 → yellow wins cols 0–3 in row 0
    "0415263".split("").forEach((c) => g.applyMove(parseInt(c, 10)));
    expect(g.status).toBe("won");
    expect(g.winner).toBe("yellow");
    expect(g.winningCells).toHaveLength(4);
  });

  it("detects vertical win", () => {
    const g = new GameState();
    // Y@0, R@1, Y@0, R@1, Y@0, R@1, Y@0 → yellow wins col 0 rows 0–3
    "0101010".split("").forEach((c) => g.applyMove(parseInt(c, 10)));
    expect(g.status).toBe("won");
    expect(g.winner).toBe("yellow");
  });

  it("detects positive-slope diagonal win", () => {
    const g = new GameState();
    // Yellow ends at (0,0),(1,1),(2,2),(3,3)
    "0112422536333".split("").forEach((c) => g.applyMove(parseInt(c, 10)));
    expect(g.status).toBe("won");
  });

  it("detects draw on full board with no winner", () => {
    const g = new GameState();
    // Construct a known draw sequence (42 moves, no four-in-a-row).
    // Original sequence created a win; using a verified draw sequence instead.
    const drawSeq = "333333222222444444011111155555500000666666";
    for (const ch of drawSeq) g.applyMove(parseInt(ch, 10));
    expect(g.status).toBe("draw");
  });

  it("detects negative-slope diagonal win", () => {
    const g = new GameState();
    // Yellow wins at (0,3),(1,2),(2,1),(3,0) — descending diagonal (col+1, row-1).
    // Setup: col0 gets 3 red chips (rows 0-2), col1 gets 2 red chips (rows 0-1),
    // col2 gets 1 red chip (row 0), then yellow plays col3(r0), col2(r1), col1(r2), col0(r3).
    "6261615050503424140".split("").forEach((c) => g.applyMove(parseInt(c, 10)));
    expect(g.status).toBe("won");
    expect(g.winner).toBe("yellow");
  });

  it("fromSequence replays moves and matches applyMove path", () => {
    const g = GameState.fromSequence("3334");
    expect(g.moves).toBe("3334");
    expect(g.grid[3][0]).toBe("yellow");
    expect(g.grid[3][1]).toBe("green");
    expect(g.grid[3][2]).toBe("yellow");
    expect(g.grid[4][0]).toBe("green");
  });

  it("legalColumns excludes full columns", () => {
    const g = new GameState();
    for (let i = 0; i < 6; i++) g.applyMove(0);
    expect(g.legalColumns()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  void (PLAYERS as readonly string[]); // silence unused
});
