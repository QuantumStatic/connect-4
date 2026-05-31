// web/src/main.ts
import { GameState, type Cell } from "./game/state";
import { load, save, clear, type Mode } from "./game/persist";
import { analyze, SolverOffline } from "./solver/client";
import { ChipSim } from "./physics/chip";
import { Sfx } from "./audio/sfx";
import { Scene } from "./render/scene";
import { Hud } from "./ui/hud";
import { Session } from "./net/session";
import { RtcPeer } from "./net/peer";
import { getIceConfig } from "./net/signal";
import { hashLog, validateIncoming, reconcileLogs, type WireMsg } from "./game/protocol";

const GOOD_DEPTH = 10;

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
  private session: Session | null = null;
  private remoteSide: Cell | null = null;
  private roomId = "";

  constructor(public scene: Scene, public hud: Hud, public sfx: Sfx) {}

  async start(): Promise<void> {
    const saved = load();
    if (saved && saved.moves.length > 0 && confirm("Resume previous game?")) {
      this.state = GameState.fromSequence(saved.moves);
      this.mode = saved.mode;
      this.localSide = saved.humanSide;
    } else {
      clear();
    }
    this.scene.syncFromState(this.state);
    this.updateStatus();
    await this.pump(); // make the AI move if it's already its turn (e.g. on resume)
  }

  private updateStatus(): void {
    if (this.state.status === "won") this.hud.setStatus(`${this.state.winner} wins`);
    else if (this.state.status === "draw") this.hud.setStatus("draw");
    else this.hud.setStatus(`${this.state.toMove} to move`);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    if (mode === "friend") { void this.startFriend(); return; }
    this.localSide = mode === "2P" ? null : "yellow";
    this.session?.close(); this.session = null; this.remoteSide = null;
    this.hud.showConnState(null); this.hud.hideHostLink();
    save(this.state, this.mode, this.localSide);
    void this.pump();
  }

  newGame(): void {
    // Ignore while a chip is mid-drop — otherwise the in-flight animation
    // would resolve onto a fresh state and plant a phantom chip.
    if (this.busy) return;
    this.state = new GameState();
    this.pendingCol = null;
    this.scene.setQueuedChip(null);
    this.scene.syncFromState(this.state);
    save(this.state, this.mode, this.localSide, this.mode === "friend" ? this.roomId : undefined);
    this.updateStatus();
    void this.pump();
  }

  async hint(): Promise<void> {
    if (!this.solverOnline || this.state.status !== "ongoing") return;
    try {
      const res = await analyze(this.state.moves, null);
      this.scene.flashHintColumn(res.bestMove);
    } catch (e) {
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
      const res = await analyze(moves, depth);
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
    save(this.state, this.mode, this.localSide, this.mode === "friend" ? this.roomId : undefined);
    this.updateStatus();
    if (this.mode === "friend" && this.session && player === this.localSide) {
      const ply = this.state.moves.length - 1;
      this.session.send({
        type: "move",
        delta: { ply, col, hash: hashLog(this.state.moves) },
      });
    }
  }

  async startFriend(): Promise<void> {
    this.mode = "friend";
    const joinId = new URLSearchParams(location.hash.slice(1)).get("join");
    const role: "host" | "guest" = joinId ? "guest" : "host";
    this.localSide = role === "host" ? "yellow" : "green";
    this.remoteSide = role === "host" ? "green" : "yellow";
    this.hud.showConnState("connecting");

    let ice: RTCIceServer[];
    try { ice = await getIceConfig(); }
    catch { this.hud.toast("Relay offline — can't start an online game."); this.hud.showConnState("disconnected"); return; }

    const peer = new RtcPeer(ice, role);
    this.session = new Session({ peer, role });
    this.session.onState((s) => {
      this.hud.showConnState(s);
      if (s === "connected") this.session?.send({ type: "sync", log: this.state.moves });
    });
    this.session.onMessage((m) => this.onWire(m));

    if (role === "host") {
      this.roomId = await this.session.host();
      const url = `${location.origin}${location.pathname}#join=${this.roomId}`;
      this.hud.showHostLink(url);
    } else {
      this.roomId = joinId!;
      await this.session.join(joinId!);
    }
  }

  private onWire(m: WireMsg): void {
    if (m.type === "sync") {
      const agreed = reconcileLogs(this.state.moves, m.log);
      if (agreed === "conflict") { this.hud.toast("Game out of sync — start a new game."); return; }
      if (agreed !== this.state.moves) {
        this.state = GameState.fromSequence(agreed);
        this.scene.syncFromState(this.state);
        this.updateStatus();
      }
      return;
    }
    if (!this.remoteSide) return;
    const verdict = validateIncoming(this.state, m.delta, this.remoteSide);
    if (verdict === "ok") { this.pendingCol = m.delta.col; void this.pump(); }
    else if (verdict === "desync") { this.session?.send({ type: "sync", log: this.state.moves }); }
  }

  private handleOffline(): void {
    if (!this.solverOnline) return; // idempotent — only act on the first failure
    this.solverOnline = false;
    this.hud.setSolverOffline(true);
    this.hud.toast("Solver offline — AI/hint disabled. Hot-seat still works.");
  }
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
  }, "2P");
  const game = new Game(scene, hud, sfx);
  if (new URLSearchParams(location.hash.slice(1)).get("join")) {
    await game.startFriend();
  } else {
    await game.start();
  }
}

void main();
