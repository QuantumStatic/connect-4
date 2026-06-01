// web/src/main.ts
import { GameState, type Cell } from "./game/state";
import { load, save, clear, rememberHostRoom, forgetHostRoom, hostedRoom, type Mode } from "./game/persist";
import { analyze, SolverOffline } from "./solver/client";
import { ChipSim } from "./physics/chip";
import { Sfx } from "./audio/sfx";
import { Scene } from "./render/scene";
import { Hud, type SidePref } from "./ui/hud";
import { Session } from "./net/session";
import { RtcPeer } from "./net/peer";
import { getIceConfig, deleteRoom, closeRelayRoom } from "./net/signal";
import { RelaySocket } from "./net/relaySocket";
import type { Transport } from "./net/transport";
import { hashLog, validateIncoming, mergeScores, decideSync, type WireMsg, type Score } from "./game/protocol";

const GOOD_DEPTH = 10;
const HEARTBEAT_MS = 6_000;

class Game {
  state = new GameState();
  mode: Mode = "2P";
  localSide: Cell | null = null;
  solverOnline = true;

  // `busy` is held for an entire turn cycle (your drop → AI reply), not a single
  // chip, so input is serialized through `pump()`. `pendingCol` buffers the
  // human's next click so it registers instantly even mid-animation and plays
  // the moment the lane is clear (one chip in flight at a time — no collisions).
  private busy = false;
  private pendingCol: number | null = null;
  private session: Transport | null = null;
  private remoteSide: Cell | null = null;
  private roomId = "";
  // Running win tally for friend mode. Computed locally on each side from the
  // canonical move log (no per-game history sent) and reconciled on sync via
  // element-wise max. `gameScored` makes the per-game increment idempotent.
  private score: Score = { yellow: 0, green: 0 };
  private gameScored = false;
  // Monotonic game counter. Bumped on every New Game so a reset (a shorter/empty
  // log at a HIGHER gen) wins over an older, longer game during resync.
  private gen = 0;
  // Periodic drift detector: every HEARTBEAT_MS we send a (gen, log-hash) ping;
  // if the peer's differs from ours it triggers a full sync. Backstop for any
  // move/newgame that was lost across a reconnect.
  private heartbeat: number | null = null;
  // Whether the local player wants to move first (yellow) or second (green).
  // Applies to vs-AI and to the friend-mode host. Yellow always moves first.
  private sidePref: SidePref = "first";
  // Friend mode: true once the opponent is known to be present, which locks the
  // host's side picker (the guest already took their seat from the link).
  private peerPresent = false;

  constructor(public scene: Scene, public hud: Hud, public sfx: Sfx) {}

  private sideToColor(pref: SidePref): Cell { return pref === "first" ? "yellow" : "green"; }

  async start(): Promise<void> {
    const saved = load();
    if (saved && saved.moves.length > 0 && confirm("Resume previous game?")) {
      this.state = GameState.fromSequence(saved.moves);
      this.mode = saved.mode;
      this.localSide = saved.humanSide;
      if (saved.score) this.score = saved.score;
      this.gen = saved.gen ?? 0;
      this.gameScored = this.state.status === "won"; // already tallied if finished
    } else {
      clear();
    }
    // Restore the side picker for a resumed vs-AI game.
    if (this.mode === "good" || this.mode === "great") {
      this.sidePref = this.localSide === "green" ? "second" : "first";
      this.hud.setSideValue(this.sidePref);
      this.hud.showSidePicker(true);
    }
    this.scene.syncFromState(this.state);
    this.updateStatus();
    await this.pump(); // make the AI move if it's already its turn (e.g. on resume)
  }

  private updateStatus(): void {
    // Count a win exactly once per game, the moment the board resolves. Both
    // peers reach the same final move log, so they tally identically without
    // sending the score per move.
    if (this.state.status === "won" && this.state.winner && !this.gameScored) {
      this.gameScored = true;
      this.score[this.state.winner] += 1;
      this.persist();
    }
    this.hud.setStatus(this.statusText());
    if (this.mode === "friend") this.hud.showScore(this.score, this.localSide);
  }

  /** Human-readable status line. In friend mode it's framed from the local
   *  player's seat ("Your turn" / "Opponent's turn", "You win!" / "Opponent
   *  wins"); otherwise it names the color to move. */
  private statusText(): string {
    const s = this.state;
    if (this.mode === "friend" && this.localSide) {
      if (s.status === "won") return s.winner === this.localSide ? "You win! 🎉" : "Opponent wins";
      if (s.status === "draw") return "Draw";
      return s.toMove === this.localSide ? "Your turn" : "Opponent's turn";
    }
    if (s.status === "won") return `${s.winner} wins`;
    if (s.status === "draw") return "draw";
    return `${s.toMove} to move`;
  }

  /** Single persistence chokepoint — always writes moves + roomId + score + gen. */
  private persist(): void {
    save(
      this.state, this.mode, this.localSide,
      this.mode === "friend" ? this.roomId : undefined,
      this.score, this.gen,
    );
  }

  /** Send our full game state to the peer (generation + log + score). Used on
   *  connect/reconnect and whenever we detect we're ahead of the peer. Returns
   *  false if the channel was closed and the message was dropped. */
  private sendSync(): boolean {
    return this.session?.send({ type: "sync", gen: this.gen, log: this.state.moves, score: this.score }) ?? false;
  }

  setMode(mode: Mode): void {
    // Leaving a friend game (picking another mode) cleanly ends the room.
    if (this.mode === "friend" && mode !== "friend") this.teardownFriend(true);
    this.mode = mode;
    if (mode === "friend") { void this.startFriend(); return; }
    // vs-AI: you play your chosen side (yellow=1st, green=2nd). 2P: no "you".
    const isAi = mode === "good" || mode === "great";
    this.hud.showSidePicker(isAi);
    this.localSide = isAi ? this.sideToColor(this.sidePref) : null;
    save(this.state, this.mode, this.localSide);
    void this.pump(); // if you chose 2nd, the AI (yellow) opens
  }

  /** Side picker changed. Re-seat the local player and restart so the choice
   *  applies from move 1. vs-AI restarts the board; the friend host (still
   *  waiting for an opponent) re-seats and refreshes the share link. */
  setSide(pref: SidePref): void {
    this.sidePref = pref;
    if (this.mode === "good" || this.mode === "great") {
      this.localSide = this.sideToColor(pref);
      this.startFreshGame(this.gen + 1); // fresh board → pump opens for the AI if you're 2nd
    } else if (this.mode === "friend" && this.roomId && !this.peerPresent) {
      // Host re-seats before the opponent connects; refresh the link's seat.
      this.localSide = this.sideToColor(pref);
      this.remoteSide = this.localSide === "yellow" ? "green" : "yellow";
      this.hud.showLocalSide(this.localSide);
      this.hud.showScore(this.score, this.localSide);
      this.showFriendLink();
      this.persist();
    }
  }

  /** Start the periodic drift check. Every HEARTBEAT_MS we ping the peer with our
   *  (gen, log-hash); a mismatch on their side triggers a full sync. This is the
   *  backstop for a move or new-game that was lost across a reconnect. */
  private startHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(() => {
      if (!this.session) return;
      const sent = this.session.send({ type: "ping", gen: this.gen, hash: hashLog(this.state.moves) });
      // If the ping couldn't go out, the channel died silently (no "reconnecting"
      // event) — kick a reconnect so the boards re-sync automatically.
      if (!sent) this.session.reconnectNow();
    }, HEARTBEAT_MS);
  }

  /** Tear down the friend session + UI. `notify` sends a "bye" so the peer knows
   *  it was intentional (and won't try to reconnect), and frees the relay room. */
  private teardownFriend(notify: boolean): void {
    if (this.heartbeat !== null) { clearInterval(this.heartbeat); this.heartbeat = null; }
    const wasRelay = this.session instanceof RelaySocket;
    if (this.session) {
      if (notify) this.session.send({ type: "bye" });
      this.session.close();
      this.session = null;
    }
    if (this.roomId) {
      // Free the room now instead of waiting for it to expire. Relay rooms are
      // Durable Objects (DELETE /ws/:id); P2P rooms live in KV (DELETE /room/:id).
      if (wasRelay) void closeRelayRoom(this.roomId);
      else void deleteRoom(this.roomId);
      this.roomId = "";
    }
    this.remoteSide = null;
    this.peerPresent = false;
    forgetHostRoom();
    this.clearJoinHash(); // so a later "Play a friend" hosts a fresh room, not the dead one
    this.hud.showConnState(null);
    this.hud.hideHostLink();
    this.hud.showLocalSide(null);
    this.hud.showScore(null);
    this.hud.showEndRoom(false);
    this.hud.showSidePicker(false);
    this.hud.showTransportToggle(false);
  }

  /** Build + show the host's share link, encoding the transport and the seat the
   *  joiner takes (the opposite of our color). Also records that we host this
   *  room so a reload reclaims the host seat. */
  private showFriendLink(): void {
    if (!this.roomId) return;
    rememberHostRoom(this.roomId);
    const t = this.session instanceof RelaySocket ? "relay" : "p2p";
    const guestSeat = this.localSide === "yellow" ? "green" : "yellow";
    this.hud.showHostLink(
      `${location.origin}${location.pathname}#join=${this.roomId}&t=${t}&seat=${guestSeat}`,
    );
  }

  /** Strip "#join=..." from the URL without reloading. After leaving a room the
   *  stale id must go, otherwise startFriend would try to rejoin the dead room
   *  instead of creating a new one. */
  private clearJoinHash(): void {
    if (location.hash.includes("join=")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  /** "Resync" button: force an immediate state reconciliation with the peer
   *  (don't wait for the 30s heartbeat). Sends our full state; decideSync on
   *  the other end pushes back if they're ahead. */
  resync(): void {
    if (!this.session) { this.hud.toast("Not connected to a friend."); return; }
    if (this.sendSync()) {
      this.hud.toast("Re-syncing with your opponent…", 2500);
    } else {
      // Channel is dead — that's why state drifted. Force a reconnect; the
      // post-reconnect sync will reconcile both boards.
      this.hud.toast("Connection dropped — reconnecting…", 3500);
      this.session.reconnectNow();
    }
  }

  /** "End room" button: leave the room, notify the peer, return to local play. */
  endRoom(): void {
    this.teardownFriend(true);
    this.mode = "2P";
    this.localSide = null;
    this.hud.setModeValue("2P");
    this.hud.toast("Room closed.");
    save(this.state, this.mode, this.localSide);
  }

  newGame(): void {
    // Ignore while a chip is mid-drop — otherwise the in-flight animation
    // would resolve onto a fresh state and plant a phantom chip.
    if (this.busy) return;
    this.startFreshGame(this.gen + 1); // bump generation so the reset wins on resync
    // Tell the peer to reset too, carrying the new generation. Without this the
    // remote keeps the finished board until the next reconnect/sync.
    if (this.mode === "friend" && this.session) this.session.send({ type: "newgame", gen: this.gen });
  }

  /** Reset to a fresh board at generation `gen`. Used by New Game (gen+1) and by
   *  an incoming "newgame"/"sync" from the peer (adopting their gen). The running
   *  score is preserved across games. */
  private startFreshGame(gen: number): void {
    this.gen = gen;
    this.state = new GameState();
    this.pendingCol = null;
    this.gameScored = false;
    this.scene.setQueuedChip(null);
    this.scene.syncFromState(this.state);
    this.persist();
    this.updateStatus();
    void this.pump();
  }

  /** Replace the board with `log` at generation `gen` (adopting a peer's state). */
  private adoptState(gen: number, log: string): void {
    this.gen = gen;
    this.state = GameState.fromSequence(log);
    this.pendingCol = null;
    this.gameScored = this.state.status === "won"; // already reflected in merged score
    this.scene.setQueuedChip(null);
    this.scene.syncFromState(this.state);
    this.persist();
    this.updateStatus();
  }

  async hint(): Promise<void> {
    if (!this.solverOnline || this.state.status !== "ongoing") return;
    // Only hint on your own move — in vs-AI / friend mode, refuse on the
    // opponent's turn (otherwise it would reveal their best move).
    const myTurn = this.mode === "2P" || this.state.toMove === this.localSide;
    if (!myTurn) { this.hud.toast("Hint is only available on your turn."); return; }
    try {
      const res = await analyze(this.state.moves, null, (frac) =>
        this.hud.setThinking(`Loading hint engine… ${Math.round(frac * 100)}% (one-time)`));
      this.hud.setThinking(null);
      this.scene.flashHintColumn(res.bestMove);
    } catch (e) {
      this.hud.setThinking(null);
      if (e instanceof SolverOffline) this.handleOffline();
    }
  }

  /** Handle a board click. When the lane is free it drops immediately; when a
   *  chip is mid-cycle the click queues a "held" chip hovering over the column,
   *  which the player can move (click another column) or cancel (click the same
   *  column again) before it drops. */
  onColumnClick(col: number): void {
    if (this.state.status !== "ongoing") return;
    const myTurn = this.mode === "2P" || this.state.toMove === this.localSide;
    if (this.busy) {
      if (myTurn) { this.pendingCol = this.pendingCol === col ? null : col; this.updateQueuedGhost(); }
      return;
    }
    if (!myTurn) return;
    this.pendingCol = col;
    void this.pump();
  }

  /** Color the queued ghost will drop as: in vs-AI it's always the human's;
   *  in hot-seat it's whoever moves next (opposite the chip currently falling). */
  private queuedColor(): Cell {
    if (this.mode !== "2P" && this.localSide) return this.localSide;
    return this.state.toMove === "yellow" ? "green" : "yellow";
  }

  private updateQueuedGhost(): void {
    this.scene.setQueuedChip(this.pendingCol, this.pendingCol === null ? undefined : this.queuedColor());
  }

  private aiToMove(): boolean {
    return this.mode !== "2P" && this.mode !== "friend" && this.solverOnline && this.state.toMove !== this.localSide;
  }

  /** Serialized turn loop: drains queued human clicks and plays AI replies one
   *  chip at a time. Re-entrant calls bail on the `busy` guard; the running loop
   *  picks up whatever `pendingCol` / state they changed. */
  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // Resolves to the AI's best move, prefetched DURING the human's drop so the
    // solver computes in parallel instead of after. Never rejects (errors → null).
    let prefetch: Promise<number | null> | null = null;
    try {
      while (this.state.status === "ongoing") {
        if (this.aiToMove()) {
          const label = this.mode === "good" ? "Good player" : "Great player";
          this.hud.setThinking(`${label} is thinking…`);
          let best: number | null;
          if (prefetch) {
            best = await prefetch; // overlapped with the human's drop — usually ready
            prefetch = null;
          } else {
            best = await this.solve(this.state.moves);
          }
          this.hud.setThinking(null);
          if (best === null) break; // solver offline
          await this.animateAndApply(best);
          continue;
        }
        // Human / hot-seat turn: consume a queued click, if any.
        const col = this.takePending();
        this.scene.setQueuedChip(null); // the held chip (if any) is now dropping
        if (col === null) break; // nothing queued — idle until the next click
        if (!this.state.legalColumns().includes(col)) continue;
        // If this move hands the turn to the AI, start solving now (overlap).
        if (this.mode !== "2P" && this.mode !== "friend" && this.solverOnline && this.state.toMove === this.localSide) {
          prefetch = this.solve(this.state.moves + String(col));
        }
        await this.animateAndApply(col);
      }
    } finally {
      this.busy = false;
      this.hud.setThinking(null);
    }
  }

  private takePending(): number | null {
    const c = this.pendingCol;
    this.pendingCol = null;
    return c;
  }

  /** Ask the solver for the best move from a position. Resolves to null (and
   *  flips to offline) on failure, so callers never see a rejection. */
  private async solve(moves: string): Promise<number | null> {
    const depth = this.mode === "good" ? GOOD_DEPTH : null;
    try {
      const res = await analyze(moves, depth, (frac) => {
        // Only fires while the one-time opening book downloads (Great mode).
        if (depth === null) this.hud.setThinking(`Loading Great player… ${Math.round(frac * 100)}% (one-time)`);
      });
      return res.bestMove;
    } catch (e) {
      if (e instanceof SolverOffline) this.handleOffline();
      return null;
    }
  }

  /** Drop one chip into `col` for the side to move, then commit it to state. */
  private async animateAndApply(col: number): Promise<void> {
    const settledHeight = this.state.heightOf(col);
    const player = this.state.toMove;
    // Send our move to the peer BEFORE the drop animation. The delta is computed
    // from the post-move log without mutating state yet, so the opponent starts
    // their chip falling while ours is still in flight — feels noticeably snappier.
    if (this.mode === "friend" && this.session && player === this.localSide) {
      const ply = this.state.moves.length; // 0-based index this move will occupy
      this.session.send({ type: "move", delta: { ply, col, hash: hashLog(this.state.moves + String(col)) } });
    }
    await this.sfx.ensureLoaded();
    const floorY = this.scene.floorYFor(col, settledHeight);
    const sim = new ChipSim({ floorY, startY: this.scene.startYAbove(), gravity: 2400, restitution: 0.32 });
    let firstImpact = true;
    sim.onImpact((v) => {
      this.sfx.impact(Math.abs(v), !firstImpact);
      firstImpact = false;
    });
    await this.scene.animateDrop(col, settledHeight, player, sim);
    this.state.applyMove(col);
    this.scene.syncFromState(this.state);
    if (this.state.status === "won") this.sfx.win();
    this.persist();
    this.updateStatus();
  }

  async startFriend(): Promise<void> {
    this.mode = "friend";
    const joinId = new URLSearchParams(location.hash.slice(1)).get("join");
    // If this device is reopening a link to a room it originally hosted (saved
    // state says we were yellow + roomId matches), take back the host slot
    // instead of joining. This handles "closed my tab, clicked the link again".
    const saved = load();
    // "Resuming" = we have saved friend state for *this* room (reload / reconnect
    // of an in-progress game). True for both the host reopening their own link
    // and a guest refreshing the join link.
    const urlParams = new URLSearchParams(location.hash.slice(1));
    const resuming = !!joinId && saved?.mode === "friend" && saved.roomId === joinId;
    // You host if there's no join link, or you're reopening a link to a room you
    // created — tracked explicitly so it works regardless of the color you chose
    // (the old "host == yellow" assumption breaks once the host can pick green).
    const isRehost = !!joinId && hostedRoom() === joinId;
    const role: "host" | "guest" = isRehost || !joinId ? "host" : "guest";

    // Read transport from URL (guest) or toggle (host).
    const transport: "relay" | "p2p" =
      joinId ? (urlParams.get("t") === "p2p" ? "p2p" : "relay") : this.hud.transport();

    // Seat: resume → saved color; host → your picked side; guest → the seat the
    // host encoded in the link (default green, matching pre-feature links).
    if (resuming && saved!.humanSide) {
      this.localSide = saved!.humanSide;
    } else if (role === "host") {
      this.localSide = this.sideToColor(this.sidePref);
    } else {
      this.localSide = urlParams.get("seat") === "yellow" ? "yellow" : "green";
    }
    this.remoteSide = this.localSide === "yellow" ? "green" : "yellow";
    this.peerPresent = false;
    // Reflect the host's seat in the picker; only the host may change it.
    this.hud.showSidePicker(role === "host");
    if (role === "host") {
      this.sidePref = this.localSide === "yellow" ? "first" : "second";
      this.hud.setSideValue(this.sidePref);
    }
    // Restore the in-progress board + generation on reload; otherwise start clean
    // (a fresh guest will adopt the host's state via the first sync).
    if (resuming) {
      this.state = GameState.fromSequence(saved!.moves);
      this.gen = saved!.gen ?? 0;
      this.score = saved!.score ?? { yellow: 0, green: 0 };
    } else {
      this.state = new GameState();
      this.gen = 0;
      this.score = { yellow: 0, green: 0 };
    }
    this.pendingCol = null;
    this.gameScored = this.state.status === "won";
    this.scene.syncFromState(this.state);
    this.hud.showLocalSide(this.localSide);
    this.hud.showScore(this.score, this.localSide);
    this.hud.showEndRoom(true);
    this.hud.showTransportToggle(true);
    this.updateStatus();
    this.hud.showConnState("connecting");
    this.startHeartbeat();

    if (transport === "relay") {
      // WebSocket relay: client picks the room id; the DO is created lazily.
      // Color comes from the DO's welcome frame once connected.
      this.roomId = joinId ?? randomRoomId();
      const sock = new RelaySocket(`${relayWsBase()}/ws/${this.roomId}`);
      sock.onRoomFull(() => {
        this.hud.toast("This room already has two players.", 6000);
        this.teardownFriend(false);
        this.mode = "2P";
        this.localSide = null;
        this.hud.setModeValue("2P");
        save(this.state, this.mode, this.localSide);
      });
      this.session = sock;
    } else {
      // WebRTC P2P: fetch ICE config then build a session with a peer factory.
      let ice: RTCIceServer[];
      try { ice = await getIceConfig(); }
      catch { this.hud.toast("Relay offline — can't start an online game."); this.hud.showConnState("disconnected"); return; }
      this.session = new Session({ makePeer: () => new RtcPeer(ice, role), role });
    }
    // 30s cap on the initial handshake — but ONLY for a guest, who is joining an
    // existing room and should connect quickly. A host legitimately waits
    // (often minutes) for a friend to open the link, so it has no timeout and
    // keeps its share-link visible until someone connects or it ends the room.
    let connected = false;
    let handshakeTimeout: number | undefined;
    if (transport === "p2p" && role === "guest") {
      handshakeTimeout = window.setTimeout(() => {
        if (!connected) this.handshakeFailed(role);
      }, 30_000);
    }
    this.session.onState((s) => {
      this.hud.showConnState(s);
      if (s === "connected") {
        connected = true;
        if (handshakeTimeout !== undefined) window.clearTimeout(handshakeTimeout);
        this.sendSync(); // exchange full state (gen + log + score) on every (re)connect
      } else if (s === "disconnected" && !connected && transport === "p2p" && role === "guest") {
        if (handshakeTimeout !== undefined) window.clearTimeout(handshakeTimeout);
        this.handshakeFailed(role);
      }
    });
    this.session.onMessage((m) => this.onWire(m));

    try {
      if (transport === "relay") {
        // Relay: WebSocket connects automatically on construction.
        // Host: show the link immediately. Guest: no action needed.
        if (role === "host") this.showFriendLink();
        save(this.state, this.mode, this.localSide, this.roomId, this.score, this.gen);
      } else if (resuming) {
        // Reload/reconnect of an in-progress room — enter the reconnect loop
        // (host re-offers, guest waits for the fresh offer). Re-show the link
        // for the host so they can re-share if needed.
        this.roomId = joinId!;
        await (this.session as Session).resume(joinId!);
        if (role === "host") this.showFriendLink();
        this.hud.toast("Reconnecting to your game…", 4000);
        save(this.state, this.mode, this.localSide, this.roomId, this.score, this.gen);
      } else if (role === "host") {
        this.roomId = await (this.session as Session).host();
        this.showFriendLink();
        save(this.state, this.mode, this.localSide, this.roomId, this.score, this.gen);
      } else {
        this.roomId = joinId!;
        await (this.session as Session).join(joinId!);
        save(this.state, this.mode, this.localSide, this.roomId, this.score, this.gen);
      }
    } catch (e) {
      if (handshakeTimeout !== undefined) window.clearTimeout(handshakeTimeout);
      this.handshakeFailed(role, e);
    }
  }

  /** Surface a friendly error when the initial WebRTC handshake fails (timeout,
   *  bad room id, host went away, relay 4xx, etc.). Tears the session down so
   *  the user can pick a different mode without leaking state. */
  private handshakeFailed(role: "host" | "guest", error?: unknown): void {
    if (!this.session) return; // already torn down
    console.warn("P2P handshake failed", { role, error });
    if (this.heartbeat !== null) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.session.close();
    this.session = null;
    this.remoteSide = null;
    this.clearJoinHash(); // don't auto-retry the unreachable room on the next attempt
    this.hud.showConnState("disconnected");
    this.hud.hideHostLink();
    this.hud.showLocalSide(null);
    this.hud.showEndRoom(false);
    if (role === "guest") {
      this.hud.toast("Couldn't reach your friend — they may have closed the tab. Ask for a fresh link.", 6500);
    } else {
      this.hud.toast("Couldn't open a room — check your connection and try again.", 6500);
    }
  }

  private onWire(m: WireMsg): void {
    if (m.type === "bye") {
      // Peer left intentionally — tear down without echoing a bye, drop to local.
      this.teardownFriend(false);
      this.mode = "2P";
      this.localSide = null;
      this.hud.setModeValue("2P");
      this.hud.toast("Your opponent left the room. Switched to local play.", 6000);
      save(this.state, this.mode, this.localSide);
      return;
    }
    // Any message means the opponent is here — lock the host's side picker
    // (they've already taken the seat the link assigned them).
    if (!this.peerPresent) { this.peerPresent = true; this.hud.showSidePicker(false); }
    if (m.type === "ping") {
      // Drift check: if the peer's (gen, hash) differs from ours, send our full
      // state so decideSync reconciles. Whichever side is ahead wins; if we're
      // behind, the peer will push back on receiving our sync.
      if (m.gen !== this.gen || m.hash !== hashLog(this.state.moves)) this.sendSync();
      return;
    }
    if (m.type === "newgame") {
      // Peer hit New Game. Adopt only if it's a newer generation (ignore stale).
      if ((m.gen ?? 0) > this.gen) {
        this.hud.toast("Your opponent started a new game.");
        this.startFreshGame(m.gen);
      }
      return;
    }
    if (m.type === "sync") {
      // Reconcile the score first (element-wise max — idempotent). Adopt the
      // merged tally so a peer joining mid-series picks up the running score.
      if (m.score) {
        const merged = mergeScores(this.score, m.score);
        if (merged.yellow !== this.score.yellow || merged.green !== this.score.green) {
          this.score = merged;
          this.persist();
          this.hud.showScore(this.score, this.localSide);
        }
      }
      const remoteGen = m.gen ?? 0;
      const decision = decideSync(this.gen, this.state.moves, remoteGen, m.log);
      switch (decision.action) {
        case "adopt":
          this.adoptState(decision.gen, decision.log);
          break;
        case "push":
          this.sendSync(); // we're ahead — push our full state so the peer catches up
          break;
        case "conflict":
          this.hud.toast("Game out of sync — start a new game.");
          break;
        case "noop":
          break;
      }
      return;
    }
    if (!this.remoteSide) return;
    const verdict = validateIncoming(this.state, m.delta, this.remoteSide);
    if (verdict === "ok") { this.pendingCol = m.delta.col; void this.pump(); }
    else if (verdict === "desync" || verdict === "duplicate") { this.sendSync(); }
  }

  private handleOffline(): void {
    if (!this.solverOnline) return; // idempotent — only act on the first failure
    this.solverOnline = false;
    this.hud.setSolverOffline(true);
    this.hud.toast("AI engine failed to load — AI/hint disabled. Hot-seat still works.");
  }
}

function randomRoomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(36).padStart(2, "0");
  return s;
}

function relayWsBase(): string {
  const http = ((import.meta as any).env?.VITE_RELAY_URL ?? location.origin).replace(/\/$/, "");
  return http.replace(/^http/, "ws"); // http→ws, https→wss
}

async function main() {
  const host = document.getElementById("canvas-host")!;
  const sfx = new Sfx();
  const scene = new Scene({
    host,
    onColumnClick: (col) => void game.onColumnClick(col),
    onColumnHover: () => { /* reserved for future drop-preview */ },
  });
  await scene.init();
  const hud = new Hud(document.getElementById("hud")!, {
    onModeChange: (m) => game.setMode(m),
    onNewGame: () => game.newGame(),
    onHint: () => void game.hint(),
    onEndRoom: () => game.endRoom(),
    onResync: () => game.resync(),
    onSideChange: (p) => game.setSide(p),
  }, "2P");
  const game = new Game(scene, hud, sfx);
  // The AI runs in-browser via WebAssembly, so every mode works everywhere with
  // no backend. The only first-use cost is a one-time opening-book download for
  // Great/Hint, surfaced as progress on the thinking indicator.
  if (new URLSearchParams(location.hash.slice(1)).get("join")) {
    await game.startFriend();
  } else {
    await game.start();
  }
}

void main();
