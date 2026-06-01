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

// A factory that always hands back the SAME FakePeer, so tests can inspect it.
function factory(p: FakePeer) { return () => p; }

describe("Session", () => {
  it("host creates a room and exposes the join link id", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "host" });
    const id = await s.host();
    expect(id).toBe("ROOM");
    expect(signal.createRoom).toHaveBeenCalledOnce();
  });

  it("guest fetches the offer and posts an answer", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "guest" });
    await s.join("ROOM");
    expect(signal.fetchOffer).toHaveBeenCalledWith("ROOM");
    expect(signal.postAnswer).toHaveBeenCalled();
    expect(signal.store.answerEpoch).toBe(0);
  });

  it("delivers incoming wire messages to onMessage", async () => {
    const [a, b] = FakePeer.linked();
    const signal = stubSignal();
    const s = new Session({ makePeer: factory(a), signal: signal as any, role: "host" });
    const got: any[] = [];
    s.onMessage((m) => got.push(m));
    b.send({ type: "move", delta: { ply: 0, col: 3, hash: "h" } });
    expect(got).toEqual([{ type: "move", delta: { ply: 0, col: 3, hash: "h" } }]);
  });

  it("on reconnect, the HOST publishes a FRESH offer at a new epoch", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "host" });
    await s.host();
    // make an answer available so the host handshake can complete
    await signal.postAnswer("ROOM", "guest-answer", 1);
    peer.emitState("reconnecting");
    await vi.waitFor(() => expect(signal.pushOffer).toHaveBeenCalledWith("ROOM", expect.any(String), 1), { timeout: 3000 });
  });

  it("re-emits 'connected' after a successful reconnect so the app reconciles", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const states: string[] = [];
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "host" });
    s.onState((st) => states.push(st));
    await s.host();
    await signal.postAnswer("ROOM", "guest-answer", 1);
    peer.emitState("reconnecting");
    await vi.waitFor(() => expect(states).toContain("connected"), { timeout: 3000 });
  });

  it("resume() as host re-publishes a fresh offer at epoch+1", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    signal.store.offer = "old-sdp";
    signal.store.offerEpoch = 0;
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "host" });
    await s.resume("room123");
    await signal.postAnswer("room123", "guest-answer", 1);
    await vi.waitFor(() => expect(signal.pushOffer).toHaveBeenCalledWith("room123", expect.any(String), 1), { timeout: 3000 });
    expect(signal.store.offerEpoch).toBe(1);
  });

  it("resume() as host accepts the guest's answer", async () => {
    const peer = new FakePeer();
    const acceptSpy = vi.spyOn(peer, "acceptAnswer");
    const signal = stubSignal();
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "host" });
    await s.resume("room123");
    await signal.postAnswer("room123", "guest-answer", 1);
    await vi.waitFor(() => expect(acceptSpy).toHaveBeenCalledWith("guest-answer"), { timeout: 3000 });
  });

  it("reconnectNow() forces a host reconnect when the channel went silently dead", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "host" });
    await s.host();
    await signal.postAnswer("ROOM", "guest-answer", 1);
    s.reconnectNow();
    await vi.waitFor(() => expect(signal.pushOffer).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("on reconnect, the GUEST waits for a fresh offer (never publishes one)", async () => {
    const peer = new FakePeer();
    const signal = stubSignal();
    const s = new Session({ makePeer: factory(peer), signal: signal as any, role: "guest" });
    await s.join("ROOM");
    peer.emitState("reconnecting");
    await new Promise((r) => setTimeout(r, 20));
    expect(signal.pushOffer).not.toHaveBeenCalled();
  });
});
