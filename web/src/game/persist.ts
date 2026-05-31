// web/src/game/persist.ts
// localStorage persistence for resume-on-reload.

import { GameState } from "./state";

export type Mode = "2P" | "good" | "great" | "friend";

export interface Score { yellow: number; green: number; }

export interface SavedGame {
  moves: string;
  mode: Mode;
  humanSide: "yellow" | "green" | null; // localSide in vs-AI / friend; null in 2P
  roomId?: string; // present in friend mode
  score?: Score; // running room-wide tally (friend mode)
  gen?: number; // monotonic game counter (friend mode) for reset-aware resync
  ts: number;
}

// v3: added "friend" mode + roomId. score/gen are optional + back-compat (no key bump).
const KEY = "connect4:save:v3";

export function save(
  g: GameState,
  mode: Mode,
  humanSide: SavedGame["humanSide"],
  roomId?: string,
  score?: Score,
  gen?: number,
): void {
  const data: SavedGame = { moves: g.moves, mode, humanSide, roomId, score, gen, ts: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* quota — ignore */ }
}

export function load(): SavedGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedGame;
    if (typeof parsed.moves !== "string" || !/^[0-6]*$/.test(parsed.moves)) return null;
    if (!["2P", "good", "great", "friend"].includes(parsed.mode)) return null;
    GameState.fromSequence(parsed.moves); // validate by replay
    return parsed;
  } catch {
    return null;
  }
}

export function clear(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
