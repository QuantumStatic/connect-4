// web/src/net/fakePeer.ts
// In-memory Peer pair for deterministic session tests. Two FakePeers can be
// linked so a send() on one delivers to the other's onMessage.
import type { Peer, ConnState } from "./peer";
import type { WireMsg } from "../game/protocol";

export class FakePeer implements Peer {
  private link: FakePeer | null = null;
  private msgFn: (m: WireMsg) => void = () => {};
  private stateFn: (s: ConnState) => void = () => {};
  offers = 0;
  restarts = 0;

  static linked(): [FakePeer, FakePeer] {
    const a = new FakePeer();
    const b = new FakePeer();
    a.link = b; b.link = a;
    return [a, b];
  }

  async createOffer(): Promise<string> { this.offers++; return `offer#${this.offers}`; }
  async acceptOffer(sdp: string): Promise<string> { return `answer-to:${sdp}`; }
  async acceptAnswer(_sdp: string): Promise<void> { /* no-op */ }
  async restart(): Promise<string> { this.restarts++; return `restart#${this.restarts}`; }
  send(msg: WireMsg): boolean { this.link?.msgFn(msg); return this.link !== null; }
  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }
  close(): void { /* no-op */ }

  /** test helper: drive a connection-state transition */
  emitState(s: ConnState): void { this.stateFn(s); }
}
