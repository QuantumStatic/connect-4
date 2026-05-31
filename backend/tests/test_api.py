# backend/tests/test_api.py
"""Contract tests for POST /analyze."""
from fastapi.testclient import TestClient
import pytest

from pyconnect4_backend.app import app


@pytest.fixture
def client():
    # `with` triggers lifespan startup (creates the ProcessPoolExecutor)
    # and shutdown (tears it down) around each test.
    with TestClient(app) as c:
        yield c


def test_empty_position_returns_seven_legal_scores(client):
    r = client.post("/analyze", json={"moves": "", "depth": None})
    assert r.status_code == 200
    body = r.json()
    assert len(body["scores"]) == 7
    assert all(s != -1000 for s in body["scores"])
    assert body["gameStatus"] == "ongoing"
    assert 0 <= body["bestMove"] <= 6
    assert body["scores"][body["bestMove"]] == max(body["scores"])


def test_best_move_from_empty_is_center(client):
    r = client.post("/analyze", json={"moves": "", "depth": None})
    assert r.json()["bestMove"] == 3


def test_full_column_returns_illegal_score(client):
    r = client.post("/analyze", json={"moves": "000000", "depth": None})
    body = r.json()
    assert body["scores"][0] == -1000


def test_depth_limited_returns_seven_scores(client):
    r = client.post("/analyze", json={"moves": "3334", "depth": 8})
    body = r.json()
    assert len(body["scores"]) == 7
    assert body["bestMove"] in range(7)


def test_winning_position_reports_won(client):
    # Yellow plays col 0 three times, red plays 1,2,3; yellow plays col 0 again → win.
    r = client.post("/analyze", json={"moves": "0102030", "depth": None})
    assert r.json()["gameStatus"] == "won"


def test_illegal_move_string_returns_422(client):
    r = client.post("/analyze", json={"moves": "9", "depth": None})
    assert r.status_code == 422


def test_bestmove_only_among_legal(client):
    r = client.post("/analyze", json={"moves": "000000", "depth": None})
    body = r.json()
    assert body["bestMove"] != 0
