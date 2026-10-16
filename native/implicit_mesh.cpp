// C++ port of the implicit engine's meshing stages: sparse.js's evaluateLeaves.
// See implicit_mesh.h.
//
// What bit-exact parity needs, beyond native/README.md's rules:
//   - a sample's coordinate is origin[a] + (i0 + i) * edge with the INTEGER sum
//     first (exact in both), then one multiply and one add, as the JS writes it;
//   - samples run (l, j, i) with i fastest, so the store's layout and the order
//     zero samples are collected in (the nudge batch) are the JS's;
//   - the outer-layer rule reads the double field value, the store rounds it to
//     float32 (Math.fround = a double -> float conversion, round to nearest even);
//   - the exact-zero nudge DECIDES on the float32 value but takes the fallback
//     sign (+-1e-30) from the re-evaluated DOUBLE, as the JS does (Zout[z] < 0);
//   - the nudge offset is (1e-6 * edge) * dir, left to right.
#include "implicit_mesh.h"

#include <vector>

namespace ipm_mesh {

namespace {
constexpr double ZERO_DIR1 = 0.7071067811865476, ZERO_DIR2 = 0.5773502691896258;   // sparse.js's ZERO_DIR
}

int sample(ipe::Session& s, const int32_t* leaves, int count, const double* origin, double edge, const int32_t* n) {
  if (count < 0) return 1;
  // Refuse before touching the store: every leaf's program must be one eval would run.
  for (int L = 0; L < count; L++) {
    const int32_t pi = leaves[4 * L + 3];
    if (pi < 0 || (size_t)pi >= s.programs.size()) return 2;
    const ipe::Program& p = s.programs[(size_t)pi];
    if (!p.ok || p.maxSlot >= (int)s.textures.size()) return 3;
  }
  s.sampled = false;
  s.leaves.assign(leaves, leaves + (size_t)count * 4);
  s.vals.resize((size_t)count * S3);
  for (int a = 0; a < 3; a++) { s.origin[a] = origin[a]; s.n[a] = n[a]; }
  s.edge = edge;
  bool clipped = false;

  std::vector<double> buf((size_t)S3 * 8);
  double *X = buf.data(), *Y = X + S3, *Z = Y + S3, *out = Z + S3;
  double *ZX = out + S3, *ZY = ZX + S3, *ZZ = ZY + S3, *Zout = ZZ + S3;
  int ZI[S3];
  const double nudge0 = 1e-6 * edge, nudge1 = 1e-6 * edge * ZERO_DIR1, nudge2 = 1e-6 * edge * ZERO_DIR2;
  const int n0 = n[0], n1 = n[1], n2 = n[2];

  for (int L = 0; L < count; L++) {
    const int32_t i0 = leaves[4 * L], j0 = leaves[4 * L + 1], l0 = leaves[4 * L + 2];
    const ipe::Program& prog = s.programs[(size_t)leaves[4 * L + 3]];
    int q = 0;
    for (int l = 0; l < S; l++) for (int j = 0; j < S; j++) for (int i = 0; i < S; i++, q++) {
      X[q] = origin[0] + (double)(i0 + i) * edge; Y[q] = origin[1] + (double)(j0 + j) * edge; Z[q] = origin[2] + (double)(l0 + l) * edge;
    }
    ipe::eval(s, prog, X, Y, Z, S3, out);
    float* vals = s.vals.data() + (size_t)L * S3;
    int zeros = 0;
    q = 0;
    for (int l = 0; l < S; l++) for (int j = 0; j < S; j++) for (int i = 0; i < S; i++, q++) {
      double v = out[q];
      const int gi = i0 + i, gj = j0 + j, gl = l0 + l;
      if (gi == 0 || gj == 0 || gl == 0 || gi >= n0 - 1 || gj >= n1 - 1 || gl >= n2 - 1) {
        if (v <= 0) clipped = true;
        if (v < 0.5 * edge) v = 0.5 * edge;
      }
      const float f = (float)v;   // the value as stored
      vals[q] = f;
      if (f == 0) ZI[zeros++] = q;
    }
    if (zeros > 0) {
      for (int z = 0; z < zeros; z++) { const int k = ZI[z]; ZX[z] = X[k] + nudge0; ZY[z] = Y[k] + nudge1; ZZ[z] = Z[k] + nudge2; }
      ipe::eval(s, prog, ZX, ZY, ZZ, zeros, Zout);
      for (int z = 0; z < zeros; z++) {
        const float f = (float)Zout[z];
        vals[ZI[z]] = f == 0 ? (Zout[z] < 0 ? -1e-30f : 1e-30f) : f;
      }
    }
  }
  s.clipped = clipped;
  s.sampled = true;
  return 0;
}

}  // namespace ipm_mesh

extern "C" {

// evaluateLeaves over `count` leaves (i0, j0, l0, program index each; programs
// already added in plan order): 0 ok; nonzero for an unknown session, a program
// index it lacks or a program it refuses (the store is left as it was).
int ip_sample(int id, const int32_t* leaves, int count, const double* origin3, double edge, const int32_t* n3) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 4;
  return ipm_mesh::sample(*s, leaves, count, origin3, edge, n3);
}

// The leaf store: (LEAF+1)^3 float32 samples per leaf, in plan order.
const float* ip_leaf_vals(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->sampled ? s->vals.data() : nullptr;
}

int ip_clipped(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->sampled && s->clipped ? 1 : 0;
}

}
