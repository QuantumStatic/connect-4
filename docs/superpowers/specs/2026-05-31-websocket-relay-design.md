# WebSocket Relay (Durable Object) Design

**Goal:** Add a reliable WebSocket-based transport for "Play a friend" — a thin Cloudflare Durable Object that relays game messages between the two players and caches the latest state for instant resync. Keep WebRTC P2P available behind a UI toggle. Both transports run the *identical* client-side game-sync protocol.

**Status:** Approved direction. Today: 2026-05-31.

---

## Motivation

WebRTC P2P reconnection is inherently fragile: every reconnect rebuilds a direct ICE/DTLS link, and a page refresh discards one end of it. We have hardened it repeatedly (fresh-peer handshake, 45s retry, heartbeat, decideSync) but it remains the weak point.

A WebSocket to a server reconnects trivially — no ICE, no handshake. Routing game messages through a tiny stateful server (a Durable Object) makes reconnection a non-event: reopen the socket, receive the current state, continue.

We keep P2P as a user-selectable option (it's lower-latency and fully private), with Relay as the robust default.

---

## Architecture

Two transports, one protocol:

```
                         ┌─────────────── shared, transport-agnostic ───────────────┐
  main.ts  ──uses──►  Transport interface          game/protocol.ts (WireMsg, decideSync,
                          │                          hashLog, mergeScores), game/state.ts,
            ┌─────────────┴─────────────┐            HUD, heartbeat, sendSync — UNCHANGED
            │                           │
     net/session.ts              net/relaySocket.ts
     (WebRTC P2P, existing)      (WebSocket to the DO, NEW)
            │                           │
     relay /ice,/room,...        relay Durable Object (NEW)
     (existing signaling)        wss://<relay>/ws/:id
```

- **The game-sync logic does not change.** `WireMsg` (`move | sync | newgame | ping | bye`), `decideSync`, the `gen`/`score` model, `sendSync`, and the heartbeat all stay exactly as they are today. They operate over a `Transport`, not a specific peer technology.
- The only new client code is `RelaySocket` (a `Transport` over a WebSocket) and a small transport-selection seam in `main.ts`.
- The only new server code is the Durable Object plus a `/ws/:id` upgrade route.

### Transport interface

```ts
// web/src/net/transport.ts
export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface Transport {
  send(msg: WireMsg): boolean;            // false if the channel was closed (dropped)
  onMessage(fn: (m: WireMsg) => void): void;
  onState(fn: (s: ConnState) => void): void;
  reconnectNow(): void;                   // force a reconnect attempt
  close(): void;
}
```

`ConnState` is moved here from `peer.ts` (re-exported there for back-compat). The existing `Session` already exposes `send/onMessage/onState/reconnectNow/close` — it satisfies `Transport` as-is. `RelaySocket` implements the same shape.

---

## Components

### 1. Durable Object: `relay/src/room.ts` (`RoomDO`)

One instance per room id. Thin forwarder + state cache. Holds:
- The set of connected WebSockets (max 2). Uses the **WebSocket Hibernation API** (`state.acceptWebSocket`) so the DO can be evicted between messages without dropping sockets.
- `lastSync: { gen: number; log: string; score: {yellow:number;green:number} } | null` — the most recent `sync` payload seen, persisted via `state.storage` so it survives hibernation.
- Color assignment: the first socket to connect is `yellow` (host), the second is `green` (guest). Stored per-socket via `serializeAttachment`.

Behavior:
- **On connect** (`/ws/:id` upgrade): if the room already has 2 live sockets, reject with close code `4001` ("room full"). Otherwise accept, assign a color, and immediately send `{t:"welcome", color, opponentHere}`. If `lastSync` exists, also send it as a `sync` WireMsg so the new socket has current state instantly. Notify the other socket `{t:"peer", here:true}`.
- **On message**: parse JSON. If it's a `sync`, update + persist `lastSync` (element-wise-max the score so a stale sync can't lower it). Forward the raw message to the *other* socket(s). (`bye`, `move`, `newgame`, `ping` are forwarded verbatim.)
- **On close/error**: drop the socket; notify the remaining one `{t:"peer", here:false}`. Set a **1-hour idle alarm**; if no sockets reconnect by then, clear storage (room is gone).
- **Reset alarm** on every connect/message so an active room never expires.

The DO does **not** implement Connect-4 rules. Move legality (turn parity, column range, win/draw) stays client-side via `GameState` + `validateIncoming`, exactly as today. The DO only moves bytes and caches the last sync.

> **Envelope note:** DO control messages (`welcome`, `peer`) use a `{t: ...}` envelope distinct from the game `WireMsg` (`{type: ...}`). `RelaySocket` consumes `welcome`/`peer` itself (to drive `ConnState`) and surfaces only game `WireMsg`s to its `onMessage` consumer. This keeps the control channel and the game channel cleanly separated.

### 2. Worker route: `relay/src/index.ts`

Add a branch: `GET /ws/:id` with `Upgrade: websocket` → look up the `RoomDO` stub by id (`env.ROOMS_DO.idFromName(id)`), forward the request to it. Existing `/ice`, `/room*` routes remain (P2P still uses them). `/room*` KV routes can stay as-is.

`wrangler.toml` gains a `[[durable_objects.bindings]]` (`ROOMS_DO` → `RoomDO`) and a migration (`new_sqlite_classes = ["RoomDO"]` — SQLite-backed DOs are free-tier eligible).

### 3. Client: `web/src/net/relaySocket.ts`

Implements `Transport` over a `WebSocket`:
- `connect()`: open `wss://<relay>/ws/:id`. On `open` → `onState("connected")` and send a `hello`-less flow (the DO sends `welcome` unprompted). On `close`/`error` → `onState("reconnecting")` and schedule a reconnect with capped exponential backoff (e.g. 0.5s → 1s → 2s → … max 5s), retrying indefinitely while the session is active (WebSocket reconnect is cheap and reliable). `close()` stops retries and sets `disconnected`.
- Consumes DO control frames (`welcome` → record assigned color, surface "connected"; `peer` → drive a "reconnecting"/"connected" hint for opponent presence) and passes game `WireMsg`s through to `onMessage`.
- `send(msg)`: if socket `readyState === OPEN`, `ws.send(JSON.stringify(msg))` and return true; else return false (so `main.ts`'s existing dead-channel handling / `reconnectNow` still applies).
- Exposes the assigned color so `main.ts` knows local side (mirrors how role is derived for P2P).

Relay URL base: same `VITE_RELAY_URL` env already used by `signal.ts`; `ws(s)://` derived from it (or same-origin).

### 4. `main.ts` transport seam

`startFriend()` currently constructs a WebRTC `Session`. Generalize:
- Read the chosen transport (`"relay" | "p2p"`) from the UI toggle (default `"relay"`), encode it in the room link (`#join=<id>&t=relay`), and read it back when joining so both sides match.
- For `"relay"`: build a `RelaySocket(roomId)`; local color comes from the DO's `welcome`. No `getIceConfig`, no host/guest/resume/rehost handshake — just connect.
- For `"p2p"`: existing `Session` path (host/join/resume), unchanged.
- Everything after `this.session = <transport>` — `onState`, `onMessage`/`onWire`, `sendSync`, heartbeat, score, gen, HUD — is shared and untouched. `this.session` is typed as `Transport`.

Room-id generation for relay: the client picks a random id (same 128-bit scheme as today) and the DO is created lazily by `idFromName(id)` on first connect — no `POST /room` round-trip needed for relay.

### 5. HUD toggle: `web/src/ui/hud.ts`

When friend mode is selected, show a small **"Direct (P2P)"** checkbox (unchecked = Relay, the default) next to the link box. Add `onTransportChange`/a getter, or read its value at `startFriend` time. The toggle is only visible/relevant while setting up a friend game.

---

## Data flow (relay mode)

1. Host picks "Play a friend" (Relay). Client generates room id, opens `wss://…/ws/<id>`. DO assigns `yellow`, sends `welcome`. Client shows the share link `…#join=<id>&t=relay`.
2. Guest opens the link, opens the same WS. DO assigns `green`, sends `welcome` + cached `sync` (none yet). Host gets `{t:"peer", here:true}`.
3. A move: client appends locally (existing flow), `send({type:"move",delta})`. DO forwards to the opponent, who applies it via `validateIncoming` (unchanged). The mover also emits a `sync` periodically (heartbeat) / on demand; the DO caches it.
4. Refresh/drop: the WebSocket closes; `RelaySocket` reopens it; DO sends `welcome` + cached `sync`; client reconciles via `decideSync`. No handshake, no epochs.

---

## Reconnection & error handling

- **Transport-level reconnect** is `RelaySocket`'s job (backoff reopen). The DO's cached `lastSync` means even if the opponent is briefly absent, a reconnecting client still receives current state.
- **App-level reconciliation** is unchanged: `decideSync` on every `sync`, the heartbeat, and the manual Resync button all keep working because they operate on `Transport`.
- **Room full** (`4001`) → toast "This room already has two players." and drop to local 2P.
- **Relay unreachable** → toast (same as today's "Relay offline").
- **`bye`** still tears down both sides and clears the join hash (existing logic).
- **1-hour TTL** enforced by the DO alarm (matches the current KV TTL).

---

## Testing

- `relay` (vitest-pool-workers): RoomDO unit/integration tests — color assignment (1st yellow, 2nd green), `welcome` on connect, `lastSync` cache + replay on reconnect, forward-to-other-socket, room-full rejection, `peer` notifications, alarm-based cleanup. (Requires the `nodejs_compat` flag in `wrangler.toml`.)
- `web`: `RelaySocket` tests with a fake/mock `WebSocket` — state transitions (connecting→connected→reconnecting), backoff reconnect, control-frame handling (`welcome`/`peer` consumed, game frames surfaced), `send` returns false when closed.
- Existing `protocol.test.ts`, `session.test.ts`, `state.test.ts`, etc. remain green (the shared logic is untouched). `decideSync` tests still cover reconciliation for both transports.
- Manual e2e: two devices in relay mode — play, refresh one, confirm instant resync; new game; end room; room-full; P2P toggle still works.

---

## Deployment

- `wrangler.toml`: add the `RoomDO` durable-object binding + `new_sqlite_classes` migration; keep `nodejs_compat`. Deploy with `wrangler deploy`.
- Durable Objects: try the **free tier** first (SQLite-backed DOs are free-tier eligible as of 2025). Confirm post-deploy; upgrade to Workers Paid only if limits bite.
- Same-origin / `VITE_RELAY_URL` story is unchanged; the WS URL derives from the existing relay origin.
- README + `relay/README.md`: document the DO, the `/ws/:id` endpoint, and the transport toggle.

---

## Scope / non-goals

- No change to vs-AI, hot-seat, physics, audio, rendering, persistence model, or the move-log-as-state design.
- No authoritative server-side rules (thin DO only).
- No spectators, no >2 players, no matchmaking — room-link sharing only, as today.
- WebRTC P2P stays functional and selectable; not removed.
