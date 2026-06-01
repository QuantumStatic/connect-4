# WebSocket Relay (Durable Object) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WebSocket transport for "Play a friend" backed by a thin Cloudflare Durable Object that relays messages and caches the last sync, with a UI toggle to choose Relay (default) or Direct P2P. Both transports run the identical client game-sync protocol.

**Architecture:** Introduce a `Transport` interface satisfied by both the existing WebRTC `Session` and a new `RelaySocket` (WebSocket → `RoomDO`). The DO is a dumb forwarder + `lastSync` cache; Connect-4 rules stay client-side. `main.ts` selects the transport; everything above it (`protocol.ts`, `decideSync`, heartbeat, HUD) is unchanged.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (SQLite-backed, WebSocket Hibernation API), Vite, Vitest, `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-05-31-websocket-relay-design.md`

**Conventions for every commit message in this plan:** end with
```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## File structure

**Create:**
- `web/src/net/transport.ts` — `Transport` interface + `ConnState` (the shared seam).
- `web/src/net/relaySocket.ts` — `RelaySocket implements Transport` over a `WebSocket`.
- `web/src/net/relaySocket.test.ts` — tests with a mock WebSocket.
- `relay/src/room.ts` — `RoomDO` Durable Object (forwarder + lastSync cache).
- `relay/test/room.test.ts` — DO integration tests.

**Modify:**
- `web/src/net/peer.ts` — import + re-export `ConnState` from `transport.ts` (single source). `session.ts`/`fakePeer.ts` keep importing `ConnState` from `peer.ts`, unchanged.
- `web/src/main.ts` — transport seam in `startFriend`; type `session` as `Transport | null`.
- `web/src/ui/hud.ts` — "Direct (P2P)" checkbox + getter.
- `relay/src/index.ts` — `GET /ws/:id` upgrade route → DO.
- `relay/wrangler.toml` — DO binding + migration + `nodejs_compat` flag.

---

## Task 1: `Transport` interface (shared seam)

**Files:**
- Create: `web/src/net/transport.ts`
- Modify: `web/src/net/peer.ts:7`

- [ ] **Step 1: Create the interface**

`web/src/net/transport.ts`:
```ts
// web/src/net/transport.ts
// The seam between game-sync logic (main.ts) and a concrete connection. Both the
// WebRTC Session and the WebSocket RelaySocket implement this, so everything
// above the transport (protocol, decideSync, heartbeat, HUD) is shared.
import type { WireMsg } from "../game/protocol";

export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface Transport {
  /** Returns false if the channel was closed and the message was dropped. */
  send(msg: WireMsg): boolean;
  onMessage(fn: (m: WireMsg) => void): void;
  onState(fn: (s: ConnState) => void): void;
  /** Force a reconnect attempt now. No-op if already reconnecting/closed. */
  reconnectNow(): void;
  close(): void;
}
```

- [ ] **Step 2: Point `peer.ts` at the shared `ConnState`**

In `web/src/net/peer.ts`, replace the local `ConnState` declaration (line ~7) so there is one source of truth. Because `peer.ts` *also uses* `ConnState` internally (`onState(fn: (s: ConnState) => void)`), import it AND re-export it:
```ts
// was: export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";
import type { ConnState } from "./transport";
export type { ConnState };
```
(Keep the existing `import type { WireMsg } from "../game/protocol";` line. `session.ts` and `fakePeer.ts` import `ConnState` from `peer.ts`, which now re-exports it — no edits needed there.)

- [ ] **Step 3: Verify it compiles**

Run: `cd web && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Verify the existing suite is still green**

Run: `cd web && npm test -- --run`
Expected: all current tests pass (no behavior changed).

- [ ] **Step 5: Commit**
```bash
git add web/src/net/transport.ts web/src/net/peer.ts
git commit -m "refactor(web/net): extract Transport interface + shared ConnState

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: `RoomDO` Durable Object — failing tests

**Files:**
- Create: `relay/test/room.test.ts`
- Modify: `relay/wrangler.toml`

Context: the relay uses `@cloudflare/vitest-pool-workers`. DO tests run inside Miniflare and need the DO binding + `nodejs_compat`. We set up config first so the tests can resolve the binding, then write failing tests against a not-yet-implemented `RoomDO`.

- [ ] **Step 1: Configure the DO binding + migration in `wrangler.toml`**

Replace `relay/wrangler.toml` with:
```toml
name = "connect4-relay"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "ROOMS"
id = "24380a2e1ab646bca8174e5e8ab22237"

[[durable_objects.bindings]]
name = "ROOMS_DO"
class_name = "RoomDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDO"]

# TURN: set via `wrangler secret put TURN_KEY_ID` and `TURN_KEY_API_TOKEN`.
# STUN needs no secret.
```

- [ ] **Step 2: Write the failing test**

`relay/test/room.test.ts`:
```ts
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Open a WebSocket to the DO for room `id`. Returns the client-side socket.
async function connect(id: string): Promise<WebSocket> {
  const stub = env.ROOMS_DO.get(env.ROOMS_DO.idFromName(id));
  const res = await stub.fetch("https://do/ws/" + id, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

// Collect the next JSON message from a socket.
function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (e: MessageEvent) => resolve(JSON.parse(e.data as string)), { once: true });
  });
}

describe("RoomDO", () => {
  it("assigns yellow to the first socket and green to the second", async () => {
    const a = await connect("room-colors");
    expect(await next(a)).toMatchObject({ t: "welcome", color: "yellow", opponentHere: false });
    const b = await connect("room-colors");
    expect(await next(b)).toMatchObject({ t: "welcome", color: "green", opponentHere: true });
  });

  it("forwards a game message to the other socket only", async () => {
    const a = await connect("room-fwd");
    await next(a); // welcome
    const b = await connect("room-fwd");
    await next(b); // welcome
    const got = next(b);
    a.send(JSON.stringify({ type: "move", delta: { ply: 0, col: 3, hash: "h" } }));
    expect(await got).toMatchObject({ type: "move", delta: { ply: 0, col: 3 } });
  });

  it("caches the last sync and replays it to a socket that connects later", async () => {
    const a = await connect("room-cache");
    await next(a); // welcome
    a.send(JSON.stringify({ type: "sync", gen: 2, log: "334", score: { yellow: 1, green: 0 } }));
    // small delay so the DO processes the sync before B connects
    await new Promise((r) => setTimeout(r, 20));
    const b = await connect("room-cache");
    expect(await next(b)).toMatchObject({ t: "welcome", color: "green" });
    expect(await next(b)).toMatchObject({ type: "sync", gen: 2, log: "334" });
  });

  it("rejects a third socket with close code 4001", async () => {
    const a = await connect("room-full");
    await next(a);
    const b = await connect("room-full");
    await next(b);
    const stub = env.ROOMS_DO.get(env.ROOMS_DO.idFromName("room-full"));
    const res = await stub.fetch("https://do/ws/room-full", { headers: { Upgrade: "websocket" } });
    const third = res.webSocket!;
    third.accept();
    const closed = new Promise<number>((resolve) =>
      third.addEventListener("close", (e: CloseEvent) => resolve(e.code), { once: true }));
    expect(await closed).toBe(4001);
  });

  it("notifies the remaining socket when the other leaves", async () => {
    const a = await connect("room-peer");
    await next(a); // welcome
    const b = await connect("room-peer");
    await next(b); // welcome
    const peerGone = next(a);
    b.close();
    expect(await peerGone).toMatchObject({ t: "peer", here: false });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd relay && npx vitest run room.test`
Expected: FAIL — `RoomDO` is not exported / binding class missing.

- [ ] **Step 4: Commit the failing test + config**
```bash
git add relay/wrangler.toml relay/test/room.test.ts
git commit -m "test(relay): failing RoomDO websocket tests + DO wrangler config

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Implement `RoomDO`

**Files:**
- Create: `relay/src/room.ts`
- Modify: `relay/src/index.ts` (export the class + add `ROOMS_DO` to `Env`)

- [ ] **Step 1: Implement the Durable Object**

`relay/src/room.ts`:
```ts
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
      // Room full — accept then immediately close with our app code so the
      // client gets a clean signal.
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
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
```

- [ ] **Step 2: Export the class + extend `Env` in `index.ts`**

In `relay/src/index.ts`, add near the top (after the existing imports):
```ts
export { RoomDO } from "./room";
```
And add to the `Env` interface:
```ts
  ROOMS_DO: DurableObjectNamespace;
```

- [ ] **Step 3: Run the tests**

Run: `cd relay && npx vitest run room.test`
Expected: PASS (5 tests).

- [ ] **Step 4: Run the whole relay suite**

Run: `cd relay && npx vitest run`
Expected: all relay tests pass (existing rooms/router/cors + new room tests).

- [ ] **Step 5: Commit**
```bash
git add relay/src/room.ts relay/src/index.ts
git commit -m "feat(relay): RoomDO websocket relay with lastSync cache + idle TTL

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `GET /ws/:id` upgrade route

**Files:**
- Modify: `relay/src/index.ts` (router) ; `relay/test/router.test.ts` (one test)

- [ ] **Step 1: Add a failing router test**

Append to `relay/test/router.test.ts` inside the top-level `describe("relay router", ...)` block:
```ts
  it("GET /ws/:id with Upgrade routes to the DO and returns 101", async () => {
    const res = await worker.fetch(
      new Request("https://relay/ws/abc", { headers: { Upgrade: "websocket" } }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(101);
  });

  it("GET /ws/:id without Upgrade returns 426", async () => {
    const res = await worker.fetch(
      new Request("https://relay/ws/abc"),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(426);
  });
```
(`worker`, `env`, `createExecutionContext` are already imported at the top of that file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd relay && npx vitest run router.test`
Expected: FAIL — `/ws/abc` currently returns 404.

- [ ] **Step 3: Add the route in `index.ts`**

In `relay/src/index.ts`, inside `fetch`, before the final `return empty(404, req, env);`, add:
```ts
    // GET /ws/:id  (Durable Object websocket relay)
    if (parts[0] === "ws" && parts[1]) {
      if (req.headers.get("Upgrade") !== "websocket") return empty(426, req, env);
      const stub = env.ROOMS_DO.get(env.ROOMS_DO.idFromName(parts[1]));
      return stub.fetch(req);
    }
```

- [ ] **Step 4: Run the tests**

Run: `cd relay && npx vitest run`
Expected: PASS (all relay tests).

- [ ] **Step 5: Commit**
```bash
git add relay/src/index.ts relay/test/router.test.ts
git commit -m "feat(relay): route GET /ws/:id to RoomDO

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `RelaySocket` client — failing tests

**Files:**
- Create: `web/src/net/relaySocket.test.ts`

Context: jsdom (used by some web tests) has no `WebSocket`. We inject a fake `WebSocket` constructor so `RelaySocket` is fully testable without a network. The fake records sent frames and lets the test drive `open`/`message`/`close`.

- [ ] **Step 1: Write the failing test**

`web/src/net/relaySocket.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- relaySocket --run`
Expected: FAIL — `./relaySocket` does not exist.

- [ ] **Step 3: Commit the failing test**
```bash
git add web/src/net/relaySocket.test.ts
git commit -m "test(web/net): failing RelaySocket transport tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Implement `RelaySocket`

**Files:**
- Create: `web/src/net/relaySocket.ts`

- [ ] **Step 1: Implement**

`web/src/net/relaySocket.ts`:
```ts
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
    ws.onclose = () => this.onDrop();
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }

  reconnectNow(): void {
    if (this.closed) return;
    try { this.ws?.close(); } catch { /* ignore */ }
    // onclose → onDrop schedules a reopen; force immediate if no socket.
    if (this.timer === null) this.onDrop();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) { (globalThis as any).clearTimeout(this.timer); this.timer = null; }
    this.stateFn("disconnected");
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 2: Run the tests**

Run: `cd web && npm test -- relaySocket --run`
Expected: PASS (5 tests).

- [ ] **Step 3: Verify the whole web suite**

Run: `cd web && npm test -- --run`
Expected: all pass.

- [ ] **Step 4: Commit**
```bash
git add web/src/net/relaySocket.ts
git commit -m "feat(web/net): RelaySocket transport (WebSocket to RoomDO)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: HUD "Direct (P2P)" toggle

**Files:**
- Modify: `web/src/ui/hud.ts` ; `web/src/ui/hud.test.ts` ; `web/index.html` (CSS)

- [ ] **Step 1: Write a failing HUD test**

Append to `web/src/ui/hud.test.ts`:
```ts
describe("Hud transport toggle", () => {
  it("defaults to relay and reports p2p when checked", () => {
    const root = document.createElement("div");
    const hud = new Hud(
      root,
      { onModeChange: () => {}, onNewGame: () => {}, onHint: () => {}, onEndRoom: () => {}, onResync: () => {} },
      "2P",
    );
    expect(hud.transport()).toBe("relay");
    const box = root.querySelector(".p2p-toggle input") as HTMLInputElement;
    box.checked = true;
    expect(hud.transport()).toBe("p2p");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- hud --run`
Expected: FAIL — `hud.transport` is not a function / no `.p2p-toggle`.

- [ ] **Step 3: Add the toggle to the HUD**

In `web/src/ui/hud.ts`:

Add a field near the other element fields:
```ts
  private p2pToggle = document.createElement("label");
  private p2pCheck = document.createElement("input");
```

In the constructor, after the resync/end buttons are appended, add:
```ts
    this.p2pCheck.type = "checkbox";
    this.p2pToggle.className = "p2p-toggle";
    this.p2pToggle.style.display = "none";
    this.p2pToggle.append(this.p2pCheck, document.createTextNode(" Direct (P2P)"));
    root.append(this.p2pToggle);
```

Add a public getter and show/hide hook:
```ts
  /** Chosen transport for a new friend game. */
  transport(): "relay" | "p2p" { return this.p2pCheck.checked ? "p2p" : "relay"; }

  /** Show/hide the transport toggle (visible only while setting up friend mode). */
  showTransportToggle(show: boolean): void { this.p2pToggle.style.display = show ? "" : "none"; }
```

- [ ] **Step 4: Add CSS**

In `web/index.html`, in the `<style>` block, after the `.end-room` rule:
```css
      .p2p-toggle { font-size: 13px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
```

- [ ] **Step 5: Run the tests**

Run: `cd web && npm test -- hud --run`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add web/src/ui/hud.ts web/src/ui/hud.test.ts web/index.html
git commit -m "feat(web/ui): Direct (P2P) transport toggle in friend HUD

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Wire the transport seam into `main.ts`

**Files:**
- Modify: `web/src/main.ts`

Context: `main.ts` currently constructs a WebRTC `Session` in `startFriend`. We (a) type `session` as `Transport | null`, (b) branch on the chosen transport, (c) encode/read `t=relay|p2p` in the room link. The shared logic (`onState`, `onWire`, `sendSync`, heartbeat, score, gen) is untouched.

- [ ] **Step 1: Imports + field type**

At the top of `web/src/main.ts`, add:
```ts
import { RelaySocket } from "./net/relaySocket";
import type { Transport } from "./net/transport";
```
Change the session field declaration from `private session: Session | null = null;` to:
```ts
  private session: Transport | null = null;
```
(`Session` is still imported and used for the p2p branch.)

- [ ] **Step 2: Show the toggle when entering friend mode**

In `setMode`, where friend mode is entered, ensure the toggle is shown before `startFriend`. In `startFriend`, near the other `this.hud.show*` calls, add:
```ts
    this.hud.showTransportToggle(true);
```
And in `teardownFriend` (where other HUD elements are hidden), add:
```ts
    this.hud.showTransportToggle(false);
```

- [ ] **Step 3: Branch on transport in `startFriend`**

Replace the relay-vs-peer construction. Find the block (around `main.ts:393`):
```ts
    let ice: RTCIceServer[];
    try { ice = await getIceConfig(); }
    catch { this.hud.toast("Relay offline — can't start an online game."); this.hud.showConnState("disconnected"); return; }

    // Factory (not a fixed peer) so the session can build a FRESH peer on every
    // reconnect — required to pair with a peer that did a full page refresh.
    this.session = new Session({ makePeer: () => new RtcPeer(ice, role), role });
```
Replace it with transport selection. Read the chosen transport from the URL (joining) or the toggle (hosting):
```ts
    const urlParams = new URLSearchParams(location.hash.slice(1));
    const transport: "relay" | "p2p" =
      joinId ? (urlParams.get("t") === "p2p" ? "p2p" : "relay") : this.hud.transport();

    if (transport === "relay") {
      // Relay: a WebSocket to the RoomDO. roomId is client-chosen; the DO is
      // created lazily on first connect. Color comes from the DO welcome.
      this.roomId = joinId ?? randomRoomId();
      const base = relayWsBase();
      const sock = new RelaySocket(`${base}/ws/${this.roomId}`);
      this.session = sock;
      // Local side: host (no joinId) is yellow, guest is green. (Matches the
      // DO's first=yellow assignment; sock.color confirms it once connected.)
      this.localSide = joinId ? "green" : "yellow";
      this.remoteSide = joinId ? "yellow" : "green";
    } else {
      let ice: RTCIceServer[];
      try { ice = await getIceConfig(); }
      catch { this.hud.toast("Relay offline — can't start an online game."); this.hud.showConnState("disconnected"); return; }
      this.session = new Session({ makePeer: () => new RtcPeer(ice, role), role });
    }
```
Then, where the host share-link is built, include the transport in the hash. Find the two `showHostLink` calls and change the URL template from:
```ts
`${location.origin}${location.pathname}#join=${this.roomId}`
```
to:
```ts
`${location.origin}${location.pathname}#join=${this.roomId}&t=${transport}`
```

For the relay branch, the host should show the link immediately (no async handshake). After the `if/else`, restructure the existing `try { ... host()/join()/resume() ... }` so the **p2p** branch keeps calling `host()/join()/resume()`, and the **relay** branch instead just shows the link (host) — the socket connects on its own:
```ts
    try {
      if (transport === "relay") {
        if (!joinId) {
          this.hud.showHostLink(`${location.origin}${location.pathname}#join=${this.roomId}&t=relay`);
        }
        save(this.state, this.mode, this.localSide, this.roomId, this.score, this.gen);
      } else if (resuming) {
        // ... existing p2p resume branch unchanged ...
      } else if (role === "host") {
        // ... existing p2p host branch unchanged, but use the &t=p2p link ...
      } else {
        // ... existing p2p join branch unchanged ...
      }
    } catch (e) {
      window.clearTimeout(handshakeTimeout);
      this.handshakeFailed(role, e);
    }
```

- [ ] **Step 4: Add the two small helpers**

At the bottom of `main.ts` (module scope, near `main()`), add:
```ts
function randomRoomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(36).padStart(2, "0");
  return s;
}

function relayWsBase(): string {
  const http = (import.meta.env.VITE_RELAY_URL ?? location.origin).replace(/\/$/, "");
  return http.replace(/^http/, "ws"); // http→ws, https→wss
}
```

- [ ] **Step 5: Guard the handshake timeout for relay**

The 30s `handshakeTimeout` and the `disconnected && !connected` failure path were written for the p2p guest. For relay, `RelaySocket` reconnects on its own, so skip the timeout. Wrap the existing timeout setup so it only arms for `transport === "p2p" && role === "guest"`:
```ts
    let handshakeTimeout: number | undefined;
    if (transport === "p2p" && role === "guest") {
      handshakeTimeout = window.setTimeout(() => { if (!connected) this.handshakeFailed(role); }, 30_000);
    }
```
And in the `onState` handler, gate the failure branch the same way:
```ts
      } else if (s === "disconnected" && !connected && transport === "p2p" && role === "guest") {
```

- [ ] **Step 6: Type-check + run web suite**

Run: `cd web && npx tsc -b && npm test -- --run`
Expected: clean compile, all tests pass.

- [ ] **Step 7: Manual local sanity (Vite dev)**

Run: `cd web && npm run dev`, open two tabs at the printed URL. Pick "Play a friend" (relay default) in tab A, copy the link, open in tab B. *Note:* relay needs the deployed Worker (or `wrangler dev`) — set `VITE_RELAY_URL` to a running relay, or test relay e2e after Task 10 deploy. P2P toggle path should still work against the deployed `/ice`.

- [ ] **Step 8: Commit**
```bash
git add web/src/main.ts
git commit -m "feat(web): transport seam — relay (default) or p2p via toggle/link

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Surface relay disconnect/"room full" + opponent presence (polish)

**Files:**
- Modify: `web/src/net/relaySocket.ts` ; `web/src/main.ts`

- [ ] **Step 1: Detect the 4001 close code in `RelaySocket`**

WebSocket `onclose` carries a `code`. Add an optional `onClose(code)` notify so `main.ts` can show the room-full toast and stop. Change the `onclose` wiring:
```ts
    ws.onclose = (e: CloseEvent) => { if (e.code === 4001) { this.closed = true; this.stateFn("disconnected"); this.fullFn(); return; } this.onDrop(); };
```
Add the field + setter:
```ts
  private fullFn: () => void = () => {};
  onRoomFull(fn: () => void): void { this.fullFn = fn; }
```
(Type the `onerror`/`onclose` params to satisfy TS; `onerror` keeps calling `onDrop`.)

- [ ] **Step 2: Wire it in `main.ts`**

In the relay branch of `startFriend`, after constructing `sock`:
```ts
      sock.onRoomFull(() => {
        this.hud.toast("This room already has two players.", 6000);
        this.teardownFriend(false);
        this.mode = "2P"; this.localSide = null; this.hud.setModeValue("2P");
        save(this.state, this.mode, this.localSide);
      });
```

- [ ] **Step 3: Type-check + test**

Run: `cd web && npx tsc -b && npm test -- --run`
Expected: clean, all pass.

- [ ] **Step 4: Commit**
```bash
git add web/src/net/relaySocket.ts web/src/main.ts
git commit -m "feat(web): handle relay room-full (4001) with a clear toast

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Docs + deploy

**Files:**
- Modify: `relay/README.md` ; `README.md`

- [ ] **Step 1: Document the DO + endpoint**

In `relay/README.md`, add a section:
```markdown
## WebSocket relay (Durable Object)

`RoomDO` relays game messages between the two players in a room over a WebSocket
and caches the last sync for instant resync. Endpoint: `GET /ws/:id` (Upgrade:
websocket). It stores no game logic — clients enforce Connect-4 rules.

Deploy includes the DO automatically (binding `ROOMS_DO`, migration `v1`,
SQLite-backed — free-tier eligible):

    cd relay && npx wrangler deploy

The web app uses relay mode by default; "Direct (P2P)" in the friend UI switches
to the WebRTC path (`/ice`, `/room*`).
```

In the root `README.md` "Play a friend" section, add a line:
```markdown
Connections default to a reliable WebSocket relay (a tiny Cloudflare Durable
Object that only forwards moves). A "Direct (P2P)" toggle uses browser-to-browser
WebRTC instead. Either way, no game state is stored on a server beyond a transient
in-memory cache for reconnects.
```

- [ ] **Step 2: Deploy the relay**

Run: `cd relay && npx wrangler deploy`
Expected: deploy succeeds; output lists the `ROOMS_DO` durable object binding and migration `v1` applied. If the account isn't DO-enabled, wrangler will say so — enable Durable Objects (free tier) in the dashboard and re-run.

- [ ] **Step 3: Smoke-test the endpoint**

Open the deployed app in two browsers, "Play a friend" (relay), share the link, play a move, refresh one tab, confirm instant resync. Then toggle "Direct (P2P)" and confirm that path still connects.

- [ ] **Step 4: Commit**
```bash
git add relay/README.md README.md
git commit -m "docs: document RoomDO websocket relay + transport toggle

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Final manual e2e verification

- [ ] **Step 1:** Two devices, relay mode: create room, join, play to a win, New Game, score increments and persists.
- [ ] **Step 2:** Refresh the guest mid-game → reconnects within ~1s, board reconciles from the DO `lastSync`.
- [ ] **Step 3:** Refresh the host mid-game → same.
- [ ] **Step 4:** Open the link in a 3rd tab → "room already has two players" toast.
- [ ] **Step 5:** End Room → both drop to local 2P; re-create works (fresh link).
- [ ] **Step 6:** Toggle "Direct (P2P)", repeat a quick connect + a move to confirm the WebRTC path still works.
- [ ] **Step 7:** Confirm vs-AI / hot-seat unaffected.

---

## Notes for the implementer

- **DO test API:** `cloudflare:test` exposes `env.ROOMS_DO`, `runInDurableObject`, `runDurableObjectAlarm`. Opening a WebSocket to a DO in tests is done by `stub.fetch(url, { headers: { Upgrade: "websocket" } })` and reading `res.webSocket`. If the harness version differs, consult the `durable-objects` Cloudflare skill.
- **Hibernation API:** use `this.ctx.acceptWebSocket(server)` + `webSocketMessage/Close/Error` handlers (not `addEventListener`) so the DO can hibernate. `serializeAttachment`/`deserializeAttachment` persist the per-socket color across hibernation.
- **`this.ctx`:** in a class extending `DurableObject` from `cloudflare:workers`, the state is `this.ctx` and the env is `this.env`.
- **Do not** touch `protocol.ts`, `decideSync`, `state.ts`, the heartbeat, or `onWire` — they are transport-agnostic by design and must stay shared.
- **`import.meta.env`** types are provided by `web/src/vite-env.d.ts` (already present).
