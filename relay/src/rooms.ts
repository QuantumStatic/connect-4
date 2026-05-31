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

const TTL_SECONDS = 60 * 60; // 1h, refreshed on each write

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

export async function deleteRoom(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`room:${id}`);
}
