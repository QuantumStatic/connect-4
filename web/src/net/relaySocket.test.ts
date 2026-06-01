import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelaySocket } from "./relaySocket";
import type { ConnState } from "./transport";

// Minimal fake WebSocket. Construct → instances pushed to `sockets`. Tests drive
// open/message/close manually.
class FakeWS {
  static OPEN = 1; static CLOSED = 3;
  static sockets: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeWS.sockets.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
  // helpers
  open() { this.readyState = FakeWS.OPEN; this.onopen?.(); }
  message(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

beforeEach(() => {
  FakeWS.sockets = [];
  vi.stubGlobal("WebSocket", FakeWS as any);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function latest(): FakeWS { return FakeWS.sockets[FakeWS.sockets.length - 1]; }

describe("RelaySocket", () => {
  it("connects and reports 'connected' once the welcome arrives", () => {
    const states: ConnState[] = [];
    const rs = new RelaySocket("wss://relay/ws/room1");
    rs.onState((s) => states.push(s));
    const ws = latest();
    ws.open();
    ws.message({ t: "welcome", color: "yellow", opponentHere: false });
    expect(states).toContain("connected");
    expect(rs.color).toBe("yellow");
  });

  it("surfaces game WireMsgs but consumes control frames", () => {
    const got: any[] = [];
    const rs = new RelaySocket("wss://relay/ws/room1");
    rs.onMessage((m) => got.push(m));
    const ws = latest();
    ws.open();
    ws.message({ t: "welcome", color: "green", opponentHere: true });
    ws.message({ t: "peer", here: false });
    ws.message({ type: "move", delta: { ply: 0, col: 3, hash: "h" } });
    expect(got).toEqual([{ type: "move", delta: { ply: 0, col: 3, hash: "h" } }]);
  });

  it("send returns false before open, true after", () => {
    const rs = new RelaySocket("wss://relay/ws/room1");
    expect(rs.send({ type: "ping", gen: 0, hash: "x" })).toBe(false);
    latest().open();
    expect(rs.send({ type: "ping", gen: 0, hash: "x" })).toBe(true);
    expect(latest().sent.length).toBe(1);
  });

  it("auto-reconnects after a close (opens a new socket)", () => {
    const states: ConnState[] = [];
    const rs = new RelaySocket("wss://relay/ws/room1");
    rs.onState((s) => states.push(s));
    latest().open();
    const before = FakeWS.sockets.length;
    latest().close();
    expect(states).toContain("reconnecting");
    vi.advanceTimersByTime(1000); // backoff window
    expect(FakeWS.sockets.length).toBe(before + 1);
  });

  it("close() stops reconnecting", () => {
    const rs = new RelaySocket("wss://relay/ws/room1");
    latest().open();
    rs.close();
    const n = FakeWS.sockets.length;
    latest().close();
    vi.advanceTimersByTime(5000);
    expect(FakeWS.sockets.length).toBe(n); // no new socket opened
  });
});
