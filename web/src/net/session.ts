// web/src/net/session.ts
// Orchestrates the WebRTC handshake + reconnect over the relay. Depends only on
// the Peer interface (via a factory) and a signal-shaped object, so it is fully
// testable with FakePeer + a stub signal.
//
// Reconnect model: the INITIAL connection uses the peer built at construction.
// Every RECONNECT builds a FRESH peer and does a full offer/answer. This is the
// key to surviving a page refresh — the refreshed side has a brand-new peer with
// a new DTLS identity, which an ICE-restart on the *old* peer could never pair
// with. Host always (re)offers, guest always (re)answers (no glare). Both a
// network blip and a refresh funnel into the same loop, retried for a window.
import type { Peer, ConnState } from "./peer";
import type { WireMsg } from "../game/protocol";
import * as defaultSignal from "./signal";

type Signal = Pick<typeof defaultSignal,
  "createRoom" | "fetchOffer" | "postAnswer" | "pollAnswer" | "pushOffer" | "pollOffer">;

export type PeerFactory = () => Peer;

export interface SessionOpts {
  makePeer: PeerFactory;
  role: "host" | "guest";
  signal?: Signal;
}

const POLL_MS = 1000;
const RECONNECT_WINDOW_MS = 45_000; // keep trying fresh handshakes for ~45s
const RECONNECT_GAP_MS = 2_000;     // pause between failed attempts
const HANDSHAKE_POLL_MS = 8_000;    // per-attempt wait for the counterpart's SDP

export class Session {
  private peer: Peer;
  private makePeer: PeerFactory;
  private role: "host" | "guest";
  private signal: Signal;
  private roomId = "";
  private offerEpoch = 0;     // highest offer epoch this HOST has published
  private lastOfferSeen = -1; // highest offer epoch this GUEST has consumed
  private lastAnswerSeen = -1; // highest answer epoch this HOST has consumed
  private msgFn: (m: WireMsg) => void = () => {};
  private stateFn: (s: ConnState) => void = () => {};
  private reconnecting = false;
  private closed = false;

  constructor(opts: SessionOpts) {
    this.makePeer = opts.makePeer;
    this.role = opts.role;
    this.signal = opts.signal ?? (defaultSignal as Signal);
    this.peer = this.makePeer();
    this.wire(this.peer);
  }

  private wire(p: Peer): void {
    p.onMessage((m) => this.msgFn(m));
    p.onState((s) => this.handleState(s));
  }

  /** Swap in a freshly-handshaken peer and tear down the old one. */
  private swap(p: Peer): void {
    const old = this.peer;
    this.peer = p;
    this.wire(p);
    try { old.close(); } catch { /* ignore */ }
  }

  onMessage(fn: (m: WireMsg) => void): void { this.msgFn = fn; }
  onState(fn: (s: ConnState) => void): void { this.stateFn = fn; }
  /** Returns false if the channel was closed and the message was dropped. */
  send(m: WireMsg): boolean { return this.peer.send(m); }

  /** Force a reconnect attempt now (e.g. the channel went silently dead and the
   *  peer never emitted "reconnecting"). No-op if already reconnecting/closed. */
  reconnectNow(): void {
    if (!this.reconnecting && !this.closed) { this.stateFn("reconnecting"); void this.reconnect(); }
  }

  /** Host: create offer on the initial peer, register the room, return the id for
   *  the share link, then poll for the guest's answer in the background. */
  async host(): Promise<string> {
    const offer = await this.peer.createOffer();
    this.roomId = await this.signal.createRoom(offer);
    this.offerEpoch = 0;
    void this.awaitFirstAnswer();
    return this.roomId;
  }

  /** Guest: fetch the host's offer, answer it on the initial peer, post the answer. */
  async join(id: string): Promise<void> {
    this.roomId = id;
    const { offer, epoch } = await this.signal.fetchOffer(id);
    this.lastOfferSeen = epoch;
    const answer = await this.peer.acceptOffer(offer);
    await this.signal.postAnswer(id, answer, epoch);
  }

  /** Resume an in-progress room after a reload (either side). Seeds epoch state
   *  from the relay, then enters the reconnect loop so the host re-offers and the
   *  guest waits for that fresh offer — exactly the same path as a live blip. */
  async resume(id: string): Promise<void> {
    this.roomId = id;
    try {
      const cur = await this.signal.fetchOffer(id);
      if (this.role === "host") this.offerEpoch = cur.epoch;
      else this.lastOfferSeen = cur.epoch; // wait for an offer NEWER than this
    } catch { /* room may be gone; reconnect loop will surface failure */ }
    void this.reconnect();
  }

  /** Host's initial wait for the very first answer (no timeout — we sit on the
   *  share link until a friend joins). */
  private async awaitFirstAnswer(): Promise<void> {
    while (!this.closed) {
      const got = await this.signal.pollAnswer(this.roomId, this.lastAnswerSeen);
      if (got) {
        this.lastAnswerSeen = got.epoch;
        await this.peer.acceptAnswer(got.answer);
        return;
      }
      await sleep(POLL_MS);
    }
  }

  private handleState(s: ConnState): void {
    if (this.closed) return; // intentional teardown — swallow late peer events
    this.stateFn(s);
    if (s === "reconnecting" && !this.reconnecting) void this.reconnect();
  }

  /** One host reconnect attempt: fresh peer, fresh offer at a new epoch, wait for
   *  the matching answer, swap it in. Throws on timeout so the caller retries. */
  private async hostHandshake(): Promise<void> {
    const p = this.makePeer();
    const offer = await p.createOffer();
    // Re-read the room epoch so a refreshed host (epoch reset to 0) doesn't
    // collide with a higher epoch already in the room.
    let base = this.offerEpoch;
    try { const cur = await this.signal.fetchOffer(this.roomId); base = Math.max(base, cur.epoch); } catch { /* keep base */ }
    const epoch = base + 1;
    await this.signal.pushOffer(this.roomId, offer, epoch);
    this.offerEpoch = epoch;
    const ans = await this.pollUntil(() => this.signal.pollAnswer(this.roomId, this.lastAnswerSeen));
    this.lastAnswerSeen = ans.epoch;
    await p.acceptAnswer(ans.answer);
    this.swap(p);
  }

  /** One guest reconnect attempt: wait for an offer newer than we've seen, answer
   *  it on a fresh peer, post the answer, swap it in. Throws on timeout. */
  private async guestHandshake(): Promise<void> {
    const off = await this.pollUntil(() => this.signal.pollOffer(this.roomId, this.lastOfferSeen));
    const p = this.makePeer();
    const answer = await p.acceptOffer(off.offer);
    await this.signal.postAnswer(this.roomId, answer, off.epoch);
    this.lastOfferSeen = off.epoch;
    this.swap(p);
  }

  /** Reconnect loop: retry a full fresh-peer handshake for up to the window. */
  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    this.stateFn("reconnecting");
    const deadline = Date.now() + RECONNECT_WINDOW_MS;
    try {
      while (!this.closed && Date.now() < deadline) {
        try {
          if (this.role === "host") await this.hostHandshake();
          else await this.guestHandshake();
          this.reconnecting = false;
          // Announce connected so the app reconciles state (a fresh peer may not
          // surface its own "connected" before we want the sync to fire).
          if (!this.closed) this.stateFn("connected");
          return;
        } catch {
          await sleep(RECONNECT_GAP_MS);
        }
      }
      if (!this.closed) this.stateFn("disconnected");
    } finally {
      this.reconnecting = false;
    }
  }

  /** Poll `fn` until it returns a value or HANDSHAKE_POLL_MS elapses (then throws). */
  private async pollUntil<T>(fn: () => Promise<T | null>): Promise<T> {
    const end = Date.now() + HANDSHAKE_POLL_MS;
    for (;;) {
      if (this.closed) throw new Error("session closed");
      const v = await fn();
      if (v) return v;
      if (Date.now() >= end) throw new Error("handshake poll timeout");
      await sleep(POLL_MS);
    }
  }

  close(): void { this.closed = true; this.peer.close(); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
