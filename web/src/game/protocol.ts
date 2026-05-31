// web/src/game/protocol.ts
// Pure move-wire protocol for P2P play. No DOM, no fetch, no WebRTC.
import { GameState, type Cell } from "./state";

export interface MoveDelta {
  ply: number; // 0-based index of this move in the log
  col: number; // 0-6
  hash: string; // hashLog of the move log AFTER applying this move
}

export type WireMsg =
  | { type: "move"; delta: MoveDelta }
  | { type: "sync"; log: string };

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
