// web/src/net/relaySocket.ts
// Transport over a WebSocket to the RoomDO. Reconnects with capped backoff. The
// DO sends `{t:"welcome"|"peer"}` control frames (consumed here to drive state +
// record assigned color) and game WireMsgs (passed through to onMessage).
import type { WireMsg } from "../game/protocol";
import type { Transport, ConnState } from "./transport";

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 5_000;

export class RelaySocket implements Transport {
  private ws: WebSocket | null = null;
  private msgFn: (m: WireMsg) => void = () => {};
  private stateFn: (s: ConnState) => void = () => {};
  private fullFn: () => void = () => {};
  private closed = false;
  private backoff = BACKOFF_START_MS;
  private timer: number | null = null;
  /** Color assigned by the DO (set from the welcome frame). */
  color: "yellow" | "green" | null = null;

  constructor(private url: string) { this.open(); }

  private open(): void {
    if (this.closed) return;
    this.stateFn("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.backoff = BACKOFF_START_MS; /* wait for welcome to mark connected */ };
    ws.onmessage = (e: MessageEvent) => this.handle(e.data as string);
    ws.onclose = (e: CloseEvent) => {
      if (e.code === 4001) {
        this.closed = true;
        this.stateFn("disconnected");
        this.fullFn();
        return;
      }
      this.onDrop();
    };
    ws.onerror = () => this.onDrop();
  }

  private handle(data: string): void {
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (m && m.t === "welcome") {
      this.color = m.color;
      this.stateFn("connected");
      return;
    }
    if (m && m.t === "peer") {
      // Opponent presence is informational; keep our own connection state as-is.
      return;
    }
    this.msgFn(m as WireMsg);
  }

  private onDrop(): void {
    if (this.closed) return;
    this.stateFn("reconnecting");
    if (this.timer !== null) return; // already scheduled
    this.timer = (globalThis as any).setTimeout(() => {
      this.timer = null;
      this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  send(msg: WireMsg): boolean {
    if (this.ws && this.ws.readyState === 1 /* WebSocket.OPEN */) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }
  onRoomFull(fn: () => void): void { this.fullFn = fn; }

  reconnectNow(): void {
    if (this.closed) return;
    // Cancel any pending backoff so we don't get a double-open after the forced one.
    if (this.timer !== null) { (globalThis as any).clearTimeout(this.timer); this.timer = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    // ws.close() → onclose → onDrop schedules the reopen (async in browsers).
    // If there's no live socket, drive onDrop directly.
    if (this.timer === null) this.onDrop();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) { (globalThis as any).clearTimeout(this.timer); this.timer = null; }
    this.stateFn("disconnected");
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
