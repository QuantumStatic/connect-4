// solver/wasm/wasm_api.cpp
// Emscripten/embind entrypoint over the Pascal Pons Connect 4 solver.
// Mirrors the backend's _solve_in_worker + _best_legal_move so the browser
// solver returns identical results to the Python backend.
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include <vector>

#include "Solver.hpp"
#include "Position.hpp"

using GameSolver::Connect4::Solver;
using GameSolver::Connect4::Position;
using emscripten::val;

namespace {

constexpr int ILLEGAL = -1000;
const int CENTER_ORDER[7] = {3, 4, 2, 5, 1, 6, 0};

// One solver instance for the page; reused across calls. Loading the book
// populates its opening-book table.
Solver g_solver;

int negamax_limited(const Position &P, int alpha, int beta, int depth) {
    if (P.nbMoves() == Position::WIDTH * Position::HEIGHT) return 0;
    for (int c = 0; c < Position::WIDTH; ++c)
        if (P.canPlay(c) && P.isWinningMove(c))
            return (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
    if (depth == 0) return 0;
    int max_score = (Position::WIDTH * Position::HEIGHT - 1 - P.nbMoves()) / 2;
    if (beta > max_score) { beta = max_score; if (alpha >= beta) return beta; }
    for (int c : CENTER_ORDER) {
        if (P.canPlay(c)) {
            Position P2(P);
            P2.playCol(c);
            int score = -negamax_limited(P2, -beta, -alpha, depth - 1);
            if (score >= beta) return score;
            if (score > alpha) alpha = score;
        }
    }
    return alpha;
}

std::vector<int> scores_full(const Position &P) {
    std::vector<int> out(Position::WIDTH, ILLEGAL);
    for (int c = 0; c < Position::WIDTH; ++c) {
        if (!P.canPlay(c)) continue;
        if (P.isWinningMove(c)) {
            out[c] = (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
            continue;
        }
        Position P2(P);
        P2.playCol(c);
        out[c] = -g_solver.solve(P2, false);
    }
    return out;
}

std::vector<int> scores_limited(const Position &P, int depth) {
    std::vector<int> out(Position::WIDTH, ILLEGAL);
    for (int c = 0; c < Position::WIDTH; ++c) {
        if (!P.canPlay(c)) continue;
        if (P.isWinningMove(c)) {
            out[c] = (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
            continue;
        }
        Position P2(P);
        P2.playCol(c);
        out[c] = -negamax_limited(P2, -100000, 100000, depth - 1);
    }
    return out;
}

int best_legal_move(const std::vector<int> &scores) {
    int best_score = -10000, best = 3;
    for (int c : CENTER_ORDER) {
        if (scores[c] == ILLEGAL) continue;
        if (scores[c] > best_score) { best_score = scores[c]; best = c; }
    }
    return best;
}

// Translate "0".."6" into the solver's 1-based play() alphabet, like the
// Python binding's play_sequence.
int play_sequence(Position &P, const std::string &moves) {
    std::string translated(moves.size(), '0');
    for (size_t i = 0; i < moves.size(); ++i) translated[i] = moves[i] + 1;
    return (int)P.play(translated);
}

// Returns { scores:number[], bestMove:number, gameStatus:string, ok:boolean }.
// ok=false signals an illegal move sequence (controller maps to error).
val analyze(const std::string &moves, int depth) {
    val res = val::object();
    Position P;
    int played = play_sequence(P, moves);
    if (played != (int)moves.size()) {
        int stopped = moves[played] - '0';
        if (P.isWinningMove(stopped)) {
            std::vector<int> s(7, ILLEGAL);
            res.set("scores", val::array(s));
            res.set("bestMove", stopped);
            res.set("gameStatus", std::string("won"));
            res.set("ok", true);
            return res;
        }
        res.set("ok", false);
        return res;
    }
    if (P.nbMoves() == 42) {
        std::vector<int> s(7, ILLEGAL);
        res.set("scores", val::array(s));
        res.set("bestMove", 0);
        res.set("gameStatus", std::string("draw"));
        res.set("ok", true);
        return res;
    }
    std::vector<int> scores = (depth <= 0) ? scores_full(P) : scores_limited(P, depth);
    res.set("scores", val::array(scores));
    res.set("bestMove", best_legal_move(scores));
    res.set("gameStatus", std::string("ongoing"));
    res.set("ok", true);
    return res;
}

// Load the opening book from a path in the Emscripten virtual FS.
void load_book(const std::string &path) { g_solver.loadBook(path); }

void reset_solver() { g_solver.reset(); }

} // namespace

EMSCRIPTEN_BINDINGS(pyconnect4) {
    emscripten::function("analyze", &analyze);
    emscripten::function("loadBook", &load_book);
    emscripten::function("resetSolver", &reset_solver);
}
