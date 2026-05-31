// web/src/ui/hud.ts
import type { Mode } from "../game/persist";

export interface HudCallbacks {
  onModeChange: (mode: Mode) => void;
  onNewGame: () => void;
  onHint: () => void;
}

export class Hud {
  private statusEl = document.createElement("div");
  private modeSel = document.createElement("select");
  private newBtn = document.createElement("button");
  private hintBtn = document.createElement("button");
  private dot = document.createElement("span");
  private statusText = document.createElement("span");
  private thinking = false;
  private linkBox = document.createElement("div");
  private connChip = document.createElement("span");
  private sideChip = document.createElement("span");

  constructor(private root: HTMLElement, cbs: HudCallbacks, initialMode: Mode) {
    this.statusEl.className = "status";
    this.dot.className = "think-dot";
    this.statusEl.append(this.dot, this.statusText);
    for (const [value, label] of [
      ["2P", "2 Player"],
      ["good", "vs Good player"],
      ["great", "vs Great player"],
      ["friend", "Play a friend"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      this.modeSel.appendChild(opt);
    }
    this.modeSel.value = initialMode;
    this.modeSel.onchange = () => cbs.onModeChange(this.modeSel.value as Mode);
    this.newBtn.textContent = "New game";
    this.newBtn.onclick = () => cbs.onNewGame();
    this.hintBtn.textContent = "Hint";
    this.hintBtn.onclick = () => cbs.onHint();
    root.append(this.modeSel, this.newBtn, this.hintBtn, this.statusEl);
    this.linkBox.className = "linkbox";
    this.linkBox.style.display = "none";
    this.connChip.className = "conn-chip";
    this.connChip.style.display = "none";
    this.sideChip.className = "side-chip";
    this.sideChip.style.display = "none";
    root.append(this.sideChip, this.connChip, this.linkBox);
  }

  setStatus(text: string): void {
    // Ignore normal status updates while the AI-thinking indicator is showing;
    // setThinking(null) is responsible for clearing it.
    if (this.thinking) return;
    this.statusText.textContent = text;
  }

  /** Show ("…thinking") or clear (null) the AI-thinking indicator. While
   *  thinking, the pulsing dot is visible and Hint / mode-switch are disabled. */
  setThinking(text: string | null): void {
    this.thinking = text !== null;
    this.statusEl.classList.toggle("thinking", this.thinking);
    this.hintBtn.disabled = this.thinking;
    this.modeSel.disabled = this.thinking;
    if (text !== null) this.statusText.textContent = text;
  }

  setHintEnabled(enabled: boolean): void { this.hintBtn.disabled = !enabled; }
  setSolverOffline(offline: boolean): void {
    this.hintBtn.disabled = offline;
    if (offline) {
      for (const opt of Array.from(this.modeSel.options)) {
        if (opt.value === "good" || opt.value === "great") {
          opt.disabled = true;
          if (!opt.textContent?.includes("(local only)")) opt.textContent = `${opt.textContent} (local only)`;
        }
      }
      // Hint requires solver but isn't a mode — disable it explicitly.
      // Friend mode stays available (it doesn't need the solver).
      if (this.modeSel.value === "good" || this.modeSel.value === "great") {
        this.modeSel.value = "2P";
        this.modeSel.dispatchEvent(new Event("change"));
      }
    }
  }

  /** Show the shareable join link with a copy button. */
  showHostLink(url: string): void {
    this.linkBox.style.display = "flex";
    this.linkBox.replaceChildren();
    const input = document.createElement("input");
    input.readOnly = true; input.value = url; input.className = "link-input";
    const copy = document.createElement("button");
    copy.textContent = "Copy link";
    copy.onclick = () => { void navigator.clipboard.writeText(url); copy.textContent = "Copied!"; };
    const hint = document.createElement("span");
    hint.textContent = "Send this to your friend";
    this.linkBox.append(input, copy, hint);
  }

  hideHostLink(): void { this.linkBox.style.display = "none"; }

  /** Tell the player which color they're playing in friend mode.
   *  Pass null to hide the chip (when leaving friend mode). */
  showLocalSide(side: "yellow" | "green" | null): void {
    if (side === null) { this.sideChip.style.display = "none"; return; }
    this.sideChip.style.display = "inline-block";
    this.sideChip.textContent = `You: ${side}`;
    this.sideChip.dataset.side = side;
  }

  /** Show/refresh the connection-status chip. */
  showConnState(state: "connecting" | "connected" | "reconnecting" | "disconnected" | null): void {
    if (state === null) { this.connChip.style.display = "none"; return; }
    this.connChip.style.display = "inline-block";
    this.connChip.textContent = state;
    this.connChip.dataset.state = state;
  }

  toast(text: string, ms = 3500): void {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
}
