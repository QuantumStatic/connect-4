// web/src/net/transport.ts
// The seam between game-sync logic (main.ts) and a concrete connection. Both the
// WebRTC Session and the WebSocket RelaySocket implement this, so everything
// above the transport (protocol, decideSync, heartbeat, HUD) is shared.
import type { WireMsg } from "../game/protocol";

export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface Transport {
  /** Returns false if the channel was closed and the message was dropped. */
  send(msg: WireMsg): boolean;
  onMessage(fn: (m: WireMsg) => void): void;
  onState(fn: (s: ConnState) => void): void;
  /** Force a reconnect attempt now. No-op if already reconnecting/closed. */
  reconnectNow(): void;
  close(): void;
}
