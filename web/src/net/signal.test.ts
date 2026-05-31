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
afterEach(() => { vi.unstubAllGlobals(); });

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
