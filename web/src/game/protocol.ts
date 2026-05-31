// web/src/game/protocol.ts
// Pure move-wire protocol for P2P play. No DOM, no fetch, no WebRTC.
import { GameState, type Cell } from "./state";

export interface MoveDelta {
  ply: number; // 0-based index of this move in the log
  col: number; // 0-6
  hash: string; // hashLog of the move log AFTER applying this move
}

/** Running per-color win tally for the room. Transmitted only on `sync` (tiny:
 *  two ints) and reconciled by element-wise max — scores only ever increase, so
 *  max is idempotent across reconnects and avoids double-counting. */
export interface Score {
  yellow: number;
  green: number;
}

export type WireMsg =
  | { type: "move"; delta: MoveDelta }
  | { type: "sync"; gen: number; log: string; score?: Score }
  | { type: "newgame"; gen: number }
  | { type: "bye" }; // peer is intentionally leaving — don't try to reconnect

/** Element-wise max of two scores. Idempotent reconciliation for `sync`. */
export function mergeScores(a: Score, b: Score): Score {
  return { yellow: Math.max(a.yellow, b.yellow), green: Math.max(a.green, b.green) };
}

/** What to do when a `sync` arrives, given local vs remote (generation, log).
 *  `gen` is a monotonic game counter bumped on every New Game — it lets a reset
 *  (shorter/empty log at a HIGHER gen) win over an older, longer game, which
 *  plain longest-prefix reconciliation cannot express.
 *
 *  - "adopt": take the remote game wholesale (it's newer or further along)
 *  - "push":  we're ahead — re-send our state so the peer catches up
 *  - "noop":  already in agreement
 *  - "conflict": same gen but logs diverged (impossible without a bug/tamper) */
export type SyncDecision =
  | { action: "adopt"; gen: number; log: string }
  | { action: "push" }
  | { action: "noop" }
  | { action: "conflict" };

export function decideSync(
  localGen: number,
  localLog: string,
  remoteGen: number,
  remoteLog: string,
): SyncDecision {
  if (remoteGen > localGen) return { action: "adopt", gen: remoteGen, log: remoteLog };
  if (remoteGen < localGen) return { action: "push" };
  // Same generation → reconcile by move-log prefix.
  const agreed = reconcileLogs(localLog, remoteLog);
  if (agreed === "conflict") return { action: "conflict" };
  if (agreed === localLog && agreed === remoteLog) return { action: "noop" };
  if (agreed === remoteLog) return { action: "adopt", gen: localGen, log: remoteLog };
  return { action: "push" }; // our log is the longer one
}

/** FNV-1a (32-bit) over the canonical move-log string. Deterministic, fast,
 *  and good enough as a desync tripwire (not a security hash). */
export function hashLog(moves: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < moves.length; i++) {
    h ^= moves.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Build the delta for playing `col` from the current state (move not yet applied). */
export function makeDelta(state: GameState, col: number): MoveDelta {
  const ply = state.moves.length;
  return { ply, col, hash: hashLog(state.moves + String(col)) };
}

export type Verdict = "ok" | "duplicate" | "illegal" | "desync";

/** Validate an incoming opponent delta against local state.
 *  `opponentSide` is the color the remote peer controls. */
export function validateIncoming(state: GameState, delta: MoveDelta, opponentSide: Cell): Verdict {
  if (delta.ply < state.moves.length) return "duplicate";
  if (delta.ply > state.moves.length) return "desync"; // gap — logs diverged
  if (state.status !== "ongoing") return "illegal";
  if (state.toMove !== opponentSide) return "illegal"; // not their turn
  if (!Number.isInteger(delta.col) || delta.col < 0 || delta.col > 6) return "illegal";
  if (!state.legalColumns().includes(delta.col)) return "illegal";
  if (delta.hash !== hashLog(state.moves + String(delta.col))) return "desync";
  return "ok";
}

/** Reconcile two move logs. Returns the agreed log, or "conflict" if neither is
 *  a prefix of the other (should be impossible without a bug or tampering). */
export function reconcileLogs(localLog: string, remoteLog: string): string | "conflict" {
  if (localLog === remoteLog) return localLog;
  if (remoteLog.startsWith(localLog)) return remoteLog;
  if (localLog.startsWith(remoteLog)) return localLog;
  return "conflict";
}
