# Peer-to-Peer Multiplayer — Design

**Date:** 2026-05-31
**Status:** Draft for review
**Builds on:** [2026-05-31-connect-4-design.md](2026-05-31-connect-4-design.md)

## Goal

Let two friends, anywhere, play Connect 4 against each other directly peer-to-peer, with **no game server holding board state**. Game state stays in the two browsers as an append-only move log; a stateless Cloudflare relay only brokers the WebRTC handshake (signaling) and mints ICE/TURN credentials. One friend shares a single link; the other clicks it and they're connected. Connections that drop auto-reconnect via ICE restart through the relay without re-sharing.

## Non-goals

- Cross-device "rejoin from a cold page load while my opponent waits" (that was option C — deferred). Reconnect here assumes the page/`RTCPeerConnection` survives; if it truly dies, the player re-shares a link.
- Matchmaking, lobbies, presence beyond a single game room, accounts, persistence of finished games.
- Spectators, more than two peers, in-game chat.
- Changing the offline experience: 2P hot-seat and vs-AI stay exactly as they are.
- A signaling server that holds game state. The relay holds only ephemeral SDP + ICE config.

## Two tiers

The game splits into two tiers sharing one core:

- **Offline tier (unchanged):** 2P hot-seat and vs-AI run fully local — the Pixi app plus the FastAPI solver on localhost. No relay, no internet.
- **Online tier (new):** "Play a friend" — the static app served from **Cloudflare Pages**, signaling via a **Cloudflare Worker + KV**, ICE config (STUN + Cloudflare TURN) fetched from the Worker, and a **WebRTC DataChannel** carrying move deltas.

`fork → clone → run` still works locally for the offline tier. The online tier is the deployed experience.

## Architecture

```
┌─────────────────────────┐                       ┌─────────────────────────┐
│ Peer A (host, yellow)   │                       │ Peer B (guest, green)   │
│  Pixi app (CF Pages)    │                       │  Pixi app (CF Pages)    │
│  GameState (move log)   │                       │  GameState (move log)   │
│  net/session + peer     │                       │  net/session + peer     │
└───────────┬─────────────┘                       └─────────────┬───────────┘
            │  1. POST /room {offer} → id                       │
            │  share link  connect4…/#join=<id>  ──(WhatsApp)──▶│
            │                                  2. GET /room/:id │
            │  4. GET /room/:id/answer (poll) ◀─ 3. POST answer │
            │                                                    │
            └──────── WebRTC DataChannel (DTLS, move deltas) ────┘
                              (direct, or via TURN relay)

         ┌──────────────────────────────────────────────┐
         │ Cloudflare Worker + KV (stateless re: game)    │
         │  GET  /ice                 (STUN + TURN creds) │
         │  POST /room                (store offer)       │
         │  GET  /room/:id            (fetch offer)       │
         │  POST /room/:id/answer     (store answer)      │
         │  GET  /room/:id/answer     (poll answer)       │
         │  KV: ephemeral SDP keyed by room id, TTL ~2h   │
         └──────────────────────────────────────────────┘
```

**The opponent seam.** The existing `pump()` loop in `main.ts` already distinguishes "your turn" from "the opponent's turn." We formalize the **opponent source** as one of `local | ai | remote`. A move is validated and applied identically regardless of source; only where it originates differs:

- `local` — hot-seat: both sides come from board clicks.
- `ai` — vs-AI: the opponent move comes from the solver (`/analyze`).
- `remote` — vs-friend: the opponent move arrives over the DataChannel.

`humanSide` generalizes to `localSide`. `state.ts`, `physics/`, `audio/`, and `render/` are **untouched** — P2P is purely additive.

## Components

### 1. Relay — Cloudflare Worker + KV (`relay/`)

A Worker holding only ephemeral SDP and minting ICE config. Zero game state. Routes:

| Route | Body | Returns | Purpose |
|---|---|---|---|
| `GET /ice` | — | `{ iceServers }` | STUN + short-lived Cloudflare TURN creds, minted per call |
| `POST /room` | `{ offer }` | `{ id }` | Store offer in KV under an unguessable id |
| `GET /room/:id` | — | `{ offer, epoch }` \| 404 | Guest fetches the host's offer |
| `POST /room/:id/answer` | `{ answer, epoch }` | 204 | Guest posts its answer |
| `GET /room/:id/answer?since=<epoch>` | — | `{ answer, epoch }` \| 404 | Host polls for the answer |
| `POST /room/:id/offer` | `{ offer, epoch }` | 204 | Host pushes an ICE-restart offer (reconnect) |
| `GET /room/:id/offer?since=<epoch>` | — | `{ offer, epoch }` \| 404 | Guest polls for a restart offer (reconnect) |

**Epoch model (reconnection support).** A room is a *per-session mailbox*, not single-use. The `offer` and `answer` slots each carry a monotonic `epoch`. Initial connect is epoch 0; an ICE restart bumps it. Peers poll with `?since=<lastEpoch>` and act only on a strictly newer epoch — so the same room brokers repeated handshakes without anyone re-sharing the link.

**KV record** (per room id): `{ offerSdp, offerEpoch, answerSdp, answerEpoch, createdAt }`. No moves, no board, no log — ever.

**Hygiene:** room ids are unguessable (128-bit, base62). KV TTL ~2h, refreshed on activity, hard cap. Payload-size limit (SDP is a few KB; reject larger). Basic per-IP rate-limiting on `POST /room`. TURN creds are short-lived, minted per `GET /ice` call.

**Config:** the TURN key is a Worker secret. Pointing at a different TURN provider (Metered, self-hosted coturn) is a secret/config change — no client rebuild, because the client always fetches ICE config from `GET /ice`.

### 2. `web/src/net/signal.ts` — relay client

Typed `fetch` wrapper. No WebRTC. Functions:

```ts
getIceConfig(): Promise<RTCIceServer[]>
createRoom(offer: string): Promise<string>            // → room id
fetchOffer(id: string): Promise<{ offer: string; epoch: number }>
postAnswer(id: string, answer: string, epoch: number): Promise<void>
pollAnswer(id: string, sinceEpoch: number): Promise<{ answer: string; epoch: number } | null>
pushOffer(id: string, offer: string, epoch: number): Promise<void>   // reconnect
pollOffer(id: string, sinceEpoch: number): Promise<{ offer: string; epoch: number } | null>
```

`RELAY_BASE_URL` comes from a Vite env var (`VITE_RELAY_URL`), defaulting to same-origin (`/`), since Pages + Worker share an origin.

### 3. `web/src/net/peer.ts` — WebRTC wrapper

Thin wrapper over `RTCPeerConnection` + a reliable/ordered DataChannel, behind an interface so the orchestration above it is testable with a fake.

```ts
interface Peer {
  createOffer(): Promise<string>          // returns SDP after ICE gathering completes (non-trickle)
  acceptOffer(sdp: string): Promise<string> // guest: set remote, return answer SDP
  acceptAnswer(sdp: string): Promise<void>  // host: set remote
  restart(): Promise<string>              // ICE-restart offer (host)
  send(delta: MoveDelta): void
  onMove(fn: (d: MoveDelta) => void): void
  onResync(fn: (log: string) => void): void
  onStateChange(fn: (s: ConnState) => void): void  // connected | reconnecting | disconnected
  close(): void
}
type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";
```

Non-trickle: `createOffer`/`acceptOffer` resolve only after `iceGatheringState === "complete"`. ICE servers are injected (from `signal.getIceConfig()`).

### 4. `web/src/net/session.ts` — handshake + reconnection orchestration

Owns the state machine and the glare rule. Drives `peer` + `signal`:

- **Host flow:** `getIceConfig` → `peer.createOffer` → `signal.createRoom` → surface link → `signal.pollAnswer` → `peer.acceptAnswer` → connected → resync.
- **Guest flow:** read `#join=<id>` → `getIceConfig` → `signal.fetchOffer` → `peer.acceptOffer` → `signal.postAnswer` → connected → resync.
- **Reconnect (B):** on `peer` state `failed`, transition `reconnecting`; **only the host** calls `peer.restart()`, `signal.pushOffer(epoch+1)`; guest `signal.pollOffer(since)` → `peer.acceptOffer` → `signal.postAnswer`. Retry with capped backoff; after N attempts emit `disconnected` and prompt the user to re-share a link.
- **Resync:** on every (re)open, peers exchange full move logs; reconcile (see protocol).

### 5. `web/src/game/protocol.ts` — pure move protocol

```ts
interface MoveDelta { ply: number; col: number; hash: string }
// The DataChannel carries exactly two message kinds, JSON-framed:
type WireMsg =
  | { type: "move"; delta: MoveDelta }
  | { type: "sync"; log: string };       // full move-log, sent on every (re)connect
hashLog(moves: string): string                    // FNV-1a over the canonical move-log string
makeDelta(state: GameState, col: number): MoveDelta
validateIncoming(state, delta, opponentSide): "ok" | "duplicate" | "illegal" | "desync"
reconcileLogs(localLog: string, remoteLog: string): string | "conflict"  // longer wins iff shorter is a prefix
```

On (re)connect each peer sends a `sync` message with its full log; the receiver
runs `reconcileLogs` and replays to the agreed state before normal `move` deltas
resume. Pure functions, no network, fully unit-tested.

### 6. `web/src/main.ts` — opponent-source refactor

- Add mode `vs-friend`; `humanSide` → `localSide`.
- A remote move arrives via `session.onMove` → `validateIncoming` → if `ok`, apply through the **same path** local/AI moves use; if `duplicate`, ignore; if `illegal`, ignore + log; if `desync`, trigger resync.
- A local move (board click) on your turn → apply locally → `session.send(makeDelta(...))`.
- The AI path is unchanged and mutually exclusive with `vs-friend`.

### 7. UI (`web/src/ui/`)

- A **"Play a friend"** entry in the mode area → **Host** (Create game → copy link → "waiting for opponent…") or auto **Guest** when the page loads with `#join=<id>`.
- A connection-status chip: `connected` / `reconnecting` / `disconnected`.
- Side assignment: host = yellow (first), guest = green.
- A one-line note that peers can see each other's IP (inherent to WebRTC).

### 8. Repo layout additions

```
connect-4/
  relay/                     # Cloudflare Worker + KV (signaling + ICE)
    src/index.ts
    wrangler.toml
    test/relay.test.ts
  web/src/net/
    signal.ts  peer.ts  session.ts
  web/src/game/protocol.ts
  web/src/game/protocol.test.ts
  web/src/net/session.test.ts
```

## Data flow — one online move

1. It's your turn; you click column 3 (or release a queued ghost). `main` validates locally and calls `animateAndApply(3)`.
2. After the chip settles and `state.applyMove(3)` commits, `main` calls `session.send(makeDelta(state, 3))` → `{ ply, col: 3, hash }` over the DataChannel.
3. Peer receives the delta → `validateIncoming` (turn order, legal, live, hash) → `animateAndApply(3)` on their board. No rebroadcast.
4. Both boards now match; both persist the log to localStorage.
5. If the peer's hash disagrees → desync → exchange logs → `reconcileLogs` → replay.

## Error handling

- **Relay unreachable (create/join):** surface a clear toast; the player can retry. Offline tier (2P/AI) is unaffected.
- **ICE/connection failure (CGNAT, symmetric NAT):** TURN fallback handles most. If even TURN fails, emit `disconnected` with "couldn't connect — try again."
- **Mid-game drop:** state machine attempts ICE-restart reconnect (B); on exhaustion, prompt to re-share a link. No game state lost (log + localStorage).
- **Illegal/duplicate incoming move:** rejected by `validateIncoming`; never crashes; duplicate is idempotent via `ply`.
- **Desync:** detected by hash mismatch; resolved by log reconciliation; if logs genuinely conflict (non-prefix — should be impossible without a bug/tamper), surface an error and offer "new game."
- **Both peers refresh / room expired:** treated as a new connection; re-share link.

## Testing

- **Unit (vitest, pure):** `protocol.ts` — `hashLog` determinism, `validateIncoming` (each verdict), `reconcileLogs` (prefix wins, conflict detection), idempotency by `ply`.
- **Unit (mocked):** `signal.ts` against mocked `fetch`; `session.ts` state machine driven by a **fake `Peer`** (injected) — covers handshake order and all reconnect transitions deterministically, no real WebRTC.
- **Worker (`@cloudflare/vitest-pool-workers` / Miniflare):** room lifecycle, epoch bumps, `since` filtering, TTL expiry, 404s, payload-size + rate-limit guards, `GET /ice` shape.
- **Manual e2e:** two browser profiles for the happy path; forced network toggle to exercise reconnect; ideally one device behind CGNAT for the TURN path.
- **No real-RTCPeerConnection unit tests** — `peer.ts` is kept thin and verified manually; all logic worth testing lives above it behind the `Peer` interface.

## Deferred / open

- Option C (cold-rejoin from a fresh page load with a waiting opponent) — revisit only if reconnect-via-restart proves insufficient in real use.
- TURN provider swap (Metered / self-hosted coturn) — already supported via the Worker secret; not exercised in v1.
- Exact reconnect retry count / backoff timings — start at 4 attempts, 1s→8s backoff; tune by feel.
