// web/src/physics/chip.ts
// Single-body falling chip simulator. Vertical only; columns are independent
// so one instance per active drop is enough. Fixed-timestep integration; the
// render loop pumps step() in dt-sized slices.

export interface ChipSimOpts {
  floorY: number;      // pixel Y of the resting top of this chip's slot
  startY: number;      // initial pixel Y (typically just above the board)
  gravity: number;     // px/s^2
  restitution: number; // 0..1 — energy retained per bounce
  restThreshold?: number; // |v| below this on impact → snap to rest
}

export type ImpactListener = (impactVelocity: number) => void;

export class ChipSim {
  y: number;
  vy: number = 0;
  atRest: boolean = false;
  private floorY: number;
  private gravity: number;
  private restitution: number;
  private restThreshold: number;
  private listeners: ImpactListener[] = [];

  constructor(opts: ChipSimOpts) {
    this.y = opts.startY;
    this.floorY = opts.floorY;
    this.gravity = opts.gravity;
    this.restitution = opts.restitution;
    this.restThreshold = opts.restThreshold ?? 120;
  }

  onImpact(fn: ImpactListener): void { this.listeners.push(fn); }

  step(dt: number): void {
    if (this.atRest) return;
    this.vy += this.gravity * dt;
    this.y += this.vy * dt;
    if (this.y >= this.floorY) {
      this.y = this.floorY;
      const impact = this.vy;
      for (const fn of this.listeners) fn(impact);
      if (impact < this.restThreshold) {
        this.vy = 0;
        this.atRest = true;
      } else {
        this.vy = -impact * this.restitution;
      }
    }
  }
}
