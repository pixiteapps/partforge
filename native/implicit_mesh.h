// The implicit engine's meshing stages on a session — the C++ twin of
// src/framework/geometry/implicit/sparse.js (evaluateLeaves, the evaluation
// half), mesher.js (meshStore), project.js (projectVertices) and cleanup.js
// (cleanupMesh). Bit-identical to the JS (native/README.md):
// the same coordinate arithmetic, sample/leaf/cell/tet order, float32 stores
// and vertex creation order. The stages read and write the Session
// (implicit_eval.h).
#pragma once
#include <cstdint>
#include <vector>

#include "implicit_eval.h"

namespace ipm_mesh {

constexpr int LEAF = 4;                         // sparse.js's LEAF
constexpr int S = LEAF + 1, S3 = S * S * S;     // samples per leaf side / per leaf

// evaluateLeaves: samples `count` leaves (i0, j0, l0, program index each) into the
// session's leaf store. With ownerK > 0 (an owner plan: the root is an exact contact
// of ownerK children) each sample's owner is captured too (s.owners). Returns 0, or
// nonzero (nothing kept) for a program index the session lacks, a program it refuses
// to run, or an ownerK outside 0..MAX_OWNER_K or below a child index a program names.
int sample(ipe::Session& s, const int32_t* leaves, int count, const double* origin, double edge, const int32_t* n, int ownerK);

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
// spreadCos2: fan-spread guard; <= 0: that guard off; the first pass skipped when
// its probe allows fewer than minAccept of the edges it tries, the passes ended
// once one removes fewer than minGain of the triangles), then projection and relaxation
// passes. Replaces the mesh with the cleaned one and fills s.normals. Returns 0,
// or nonzero when there is no mesh.
int cleanup(ipe::Session& s, double collapseFrac, int relaxPasses, double relaxWeight, double maxMoveCells,
            double decimateFrac, int decimatePasses, double guardCos2, double normalCos2, double spreadCos2,
            double minAccept, double minGain);

// ---------------------------------------------------------------------------
// The owner path (a root exact contact): implicit_owner.cpp, plus the owner modes of
// cleanup (above, on an owner mesh) and project_owned.

// Points to evaluate, each with one session program (a mesh point is evaluated with its
// vertex's leaf program). The interpreter is lane-local, so the order the points are
// evaluated in decides nothing: eval_points buckets them by program.
struct Points {
  std::vector<double> X, Y, Z;
  std::vector<int32_t> prog;
  void clear() { X.clear(); Y.clear(); Z.clear(); prog.clear(); }
  size_t size() const { return X.size(); }
  void add(double x, double y, double z, int32_t p) { X.push_back(x); Y.push_back(y); Z.push_back(z); prog.push_back(p); }
};

// evalBatchContact over `pts`: the field into `out`, and wherever not null each point's piece
// (one per point) and cuts / shares (s.ownerK per point; +Infinity for a pruned child). Returns
// 0, or nonzero for a program the session cannot run or a capture without an owner plan.
int eval_points(ipe::Session& s, const Points& pts, double* out, int32_t* piece, double* cuts, double* shares);

// Drops the session mesh's owner fields (a plain mesh carries none).
void clear_owner_mesh(ipe::Session& s);

// The program of leaf L of the store.
inline int32_t leaf_prog(const ipe::Session& s, int32_t L) { return s.leaves[4 * (size_t)L + 3]; }

// project.js's projectVertices on an owner mesh (`owner` and `held` given): see project.js.
// As project(), plus nonzero when the mesh is not an owner mesh. `unsettled` (per vertex, may be
// null) gets, for each vertex projected, 1 when it was selected for a share step or its step
// moved it more than HELD_FIELD_TOL * edge (project.js's `unsettled`), else 0.
int project_owned(ipe::Session& s, const int32_t* which, int whichCount, double maxStep, bool wantNormals, uint8_t* unsettled = nullptr);

// mesher-owners.js's meshStoreOwners over the session's (owner) store, with the contact set:
// fills the mesh and its owner fields. Returns 0, or nonzero when nothing (or no owner plan) is
// sampled, no contact is set, or a vertex's owner is not a child index below ownerK (the JS
// indexes shares by it, so the core leaves such a mesh to the JS).
int mesh_owners(ipe::Session& s);

// crease.js's cutCreases on the session's owner mesh (cleaned, with normals). 0, or nonzero.
int crease(ipe::Session& s);

// crease.js's untangle on the session's cut owner mesh. 0, or nonzero.
int untangle(ipe::Session& s);

// result.js's triangleOwners of the session's owner mesh into s.triOwner. 0, or nonzero.
int tri_owners(ipe::Session& s);

}  // namespace ipm_mesh
