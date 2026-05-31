// web/src/audio/sfx.ts
// Velocity-mapped plastic-clack sample player.

type Sample = "clack_soft" | "clack_hard" | "tick" | "win";

const PATHS: Record<Sample, string> = {
  clack_soft: "/sfx/clack_soft.wav",
  clack_hard: "/sfx/clack_hard.wav",
  tick: "/sfx/tick.wav",
  win: "/sfx/win.wav",
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private buffers: Partial<Record<Sample, AudioBuffer>> = {};
  private loaded: Promise<void> | null = null;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      this.ctx = new AudioContext();
      await Promise.all(
        (Object.keys(PATHS) as Sample[]).map(async (name) => {
          try {
            const res = await fetch(PATHS[name]);
            const arr = await res.arrayBuffer();
            this.buffers[name] = await this.ctx!.decodeAudioData(arr);
          } catch {
            // Sample missing or invalid — audio for this sample will be silent.
          }
        }),
      );
    })();
    return this.loaded;
  }

  /** Velocity in px/s. Maps to soft/hard sample + gain + small pitch shift. */
  impact(velocity: number, isMicroBounce: boolean = false): void {
    if (!this.ctx) return;
    const v = Math.max(0, velocity);
    const hard = v > 900;
    const buf = this.buffers[hard ? "clack_hard" : "clack_soft"];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.12;
    const gain = this.ctx.createGain();
    const norm = Math.min(1, v / 1500);
    gain.gain.value = isMicroBounce ? 0.15 * norm : 0.35 + 0.55 * norm;
    if (isMicroBounce) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1500;
      src.connect(hp).connect(gain).connect(this.ctx.destination);
    } else {
      src.connect(gain).connect(this.ctx.destination);
    }
    src.start();
  }

  ui(): void { this.playOne("tick", 0.3); }
  win(): void { this.playOne("win", 0.8); }

  private playOne(name: Sample, gainValue: number): void {
    if (!this.ctx) return;
    const buf = this.buffers[name];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = gainValue;
    src.connect(gain).connect(this.ctx.destination);
    src.start();
  }
}
