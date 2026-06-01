// relay/src/room.ts
// Thin per-room relay. Holds up to two hibernatable WebSockets, forwards game
// messages between them, and caches the latest `sync` so a (re)connecting socket
// gets current state instantly. Knows NO Connect-4 rules — clients validate.
import { DurableObject } from "cloudflare:workers";

type Color = "yellow" | "green";
interface Sync { gen: number; log: string; score: { yellow: number; green: number } }

const IDLE_TTL_MS = 60 * 60 * 1000; // 1h

export class RoomDO extends DurableObject {
  private lastSync: Sync | null = null;
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.lastSync = (await this.ctx.storage.get<Sync>("lastSync")) ?? null;
    this.loaded = true;
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.load();
    const existing = this.sockets();
    if (existing.length >= 2) {
      // Room full — use hibernation API so storage isolation stays clean,
      // then immediately close with our app code so the client gets a clean signal.
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.close(4001, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const usedYellow = existing.some((ws) => this.colorOf(ws) === "yellow");
    const color: Color = usedYellow ? "green" : "yellow";

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ color });

    const opponentHere = existing.length > 0;
    server.send(JSON.stringify({ t: "welcome", color, opponentHere }));
    if (this.lastSync) server.send(JSON.stringify({ type: "sync", ...this.lastSync }));
    // tell the other socket someone joined
    for (const ws of existing) ws.send(JSON.stringify({ t: "peer", here: true }));

    await this.armAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private colorOf(ws: WebSocket): Color | null {
    const att = ws.deserializeAttachment() as { color: Color } | null;
    return att?.color ?? null;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.load();
    if (typeof raw !== "string") return;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg && msg.type === "sync" && typeof msg.log === "string") {
      // Cache; element-wise-max the score so a stale sync can't lower it.
      const prev = this.lastSync;
      const score = {
        yellow: Math.max(prev?.score.yellow ?? 0, msg.score?.yellow ?? 0),
        green: Math.max(prev?.score.green ?? 0, msg.score?.green ?? 0),
      };
      this.lastSync = { gen: msg.gen ?? 0, log: msg.log, score };
      await this.ctx.storage.put("lastSync", this.lastSync);
    }

    // Forward verbatim to the OTHER socket(s).
    for (const other of this.sockets()) {
      if (other !== ws) other.send(raw);
    }
    await this.armAlarm();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    for (const other of this.sockets()) {
      if (other !== ws) other.send(JSON.stringify({ t: "peer", here: false }));
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private async armAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
  }

  async alarm(): Promise<void> {
    // Idle for an hour and no live sockets → discard the room.
    if (this.sockets().length === 0) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.armAlarm();
    }
  }
}
