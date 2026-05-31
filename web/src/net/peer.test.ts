// web/src/net/peer.test.ts
// White-box checks of RtcPeer event wiring. We don't exercise actual WebRTC —
// we only verify the JSON-parse guard and the connection-state mapping by
// stubbing globalThis.RTCPeerConnection with a minimal EventTarget-y class.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnState } from "./peer";

class FakeDataChannel extends EventTarget {
  ordered = true;
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  send = vi.fn();
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGathererState = "complete";
  // Host path: a data channel is created up front.
  dc = new FakeDataChannel();
  // Guest path is also covered by emitting a "datachannel" event externally.
  createDataChannel(_label: string): FakeDataChannel {
    return this.dc;
  }
  close = vi.fn();
  setRemoteDescription = vi.fn();
  setLocalDescription = vi.fn();
  createOffer = vi.fn();
  createAnswer = vi.fn();
  get localDescription(): unknown { return {}; }
  setConn(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

const originalRtc = (globalThis as any).RTCPeerConnection;

beforeEach(() => {
  (globalThis as any).RTCPeerConnection = FakePeerConnection;
});
afterEach(() => {
  (globalThis as any).RTCPeerConnection = originalRtc;
});

async function freshPeer(role: "host" | "guest" = "host") {
  const { RtcPeer } = await import("./peer");
  const peer = new RtcPeer([], role);
  // Reach into the underlying fake — fine for white-box assertions.
  const pc = (peer as unknown as { pc: FakePeerConnection }).pc;
  const dc = (peer as unknown as { dc: FakeDataChannel | null }).dc;
  return { peer, pc, dc };
}

describe("RtcPeer", () => {
  it("ignores malformed JSON on the data channel", async () => {
    const { peer, dc } = await freshPeer("host");
    const onMessage = vi.fn();
    peer.onMessage(onMessage);
    expect(dc).toBeTruthy();
    dc!.dispatchEvent(new MessageEvent("message", { data: "{not json" }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("delivers parsed WireMsg on valid JSON", async () => {
    const { peer, dc } = await freshPeer("host");
    const onMessage = vi.fn();
    peer.onMessage(onMessage);
    const wire = { type: "sync", log: "012" };
    dc!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(wire) }));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(wire);
  });

  it("maps connectionstatechange to ConnState", async () => {
    const { peer, pc } = await freshPeer("host");
    const states: ConnState[] = [];
    peer.onState((s) => states.push(s));

    pc.setConn("connected");
    pc.setConn("failed");
    pc.setConn("disconnected");
    pc.setConn("closed");

    expect(states).toEqual(["connected", "reconnecting", "reconnecting", "disconnected"]);
  });

  it("data-channel 'open' triggers 'connected'", async () => {
    const { peer, dc } = await freshPeer("host");
    const states: ConnState[] = [];
    peer.onState((s) => states.push(s));
    dc!.dispatchEvent(new Event("open"));
    expect(states).toContain("connected");
  });
});
