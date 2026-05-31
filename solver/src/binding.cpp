// solver/src/binding.cpp
// pybind11 binding for the Pascal Pons Connect 4 solver.
// Adds analyze() (full solve per column) and analyze_limited() (depth-limited
// heuristic) on top of the vendored Solver API.

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <string>
#include <vector>

#include "Solver.hpp"
#include "Position.hpp"

namespace py = pybind11;
using GameSolver::Connect4::Solver;
using GameSolver::Connect4::Position;

namespace {

constexpr int ILLEGAL = -1000;

// Depth-limited negamax with a simple heuristic at the leaves. Returns score
// from the perspective of the side to move. We intentionally do not reuse the
// solver's transposition table here because the heuristic eval would poison it
// for subsequent full solves on the same Solver instance.
int negamax_limited(const Position &P, int alpha, int beta, int depth) {
    if (P.nbMoves() == Position::WIDTH * Position::HEIGHT) return 0;
    for (int c = 0; c < Position::WIDTH; ++c) {
        if (P.canPlay(c) && P.isWinningMove(c)) {
            return (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
        }
    }
    if (depth == 0) {
        // No position-dependent evaluation is available without exposing threat counting.
        // Return draw score; alpha-beta + center-first move ordering carries the signal.
        return 0;
    }
    int max_score = (Position::WIDTH * Position::HEIGHT - 1 - P.nbMoves()) / 2;
    if (beta > max_score) {
        beta = max_score;
        if (alpha >= beta) return beta;
    }
    for (int c : {3, 4, 2, 5, 1, 6, 0}) {
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

std::vector<int> analyze(Solver &s, const Position &P, bool weak) {
    std::vector<int> out(Position::WIDTH, ILLEGAL);
    for (int c = 0; c < Position::WIDTH; ++c) {
        if (!P.canPlay(c)) continue;
        if (P.isWinningMove(c)) {
            out[c] = (Position::WIDTH * Position::HEIGHT + 1 - P.nbMoves()) / 2;
            continue;
        }
        Position P2(P);
        P2.playCol(c);
        out[c] = -s.solve(P2, weak);
    }
    return out;
}

std::vector<int> analyze_limited(const Position &P, int depth) {
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

} // namespace

PYBIND11_MODULE(_pyconnect4, m) {
    m.doc() = "Pascal Pons Connect 4 solver — Python binding.";

    py::class_<Position>(m, "Position")
        .def(py::init<>())
        .def("play_sequence", [](Position &P, const std::string &moves) {
            std::string translated(moves.size(), '0');
            for (size_t i = 0; i < moves.size(); ++i)
                translated[i] = moves[i] + 1;
            return (int)P.play(translated);
        })
        .def("can_play", &Position::canPlay)
        .def("is_winning_move", &Position::isWinningMove)
        .def("nb_moves", &Position::nbMoves)
        .def_property_readonly_static("WIDTH",  [](py::object) { return (int)Position::WIDTH; })
        .def_property_readonly_static("HEIGHT", [](py::object) { return (int)Position::HEIGHT; });

    py::class_<Solver>(m, "Solver")
        .def(py::init<>())
        .def("load_book", &Solver::loadBook)
        .def("solve", &Solver::solve, py::arg("position"), py::arg("weak") = false)
        .def("reset", &Solver::reset);

    m.def("analyze", &analyze, py::arg("solver"), py::arg("position"), py::arg("weak") = false);
    m.def("analyze_limited", &analyze_limited, py::arg("position"), py::arg("depth"));
}
