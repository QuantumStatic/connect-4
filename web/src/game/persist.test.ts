// web/src/game/persist.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { GameState } from "./state";
import { clear, load, save } from "./persist";

// Minimal in-memory localStorage shim — the test runner uses node env.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

const KEY_V3 = "connect4:save:v3";
const KEY_V2 = "connect4:save:v2";

beforeEach(() => {
  // Fresh storage per test.
  (globalThis as any).localStorage = new MemoryStorage();
});

describe("persist", () => {
  it("round-trips friend mode with a roomId", () => {
    const g = new GameState();
    g.applyMove(3);
    g.applyMove(2);
    save(g, "friend", "yellow", "abc123");
    const loaded = load();
    expect(loaded).not.toBeNull();
    expect(loaded!.mode).toBe("friend");
    expect(loaded!.humanSide).toBe("yellow");
    expect(loaded!.roomId).toBe("abc123");
    expect(loaded!.moves).toBe("32");
  });

  it("round-trips friend mode as green with no roomId (rehost-detection contract)", () => {
    const g = new GameState();
    g.applyMove(3);
    save(g, "friend", "green");
    const loaded = load();
    expect(loaded).not.toBeNull();
    expect(loaded!.mode).toBe("friend");
    expect(loaded!.humanSide).toBe("green");
    expect(loaded!.roomId).toBeUndefined();
  });

  it("round-trips the running score in friend mode", () => {
    const g = new GameState();
    g.applyMove(3);
    save(g, "friend", "yellow", "room1", { yellow: 2, green: 1 });
    const loaded = load();
    expect(loaded!.score).toEqual({ yellow: 2, green: 1 });
  });

  it("leaves score undefined when not provided (back-compat)", () => {
    const g = new GameState();
    save(g, "friend", "yellow", "room1");
    expect(load()!.score).toBeUndefined();
  });

  it("round-trips 2P mode with null humanSide and no roomId", () => {
    const g = new GameState();
    g.applyMove(0);
    save(g, "2P", null);
    const loaded = load();
    expect(loaded).not.toBeNull();
    expect(loaded!.mode).toBe("2P");
    expect(loaded!.humanSide).toBeNull();
    expect(loaded!.roomId).toBeUndefined();
  });

  it("ignores a v2 key — only reads v3", () => {
    localStorage.setItem(
      KEY_V2,
      JSON.stringify({ moves: "0123", mode: "2P", humanSide: null, ts: 0 }),
    );
    expect(load()).toBeNull();
  });

  it("returns null for malformed moves string", () => {
    localStorage.setItem(
      KEY_V3,
      JSON.stringify({ moves: "0X9", mode: "2P", humanSide: null, ts: 0 }),
    );
    expect(load()).toBeNull();
  });

  it("returns null for unknown mode", () => {
    localStorage.setItem(
      KEY_V3,
      JSON.stringify({ moves: "0", mode: "nope", humanSide: null, ts: 0 }),
    );
    expect(load()).toBeNull();
  });

  it("clear() removes the entry", () => {
    const g = new GameState();
    save(g, "2P", null);
    expect(localStorage.getItem(KEY_V3)).not.toBeNull();
    clear();
    expect(localStorage.getItem(KEY_V3)).toBeNull();
    expect(load()).toBeNull();
  });
});
