// Typed client for the Cloudflare relay. No WebRTC. Same-origin by default;
// override with VITE_RELAY_URL when the relay is on a different host.
const BASE = ((import.meta as any).env?.VITE_RELAY_URL ?? "").replace(/\/$/, "");

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
