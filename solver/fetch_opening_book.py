#!/usr/bin/env python3
"""Download the Pascal Pons opening book so the Great player opens instantly.

The book is a ~32 MB artifact published by Pons as a GitHub release. Without
it, the perfect solver must search the opening from scratch (10-30s per early
move). With it, opening moves up to 12 plies are instant lookups.

The book is NOT committed to the repo (too large); run this once after cloning.
By default it lands at solver/data/7x6.book, which the backend loads on startup.

Usage:
    python solver/fetch_opening_book.py            # full 32 MB book (depth 12)
    python solver/fetch_opening_book.py --small    # 6 MB book (fewer positions)
"""
import argparse
import sys
import urllib.request
from pathlib import Path

FULL_URL = "https://github.com/PascalPons/connect4/releases/download/book/7x6.book"
FULL_SIZE = 33_554_524
SMALL_URL = "https://github.com/PascalPons/connect4/releases/download/book/7x6_small.book"
SMALL_SIZE = 6_291_513

# Always saved under solver/data/7x6.book regardless of which variant, so the
# backend has a single well-known path to load.
DEST = Path(__file__).resolve().parent / "data" / "7x6.book"


_last_pct = -1


def _progress(block_num: int, block_size: int, total: int) -> None:
    global _last_pct
    if total <= 0:
        return
    pct = min(100, block_num * block_size * 100 // total)
    if pct == _last_pct:
        return  # only redraw when the integer percentage changes
    _last_pct = pct
    sys.stdout.write(f"\rDownloading opening book… {pct}%")
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--small", action="store_true", help="download the 6 MB book instead of the 32 MB one")
    ap.add_argument("--force", action="store_true", help="re-download even if a valid book already exists")
    args = ap.parse_args()

    url, expected = (SMALL_URL, SMALL_SIZE) if args.small else (FULL_URL, FULL_SIZE)

    if DEST.exists() and not args.force:
        size = DEST.stat().st_size
        if size in (FULL_SIZE, SMALL_SIZE):
            print(f"Opening book already present at {DEST} ({size:,} bytes). Use --force to re-download.")
            return 0
        print(f"Found {DEST} with unexpected size {size:,}; re-downloading.")

    DEST.parent.mkdir(parents=True, exist_ok=True)
    tmp = DEST.with_suffix(".book.partial")
    try:
        urllib.request.urlretrieve(url, tmp, _progress)
    except Exception as exc:  # noqa: BLE001 — top-level CLI, report and exit
        sys.stdout.write("\n")
        print(f"ERROR: download failed: {exc}", file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return 1
    sys.stdout.write("\n")

    size = tmp.stat().st_size
    if size != expected:
        print(f"ERROR: expected {expected:,} bytes, got {size:,}. Discarding.", file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return 1

    tmp.replace(DEST)
    print(f"Opening book saved to {DEST} ({size:,} bytes).")
    print("Restart the backend to load it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
