// The implicit engine's meshing stages on a session — the C++ twin of
// src/framework/geometry/implicit/sparse.js (evaluateLeaves, the evaluation
// half), mesher.js (meshStore), project.js (projectVertices) and cleanup.js
// (cleanupMesh). Bit-identical to the JS (native/README.md):
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

// projectVertices over the session mesh: `which` (null: every vertex) moved onto
// d = 0 by one clamped Newton step each; with `wantNormals`, each vertex with a
// gradient gets its unit normal in s.normals (sized to 3 x vertices, zeroed, when
// it is not already). Returns 0, or nonzero (nothing moved) when there is no mesh
// or `which` names a vertex out of range or twice.
int project(ipe::Session& s, const int32_t* which, int whichCount, double maxStep, bool wantNormals);

// cleanupMesh over the session mesh: short-edge collapse, then (decimateFrac > 0,
// the preview tier) up to decimatePasses guarded collapse passes at
// decimateFrac x edge (guardCos2: corner guard, normalCos2: normal-turn guard,
// spreadCos2: fan-spread guard; <= 0: that guard off), then projection and relaxation
// passes. Replaces the mesh with the cleaned one and fills s.normals. Returns 0,
// or nonzero when there is no mesh.
int cleanup(ipe::Session& s, double collapseFrac, int relaxPasses, double relaxWeight, double maxMoveCells,
            double decimateFrac, int decimatePasses, double guardCos2, double normalCos2, double spreadCos2);

}  // namespace ipm_mesh
