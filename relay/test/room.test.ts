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
    // Set up a self-echo promise on `a` before sending
    const selfEcho = new Promise<any>((resolve) =>
      a.addEventListener("message", (e: MessageEvent) => resolve(JSON.parse(e.data as string)), { once: true }),
    );
    const got = next(b);
    a.send(JSON.stringify({ type: "move", delta: { ply: 0, col: 3, hash: "h" } }));
    // Confirm `b` receives it
    expect(await got).toMatchObject({ type: "move", delta: { ply: 0, col: 3 } });
    // Verify `a` did NOT receive its own message back
    const noEcho = await Promise.race([
      selfEcho.then(() => "echoed"),
      new Promise<string>((r) => setTimeout(() => r("silent"), 50)),
    ]);
    expect(noEcho).toBe("silent");
  });

  it("caches the last sync and replays it to a socket that connects later", async () => {
    const a = await connect("room-cache");
    await next(a); // welcome
    a.send(JSON.stringify({ type: "sync", gen: 2, log: "334", score: { yellow: 1, green: 0 } }));
    // small delay so the DO processes the sync before B connects
    await new Promise((r) => setTimeout(r, 50));
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
