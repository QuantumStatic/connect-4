// @vitest-environment jsdom
// web/src/ui/hud.test.ts
// Pin the showLocalSide contract: friend mode needs a visible "You: <color>"
// chip with a dataset hook for CSS styling, and hiding it when leaving friend
// mode. Regression coverage for the side-chip rendering.
import { describe, expect, it } from "vitest";
import { Hud } from "./hud";

function makeHud(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement("div");
  const hud = new Hud(root, { onModeChange: () => {}, onNewGame: () => {}, onHint: () => {}, onEndRoom: () => {}, onResync: () => {} }, "2P");
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

describe("Hud.showScore", () => {
  it("renders from the local player's perspective when localSide is given", () => {
    const { hud, root } = makeHud();
    hud.showScore({ yellow: 2, green: 1 }, "yellow");
    const chip = root.querySelector(".score-chip") as HTMLElement;
    expect(chip.style.display).not.toBe("none");
    expect(chip.textContent).toBe("You 2 – 1 Them");
  });

  it("flips the perspective for the green player", () => {
    const { hud, root } = makeHud();
    hud.showScore({ yellow: 2, green: 1 }, "green");
    const chip = root.querySelector(".score-chip") as HTMLElement;
    expect(chip.textContent).toBe("You 1 – 2 Them");
  });

  it("falls back to color labels without a localSide", () => {
    const { hud, root } = makeHud();
    hud.showScore({ yellow: 3, green: 0 });
    const chip = root.querySelector(".score-chip") as HTMLElement;
    expect(chip.textContent).toBe("Yellow 3 – 0 Green");
  });

  it("hides the chip when called with null", () => {
    const { hud, root } = makeHud();
    hud.showScore({ yellow: 1, green: 1 }, "yellow");
    hud.showScore(null);
    const chip = root.querySelector(".score-chip") as HTMLElement;
    expect(chip.style.display).toBe("none");
  });
});

describe("Hud end-room button", () => {
  it("is hidden by default and fires onEndRoom when clicked while shown", () => {
    let ended = 0;
    const root = document.createElement("div");
    const hud = new Hud(
      root,
      { onModeChange: () => {}, onNewGame: () => {}, onHint: () => {}, onEndRoom: () => { ended++; }, onResync: () => {} },
      "2P",
    );
    const btn = root.querySelector(".end-room") as HTMLButtonElement;
    expect(btn.style.display).toBe("none");
    hud.showEndRoom(true);
    expect(btn.style.display).not.toBe("none");
    btn.click();
    expect(ended).toBe(1);
    hud.showEndRoom(false);
    expect(btn.style.display).toBe("none");
  });
});

describe("Hud transport toggle", () => {
  it("defaults to relay and reports p2p when checked", () => {
    const root = document.createElement("div");
    const hud = new Hud(
      root,
      { onModeChange: () => {}, onNewGame: () => {}, onHint: () => {}, onEndRoom: () => {}, onResync: () => {} },
      "2P",
    );
    expect(hud.transport()).toBe("relay");
    const box = root.querySelector(".p2p-toggle input") as HTMLInputElement;
    box.checked = true;
    expect(hud.transport()).toBe("p2p");
  });
});
