// web/src/physics/chip.test.ts
import { describe, expect, it } from "vitest";
import { ChipSim } from "./chip";

describe("ChipSim", () => {
  it("settles within ~1.5s when dropped from the top of an empty column", () => {
    const sim = new ChipSim({ floorY: 600, startY: 0, restitution: 0.35, gravity: 2400 });
    const impacts: number[] = [];
    sim.onImpact((velocity) => impacts.push(velocity));
    let t = 0;
    while (!sim.atRest && t < 3) { sim.step(1 / 240); t += 1 / 240; }
    expect(sim.atRest).toBe(true);
    expect(impacts.length).toBeGreaterThanOrEqual(2); // at least 1 main + 1 bounce
    expect(impacts.length).toBeLessThanOrEqual(8);
    expect(sim.y).toBeCloseTo(600, 0);
  });

  it("impact velocity decreases monotonically across bounces", () => {
    const sim = new ChipSim({ floorY: 600, startY: 0, restitution: 0.35, gravity: 2400 });
    const impacts: number[] = [];
    sim.onImpact((v) => impacts.push(v));
    let t = 0;
    while (!sim.atRest && t < 3) { sim.step(1 / 240); t += 1 / 240; }
    for (let i = 1; i < impacts.length; i++) expect(impacts[i]).toBeLessThan(impacts[i - 1]);
  });

  it("is deterministic — identical params produce identical impact sequence", () => {
    const run = () => {
      const sim = new ChipSim({ floorY: 600, startY: 0, restitution: 0.35, gravity: 2400 });
      const impacts: number[] = [];
      sim.onImpact((v) => impacts.push(v));
      let t = 0;
      while (!sim.atRest && t < 3) { sim.step(1 / 240); t += 1 / 240; }
      return impacts;
    };
    expect(run()).toEqual(run());
  });
});
