// web/src/game/protocol.test.ts
import { describe, expect, it } from "vitest";
import { GameState } from "./state";
import { hashLog, makeDelta, validateIncoming, reconcileLogs, mergeScores, decideSync, type WireMsg } from "./protocol";

describe("hashLog", () => {
  it("is deterministic and order-sensitive", () => {
    expect(hashLog("3342")).toBe(hashLog("3342"));
    expect(hashLog("3342")).not.toBe(hashLog("3324"));
  });
  it("empty log hashes to a stable 8-hex-char FNV-1a value", () => {
    expect(hashLog("")).toMatch(/^[0-9a-f]{8}$/);
    // FNV-1a offset basis for empty input
    expect(hashLog("")).toBe("811c9dc5");
  });
});

describe("makeDelta", () => {
  it("captures ply, column, and post-move hash", () => {
    const g = GameState.fromSequence("33"); // 2 moves played; next ply index = 2
    const d = makeDelta(g, 4);
    expect(d).toEqual({ ply: 2, col: 4, hash: hashLog("334") });
  });
});

describe("validateIncoming", () => {
  // localSide = "yellow" (host), so opponent = "green".
  // After "3" (yellow moved), it is green's turn at ply 1.
  it("accepts a legal opponent move at the expected ply", () => {
    const g = GameState.fromSequence("3");
    const d = { ply: 1, col: 4, hash: hashLog("34") };
    expect(validateIncoming(g, d, "green")).toBe("ok");
  });
  it("flags an already-applied ply as duplicate", () => {
    const prior = GameState.fromSequence("3");
    const stale = makeDelta(prior, 4);          // ply 1, hash matches "34"
    const g = GameState.fromSequence("34");      // state has already advanced past it
    expect(validateIncoming(g, stale, "green")).toBe("duplicate");
  });
  it("flags a future ply (gap in delivery) as desync", () => {
    const g = GameState.fromSequence("3");      // next ply = 1
    const d = { ply: 5, col: 4, hash: "anything" };
    expect(validateIncoming(g, d, "green")).toBe("desync");
  });
  it("rejects an out-of-range column as illegal", () => {
    const g = GameState.fromSequence("3");      // green's turn at ply 1
    const dHigh = { ply: 1, col: 7, hash: "x" };
    const dLow = { ply: 1, col: -1, hash: "x" };
    expect(validateIncoming(g, dHigh, "green")).toBe("illegal");
    expect(validateIncoming(g, dLow, "green")).toBe("illegal");
  });
  it("rejects any move once the game is already won", () => {
    const g = GameState.fromSequence("0102030"); // yellow wins vertically in col 0
    expect(g.status).toBe("won");
    const d = { ply: 7, col: 4, hash: "x" };
    expect(validateIncoming(g, d, "green")).toBe("illegal");
  });
  it("rejects a move into a full column as illegal", () => {
    const g = GameState.fromSequence("000000" + "1"); // col 0 full (6), then yellow plays 1
    // it's green's turn at ply 7; col 0 is full → illegal
    const d = { ply: 7, col: 0, hash: "whatever" };
    expect(validateIncoming(g, d, "green")).toBe("illegal");
  });
  it("rejects a move when it is NOT the opponent's turn", () => {
    const g = GameState.fromSequence("34"); // it's yellow's turn (ply 2)
    const d = { ply: 2, col: 5, hash: hashLog("345") };
    expect(validateIncoming(g, d, "green")).toBe("illegal"); // green moving on yellow's turn
  });
  it("flags a hash mismatch as desync", () => {
    const g = GameState.fromSequence("3");
    const d = { ply: 1, col: 4, hash: "bad-hash" };
    expect(validateIncoming(g, d, "green")).toBe("desync");
  });
});

describe("WireMsg union", () => {
  it("accepts a newgame variant carrying a generation", () => {
    const m: WireMsg = { type: "newgame", gen: 3 };
    expect(m.type).toBe("newgame");
    if (m.type === "newgame") expect(m.gen).toBe(3);
  });
  it("accepts a sync variant with gen + log", () => {
    const m: WireMsg = { type: "sync", gen: 0, log: "334" };
    expect(m.type).toBe("sync");
    if (m.type === "sync") expect(m.log).toBe("334");
  });
  it("accepts a sync variant carrying a score", () => {
    const m: WireMsg = { type: "sync", gen: 1, log: "33", score: { yellow: 2, green: 1 } };
    if (m.type === "sync") expect(m.score).toEqual({ yellow: 2, green: 1 });
  });
});

describe("decideSync", () => {
  it("adopts the remote game when its generation is higher (new game wins)", () => {
    // Local is mid-game at gen 0; remote reset to an empty board at gen 1.
    expect(decideSync(0, "334", 1, "")).toEqual({ action: "adopt", gen: 1, log: "" });
  });
  it("pushes our state when our generation is higher", () => {
    expect(decideSync(2, "", 1, "3342")).toEqual({ action: "push" });
  });
  it("adopts the longer log at the same generation", () => {
    expect(decideSync(0, "33", 0, "3342")).toEqual({ action: "adopt", gen: 0, log: "3342" });
  });
  it("pushes when our log is the longer one at the same generation", () => {
    expect(decideSync(0, "3342", 0, "33")).toEqual({ action: "push" });
  });
  it("no-ops when both sides already agree", () => {
    expect(decideSync(1, "3342", 1, "3342")).toEqual({ action: "noop" });
  });
  it("flags a conflict when same-gen logs diverge", () => {
    expect(decideSync(0, "334", 0, "335")).toEqual({ action: "conflict" });
  });
});

describe("mergeScores", () => {
  it("takes the element-wise maximum", () => {
    expect(mergeScores({ yellow: 2, green: 1 }, { yellow: 1, green: 3 }))
      .toEqual({ yellow: 2, green: 3 });
  });
  it("is idempotent — merging equal scores is a no-op", () => {
    const s = { yellow: 4, green: 2 };
    expect(mergeScores(s, { ...s })).toEqual(s);
  });
  it("adopts a peer's higher tally (mid-series join)", () => {
    expect(mergeScores({ yellow: 0, green: 0 }, { yellow: 3, green: 2 }))
      .toEqual({ yellow: 3, green: 2 });
  });
});

describe("reconcileLogs", () => {
  it("returns the longer log when the shorter is a prefix", () => {
    expect(reconcileLogs("33", "3342")).toBe("3342");
    expect(reconcileLogs("3342", "33")).toBe("3342");
  });
  it("returns equal log unchanged", () => {
    expect(reconcileLogs("3342", "3342")).toBe("3342");
  });
  it("returns 'conflict' when neither is a prefix of the other", () => {
    expect(reconcileLogs("334", "335")).toBe("conflict");
  });
});
