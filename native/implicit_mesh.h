// The implicit engine's meshing stages on a session — the C++ twin of
// src/framework/geometry/implicit/sparse.js (evaluateLeaves, the evaluation
// half) and mesher.js (meshStore). Bit-identical to the JS (native/README.md):
// the same coordinate arithmetic, sample/leaf/cell/tet order, float32 stores
// and vertex creation order. The stages read and write the Session
// (implicit_eval.h).
#pragma once
#include <cstdint>

#include "implicit_eval.h"

namespace ipm_mesh {

constexpr int LEAF = 4;                         // sparse.js's LEAF
constexpr int S = LEAF + 1, S3 = S * S * S;     // samples per leaf side / per leaf

// evaluateLeaves: samples `count` leaves (i0, j0, l0, program index each) into the
// session's leaf store. Returns 0, or nonzero (nothing kept) for a program index
// the session lacks or a program it refuses to run.
int sample(ipe::Session& s, const int32_t* leaves, int count, const double* origin, double edge, const int32_t* n);

// meshStore over the session's leaf store: fills positions, indices, vertLeaf.
// Returns 0, or nonzero when nothing has been sampled.
int mesh(ipe::Session& s);

}  // namespace ipm_mesh
