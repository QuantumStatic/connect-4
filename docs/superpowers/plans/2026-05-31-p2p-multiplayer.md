# P2P Multiplayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add online "Play a friend" Connect 4 — two browsers connect peer-to-peer over WebRTC, exchanging move deltas, with a stateless Cloudflare Worker+KV relay for signaling and ICE/TURN, plus auto-reconnect via ICE restart.

**Architecture:** Game state stays in each peer as the existing move-log `GameState` (no server holds it). A Cloudflare Worker brokers the WebRTC handshake (offer/answer in KV, keyed by an unguessable room id with a monotonic epoch for reconnects) and mints STUN+TURN config. The frontend gains four focused modules — `protocol` (pure), `signal` (relay fetch), `peer` (WebRTC behind an interface), `session` (handshake + reconnect orchestration) — and `main.ts` is refactored so the opponent move source is `local | ai | remote` behind one apply path.

**Tech Stack:** TypeScript, Vite, PixiJS (existing); Cloudflare Workers + KV + Wrangler; `@cloudflare/vitest-pool-workers` for Worker tests; vitest (existing) for frontend units; WebRTC DataChannel.

**Spec:** [docs/superpowers/specs/2026-05-31-p2p-multiplayer-design.md](../specs/2026-05-31-p2p-multiplayer-design.md).

---

## File structure

```
connect-4/
  relay/                              # NEW — Cloudflare Worker (signaling + ICE)
    src/index.ts                      # router: /ice, /room, /room/:id, answer, offer
    src/rooms.ts                      # KV room read/write + epoch helpers (pure-ish)
    src/cors.ts                       # same-origin/relative; permissive only for dev
    wrangler.toml
    package.json
    tsconfig.json
    vitest.config.ts
    test/rooms.test.ts                # KV lifecycle, epoch, TTL, since-filtering
    test/router.test.ts              # endpoint contracts via vitest-pool-workers
  web/src/
    game/protocol.ts                  # NEW — pure: hashLog, makeDelta, validateIncoming, reconcileLogs
    game/protocol.test.ts             # NEW
    net/signal.ts                     # NEW — typed relay client (fetch)
    net/signal.test.ts                # NEW — against mocked fetch
    net/peer.ts                       # NEW — RTCPeerConnection wrapper behind Peer interface
    net/fakePeer.ts                   # NEW — in-memory Peer for tests
    net/session.ts                    # NEW — handshake + reconnect state machine
    net/session.test.ts               # NEW — driven by fakePeer + mocked signal
    game/persist.ts                   # MODIFY — persist mode "friend" + side; key bump v3
    ui/hud.ts                         # MODIFY — "Play a friend" entry, link box, conn-status chip
    main.ts                           # MODIFY — opponent source local|ai|remote; localSide; wire session
```

**Boundaries:**
- `relay/` knows nothing about Connect 4 — it stores opaque SDP strings.
- `protocol.ts` is pure (no DOM/fetch/WebRTC) — the only place move-wire rules live.
- `signal.ts` only does HTTP to the relay. `peer.ts` only does WebRTC. `session.ts` orchestrates them; it depends on the `Peer` *interface*, never the concrete RTC class, so it's testable with `fakePeer`.
- `state.ts`, `physics/`, `audio/`, `render/` are **not touched**.

**Conventions for this plan:**
- Frontend commands run from `web/` (e.g. `cd web && npm test`). Git commands run from the repo root; paths shown are repo-root-relative.
- Relay commands run from `relay/`.

---

## Phase 1 — Pure move protocol (no network)

### Task 1: `game/protocol.ts` — failing tests

**Files:**
- Create: `web/src/game/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/game/protocol.test.ts
import { describe, expect, it } from "vitest";
import { GameState } from "./state";
import { hashLog, makeDelta, validateIncoming, reconcileLogs } from "./protocol";

describe("hashLog", () => {
  it("is deterministic and order-sensitive", () => {
    expect(hashLog("3342")).toBe(hashLog("3342"));
    expect(hashLog("3342")).not.toBe(hashLog("3324"));
  });
  it("empty log hashes to a stable value", () => {
    expect(hashLog("")).toBe(hashLog(""));
  });
});

describe("makeDelta", () => {
  it("captures ply, column, and post-move hash", () => {
    const g = GameState.fromSequence("33"); // 2 moves played; next ply index = 2
    const d = makeDelta(g, 4);
    expect(d).toEqual({ ply: 2, col: 4, hash: hashLog("334") });
  });
});

describe("validateIncoming", () => {
  // localSide = "yellow" (host), so opponent = "green".
  // After "3" (yellow moved), it is green's turn at ply 1.
  it("accepts a legal opponent move at the expected ply", () => {
    const g = GameState.fromSequence("3");
    const d = { ply: 1, col: 4, hash: hashLog("34") };
    expect(validateIncoming(g, d, "green")).toBe("ok");
  });
  it("flags an already-seen ply as duplicate", () => {
    const g = GameState.fromSequence("34"); // ply 2 next; incoming ply 1 already applied
    const d = { ply: 1, col: 5, hash: hashLog("345") };
    expect(validateIncoming(g, d, "green")).toBe("duplicate");
  });
  it("rejects a move into a full column as illegal", () => {
    const g = GameState.fromSequence("000000" + "1"); // col 0 full (6), then yellow plays 1
    // it's green's turn at ply 7; col 0 is full → illegal
    const d = { ply: 7, col: 0, hash: "whatever" };
    expect(validateIncoming(g, d, "green")).toBe("illegal");
  });
  it("rejects a move when it is NOT the opponent's turn", () => {
    const g = GameState.fromSequence("34"); // it's yellow's turn (ply 2)
    const d = { ply: 2, col: 5, hash: hashLog("345") };
    expect(validateIncoming(g, d, "green")).toBe("illegal"); // green moving on yellow's turn
  });
  it("flags a hash mismatch as desync", () => {
    const g = GameState.fromSequence("3");
    const d = { ply: 1, col: 4, hash: "bad-hash" };
    expect(validateIncoming(g, d, "green")).toBe("desync");
  });
});

describe("reconcileLogs", () => {
  it("returns the longer log when the shorter is a prefix", () => {
    expect(reconcileLogs("33", "3342")).toBe("3342");
    expect(reconcileLogs("3342", "33")).toBe("3342");
  });
  it("returns equal log unchanged", () => {
    expect(reconcileLogs("3342", "3342")).toBe("3342");
  });
  it("returns 'conflict' when neither is a prefix of the other", () => {
    expect(reconcileLogs("334", "335")).toBe("conflict");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- protocol`
Expected: FAIL — cannot find module `./protocol`.

- [ ] **Step 3: Commit**

```bash
git add web/src/game/protocol.test.ts
git commit -m "test(web/protocol): failing tests for move protocol"
```

---

### Task 2: Implement `game/protocol.ts`

**Files:**
- Create: `web/src/game/protocol.ts`

- [ ] **Step 1: Implement**

```ts
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
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd web && npm test -- protocol`
Expected: PASS (all protocol tests).

- [ ] **Step 3: Commit**

```bash
git add web/src/game/protocol.ts
git commit -m "feat(web/protocol): pure move-wire protocol (hash, delta, validate, reconcile)"
```

---

## Phase 2 — Relay (Cloudflare Worker + KV)

### Task 3: Scaffold the relay Worker project

**Files:**
- Create: `relay/package.json`, `relay/tsconfig.json`, `relay/wrangler.toml`, `relay/vitest.config.ts`

- [ ] **Step 1: Write `relay/package.json`**

```json
{
  "name": "connect4-relay",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: Write `relay/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `relay/wrangler.toml`**

```toml
name = "connect4-relay"
main = "src/index.ts"
compatibility_date = "2024-09-23"

# KV namespace for ephemeral SDP rooms. Create with:
#   wrangler kv:namespace create ROOMS
# then paste the id below.
[[kv_namespaces]]
binding = "ROOMS"
id = "PLACEHOLDER_RUN_WRANGLER_KV_NAMESPACE_CREATE"

# TURN: set via `wrangler secret put TURN_KEY_ID` and `TURN_KEY_API_TOKEN`.
# STUN needs no secret.
```

Note: the KV `id` is filled in during deploy (Task 9); tests use Miniflare's simulated KV and don't need a real id.

- [ ] **Step 4: Write `relay/vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

- [ ] **Step 5: Install**

```bash
cd relay && npm install
```

Expected: installs wrangler + vitest pool. (No build yet — no source.)

- [ ] **Step 6: Commit**

```bash
git add relay/package.json relay/package-lock.json relay/tsconfig.json relay/wrangler.toml relay/vitest.config.ts
git commit -m "build(relay): scaffold Cloudflare Worker project"
```

---

### Task 4: Room store (`relay/src/rooms.ts`) — failing tests

**Files:**
- Create: `relay/test/rooms.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// relay/test/rooms.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createRoom, getRoom, putOffer, putAnswer } from "../src/rooms";

// env.ROOMS is the Miniflare-simulated KV namespace from wrangler.toml.

describe("rooms", () => {
  it("createRoom returns an unguessable id and stores the offer at epoch 0", async () => {
    const id = await createRoom(env.ROOMS, "OFFER_SDP");
    expect(id).toMatch(/^[0-9a-zA-Z]{22,}$/); // ~128-bit base62
    const room = await getRoom(env.ROOMS, id);
    expect(room).toMatchObject({ offerSdp: "OFFER_SDP", offerEpoch: 0, answerSdp: null, answerEpoch: -1 });
  });

  it("getRoom returns null for an unknown id", async () => {
    expect(await getRoom(env.ROOMS, "nope")).toBeNull();
  });

  it("putAnswer records the answer with its epoch", async () => {
    const id = await createRoom(env.ROOMS, "O0");
    await putAnswer(env.ROOMS, id, "ANS", 0);
    const room = await getRoom(env.ROOMS, id);
    expect(room).toMatchObject({ answerSdp: "ANS", answerEpoch: 0 });
  });

  it("putOffer bumps the offer epoch for reconnect rounds", async () => {
    const id = await createRoom(env.ROOMS, "O0");
    await putOffer(env.ROOMS, id, "O1", 1);
    const room = await getRoom(env.ROOMS, id);
    expect(room).toMatchObject({ offerSdp: "O1", offerEpoch: 1 });
  });

  it("putAnswer on a missing room is a no-op returning false", async () => {
    expect(await putAnswer(env.ROOMS, "ghost", "ANS", 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd relay && npm test -- rooms`
Expected: FAIL — cannot find module `../src/rooms`.

- [ ] **Step 3: Commit**

```bash
git add relay/test/rooms.test.ts
git commit -m "test(relay): failing tests for KV room store"
```

---

### Task 5: Implement `relay/src/rooms.ts`

**Files:**
- Create: `relay/src/rooms.ts`

- [ ] **Step 1: Implement**

```ts
// relay/src/rooms.ts
// KV-backed ephemeral signaling rooms. Stores only opaque SDP strings — never
// any game state. Each offer/answer slot carries a monotonic epoch so the same
// room can broker reconnect (ICE-restart) rounds.

export interface Room {
  offerSdp: string;
  offerEpoch: number;
  answerSdp: string | null;
  answerEpoch: number;
  createdAt: number;
}

const TTL_SECONDS = 2 * 60 * 60; // 2h, refreshed on each write

function randomId(): string {
  // 128 bits → base62-ish via hex grouping; unguessable.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(36).padStart(2, "0");
  return out;
}

async function write(kv: KVNamespace, id: string, room: Room): Promise<void> {
  await kv.put(`room:${id}`, JSON.stringify(room), { expirationTtl: TTL_SECONDS });
}

export async function createRoom(kv: KVNamespace, offerSdp: string): Promise<string> {
  const id = randomId();
  await write(kv, id, {
    offerSdp,
    offerEpoch: 0,
    answerSdp: null,
    answerEpoch: -1,
    createdAt: Date.now(),
  });
  return id;
}

export async function getRoom(kv: KVNamespace, id: string): Promise<Room | null> {
  const raw = await kv.get(`room:${id}`);
  return raw ? (JSON.parse(raw) as Room) : null;
}

export async function putOffer(kv: KVNamespace, id: string, offerSdp: string, epoch: number): Promise<boolean> {
  const room = await getRoom(kv, id);
  if (!room) return false;
  room.offerSdp = offerSdp;
  room.offerEpoch = epoch;
  await write(kv, id, room);
  return true;
}

export async function putAnswer(kv: KVNamespace, id: string, answerSdp: string, epoch: number): Promise<boolean> {
  const room = await getRoom(kv, id);
  if (!room) return false;
  room.answerSdp = answerSdp;
  room.answerEpoch = epoch;
  await write(kv, id, room);
  return true;
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd relay && npm test -- rooms`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
git add relay/src/rooms.ts
git commit -m "feat(relay): KV room store with epoch slots"
```

---

### Task 6: Router (`relay/src/index.ts`) — failing tests

**Files:**
- Create: `relay/test/router.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// relay/test/router.test.ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://relay.test${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("relay router", () => {
  it("GET /ice returns iceServers including a stun entry", async () => {
    const res = await call("GET", "/ice");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.iceServers)).toBe(true);
    expect(JSON.stringify(body.iceServers)).toMatch(/stun:/);
  });

  it("POST /room stores an offer and returns an id; GET /room/:id returns it", async () => {
    const create = await call("POST", "/room", { offer: "OFFER" });
    expect(create.status).toBe(200);
    const { id } = await create.json();
    expect(typeof id).toBe("string");

    const get = await call("GET", `/room/${id}`);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ offer: "OFFER", epoch: 0 });
  });

  it("GET /room/:id is 404 for unknown id", async () => {
    expect((await call("GET", "/room/ghost")).status).toBe(404);
  });

  it("answer round-trip: POST answer then GET answer?since returns it", async () => {
    const { id } = await (await call("POST", "/room", { offer: "O" })).json();
    expect((await call("POST", `/room/${id}/answer`, { answer: "ANS", epoch: 0 })).status).toBe(204);

    const poll = await call("GET", `/room/${id}/answer?since=-1`);
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ answer: "ANS", epoch: 0 });
  });

  it("GET answer?since=epoch returns 404 when nothing newer", async () => {
    const { id } = await (await call("POST", "/room", { offer: "O" })).json();
    await call("POST", `/room/${id}/answer`, { answer: "ANS", epoch: 0 });
    expect((await call("GET", `/room/${id}/answer?since=0`)).status).toBe(404); // not newer than 0
  });

  it("reconnect offer round-trip via POST/GET /room/:id/offer", async () => {
    const { id } = await (await call("POST", "/room", { offer: "O0" })).json();
    expect((await call("POST", `/room/${id}/offer`, { offer: "O1", epoch: 1 })).status).toBe(204);
    const poll = await call("GET", `/room/${id}/offer?since=0`);
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ offer: "O1", epoch: 1 });
  });

  it("rejects oversized payloads with 413", async () => {
    const huge = "x".repeat(200_000);
    expect((await call("POST", "/room", { offer: huge })).status).toBe(413);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd relay && npm test -- router`
Expected: FAIL — cannot find module `../src/index`.

- [ ] **Step 3: Commit**

```bash
git add relay/test/router.test.ts
git commit -m "test(relay): failing endpoint-contract tests"
```

---

### Task 7: Implement `relay/src/index.ts` (router) + `relay/src/cors.ts`

**Files:**
- Create: `relay/src/index.ts`
- Create: `relay/src/cors.ts`

- [ ] **Step 1: Write `relay/src/cors.ts`**

```ts
// relay/src/cors.ts
// Same-origin deploy needs no CORS. For local dev / separate-origin hosting we
// echo the request Origin (relay is non-sensitive: opaque SDP only).
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
```

- [ ] **Step 2: Write `relay/src/index.ts`**

```ts
// relay/src/index.ts
// Stateless signaling relay. Stores only opaque SDP in KV; never game state.
import { createRoom, getRoom, putOffer, putAnswer } from "./rooms";
import { corsHeaders } from "./cors";

interface Env {
  ROOMS: KVNamespace;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const MAX_BODY = 100_000; // SDP is a few KB; reject anything absurd.

function json(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}
function empty(status: number, req: Request): Response {
  return new Response(null, { status, headers: corsHeaders(req) });
}

async function readJson(req: Request): Promise<any | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return "TOO_LARGE";
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

/** STUN always; TURN creds minted from Cloudflare if configured. */
async function iceServers(env: Env): Promise<RTCIceServer[]> {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (r.ok) {
      const data: any = await r.json();
      if (data.iceServers) servers.push(data.iceServers);
    }
  }
  return servers;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return empty(204, req);
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["room","abc","answer"]

    // GET /ice
    if (req.method === "GET" && parts[0] === "ice" && parts.length === 1) {
      return json({ iceServers: await iceServers(env) }, 200, req);
    }

    // POST /room  { offer } -> { id }
    if (req.method === "POST" && parts[0] === "room" && parts.length === 1) {
      const body = await readJson(req);
      if (body === "TOO_LARGE") return empty(413, req);
      if (!body || typeof body.offer !== "string") return empty(400, req);
      const id = await createRoom(env.ROOMS, body.offer);
      return json({ id }, 200, req);
    }

    // /room/:id ...
    if (parts[0] === "room" && parts[1]) {
      const id = parts[1];
      const sub = parts[2];

      // GET /room/:id -> { offer, epoch }
      if (req.method === "GET" && !sub) {
        const room = await getRoom(env.ROOMS, id);
        if (!room) return empty(404, req);
        return json({ offer: room.offerSdp, epoch: room.offerEpoch }, 200, req);
      }

      // POST /room/:id/answer { answer, epoch }
      if (req.method === "POST" && sub === "answer") {
        const body = await readJson(req);
        if (body === "TOO_LARGE") return empty(413, req);
        if (!body || typeof body.answer !== "string" || typeof body.epoch !== "number") return empty(400, req);
        const ok = await putAnswer(env.ROOMS, id, body.answer, body.epoch);
        return empty(ok ? 204 : 404, req);
      }

      // GET /room/:id/answer?since=<epoch> -> { answer, epoch } | 404
      if (req.method === "GET" && sub === "answer") {
        const since = Number(url.searchParams.get("since") ?? "-1");
        const room = await getRoom(env.ROOMS, id);
        if (!room || room.answerSdp === null || room.answerEpoch <= since) return empty(404, req);
        return json({ answer: room.answerSdp, epoch: room.answerEpoch }, 200, req);
      }

      // POST /room/:id/offer { offer, epoch }  (reconnect)
      if (req.method === "POST" && sub === "offer") {
        const body = await readJson(req);
        if (body === "TOO_LARGE") return empty(413, req);
        if (!body || typeof body.offer !== "string" || typeof body.epoch !== "number") return empty(400, req);
        const ok = await putOffer(env.ROOMS, id, body.offer, body.epoch);
        return empty(ok ? 204 : 404, req);
      }

      // GET /room/:id/offer?since=<epoch> -> { offer, epoch } | 404  (reconnect)
      if (req.method === "GET" && sub === "offer") {
        const since = Number(url.searchParams.get("since") ?? "-1");
        const room = await getRoom(env.ROOMS, id);
        if (!room || room.offerEpoch <= since) return empty(404, req);
        return json({ offer: room.offerSdp, epoch: room.offerEpoch }, 200, req);
      }
    }

    return empty(404, req);
  },
};
```

- [ ] **Step 3: Run to verify it passes**

Run: `cd relay && npm test`
Expected: PASS (rooms + router suites).

- [ ] **Step 4: Commit**

```bash
git add relay/src/index.ts relay/src/cors.ts
git commit -m "feat(relay): signaling router with /ice, room, answer, reconnect-offer"
```

---

## Phase 3 — Frontend networking modules

### Task 8: `net/signal.ts` — failing tests + implementation

**Files:**
- Create: `web/src/net/signal.test.ts`
- Create: `web/src/net/signal.ts`

- [ ] **Step 1: Write failing tests**

```ts
// web/src/net/signal.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIceConfig, createRoom, fetchOffer, postAnswer, pollAnswer, pushOffer, pollOffer } from "./signal";

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(String(url), init);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe("signal", () => {
  it("getIceConfig returns the iceServers array", async () => {
    mockFetch((u) => u.endsWith("/ice") ? { status: 200, body: { iceServers: [{ urls: "stun:x" }] } } : { status: 404 });
    expect(await getIceConfig()).toEqual([{ urls: "stun:x" }]);
  });

  it("createRoom POSTs the offer and returns the id", async () => {
    mockFetch((u, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body)).offer).toBe("OFFER");
      return { status: 200, body: { id: "room123" } };
    });
    expect(await createRoom("OFFER")).toBe("room123");
  });

  it("fetchOffer returns offer + epoch", async () => {
    mockFetch(() => ({ status: 200, body: { offer: "O", epoch: 0 } }));
    expect(await fetchOffer("r")).toEqual({ offer: "O", epoch: 0 });
  });

  it("pollAnswer returns null on 404 (nothing newer)", async () => {
    mockFetch(() => ({ status: 404 }));
    expect(await pollAnswer("r", -1)).toBeNull();
  });

  it("pollAnswer returns answer + epoch on 200", async () => {
    mockFetch(() => ({ status: 200, body: { answer: "A", epoch: 0 } }));
    expect(await pollAnswer("r", -1)).toEqual({ answer: "A", epoch: 0 });
  });

  it("postAnswer and pushOffer issue POSTs with epoch", async () => {
    const seen: any[] = [];
    mockFetch((u, init) => { seen.push({ u, body: JSON.parse(String(init?.body)) }); return { status: 204 }; });
    await postAnswer("r", "A", 0);
    await pushOffer("r", "O1", 1);
    expect(seen[0].u).toMatch(/\/room\/r\/answer$/);
    expect(seen[0].body).toEqual({ answer: "A", epoch: 0 });
    expect(seen[1].u).toMatch(/\/room\/r\/offer$/);
    expect(seen[1].body).toEqual({ offer: "O1", epoch: 1 });
  });

  it("pollOffer returns null on 404", async () => {
    mockFetch(() => ({ status: 404 }));
    expect(await pollOffer("r", 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- signal`
Expected: FAIL — cannot find module `./signal`.

- [ ] **Step 3: Implement `web/src/net/signal.ts`**

```ts
// web/src/net/signal.ts
// Typed client for the Cloudflare relay. No WebRTC. Same-origin by default;
// override with VITE_RELAY_URL when the relay is on a different host.
const BASE = (import.meta.env?.VITE_RELAY_URL ?? "").replace(/\/$/, "");

const u = (path: string) => `${BASE}${path}`;

export async function getIceConfig(): Promise<RTCIceServer[]> {
  const res = await fetch(u("/ice"));
  if (!res.ok) throw new Error(`ice ${res.status}`);
  return (await res.json()).iceServers as RTCIceServer[];
}

export async function createRoom(offer: string): Promise<string> {
  const res = await fetch(u("/room"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offer }),
  });
  if (!res.ok) throw new Error(`createRoom ${res.status}`);
  return (await res.json()).id as string;
}

export async function fetchOffer(id: string): Promise<{ offer: string; epoch: number }> {
  const res = await fetch(u(`/room/${id}`));
  if (!res.ok) throw new Error(`fetchOffer ${res.status}`);
  return await res.json();
}

export async function postAnswer(id: string, answer: string, epoch: number): Promise<void> {
  const res = await fetch(u(`/room/${id}/answer`), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer, epoch }),
  });
  if (!res.ok) throw new Error(`postAnswer ${res.status}`);
}

export async function pollAnswer(id: string, sinceEpoch: number): Promise<{ answer: string; epoch: number } | null> {
  const res = await fetch(u(`/room/${id}/answer?since=${sinceEpoch}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pollAnswer ${res.status}`);
  return await res.json();
}

export async function pushOffer(id: string, offer: string, epoch: number): Promise<void> {
  const res = await fetch(u(`/room/${id}/offer`), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offer, epoch }),
  });
  if (!res.ok) throw new Error(`pushOffer ${res.status}`);
}

export async function pollOffer(id: string, sinceEpoch: number): Promise<{ offer: string; epoch: number } | null> {
  const res = await fetch(u(`/room/${id}/offer?since=${sinceEpoch}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pollOffer ${res.status}`);
  return await res.json();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- signal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/net/signal.test.ts web/src/net/signal.ts
git commit -m "feat(web/net): typed relay signaling client"
```

---

### Task 9: `net/peer.ts` (WebRTC) + `net/fakePeer.ts`

**Files:**
- Create: `web/src/net/peer.ts`
- Create: `web/src/net/fakePeer.ts`

This task has no unit test (real `RTCPeerConnection` isn't available in vitest/node). It defines the `Peer` interface, the real implementation (verified manually in Task 13's e2e), and an in-memory fake used to test `session.ts` in Task 10.

- [ ] **Step 1: Write `web/src/net/peer.ts`**

```ts
// web/src/net/peer.ts
// Thin wrapper over RTCPeerConnection + a reliable/ordered DataChannel, behind
// the Peer interface so session logic can be tested with a fake. Non-trickle:
// offer/answer resolve only after ICE gathering completes.
import type { WireMsg } from "../game/protocol";

export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface Peer {
  createOffer(): Promise<string>;
  acceptOffer(sdp: string): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  restart(): Promise<string>;
  send(msg: WireMsg): void;
  onMessage(fn: (m: WireMsg) => void): void;
  onState(fn: (s: ConnState) => void): void;
  close(): void;
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export class RtcPeer implements Peer {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private msgFn: (m: WireMsg) => void = () => {};
  private stateFn: (s: ConnState) => void = () => {};

  constructor(iceServers: RTCIceServer[], role: "host" | "guest") {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.addEventListener("connectionstatechange", () => {
      const s = this.pc.connectionState;
      if (s === "connected") this.stateFn("connected");
      else if (s === "failed") this.stateFn("reconnecting");
      else if (s === "disconnected") this.stateFn("reconnecting");
      else if (s === "closed") this.stateFn("disconnected");
    });
    if (role === "host") {
      this.attachChannel(this.pc.createDataChannel("moves", { ordered: true }));
    } else {
      this.pc.addEventListener("datachannel", (e) => this.attachChannel(e.channel));
    }
  }

  private attachChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.addEventListener("message", (e) => {
      try { this.msgFn(JSON.parse(e.data) as WireMsg); } catch { /* ignore malformed */ }
    });
    dc.addEventListener("open", () => this.stateFn("connected"));
  }

  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIce(this.pc);
    return JSON.stringify(this.pc.localDescription);
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription(JSON.parse(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIce(this.pc);
    return JSON.stringify(this.pc.localDescription);
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription(JSON.parse(sdp));
  }

  async restart(): Promise<string> {
    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    await waitForIce(this.pc);
    return JSON.stringify(this.pc.localDescription);
  }

  send(msg: WireMsg): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg));
  }
  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }
  close(): void { this.pc.close(); }
}
```

- [ ] **Step 2: Write `web/src/net/fakePeer.ts`**

```ts
// web/src/net/fakePeer.ts
// In-memory Peer pair for deterministic session tests. Two FakePeers can be
// linked so a send() on one delivers to the other's onMessage.
import type { Peer, ConnState } from "./peer";
import type { WireMsg } from "../game/protocol";

export class FakePeer implements Peer {
  private link: FakePeer | null = null;
  private msgFn: (m: WireMsg) => void = () => {};
  private stateFn: (s: ConnState) => void = () => {};
  offers = 0;
  restarts = 0;

  static linked(): [FakePeer, FakePeer] {
    const a = new FakePeer();
    const b = new FakePeer();
    a.link = b; b.link = a;
    return [a, b];
  }

  async createOffer(): Promise<string> { this.offers++; return `offer#${this.offers}`; }
  async acceptOffer(sdp: string): Promise<string> { return `answer-to:${sdp}`; }
  async acceptAnswer(_sdp: string): Promise<void> { /* no-op */ }
  async restart(): Promise<string> { this.restarts++; return `restart#${this.restarts}`; }
  send(msg: WireMsg): void { this.link?.msgFn(msg); }
  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }
  close(): void { /* no-op */ }

  /** test helper: drive a connection-state transition */
  emitState(s: ConnState): void { this.stateFn(s); }
}
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/net/peer.ts web/src/net/fakePeer.ts
git commit -m "feat(web/net): RTCPeer wrapper + FakePeer for tests"
```

---

### Task 10: `net/session.ts` — failing tests + implementation

**Files:**
- Create: `web/src/net/session.test.ts`
- Create: `web/src/net/session.ts`

- [ ] **Step 1: Write failing tests**

```ts
// web/src/net/session.test.ts
import { describe, expect, it, vi } from "vitest";
import { FakePeer } from "./fakePeer";
import { Session } from "./session";

// Minimal signal stub the Session depends on (injected).
function stubSignal() {
  const store: any = { answer: null, answerEpoch: -1, offer: "O0", offerEpoch: 0 };
  return {
    store,
    createRoom: vi.fn(async (_offer: string) => "ROOM"),
    fetchOffer: vi.fn(async () => ({ offer: store.offer, epoch: store.offerEpoch })),
    postAnswer: vi.fn(async (_id: string, a: string, e: number) => { store.answer = a; store.answerEpoch = e; }),
    pollAnswer: vi.fn(async (_id: string, since: number) =>
      store.answer !== null && store.answerEpoch > since ? { answer: store.answer, epoch: store.answerEpoch } : null),
    pushOffer: vi.fn(async (_id: string, o: string, e: number) => { store.offer = o; store.offerEpoch = e; }),
    pollOffer: vi.fn(async (_id: string, since: number) =>
      store.offerEpoch > since ? { offer: store.offer, epoch: store.offerEpoch } : null),
  };
}

describe("Session", () => {
  it("host creates a room and exposes the join link id", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ peer, signal: signal as any, role: "host" });
    const id = await s.host();
    expect(id).toBe("ROOM");
    expect(signal.createRoom).toHaveBeenCalledOnce();
  });

  it("guest fetches the offer and posts an answer", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ peer, signal: signal as any, role: "guest" });
    await s.join("ROOM");
    expect(signal.fetchOffer).toHaveBeenCalledWith("ROOM");
    expect(signal.postAnswer).toHaveBeenCalled();
    expect(signal.store.answerEpoch).toBe(0);
  });

  it("delivers incoming wire messages to onMessage", async () => {
    const [a, b] = FakePeer.linked();
    const signal = stubSignal();
    const s = new Session({ peer: a, signal: signal as any, role: "host" });
    const got: any[] = [];
    s.onMessage((m) => got.push(m));
    b.send({ type: "move", delta: { ply: 0, col: 3, hash: "h" } });
    expect(got).toEqual([{ type: "move", delta: { ply: 0, col: 3, hash: "h" } }]);
  });

  it("on reconnecting, the HOST issues an ICE-restart offer to the relay", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ peer, signal: signal as any, role: "host" });
    await s.host();
    peer.emitState("reconnecting");
    await vi.waitFor(() => expect(peer.restarts).toBe(1));
    expect(signal.pushOffer).toHaveBeenCalledWith("ROOM", "restart#1", 1);
  });

  it("on reconnecting, the GUEST does NOT issue an offer (no glare)", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ peer, signal: signal as any, role: "guest" });
    await s.join("ROOM");
    peer.emitState("reconnecting");
    await new Promise((r) => setTimeout(r, 20));
    expect(peer.restarts).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- session`
Expected: FAIL — cannot find module `./session`.

- [ ] **Step 3: Implement `web/src/net/session.ts`**

```ts
// web/src/net/session.ts
// Orchestrates the WebRTC handshake + reconnect (ICE restart) over the relay.
// Depends only on the Peer interface and a signal-shaped object, so it is fully
// testable with FakePeer + a stub signal. Glare rule: only the host re-offers.
import type { Peer, ConnState } from "./peer";
import type { WireMsg } from "../game/protocol";
import * as defaultSignal from "./signal";

type Signal = Pick<typeof defaultSignal,
  "createRoom" | "fetchOffer" | "postAnswer" | "pollAnswer" | "pushOffer" | "pollOffer">;

export interface SessionOpts {
  peer: Peer;
  role: "host" | "guest";
  signal?: Signal;
}

const POLL_MS = 1000;
const MAX_RECONNECT = 4;

export class Session {
  private peer: Peer;
  private role: "host" | "guest";
  private signal: Signal;
  private roomId = "";
  private epoch = 0;
  private answerSince = -1;
  private offerSince = 0;
  private msgFn: (m: WireMsg) => void = () => {};
  private stateFn: (s: ConnState) => void = () => {};
  private reconnecting = false;

  constructor(opts: SessionOpts) {
    this.peer = opts.peer;
    this.role = opts.role;
    this.signal = opts.signal ?? (defaultSignal as Signal);
    this.peer.onMessage((m) => this.msgFn(m));
    this.peer.onState((s) => this.handleState(s));
  }

  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }
  send(m: WireMsg): void { this.peer.send(m); }

  /** Host: create offer, register room, return id for the share link, then poll
   *  for the guest's answer in the background. */
  async host(): Promise<string> {
    const offer = await this.peer.createOffer();
    this.roomId = await this.signal.createRoom(offer);
    void this.awaitAnswer();
    return this.roomId;
  }

  /** Guest: fetch the host offer, answer it, post the answer. */
  async join(id: string): Promise<void> {
    this.roomId = id;
    const { offer, epoch } = await this.signal.fetchOffer(id);
    this.offerSince = epoch;
    const answer = await this.peer.acceptOffer(offer);
    await this.signal.postAnswer(id, answer, epoch);
    this.answerSince = epoch;
  }

  private async awaitAnswer(): Promise<void> {
    for (;;) {
      const got = await this.signal.pollAnswer(this.roomId, this.answerSince);
      if (got) {
        this.answerSince = got.epoch;
        await this.peer.acceptAnswer(got.answer);
        return;
      }
      await sleep(POLL_MS);
    }
  }

  private handleState(s: ConnState): void {
    this.stateFn(s);
    if (s === "reconnecting" && !this.reconnecting) void this.reconnect();
  }

  /** Host re-offers via ICE restart; guest waits for the new offer epoch. */
  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      for (let attempt = 0; attempt < MAX_RECONNECT; attempt++) {
        try {
          if (this.role === "host") {
            const offer = await this.peer.restart();
            this.epoch += 1;
            await this.signal.pushOffer(this.roomId, offer, this.epoch);
            const ans = await this.pollUntil(() => this.signal.pollAnswer(this.roomId, this.answerSince));
            this.answerSince = ans.epoch;
            await this.peer.acceptAnswer(ans.answer);
          } else {
            const off = await this.pollUntil(() => this.signal.pollOffer(this.roomId, this.offerSince));
            this.offerSince = off.epoch;
            const answer = await this.peer.acceptOffer(off.offer);
            await this.signal.postAnswer(this.roomId, answer, off.epoch);
          }
          this.reconnecting = false;
          return; // a successful (re)connect fires onState("connected") via the peer
        } catch {
          await sleep(POLL_MS * (attempt + 1));
        }
      }
      this.stateFn("disconnected");
    } finally {
      this.reconnecting = false;
    }
  }

  private async pollUntil<T>(fn: () => Promise<T | null>): Promise<T> {
    for (;;) {
      const v = await fn();
      if (v) return v;
      await sleep(POLL_MS);
    }
  }

  close(): void { this.peer.close(); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test -- session`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/net/session.test.ts web/src/net/session.ts
git commit -m "feat(web/net): session handshake + ICE-restart reconnect orchestration"
```

---

## Phase 4 — Game integration

### Task 11: `game/persist.ts` — add friend mode + bump key

**Files:**
- Modify: `web/src/game/persist.ts`

- [ ] **Step 1: Update the Mode type, SavedGame, and key**

Replace the `Mode` type and `KEY` constant. The new `Mode` adds `"friend"`; `SavedGame` gains an optional `roomId` so a refresh can offer to rejoin. Bump the key to invalidate older saves.

```ts
// web/src/game/persist.ts
// localStorage persistence for resume-on-reload.

import { GameState } from "./state";

export type Mode = "2P" | "good" | "great" | "friend";

export interface SavedGame {
  moves: string;
  mode: Mode;
  humanSide: "yellow" | "green" | null; // localSide in vs-AI / friend; null in 2P
  roomId?: string; // present in friend mode
  ts: number;
}

// v3: added "friend" mode + roomId.
const KEY = "connect4:save:v3";

export function save(g: GameState, mode: Mode, humanSide: SavedGame["humanSide"], roomId?: string): void {
  const data: SavedGame = { moves: g.moves, mode, humanSide, roomId, ts: Date.now() };
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
```

- [ ] **Step 2: Run existing tests + build**

Run: `cd web && npm test && npx tsc -b`
Expected: existing 14 tests still pass; type-check clean. (Note: `main.ts` will not type-check until Task 13 updates the `save()` callers — if `tsc -b` fails only on `main.ts` arity, that is expected and resolved in Task 13. Run `npm test` to confirm non-main tests pass.)

- [ ] **Step 3: Commit**

```bash
git add web/src/game/persist.ts
git commit -m "feat(web/persist): add friend mode + roomId, bump key v3"
```

---

### Task 12: `ui/hud.ts` — friend entry, link box, connection chip

**Files:**
- Modify: `web/src/ui/hud.ts`

- [ ] **Step 1: Add friend-mode UI to the HUD**

Add a "Play a friend" `<option>` to the mode select, plus three new methods: `showHostLink(url)`, `showConnState(state)`, and `onCopyLink`. Add the new option value to the select-building loop and the methods to the class.

Replace the select-building loop:
```ts
    for (const [value, label] of [
      ["2P", "2 Player"],
      ["good", "vs Good player"],
      ["great", "vs Great player"],
      ["friend", "Play a friend"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      this.modeSel.appendChild(opt);
    }
```

Add these fields near the other `private` element fields:
```ts
  private linkBox = document.createElement("div");
  private connChip = document.createElement("span");
```

Append them in the constructor after `root.append(...)`:
```ts
    this.linkBox.className = "linkbox";
    this.linkBox.style.display = "none";
    this.connChip.className = "conn-chip";
    this.connChip.style.display = "none";
    root.append(this.connChip, this.linkBox);
```

Add these methods:
```ts
  /** Show the shareable join link with a copy button. */
  showHostLink(url: string): void {
    this.linkBox.style.display = "flex";
    this.linkBox.replaceChildren();
    const input = document.createElement("input");
    input.readOnly = true; input.value = url; input.className = "link-input";
    const copy = document.createElement("button");
    copy.textContent = "Copy link";
    copy.onclick = () => { void navigator.clipboard.writeText(url); copy.textContent = "Copied!"; };
    const hint = document.createElement("span");
    hint.textContent = "Send this to your friend";
    this.linkBox.append(input, copy, hint);
  }

  hideHostLink(): void { this.linkBox.style.display = "none"; }

  /** Show/refresh the connection-status chip. */
  showConnState(state: "connecting" | "connected" | "reconnecting" | "disconnected" | null): void {
    if (state === null) { this.connChip.style.display = "none"; return; }
    this.connChip.style.display = "inline-block";
    this.connChip.textContent = state;
    this.connChip.dataset.state = state;
  }
```

- [ ] **Step 2: Add styles to `web/index.html`**

Add inside the `<style>` block:
```css
      .linkbox { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
      .link-input { width: 280px; background: #11141d; color: #e7e7ea; border: 1px solid #2c3146; border-radius: 6px; padding: 6px 8px; }
      .conn-chip { padding: 4px 10px; border-radius: 999px; font-size: 13px; border: 1px solid #2c3146; }
      .conn-chip[data-state="connected"] { color: #3aa05a; border-color: #2f6b43; }
      .conn-chip[data-state="reconnecting"] { color: #e6c437; border-color: #6b5e1a; }
      .conn-chip[data-state="disconnected"], .conn-chip[data-state="connecting"] { color: #c46; border-color: #6b2a3a; }
```

- [ ] **Step 3: Build**

Run: `cd web && npm run build`
Expected: type-check + build succeed (HUD changes are self-contained; `main.ts` wiring comes next — if `tsc -b` errors only on `main.ts`, proceed to Task 13).

- [ ] **Step 4: Commit**

```bash
git add web/src/ui/hud.ts web/index.html
git commit -m "feat(web/ui): friend-mode link box + connection-status chip"
```

---

### Task 13: Wire P2P into `main.ts`

**Files:**
- Modify: `web/src/main.ts`

This task connects everything: a `friend` mode that hosts or joins (based on a `#join=<id>` URL fragment), routes remote moves through the existing apply path, and broadcasts local moves. `localSide` replaces the implicit human side.

- [ ] **Step 1: Add imports and constants at the top of `main.ts`**

After the existing imports add:
```ts
import { Session } from "./net/session";
import { RtcPeer } from "./net/peer";
import { getIceConfig } from "./net/signal";
import { makeDelta, validateIncoming, reconcileLogs, type WireMsg } from "./game/protocol";
```

- [ ] **Step 2: Add P2P fields and a session reference to the `Game` class**

Add fields near the other private fields:
```ts
  private session: Session | null = null;
  private remoteSide: Cell | null = null; // the friend's color (opposite localSide)
```

- [ ] **Step 3: Update `save()` calls to pass the room id in friend mode**

Every `save(this.state, this.mode, this.humanSide)` call becomes:
```ts
    save(this.state, this.mode, this.humanSide, this.session ? this.roomId : undefined);
```
Add a `private roomId = "";` field. (There are calls in `setMode`, `newGame`, and `animateAndApply` — update all three.)

- [ ] **Step 4: Add the friend-mode entry method**

Add to the `Game` class:
```ts
  /** Enter friend mode. If the URL has #join=<id>, join as guest; else host. */
  async startFriend(): Promise<void> {
    this.mode = "friend";
    const joinId = new URLSearchParams(location.hash.slice(1)).get("join");
    const role: "host" | "guest" = joinId ? "guest" : "host";
    this.localSide = role === "host" ? "yellow" : "green";
    this.remoteSide = role === "host" ? "green" : "yellow";
    this.humanSide = this.localSide;
    this.hud.showConnState("connecting");

    let ice: RTCIceServer[];
    try { ice = await getIceConfig(); }
    catch { this.hud.toast("Relay offline — can't start an online game."); this.hud.showConnState("disconnected"); return; }

    const peer = new RtcPeer(ice, role);
    this.session = new Session({ peer, role });
    this.session.onState((s) => this.hud.showConnState(s));
    this.session.onMessage((m) => this.onWire(m));

    if (role === "host") {
      this.roomId = await this.session.host();
      const url = `${location.origin}${location.pathname}#join=${this.roomId}`;
      this.hud.showHostLink(url);
    } else {
      this.roomId = joinId!;
      await this.session.join(joinId!);
    }
  }
```

- [ ] **Step 5: Add the wire-message handler**

Add to the `Game` class:
```ts
  private onWire(m: WireMsg): void {
    if (m.type === "sync") {
      const agreed = reconcileLogs(this.state.moves, m.log);
      if (agreed === "conflict") { this.hud.toast("Game out of sync — start a new game."); return; }
      if (agreed !== this.state.moves) {
        this.state = GameState.fromSequence(agreed);
        this.scene.syncFromState(this.state);
        this.updateStatus();
      }
      return;
    }
    // m.type === "move"
    if (!this.remoteSide) return;
    const verdict = validateIncoming(this.state, m.delta, this.remoteSide);
    if (verdict === "ok") { this.pendingCol = m.delta.col; void this.pump(); }
    else if (verdict === "desync") { this.session?.send({ type: "sync", log: this.state.moves }); }
    // "duplicate" / "illegal" → ignore
  }
```

Note: a remote "ok" move is applied by routing it through the same `pump()` path. Because in friend mode the `aiToMove()` check is false and it is the remote side's turn, add a small guard so `pump()` will drain `pendingCol` for the remote move. Update `aiToMove()` is unaffected; instead update the turn-guard in `onColumnClick` (Step 7) and rely on `pump()` draining `pendingCol` regardless of side in friend mode.

- [ ] **Step 6: Broadcast local moves**

In `animateAndApply`, after `this.state.applyMove(col)` and the `save(...)` line, add:
```ts
    if (this.mode === "friend" && this.session && player === this.localSide) {
      this.session.send({ type: "move", delta: makeDelta(GameState.fromSequence(this.state.moves.slice(0, -1)), col) });
    }
```
Note: `makeDelta` needs the pre-move state; reconstruct it from the log minus the last move so `ply`/`hash` are correct. (Alternatively compute the delta before applying — but applying first keeps the existing flow; the reconstruction is O(≤42).)

- [ ] **Step 7: Gate local input to your side in friend mode**

In `onColumnClick`, change the turn guard so that in friend mode you can only drop on your own turn. Replace the early section of `onColumnClick`:
```ts
  onColumnClick(col: number): void {
    if (this.state.status !== "ongoing") return;
    // In vs-AI and friend modes, only act on the local side's turn.
    const myTurn = this.mode === "2P" || this.state.toMove === this.localSide;
    if (this.busy) {
      if (myTurn) { this.pendingCol = this.pendingCol === col ? null : col; this.updateQueuedGhost(); }
      return;
    }
    if (!myTurn) return;
    this.pendingCol = col;
    void this.pump();
  }
```
(Replaces the prior body that referenced `humanSide`. Ensure the class uses `localSide` consistently — rename the field `humanSide` → `localSide` throughout `main.ts`, keeping `this.humanSide` only where `save()`/`persist` expects it. To avoid confusion, keep one field `localSide: Cell | null` and pass it as the `humanSide` argument to `save()`.)

- [ ] **Step 8: Rename `humanSide` → `localSide` in `main.ts`**

Rename the field and all references (`this.humanSide` → `this.localSide`) in `main.ts`. The `save()` calls pass `this.localSide` for the `humanSide` parameter. The `maybeAiTurn`/`aiToMove`/`setMode` logic that compared `this.state.toMove === this.humanSide` now uses `this.localSide`.

- [ ] **Step 9: Hook friend mode into `setMode`**

In `setMode`, when the chosen mode is `"friend"`, delegate to `startFriend()` instead of the AI path:
```ts
  setMode(mode: Mode): void {
    this.mode = mode;
    if (mode === "friend") { void this.startFriend(); return; }
    this.localSide = mode === "2P" ? null : "yellow";
    this.session?.close(); this.session = null; this.remoteSide = null;
    this.hud.showConnState(null); this.hud.hideHostLink();
    save(this.state, this.mode, this.localSide);
    void this.pump();
  }
```

- [ ] **Step 10: Auto-join on load if the URL has `#join`**

In `main()` after constructing `game` and before/with `game.start()`, add:
```ts
  if (new URLSearchParams(location.hash.slice(1)).get("join")) {
    // Reflect the mode in the selector and enter friend mode as guest.
    await game.startFriend();
  } else {
    await game.start();
  }
```

- [ ] **Step 11: On connect, send a sync message**

In `startFriend`, the `onState` handler should send the local log once connected so logs reconcile. Update the `onState` wiring:
```ts
    this.session.onState((s) => {
      this.hud.showConnState(s);
      if (s === "connected") this.session?.send({ type: "sync", log: this.state.moves });
    });
```

- [ ] **Step 12: Build + run existing tests**

Run: `cd web && npm run build && npm test`
Expected: type-check + build succeed; all prior unit tests (state, chip, protocol, signal, session) pass.

- [ ] **Step 13: Commit**

```bash
git add web/src/main.ts
git commit -m "feat(web): wire P2P friend mode — host/join, remote moves, sync, localSide"
```

---

## Phase 5 — Deploy config & docs

### Task 14: Pages + Worker deploy wiring and README

**Files:**
- Create: `relay/README.md`
- Modify: `README.md`
- Create: `web/.env.example`

- [ ] **Step 1: Write `web/.env.example`**

```
# Leave empty for same-origin deploy (Pages + Worker on one domain).
# Set to the relay's full URL only if hosting the relay on a separate origin.
VITE_RELAY_URL=
```

- [ ] **Step 2: Write `relay/README.md`**

````markdown
# Connect 4 signaling relay (Cloudflare Worker)

Stateless WebRTC signaling + ICE/TURN for "Play a friend". Stores only ephemeral
SDP in KV — never any game state.

## Deploy

```bash
cd relay
npm install
wrangler kv:namespace create ROOMS      # paste the printed id into wrangler.toml
wrangler secret put TURN_KEY_ID          # from Cloudflare dashboard → Realtime → TURN
wrangler secret put TURN_KEY_API_TOKEN
wrangler deploy
```

To serve the relay on the same origin as the Pages app (recommended, no CORS),
add a Worker route binding the deployed Worker to your Pages domain for the
`/ice`, `/room*` paths (Cloudflare dashboard → Workers Routes), or use Pages
Functions. Otherwise set `VITE_RELAY_URL` in the web build to the Worker URL.

## Test

```bash
npm test
```
````

- [ ] **Step 3: Add a "Play a friend (online)" section to the root `README.md`**

Insert after the "Game modes" section:
```markdown
## Play a friend (online, peer-to-peer)

Two friends play directly browser-to-browser over WebRTC — no game server holds
state. A stateless Cloudflare Worker only brokers the connection.

**Deploy (one-time):**
1. Deploy the relay: see [`relay/README.md`](relay/README.md).
2. Deploy the web app to Cloudflare Pages (`cd web && npm run build`, then point
   Pages at `web/dist`). Put the Worker on the same domain (Worker route) so the
   app reaches it at `/ice` and `/room` with no CORS — or set `VITE_RELAY_URL`.

**Play:** pick "Play a friend", click *Create*, send the link to your friend over
any chat app. They open it and you're connected. Dropped connections auto-reconnect;
if that fails, share a fresh link. Games survive reload (move log in localStorage).
```

- [ ] **Step 4: Commit**

```bash
git add web/.env.example relay/README.md README.md
git commit -m "docs: deploy wiring + Play-a-friend instructions"
```

---

### Task 15: Manual end-to-end verification

**Files:** none (manual).

- [ ] **Step 1: Local two-tab smoke test**

Run the relay locally and the web app, open two browser profiles:
```bash
cd relay && npm run dev          # wrangler dev on :8787
# in web/, set VITE_RELAY_URL=http://localhost:8787 then:
cd web && npm run dev
```
Tab A: pick "Play a friend" → Create → copy link. Tab B: open the link. Verify:
1. Both show `connected`.
2. A move in Tab A appears in Tab B (correct column + color) and vice-versa.
3. Turn enforcement: clicking on the opponent's turn does nothing.
4. Win highlight + status agree on both tabs.
5. Reload Tab B → resync restores the same board.

- [ ] **Step 2: Reconnect test**

Mid-game, in Tab B's devtools Network panel toggle offline ~3s then back online.
Verify the status chip goes `reconnecting` → `connected` and the boards are still
in sync (a move made just after reconnect propagates).

- [ ] **Step 3: Deployed cross-network test (if deploying)**

Deploy relay + Pages; open the link on two devices on different networks (ideally
one on cellular to exercise TURN). Confirm a full game plays end to end.

- [ ] **Step 4: Commit a note (optional)**

```bash
git commit --allow-empty -m "test(p2p): manual e2e verified (local two-tab + reconnect)"
```

---

## Self-review notes

- **Spec coverage:** relay endpoints (Tasks 3–7), `/ice`+TURN (Task 7), protocol+hash+validate+reconcile (Tasks 1–2), signal client (Task 8), peer wrapper+fake (Task 9), session handshake+reconnect+glare (Task 10), persistence (Task 11), UI link+chip (Task 12), main wiring incl. sync/localSide/auto-join (Task 13), deploy+docs (Task 14), manual e2e incl. reconnect+TURN (Task 15). All spec sections mapped.
- **Wire framing:** `WireMsg = {type:"move",delta} | {type:"sync",log}` defined in `protocol.ts` (Task 2), consumed by `peer.ts` (Task 9), `session.ts` (Task 10), and `main.ts` `onWire` (Task 13) — consistent.
- **Epoch model:** `offerEpoch`/`answerEpoch` in `rooms.ts` (Task 5) ↔ `since` filtering in router (Task 7) ↔ `answerSince`/`offerSince` in session (Task 10) — consistent; reconnect bumps `epoch` and pushes via `/room/:id/offer`.
- **Signatures:** `signal` function names match between client (Task 8), the `Signal` type alias and stub (Task 10). `Peer` interface identical across `peer.ts`, `fakePeer.ts`, and `session.ts`.
- **Naming:** `humanSide` is renamed to `localSide` in `main.ts` (Task 8/13) but persists under the `humanSide` field name in `SavedGame` (Task 11) — the `save()` call passes `localSide` as that argument; this boundary is called out explicitly in Task 13 Step 7–8.
- **No placeholders** except the KV namespace id in `wrangler.toml`, which is intentionally filled at deploy time (documented in Task 3 + Task 14) and not needed for Miniflare tests.
