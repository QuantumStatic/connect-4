// web/src/ui/hud.ts
import type { Mode } from "../game/persist";

export type SidePref = "first" | "second" | "random";

export interface HudCallbacks {
  onModeChange: (mode: Mode) => void;
  onNewGame: () => void;
  onHint: () => void;
  onEndRoom: () => void;
  onResync: () => void;
  onSideChange: (pref: SidePref) => void;
}

export class Hud {
  private statusEl = document.createElement("div");
  private modeSel = document.createElement("select");
  private sideSel = document.createElement("select");
  private newBtn = document.createElement("button");
  private hintBtn = document.createElement("button");
  private endBtn = document.createElement("button");
  private resyncBtn = document.createElement("button");
  private dot = document.createElement("span");
  private statusText = document.createElement("span");
  private thinking = false;
  private linkBox = document.createElement("div");
  private connChip = document.createElement("span");
  private sideChip = document.createElement("span");
  private scoreChip = document.createElement("span");
  private p2pToggle = document.createElement("label");
  private p2pCheck = document.createElement("input");

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
    for (const [value, label] of [
      ["first", "You: 1st (yellow)"],
      ["second", "You: 2nd (green)"],
      ["random", "You: Random 🎲"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      this.sideSel.appendChild(opt);
    }
    this.sideSel.style.display = "none";
    this.sideSel.title = "Choose whether you move first or second";
    this.sideSel.onchange = () => cbs.onSideChange(this.sideSel.value as SidePref);
    this.newBtn.textContent = "New game";
    this.newBtn.onclick = () => cbs.onNewGame();
    this.hintBtn.textContent = "Hint";
    this.hintBtn.onclick = () => cbs.onHint();
    this.resyncBtn.textContent = "Resync";
    this.resyncBtn.title = "Force a state re-sync with your opponent";
    this.resyncBtn.style.display = "none";
    this.resyncBtn.onclick = () => cbs.onResync();
    this.endBtn.textContent = "End room";
    this.endBtn.className = "end-room";
    this.endBtn.style.display = "none";
    this.endBtn.onclick = () => cbs.onEndRoom();
    root.append(this.modeSel, this.sideSel, this.newBtn, this.hintBtn, this.resyncBtn, this.endBtn, this.statusEl);
    this.linkBox.className = "linkbox";
    this.linkBox.style.display = "none";
    this.connChip.className = "conn-chip";
    this.connChip.style.display = "none";
    this.sideChip.className = "side-chip";
    this.sideChip.style.display = "none";
    this.scoreChip.className = "score-chip";
    this.scoreChip.style.display = "none";
    this.p2pCheck.type = "checkbox";
    this.p2pToggle.className = "p2p-toggle";
    this.p2pToggle.style.display = "none";
    this.p2pToggle.append(this.p2pCheck, document.createTextNode(" Direct (P2P)"));
    root.append(this.scoreChip, this.sideChip, this.connChip, this.linkBox, this.p2pToggle);
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

  /** Show/hide the friend-mode action buttons (Resync + End room). */
  showEndRoom(show: boolean): void {
    this.endBtn.style.display = show ? "" : "none";
    this.resyncBtn.style.display = show ? "" : "none";
  }

  /** Reflect the current mode in the dropdown without firing onModeChange
   *  (used when mode changes programmatically, e.g. after ending a room). */
  setModeValue(mode: Mode): void { this.modeSel.value = mode; }

  /** Tell the player which color they're playing in friend mode.
   *  Pass null to hide the chip (when leaving friend mode). */
  showLocalSide(side: "yellow" | "green" | null): void {
    if (side === null) { this.sideChip.style.display = "none"; return; }
    this.sideChip.style.display = "inline-block";
    this.sideChip.textContent = `You: ${side}`;
    this.sideChip.dataset.side = side;
  }

  /** Show the running win tally. From the local player's perspective when
   *  `localSide` is given ("You 2 – 1 Them"); otherwise by color ("Yellow 2 – 1
   *  Green"). Pass null score to hide. */
  showScore(score: { yellow: number; green: number } | null, localSide?: "yellow" | "green" | null): void {
    if (score === null) { this.scoreChip.style.display = "none"; return; }
    this.scoreChip.style.display = "inline-block";
    if (localSide) {
      const mine = score[localSide];
      const theirs = localSide === "yellow" ? score.green : score.yellow;
      this.scoreChip.textContent = `You ${mine} – ${theirs} Them`;
    } else {
      this.scoreChip.textContent = `Yellow ${score.yellow} – ${score.green} Green`;
    }
  }

  /** Chosen transport for a new friend game. */
  transport(): "relay" | "p2p" { return this.p2pCheck.checked ? "p2p" : "relay"; }

  /** Whether the local player wants to move first, second, or randomly. */
  side(): SidePref {
    const v = this.sideSel.value;
    return v === "second" || v === "random" ? v : "first";
  }

  /** Show/hide the side picker (vs-AI always; friend host until connected). */
  showSidePicker(show: boolean): void { this.sideSel.style.display = show ? "" : "none"; }

  /** Reflect a side choice without firing onSideChange. */
  setSideValue(pref: SidePref): void { this.sideSel.value = pref; }

  /** Show/hide the transport toggle (only visible while setting up friend mode). */
  showTransportToggle(show: boolean): void { this.p2pToggle.style.display = show ? "" : "none"; }

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
