// web/src/net/session.ts
// Orchestrates the WebRTC handshake + reconnect (ICE restart) over the relay.
// Depends only on the Peer interface and a signal-shaped object, so it is fully
// testable with FakePeer + a stub signal. Glare rule: only the host re-offers.
import type { Peer, ConnState } from "./peer";
import type { WireMsg } from "../game/protocol";
import * as defaultSignal from "./signal";

type Signal = Pick<typeof defaultSignal,
  "createRoom" | "fetchOffer" | "postAnswer" | "pollAnswer" | "pushOffer" | "pollOffer">;

export interface SessionOpts {
  peer: Peer;
  role: "host" | "guest";
  signal?: Signal;
}

const POLL_MS = 1000;
const MAX_RECONNECT = 4;

export class Session {
  private peer: Peer;
  private role: "host" | "guest";
  private signal: Signal;
  private roomId = "";
  private epoch = 0;
  private answerSince = -1;
  private offerSince = 0;
  private msgFn: (m: WireMsg) => void = () => {};
  private stateFn: (s: ConnState) => void = () => {};
  private reconnecting = false;
  private closed = false;

  constructor(opts: SessionOpts) {
    this.peer = opts.peer;
    this.role = opts.role;
    this.signal = opts.signal ?? (defaultSignal as Signal);
    this.peer.onMessage((m) => this.msgFn(m));
    this.peer.onState((s) => this.handleState(s));
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

  /** Host: create offer, register room, return id for the share link, then poll
   *  for the guest's answer in the background. */
  async host(): Promise<string> {
    const offer = await this.peer.createOffer();
    this.roomId = await this.signal.createRoom(offer);
    void this.awaitAnswer();
    return this.roomId;
  }

  /** Guest: fetch the host offer, answer it, post the answer. */
  async join(id: string): Promise<void> {
    this.roomId = id;
    const { offer, epoch } = await this.signal.fetchOffer(id);
    this.offerSince = epoch;
    const answer = await this.peer.acceptOffer(offer);
    await this.signal.postAnswer(id, answer, epoch);
    this.answerSince = epoch;
  }

  /** Take back an existing room as host. Used when a host closes their tab and
   *  re-opens the same shareable link (their old SDP in KV is stale). Bumps the
   *  offer epoch so a fresh guest fetches the new SDP, not the dead one. */
  async rehost(id: string): Promise<void> {
    this.roomId = id;
    const current = await this.signal.fetchOffer(id); // current latest epoch
    const offer = await this.peer.createOffer();
    this.epoch = current.epoch + 1;
    await this.signal.pushOffer(id, offer, this.epoch);
    this.answerSince = current.epoch; // wait for an answer at our new epoch
    void this.awaitAnswer();
  }

  private async awaitAnswer(): Promise<void> {
    for (;;) {
      const got = await this.signal.pollAnswer(this.roomId, this.answerSince);
      if (got) {
        this.answerSince = got.epoch;
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

  /** Host re-offers via ICE restart; guest waits for the new offer epoch. */
  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      for (let attempt = 0; attempt < MAX_RECONNECT && !this.closed; attempt++) {
        try {
          if (this.role === "host") {
            const offer = await this.peer.restart();
            this.epoch += 1;
            await this.signal.pushOffer(this.roomId, offer, this.epoch);
            const ans = await this.pollUntil(() => this.signal.pollAnswer(this.roomId, this.answerSince));
            this.answerSince = ans.epoch;
            await this.peer.acceptAnswer(ans.answer);
          } else {
            const off = await this.pollUntil(() => this.signal.pollOffer(this.roomId, this.offerSince));
            this.offerSince = off.epoch;
            const answer = await this.peer.acceptOffer(off.offer);
            await this.signal.postAnswer(this.roomId, answer, off.epoch);
          }
          this.reconnecting = false;
          // Re-announce "connected" so the app reconciles state on reconnect.
          // An ICE restart keeps the same peer/data-channel, so neither
          // connectionstatechange nor the channel's "open" reliably re-fires —
          // we emit it explicitly to guarantee a fresh sync after reconnect.
          if (!this.closed) this.stateFn("connected");
          return;
        } catch {
          await sleep(POLL_MS * (attempt + 1));
        }
      }
      if (!this.closed) this.stateFn("disconnected");
    } finally {
      this.reconnecting = false;
    }
  }

  private async pollUntil<T>(fn: () => Promise<T | null>): Promise<T> {
    for (;;) {
      const v = await fn();
      if (v) return v;
      await sleep(POLL_MS);
    }
  }

  close(): void { this.closed = true; this.peer.close(); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
