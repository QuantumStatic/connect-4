// web/src/render/scene.ts
// PixiJS scene: dark matte red board with recessed slots, green/yellow chips,
// hover indicator, win-highlight pulse. Pure rendering — reads game state and
// the active falling-chip simulator; never mutates either.

import { Application, Container, Graphics, Ticker } from "pixi.js";
import type { GameState, Cell } from "../game/state";
import type { ChipSim } from "../physics/chip";

const COLS = 7;
const ROWS = 6;
const CELL = 88;
const PAD = 16;
const BOARD_W = COLS * CELL + PAD * 2;
const BOARD_H = ROWS * CELL + PAD * 2;
const TOP_GUTTER = 80;
const CHIP_R = CELL * 0.42;

const BOARD_RED = 0x6b1a1a;
const SLOT_DARK = 0x0f1115;
const YELLOW = 0xe6c437;
const GREEN = 0x3aa05a;
const HOVER_ALPHA = 0.25;

export interface SceneOpts {
  host: HTMLElement;
  onColumnClick: (col: number) => void;
  onColumnHover: (col: number | null) => void;
}

export class Scene {
  app: Application;
  private board = new Graphics();
  private staticChips = new Container();
  private fallingChip = new Graphics();
  private queuedChip = new Graphics();
  private hover = new Graphics();
  private winHighlight = new Graphics();
  private hoverCol: number | null = null;
  private activeFall: { sim: ChipSim; col: number; player: Cell } | null = null;

  constructor(private opts: SceneOpts) {
    this.app = new Application();
  }

  async init(): Promise<void> {
    await this.app.init({
      width: BOARD_W,
      height: BOARD_H + TOP_GUTTER,
      backgroundAlpha: 0,
      antialias: true,
      // Keep the framebuffer so screenshots (Cmd+Shift+4, headless capture)
      // see the rendered scene instead of an empty canvas. Tiny perf cost.
      preserveDrawingBuffer: true,
    });
    this.opts.host.appendChild(this.app.canvas);
    // Z-order bottom→top: board (with dark slot cutouts), then chips visible
    // through the cutouts, then hover overlay, then win highlight on top.
    this.app.stage.addChild(this.board);
    this.app.stage.addChild(this.staticChips);
    this.app.stage.addChild(this.fallingChip);
    this.app.stage.addChild(this.queuedChip);
    this.app.stage.addChild(this.hover);
    this.app.stage.addChild(this.winHighlight);
    this.drawBoard();
    this.attachInput();
  }

  private drawBoard(): void {
    this.board.clear();
    this.board.roundRect(0, TOP_GUTTER, BOARD_W, BOARD_H, 12).fill({ color: BOARD_RED });
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const { x, y } = this.slotCenter(c, r);
        this.board.circle(x, y, CHIP_R + 2).fill({ color: SLOT_DARK });
      }
    }
  }

  private slotCenter(col: number, row: number): { x: number; y: number } {
    const x = PAD + col * CELL + CELL / 2;
    const y = TOP_GUTTER + PAD + (ROWS - 1 - row) * CELL + CELL / 2;
    return { x, y };
  }

  floorYFor(col: number, settledHeight: number): number {
    return this.slotCenter(col, settledHeight).y;
  }

  startYAbove(): number { return CHIP_R + 4; }

  private attachInput(): void {
    // Disable iOS double-tap-zoom on the board so taps register cleanly.
    this.app.canvas.style.touchAction = "manipulation";
    const colFromEvent = (ev: PointerEvent): number | null => {
      const rect = this.app.canvas.getBoundingClientRect();
      // Canvas is CSS-scaled on small screens — map back into BOARD_W space.
      const scaleX = BOARD_W / rect.width;
      const x = (ev.clientX - rect.left) * scaleX;
      if (x < PAD || x > BOARD_W - PAD) return null;
      const col = Math.floor((x - PAD) / CELL);
      return col >= 0 && col < COLS ? col : null;
    };
    this.app.canvas.addEventListener("pointermove", (ev: PointerEvent) => this.setHover(colFromEvent(ev)));
    this.app.canvas.addEventListener("pointerleave", () => this.setHover(null));
    this.app.canvas.addEventListener("pointerdown", (ev: PointerEvent) => {
      // Compute the column directly from the event. On touch devices a tap
      // never fires `pointermove` first, so relying on the cached hoverCol
      // would silently drop iPad/phone taps.
      const col = colFromEvent(ev);
      if (col !== null) this.opts.onColumnClick(col);
    });
  }

  private setHover(col: number | null): void {
    if (col === this.hoverCol) return;
    this.hoverCol = col;
    this.hover.clear();
    if (col !== null) {
      this.hover.rect(PAD + col * CELL, TOP_GUTTER, CELL, BOARD_H - PAD).fill({ color: 0xffffff, alpha: HOVER_ALPHA });
    }
    this.opts.onColumnHover(col);
  }

  syncFromState(state: GameState): void {
    this.staticChips.removeChildren();
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const cell = state.grid[c][r];
        if (!cell) continue;
        const g = new Graphics();
        const { x, y } = this.slotCenter(c, r);
        g.circle(x, y, CHIP_R).fill({ color: cell === "yellow" ? YELLOW : GREEN });
        this.staticChips.addChild(g);
      }
    }
    this.winHighlight.clear();
    if (state.status === "won") {
      for (const [c, r] of state.winningCells) {
        const { x, y } = this.slotCenter(c, r);
        this.winHighlight.circle(x, y, CHIP_R + 6).stroke({ width: 4, color: 0xffffff, alpha: 0.9 });
      }
    }
  }

  animateDrop(col: number, settledHeight: number, player: Cell, sim: ChipSim): Promise<void> {
    if (this.activeFall !== null) {
      throw new Error("animateDrop called while a drop is already in flight");
    }
    this.activeFall = { sim, col, player };
    return new Promise<void>((resolve) => {
      const onTick = (t: Ticker) => {
        const dt = Math.min(t.deltaMS, 50) / 1000;
        const subSteps = 8;
        for (let i = 0; i < subSteps && !sim.atRest; i++) sim.step(dt / subSteps);
        this.fallingChip.clear();
        const { x } = this.slotCenter(col, settledHeight);
        this.fallingChip.circle(x, sim.y, CHIP_R).fill({ color: player === "yellow" ? YELLOW : GREEN });
        if (sim.atRest) {
          this.app.ticker.remove(onTick);
          this.fallingChip.clear();
          this.activeFall = null;
          resolve();
        }
      };
      this.app.ticker.add(onTick);
    });
  }

  /** Show a translucent "held" chip hovering in the gutter above `col`, or clear
   *  it with col === null. Used to preview a queued move the player can still
   *  move or cancel before it drops. */
  setQueuedChip(col: number | null, player: Cell = "yellow"): void {
    this.queuedChip.clear();
    if (col === null) return;
    const x = PAD + col * CELL + CELL / 2;
    const y = this.startYAbove();
    const color = player === "yellow" ? YELLOW : GREEN;
    this.queuedChip.circle(x, y, CHIP_R).fill({ color, alpha: 0.5 });
    this.queuedChip.circle(x, y, CHIP_R).stroke({ width: 3, color: 0xffffff, alpha: 0.75 });
  }

  flashHintColumn(col: number): void {
    const g = new Graphics();
    g.rect(PAD + col * CELL, TOP_GUTTER, CELL, BOARD_H - PAD).fill({ color: 0xffffff, alpha: 0.35 });
    this.app.stage.addChild(g);
    let elapsed = 0;
    const onTick = (t: Ticker) => {
      elapsed += t.deltaMS;
      g.alpha = Math.max(0, 1 - elapsed / 1200);
      if (elapsed > 1200) { this.app.ticker.remove(onTick); this.app.stage.removeChild(g); }
    };
    this.app.ticker.add(onTick);
  }
}
