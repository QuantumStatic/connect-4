# Connect 4

Local-only Connect 4 with a perfect-play AI ([Pascal Pons solver](https://github.com/PascalPons/connect4), vendored C++), GPU-accelerated 2D graphics (PixiJS v8), weighty falling-chip physics, plastic-impact audio, 2-player hot-seat, and game resume on reload.

**License:** AGPL-3.0 (inherited from the vendored solver).

---

## Run it

**Prerequisites:** Python 3.11+, Node 20+, a C++11 compiler (clang on macOS, gcc on Linux, MSVC on Windows), CMake 3.18+.

```bash
git clone --recurse-submodules <this-repo> connect-4
cd connect-4

# 1. Create a Python venv and install the solver + backend
python3.11 -m venv .venv
. .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install ./solver          # compiles the C++ binding (~30s first time)
pip install -e "./backend[dev]"

# 2. Download the opening book (recommended) so the Great player opens instantly
python solver/fetch_opening_book.py     # ~32 MB, one-time; --small for 6 MB

# 3. Start the backend
python -m pyconnect4_backend  # runs on http://127.0.0.1:8000

# 4. In a new terminal, start the frontend
cd web
npm install
npm run dev                   # opens on http://localhost:5173
```

Open **http://localhost:5173** in your browser.

> **Opening book:** Without it, the Great player still plays perfectly but its
> early moves take 10–30s each (it solves the opening from scratch). The book is
> a precomputed lookup table that makes opening moves instant. It's ~32 MB so it
> isn't committed — `solver/fetch_opening_book.py` downloads it once into
> `solver/data/`. Set `C4_OPENING_BOOK=/path/to/7x6.book` to point elsewhere.

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
