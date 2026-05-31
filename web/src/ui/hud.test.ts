// @vitest-environment jsdom
// web/src/ui/hud.test.ts
// Pin the showLocalSide contract: friend mode needs a visible "You: <color>"
// chip with a dataset hook for CSS styling, and hiding it when leaving friend
// mode. Regression coverage for the side-chip rendering.
import { describe, expect, it } from "vitest";
import { Hud } from "./hud";

function makeHud(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement("div");
  const hud = new Hud(root, { onModeChange: () => {}, onNewGame: () => {}, onHint: () => {} }, "2P");
  return { hud, root };
}

describe("Hud.showLocalSide", () => {
  it("shows a visible chip with 'yellow' text and dataset", () => {
    const { hud, root } = makeHud();
    hud.showLocalSide("yellow");
    const chip = root.querySelector(".side-chip") as HTMLElement;
    expect(chip.style.display).not.toBe("none");
    expect(chip.textContent).toContain("yellow");
    expect(chip.dataset.side).toBe("yellow");
  });

  it("shows a visible chip with 'green' text and dataset", () => {
    const { hud, root } = makeHud();
    hud.showLocalSide("green");
    const chip = root.querySelector(".side-chip") as HTMLElement;
    expect(chip.style.display).not.toBe("none");
    expect(chip.textContent).toContain("green");
    expect(chip.dataset.side).toBe("green");
  });

  it("hides the chip when called with null", () => {
    const { hud, root } = makeHud();
    hud.showLocalSide("yellow");
    hud.showLocalSide(null);
    const chip = root.querySelector(".side-chip") as HTMLElement;
    expect(chip.style.display).toBe("none");
  });
});
