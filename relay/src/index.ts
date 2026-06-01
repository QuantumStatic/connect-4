// relay/src/index.ts
// Stateless signaling relay. Stores only opaque SDP in KV; never game state.
import { createRoom, getRoom, putOffer, putAnswer, deleteRoom } from "./rooms";
import { corsHeaders } from "./cors";
export { RoomDO } from "./room";

interface Env {
  ROOMS: KVNamespace;
  ROOMS_DO: DurableObjectNamespace;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
}

const MAX_BODY = 100_000; // SDP is a few KB; reject anything absurd.

function json(body: unknown, status: number, req: Request, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req, env) },
  });
}
function empty(status: number, req: Request, env: Env): Response {
  return new Response(null, { status, headers: corsHeaders(req, env) });
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
      const ice = data.iceServers;
      if (ice) servers.push(...(Array.isArray(ice) ? ice : [ice]));
    }
  }
  return servers;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return empty(204, req, env);
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["room","abc","answer"]

    // GET /ice
    if (req.method === "GET" && parts[0] === "ice" && parts.length === 1) {
      return json({ iceServers: await iceServers(env) }, 200, req, env);
    }

    // POST /room  { offer } -> { id }
    if (req.method === "POST" && parts[0] === "room" && parts.length === 1) {
      const body = await readJson(req);
      if (body === "TOO_LARGE") return empty(413, req, env);
      if (!body || typeof body.offer !== "string") return empty(400, req, env);
      const id = await createRoom(env.ROOMS, body.offer);
      return json({ id }, 200, req, env);
    }

    // /room/:id ...
    if (parts[0] === "room" && parts[1]) {
      const id = parts[1];
      const sub = parts[2];

      // GET /room/:id -> { offer, epoch }
      if (req.method === "GET" && !sub) {
        const room = await getRoom(env.ROOMS, id);
        if (!room) return empty(404, req, env);
        return json({ offer: room.offerSdp, epoch: room.offerEpoch }, 200, req, env);
      }

      // DELETE /room/:id -> 204 (explicit teardown; idempotent)
      if (req.method === "DELETE" && !sub) {
        await deleteRoom(env.ROOMS, id);
        return empty(204, req, env);
      }

      // POST /room/:id/answer { answer, epoch }
      if (req.method === "POST" && sub === "answer") {
        const body = await readJson(req);
        if (body === "TOO_LARGE") return empty(413, req, env);
        if (!body || typeof body.answer !== "string" || typeof body.epoch !== "number") return empty(400, req, env);
        const ok = await putAnswer(env.ROOMS, id, body.answer, body.epoch);
        return empty(ok ? 204 : 404, req, env);
      }

      // GET /room/:id/answer?since=<epoch> -> { answer, epoch } | 404
      if (req.method === "GET" && sub === "answer") {
        const since = Number(url.searchParams.get("since") ?? "-1");
        const room = await getRoom(env.ROOMS, id);
        if (!room || room.answerSdp === null || room.answerEpoch <= since) return empty(404, req, env);
        return json({ answer: room.answerSdp, epoch: room.answerEpoch }, 200, req, env);
      }

      // POST /room/:id/offer { offer, epoch }  (reconnect)
      if (req.method === "POST" && sub === "offer") {
        const body = await readJson(req);
        if (body === "TOO_LARGE") return empty(413, req, env);
        if (!body || typeof body.offer !== "string" || typeof body.epoch !== "number") return empty(400, req, env);
        const ok = await putOffer(env.ROOMS, id, body.offer, body.epoch);
        return empty(ok ? 204 : 404, req, env);
      }

      // GET /room/:id/offer?since=<epoch> -> { offer, epoch } | 404  (reconnect)
      if (req.method === "GET" && sub === "offer") {
        const since = Number(url.searchParams.get("since") ?? "-1");
        const room = await getRoom(env.ROOMS, id);
        if (!room || room.offerEpoch <= since) return empty(404, req, env);
        return json({ offer: room.offerSdp, epoch: room.offerEpoch }, 200, req, env);
      }
    }

    return empty(404, req, env);
  },
};
