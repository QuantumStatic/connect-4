# Connect 4

**▶ Play: https://connect4-65t.pages.dev**

Connect 4 with a perfect-play AI ([Pascal Pons solver](https://github.com/PascalPons/connect4), vendored C++), GPU-accelerated 2D graphics (PixiJS v8), weighty falling-chip physics, plastic-impact audio, 2-player hot-seat, online play with a friend, and game resume on reload.

The AI runs **entirely in the browser** via WebAssembly — the same Pons C++ compiled with Emscripten (see [`solver/wasm/`](solver/wasm/)). No backend is needed to play vs CPU online; the deployed site is fully self-contained. The 32 MB opening book is lazy-loaded from the relay (R2-backed) on first use of the Great player / Hint and cached on-device, so it downloads once. The Python/FastAPI backend below is now **optional**, kept for local development and as the reference solver implementation.

**License:** AGPL-3.0 (inherited from the vendored solver).

---

## Run it

**Prerequisites:** Node 20+. (The AI is a prebuilt WASM module, committed under `web/src/solver/wasm/` — no Python or C++ toolchain needed just to run the app.)

```bash
git clone --recurse-submodules <this-repo> connect-4
cd connect-4/web
npm install
npm run dev                   # opens on http://localhost:5173
```

Open **http://localhost:5173** in your browser. Every mode — including vs Good / vs Great / Hint — works with no backend.

> **Opening book in dev:** the Great player and Hint lazy-load the 32 MB book
> from the relay at `GET /book/7x6.book`. Locally that route 404s unless you run
> the relay (or set `VITE_RELAY_URL` to a deployed one), so Great/Hint will
> report the engine as offline while **2 Player and vs Good still work fully**
> (vs Good is bookless). To exercise Great locally, run the relay with the book
> in R2, or set `VITE_RELAY_URL=https://<your-relay>`.

### Optional: Python backend + native solver

Only needed for solver development or the pytest suites — the app does not use it.

```bash
python3.11 -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install ./solver          # compiles the C++ binding (~30s first time)
pip install -e "./backend[dev]"
python solver/fetch_opening_book.py                # ~32 MB book into solver/data/
python -m pyconnect4_backend                       # http://127.0.0.1:8000
```

### Rebuilding the WASM solver

The committed `web/src/solver/wasm/pyconnect4.{js,wasm}` are built from the
vendored C++ with Emscripten. To rebuild: install [emsdk](https://github.com/emscripten-core/emsdk),
`source ~/emsdk/emsdk_env.sh`, then `bash solver/wasm/build.sh`. See
[`solver/wasm/README.md`](solver/wasm/README.md).

---

## Game modes

| Mode | Description |
|---|---|
| **2 Player** | Hot-seat — two humans share the keyboard |
| **vs Good player** | Depth-10 AI, beatable |
| **vs Great player** | Full Pascal Pons solver — perfect play |
| **Hint** | Highlights the solver's best column from the current position |

Resume: closing and reopening the tab restores the last game in progress.

---

## Play a friend (online, peer-to-peer)

Two friends play directly browser-to-browser over WebRTC — no game server holds
state. A stateless Cloudflare Worker only brokers the connection.

Connections default to a reliable WebSocket relay (a tiny Cloudflare Durable
Object that only forwards moves). A "Direct (P2P)" toggle uses browser-to-browser
WebRTC instead. Either way, no game state is stored on a server beyond a transient
in-memory cache for reconnects.

**Deploy (one-time):**
1. Deploy the relay: see [`relay/README.md`](relay/README.md).
2. Deploy the web app to Cloudflare Pages (`cd web && npm run build`, then point
   Pages at `web/dist`). Put the Worker on the same domain (Worker route) so the
   app reaches it at `/ice` and `/room` with no CORS — or set `VITE_RELAY_URL`.

**Play:** pick "Play a friend", click *Create*, send the link to your friend over
any chat app. They open it and you're connected. Dropped connections auto-reconnect;
if that fails, share a fresh link. Games survive reload (move log in localStorage).

---

## Tests

```bash
# Solver binding
pytest solver/tests -v

# Backend API
pytest backend/tests -v

# Frontend (game state + physics)
cd web && npm test
```

---

## Audio

`web/public/sfx/` contains placeholder WAV files. Replace them with CC0 samples (e.g. from [freesound.org](https://freesound.org)) before playing with sound:

| File | Description |
|---|---|
| `clack_soft.wav` | Soft plastic impact (low-velocity chip drop) |
| `clack_hard.wav` | Hard plastic clack (high-velocity chip drop) |
| `tick.wav` | UI tick (column hover/select) |
| `win.wav` | Win fanfare |

Add attributions here when you replace the placeholders.

---

## Architecture

```
connect-4/
  solver/         C++ Pascal Pons solver + pybind11 binding (pyconnect4)
  backend/        FastAPI — POST /analyze (stateless: position in, scores out)
  web/            Vite + TypeScript + PixiJS — owns all game state
    src/game/     Pure game state + localStorage persistence
    src/physics/  Single-body falling chip simulator
    src/audio/    WebAudio velocity-mapped sample player
    src/render/   PixiJS board + chip rendering
    src/ui/       DOM HUD overlay
    src/solver/   Fetch wrapper for POST /analyze
```
