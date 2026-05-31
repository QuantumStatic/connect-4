# Connect 4 — Design

**Date:** 2026-05-31
**Status:** Draft for review

## Goal

A local, fork-clone-run Connect 4 game with GPU-accelerated 2D graphics, weighty chip-drop physics, sample-based plastic-impact audio, and a perfect-play AI built on the Pascal Pons solver. Two-player hot-seat, two AI difficulty levels ("Good player" / "Great player"), and a hint button that consults the solver from the current position. Game state persists across page reloads.

## Non-goals

- Online multiplayer, accounts, matchmaking, leaderboards.
- Mobile-optimized UI (it should work on desktop browsers; mobile is a nice-to-have, not a requirement).
- Larger or non-standard boards. Strict 7 wide × 6 tall.
- 3D rendering, full rigid-body engine, jostling-between-chips physics.
- Replays, undo beyond "new game," puzzle / analysis modes beyond the single hint button.

## Architecture

Two cleanly separated processes:

```
┌────────────────────────────┐         HTTP            ┌──────────────────────────────────┐
│ Frontend (browser)         │ ──────────────────────► │ Backend (Python, FastAPI)        │
│                            │   POST /analyze         │                                  │
│  PixiJS scene + game state │ ◄────────────────────── │  pybind11 wrapper around the     │
│  Custom physics (chip)     │   { scores, bestMove }  │  Pascal Pons C++ solver          │
│  WebAudio sample player    │                         │                                  │
│  localStorage persistence  │                         │  Stateless: position string in,  │
│                            │                         │  scores out. Opening book loaded │
│                            │                         │  once at startup.                │
└────────────────────────────┘                         └──────────────────────────────────┘
```

The frontend owns all game state. The backend is a pure function: given a position, return an evaluation. Same input → same output, no sessions, no database.

## Components

### 1. C++ solver (vendored, unchanged)

Source: [PascalPons/connect4](https://github.com/PascalPons/connect4), AGPL-3.0, vendored as a git submodule under `solver/vendor/connect4/`. We do not modify it. Project license becomes AGPL-3.0 as a consequence.

Key properties (reference only — we do not touch this code):
- Bitboard `Position` with sentinel-row trick, branchless win detection.
- `TranspositionTable<partial_key_t, key_t, value_t, log_size>` — open-addressing, prime-sized via `constexpr`, always-replace.
- Negamax + alpha-beta + null-window iterative deepening, center-first move ordering, `MoveSorter` ranking by winning-threat count, horizontal symmetry via `key3()`.
- Opening book (8-ply) loaded as a `TranspositionTable` from a binary file.

### 2. Python solver wrapper (`solver/`)

A thin pybind11 module exposing exactly what the backend needs. Build via `setup.py` + `CMakeLists.txt`; installable with `pip install -e ./solver` (one-time C++ compile).

Exposed surface (minimal):

```python
class Position:
    def __init__(self) -> None: ...
    def play_sequence(self, moves: str) -> int  # returns number of moves played; raises on illegal
    def can_win_next(self) -> bool
    def nb_moves(self) -> int

class Solver:
    def __init__(self, opening_book_path: str | None = None) -> None: ...
    def solve(self, position: Position, weak: bool = False) -> int           # exact score
    def analyze(self, position: Position) -> list[int]                       # score per column, -1000 = illegal
    def analyze_limited(self, position: Position, depth: int) -> list[int]   # depth-limited; same shape
```

`analyze_limited` is a small variant of `Solver::negamax` that returns a heuristic eval (threat count + center bias) when depth is exhausted instead of recursing to terminal. Lives in our wrapper translation unit, not in the vendored sources.

### 3. Python API (`backend/`)

FastAPI app. One file, one endpoint, plus a small startup hook that constructs a single shared `Solver` instance (with opening book) at process start.

```
POST /analyze
  body: { "moves": "4435", "depth": null | int }
  200:  { "scores": [int, ...7], "bestMove": int, "gameStatus": "ongoing" | "won" | "draw" }
```

- `moves` is the Pons column-index string (`"0"`–`"6"`, in play order). Empty string = initial position.
- `depth` omitted or `null` → full solve (Great player, Hint).
- `depth` = integer (we'll use 10 for "Good player") → depth-limited heuristic eval.
- `scores[c] = -1000` if column `c` is full or otherwise illegal.
- `bestMove` is `argmax(scores)` among legal columns; ties broken center-first.
- `gameStatus` is computed from the input position so the frontend doesn't have to duplicate win-detection logic.

CORS allows `localhost`/`127.0.0.1`. No auth — local-only.

Run via `uvicorn backend.app:app --reload` (dev) or `python -m backend` (prod-ish).

### 4. Frontend (`web/`)

Stack: Vite + TypeScript + PixiJS + WebAudio. No physics library; no UI framework. Build/run: `npm install && npm run dev`.

Modules:

- `game/state.ts` — pure game state. Holds the move sequence string and derives the 7×6 grid + current player + win state. All state mutations go through `applyMove(col)`. Independently testable with no PixiJS or DOM imports.
- `game/persist.ts` — `localStorage` save/load. Persists: move sequence, mode (`2P` | `good` | `great`), human side (when vs AI), timestamp. On boot, surfaces a "Resume game?" prompt if a non-empty saved game exists; never auto-loads.
- `solver/client.ts` — fetch wrapper around `POST /analyze`. Single function `analyze(moves, depth?) → Promise<AnalyzeResponse>`. Handles errors with a user-visible toast ("Solver offline — AI/hint disabled, hot-seat still works").
- `render/scene.ts` — PixiJS scene graph. Renders board (dark matte red rounded rectangle with 42 recessed circular slot cutouts), chip sprites (flat hard-plastic green/yellow circles with subtle rim shading, no specular), hover indicator (faint chip ghost above the column under the cursor), and the win highlight (the four winning chips pulse softly). Pure rendering — reads from `state.ts`, writes nothing back.
- `physics/chip.ts` — single-body falling-chip simulator. Fixed timestep (e.g., 240 Hz physics, decoupled from render). One chip in flight at a time. Per chip: gravity, vertical position, vertical velocity, restitution against the slot floor (or the top of the topmost chip already in that column). Two-three bounces, then settle. Emits impact events with velocity to the audio layer.
- `audio/sfx.ts` — WebAudio sample player. Loads ~4 samples at boot (hard-plastic clack soft, hard-plastic clack hard, UI tick, win fanfare). Velocity-mapped: chip-impact velocity selects sample (soft / hard) and modulates gain + a small random pitch shift (±2 semitones) so identical drops don't sound identical. Micro-bounce impacts play the same clack at low gain, high-passed via a `BiquadFilterNode`, so they read as "tick tick."
- `ui/hud.ts` — minimal DOM overlay: current player indicator, mode selector (2P / Good / Great), "New game" button, "Hint" button. Hint button calls `analyze(moves)` (full depth), then animates a faint glow above the recommended column for ~2 seconds.

### 5. Repo layout

```
connect-4/
  solver/
    vendor/connect4/        # git submodule, unmodified
    src/binding.cpp         # pybind11 wrapper + analyze_limited
    CMakeLists.txt
    setup.py
  backend/
    app.py                  # FastAPI app
    __main__.py
    pyproject.toml
  web/
    src/
      game/ render/ physics/ audio/ solver/ ui/
      main.ts
    index.html
    package.json
    vite.config.ts
  docs/superpowers/specs/   # this doc lives here
  README.md                 # how to fork-clone-run
```

## Data flow — one full move (vs Great player)

1. User clicks column 3. `ui/hud.ts` calls `state.applyMove(3)` after checking it's legal.
2. `state.ts` appends `"3"` to the move sequence; emits a "move played" event.
3. `physics/chip.ts` spawns a falling chip body for column 3; integrates at 240 Hz.
4. On each impact (final landing + each micro-bounce), `physics` emits `{column, velocity}` to `audio/sfx.ts`, which plays a velocity-mapped clack.
5. When the chip settles, `render/scene.ts` swaps the physics chip for a static sprite in the grid.
6. `persist.ts` writes the new move sequence to `localStorage`.
7. If the mode is `great` and it's now the AI's turn, `solver/client.ts` calls `POST /analyze` with the current move sequence (no `depth`).
8. Backend constructs a `Position`, replays the sequence, calls `Solver.analyze`, returns scores + `bestMove`.
9. Frontend applies the AI's `bestMove` the same way as step 2 onward.

`gameStatus !== "ongoing"` from any response (or from local win-detection in `state.ts`, whichever fires first) ends the game and triggers the win-highlight + fanfare.

## Error handling

- **Solver process down:** `solver/client.ts` catches the fetch failure, shows a non-blocking toast, disables Hint and AI modes. 2P hot-seat continues to work — game logic is fully local.
- **Illegal move from API response:** treat as solver bug; log to console, fall back to center-most legal column for AI. Never crash.
- **Corrupt `localStorage` save:** if the saved move string fails to replay legally, discard it silently and start fresh.
- **Build failures in the pybind11 module:** README documents the fix (install C++ toolchain). No silent degradation — backend will refuse to start without the wrapper.

## Testing

- **Solver wrapper (pytest):** golden tests against published Pons positions — known-won/lost positions return expected score signs; opening book loads and returns center column as best from empty position.
- **Backend (pytest + httpx):** endpoint contract — empty moves returns 7 legal scores; full column returns `-1000` in that slot; `depth` parameter changes results vs full solve on a midgame position; `gameStatus` flips correctly on a known winning sequence.
- **Frontend game state (vitest):** `applyMove` rejects illegal columns, win detection finds all 4 orientations (horizontal/vertical/two diagonals), draw detection on full board.
- **Physics (vitest):** chip with initial velocity 0 lands at the correct slot height; restitution + damping converges to rest within N bounces; replaying identical drop with identical seed produces identical impact-event sequence.
- **No e2e browser tests in v1** — manual smoke test on Chrome + Firefox before tagging a release.

## Open questions / deferred

- Whether to bundle the prebuilt opening book in the repo (a few MB) or download on first run. Defer to implementation — bundling is simpler if size is acceptable.
- Exact depth value for "Good player" — start at 10, tune by play-feel before release.
- Exact sample files — sourced during implementation from freesound.org under CC0 / CC-BY; license file lists attributions.
- Whether to draw a soft drop-shadow under the board for depth. Defer — try both, pick what looks right.
