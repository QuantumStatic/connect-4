# backend/pyconnect4_backend/app.py
"""FastAPI app: single stateless POST /analyze endpoint.

Solver work runs in a ProcessPoolExecutor so concurrent /analyze requests
get real parallelism — each worker process owns its own pyconnect4.Solver
(and therefore its own transposition table), avoiding the data race that
threading would create on the shared TT.
"""
import asyncio
import os
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


def _resolve_book_path() -> str | None:
    """Locate the opening book. Env C4_OPENING_BOOK wins; else solver/data/7x6.book
    relative to the repo root. Returns an absolute path if the file exists, else None."""
    env = os.environ.get("C4_OPENING_BOOK")
    if env:
        return env if Path(env).is_file() else None
    # app.py is backend/pyconnect4_backend/app.py → repo root is two parents up from backend/.
    repo_root = Path(__file__).resolve().parents[2]
    default = repo_root / "solver" / "data" / "7x6.book"
    return str(default) if default.is_file() else None


# --- Worker-side state -------------------------------------------------------
# `_worker_solver` lives in each forked/spawned worker process. The main
# process never touches it. pyconnect4.Solver isn't picklable, so we cannot
# pass it across processes — instead each worker constructs its own at init.

_worker_solver = None  # set per-process by _init_worker


def _init_worker(book_path: str | None) -> None:
    global _worker_solver
    import pyconnect4  # imported inside the worker so the module loads there
    _worker_solver = pyconnect4.Solver()
    # load_book fails silently on a bad/missing file, so we gate on existence
    # ourselves. With the book, opening moves up to its stored depth are instant.
    if book_path and Path(book_path).is_file():
        _worker_solver.load_book(book_path)


def _solve_in_worker(
    moves: str, depth: int | None
) -> tuple[list[int], Literal["ongoing", "won", "draw"], int]:
    """Run solver work in a worker process. Returns (scores, status, bestMoveOrStopped).

    Raises ValueError on illegal move sequence so the controller can map to HTTP 400.
    """
    import pyconnect4
    position = pyconnect4.Position()
    played = position.play_sequence(moves)
    if played != len(moves):
        stopped_col = int(moves[played])
        if position.is_winning_move(stopped_col):
            return ([-1000] * 7, "won", stopped_col)
        raise ValueError("illegal move sequence")
    if position.nb_moves() == 42:
        return ([-1000] * 7, "draw", 0)
    if depth is None:
        scores = pyconnect4.analyze(_worker_solver, position)
    else:
        scores = pyconnect4.analyze_limited(position, depth)
    return (list(scores), "ongoing", 0)


# --- App lifecycle -----------------------------------------------------------

_executor: ProcessPoolExecutor | None = None


@asynccontextmanager
async def _lifespan(_: FastAPI):
    global _executor
    book_path = _resolve_book_path()
    if book_path:
        print(f"[pyconnect4] Opening book loaded: {book_path}")
    else:
        print("[pyconnect4] No opening book found — Great player opening moves "
              "will be slow. Run: python solver/fetch_opening_book.py")
    # max_workers=2 is enough for local single-user play: one AI move + one
    # hint in flight simultaneously, with no fork-bombing on small machines.
    _executor = ProcessPoolExecutor(
        max_workers=2, initializer=_init_worker, initargs=(book_path,)
    )
    try:
        yield
    finally:
        _executor.shutdown(wait=False, cancel_futures=True)
        _executor = None


app = FastAPI(title="pyconnect4-backend", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["POST"],
    allow_headers=["*"],
)


# --- Request / response models ----------------------------------------------


class AnalyzeRequest(BaseModel):
    moves: str = Field(default="", pattern=r"^[0-6]*$")
    depth: int | None = Field(default=None, ge=1, le=42)


class AnalyzeResponse(BaseModel):
    scores: list[int]
    bestMove: int
    gameStatus: Literal["ongoing", "won", "draw"]


_CENTER_ORDER = [3, 4, 2, 5, 1, 6, 0]


def _best_legal_move(scores: list[int]) -> int:
    best_score = -10_000
    best = 3  # center fallback; _game_status guarantees at least one legal
    for c in _CENTER_ORDER:
        if scores[c] == -1000:
            continue
        if scores[c] > best_score:
            best_score = scores[c]
            best = c
    return best


# --- Endpoint ----------------------------------------------------------------


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    assert _executor is not None  # lifespan guarantees this
    loop = asyncio.get_running_loop()
    try:
        scores, status, stopped_or_zero = await loop.run_in_executor(
            _executor, _solve_in_worker, req.moves, req.depth
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="illegal move sequence")

    if status == "won":
        return AnalyzeResponse(scores=scores, bestMove=stopped_or_zero, gameStatus="won")
    if status == "draw":
        return AnalyzeResponse(scores=scores, bestMove=0, gameStatus="draw")
    return AnalyzeResponse(
        scores=scores, bestMove=_best_legal_move(scores), gameStatus="ongoing"
    )
