// web/src/net/peer.ts
// Thin wrapper over RTCPeerConnection + a reliable/ordered DataChannel, behind
// the Peer interface so session logic can be tested with a fake. Non-trickle:
// offer/answer resolve only after ICE gathering completes.
import type { WireMsg } from "../game/protocol";
import type { ConnState } from "./transport";

export type { ConnState };

export interface Peer {
  createOffer(): Promise<string>;
  acceptOffer(sdp: string): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  restart(): Promise<string>;
  /** Returns true if the message went out over an open channel, false if it was
   *  dropped because the channel isn't open (caller may then force a reconnect). */
  send(msg: WireMsg): boolean;
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

  send(msg: WireMsg): boolean {
    if (this.dc?.readyState === "open") { this.dc.send(JSON.stringify(msg)); return true; }
    return false;
  }
  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }
  close(): void { this.pc.close(); }
}
