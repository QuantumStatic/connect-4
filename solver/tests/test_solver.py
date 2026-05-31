# solver/tests/test_solver.py
"""Golden tests for the pyconnect4 binding."""
import pyconnect4


def test_empty_position_has_seven_legal_columns():
    p = pyconnect4.Position()
    s = pyconnect4.Solver()
    scores = pyconnect4.analyze(s, p)
    assert len(scores) == 7
    assert all(score != -1000 for score in scores)


def test_full_column_is_illegal():
    p = pyconnect4.Position()
    # Fill column 0 by having both players alternate dropping into it (6 chips
    # total, rows 0-5). Chips at even rows belong to P1 and chips at odd rows
    # to P2, so neither player ever achieves four consecutive in the column.
    played = p.play_sequence("000000")
    assert played == 6
    s = pyconnect4.Solver()
    scores = pyconnect4.analyze(s, p)
    assert scores[0] == -1000
    assert scores[1] != -1000


def test_immediate_win_detected():
    # Three yellow chips in column 0 rows 0-2; column 0 row 3 wins for yellow.
    p = pyconnect4.Position()
    p.play_sequence("010203")  # yellow plays 0,0,0; red plays 1,2,3
    assert p.is_winning_move(0)


def test_center_is_optimal_from_empty():
    p = pyconnect4.Position()
    s = pyconnect4.Solver()
    scores = pyconnect4.analyze(s, p)
    best = max(range(7), key=lambda c: scores[c])
    assert best == 3, f"center should be best from empty, got col {best} (scores={scores})"


def test_analyze_limited_returns_seven_scores():
    p = pyconnect4.Position()
    scores = pyconnect4.analyze_limited(p, depth=6)
    assert len(scores) == 7
    assert all(s != -1000 for s in scores)


def test_analyze_limited_matches_solver_on_terminal_position():
    p = pyconnect4.Position()
    p.play_sequence("010203")  # yellow can win at col 0
    scores = pyconnect4.analyze_limited(p, depth=1)
    best = max(range(7), key=lambda c: scores[c])
    assert best == 0
