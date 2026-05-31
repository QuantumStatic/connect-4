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

  it("rehost fetches current epoch, creates a fresh offer, pushes at epoch+1", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    signal.store.offer = "old-sdp";
    signal.store.offerEpoch = 0;
    const s = new Session({ peer, signal: signal as any, role: "host" });
    await s.rehost("room123");
    expect(signal.fetchOffer).toHaveBeenCalledWith("room123");
    expect(peer.offers).toBe(1);
    expect(signal.pushOffer).toHaveBeenCalledWith("room123", "offer#1", 1);
    expect(signal.store.offerEpoch).toBe(1);
  });

  it("rehost background-polls for an answer and accepts it", async () => {
    const peer = new FakePeer();
    const acceptSpy = vi.spyOn(peer, "acceptAnswer");
    const signal = stubSignal();
    const s = new Session({ peer, signal: signal as any, role: "host" });
    await s.rehost("room123");
    // simulate a guest posting an answer at the new epoch
    await signal.postAnswer("room123", "guest-answer", 1);
    await vi.waitFor(() => expect(acceptSpy).toHaveBeenCalledWith("guest-answer"), { timeout: 3000 });
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
