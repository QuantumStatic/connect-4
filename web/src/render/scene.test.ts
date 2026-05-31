// web/src/render/scene.test.ts
// Pure-math test for the canvas-X → column mapping. Regression coverage for
// the iPad-tap bug: touch devices never fire pointermove first, so taps must
// compute the column directly from the event (including under CSS scaling).
import { describe, expect, it } from "vitest";
import { columnFromX } from "./scene";

// Scene constants: COLS=7, CELL=88, PAD=16, BOARD_W = 7*88 + 16*2 = 632.

describe("columnFromX", () => {
  it("returns the correct column when canvas is at native resolution", () => {
    // Middle of col 3: x = PAD + 3*CELL + CELL/2 = 16 + 264 + 44 = 324
    expect(columnFromX(324, 632, 632, 16, 88, 7)).toBe(3);
  });
  it("returns null for clicks in the left padding", () => {
    expect(columnFromX(8, 632, 632, 16, 88, 7)).toBe(null);
  });
  it("returns null for clicks in the right padding", () => {
    expect(columnFromX(625, 632, 632, 16, 88, 7)).toBe(null);
  });
  it("scales correctly when canvas is CSS-shrunk for mobile (e.g. 50%)", () => {
    // Display-x=162 on a 316px-wide canvas = same as 324 at 632px
    expect(columnFromX(162, 316, 632, 16, 88, 7)).toBe(3);
  });
  it("handles boundary cases (col 0 and col 6)", () => {
    expect(columnFromX(17, 632, 632, 16, 88, 7)).toBe(0);  // just past padding
    expect(columnFromX(615, 632, 632, 16, 88, 7)).toBe(6); // just before padding
  });
});
