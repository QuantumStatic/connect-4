// relay/test/router.test.ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("DELETE /room/:id removes the room (subsequent GET is 404)", async () => {
    const { id } = await (await call("POST", "/room", { offer: "O" })).json();
    expect((await call("GET", `/room/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/room/${id}`)).status).toBe(204);
    expect((await call("GET", `/room/${id}`)).status).toBe(404);
  });

  it("DELETE is idempotent — deleting a missing room still returns 204", async () => {
    expect((await call("DELETE", "/room/does-not-exist")).status).toBe(204);
  });
});

describe("GET /ice TURN branch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (env as any).TURN_KEY_ID;
    delete (env as any).TURN_KEY_API_TOKEN;
  });

  async function ice(): Promise<{ iceServers: any[] }> {
    const res = await call("GET", "/ice");
    expect(res.status).toBe(200);
    return res.json();
  }

  it("returns only STUN when TURN env is unset", async () => {
    const body = await ice();
    expect(body.iceServers.length).toBe(1);
    expect(body.iceServers[0].urls).toMatch(/^stun:/);
  });

  it("appends a single TURN server object alongside STUN", async () => {
    (env as any).TURN_KEY_ID = "id";
    (env as any).TURN_KEY_API_TOKEN = "tok";
    const turn = { urls: ["turn:turn.example:3478"], username: "u", credential: "c" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ iceServers: turn }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const body = await ice();
    expect(body.iceServers.length).toBe(2);
    expect(body.iceServers[0].urls).toMatch(/^stun:/);
    expect(body.iceServers[1]).toMatchObject(turn);
  });

  it("flattens an array shape from Cloudflare into the top-level list", async () => {
    (env as any).TURN_KEY_ID = "id";
    (env as any).TURN_KEY_API_TOKEN = "tok";
    const turn = [
      { urls: ["turn:turn.example:3478"], username: "u", credential: "c" },
      { urls: ["turns:turn.example:5349"], username: "u", credential: "c" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ iceServers: turn }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const body = await ice();
    expect(body.iceServers.length).toBe(3); // STUN + 2 TURN entries
    expect(body.iceServers[0].urls).toMatch(/^stun:/);
    expect(body.iceServers[1]).toMatchObject(turn[0]);
    expect(body.iceServers[2]).toMatchObject(turn[1]);
    // Make sure we did NOT nest the array (the original bug).
    expect(Array.isArray(body.iceServers[1])).toBe(false);
  });
});
