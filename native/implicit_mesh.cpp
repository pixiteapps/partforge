// C++ port of the implicit engine's meshing stages: sparse.js's evaluateLeaves
// and mesher.js's meshStore. See implicit_mesh.h.
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
// And for meshStore:
//   - leaves in store order, cells (l, j, i) with i fastest, the KUHN tets in
//     their order, so vertices are created (and numbered) in the JS's order;
//   - the weld key is gIndex(low corner) * 8 + direction bits in 64-bit integers
//     (the JS computes it in doubles, exact below 2^53, so the integers are the
//     same; it passes 2^32 on large grids). The map is flat_map.h's — it is only
//     found and inserted, never iterated, so its order decides nothing;
//   - a crossing is interpolated low -> high, t = a / (a - b) on the float32
//     samples promoted to double, positions as posOf computes them;
//   - a triangle's three vertexOn calls run left to right (locals, since C++
//     leaves argument evaluation order unspecified), and its orientation is the
//     JS's topological test with the same sums, divisions and cross product.
#include "implicit_mesh.h"

#include <vector>

#include "flat_map.h"

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
  s.meshed = false;   // a new store invalidates the mesh built from the last one
  std::vector<double>().swap(s.positions);
  std::vector<uint32_t>().swap(s.indices);
  std::vector<int32_t>().swap(s.vertLeaf);
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

namespace {
constexpr int KUHN[6][4] = {{0, 1, 3, 7}, {0, 1, 5, 7}, {0, 2, 3, 7}, {0, 2, 6, 7}, {0, 4, 5, 7}, {0, 4, 6, 7}};
}

int mesh(ipe::Session& s) {
  if (!s.sampled) return 1;
  s.meshed = false;
  std::vector<double>& positions = s.positions;
  std::vector<uint32_t>& indices = s.indices;
  std::vector<int32_t>& vertLeaf = s.vertLeaf;
  positions.clear(); indices.clear(); vertLeaf.clear();
  const int count = (int)(s.leaves.size() / 4);
  const double edge = s.edge, o0 = s.origin[0], o1 = s.origin[1], o2 = s.origin[2];
  const int64_t n0 = s.n[0], n1 = s.n[1], n2 = s.n[2];
  flat::Map<uint32_t> edgeVerts((size_t)count * 32);
  double CP[24], g[3], M[9];
  int negC[4], posC[4];

  for (int L = 0; L < count; L++) {
    const int32_t i0 = s.leaves[4 * (size_t)L], j0 = s.leaves[4 * (size_t)L + 1], l0 = s.leaves[4 * (size_t)L + 2];
    const float* vals = s.vals.data() + (size_t)L * S3;
    auto at = [vals](int i, int j, int l) -> double { return vals[(l * S + j) * S + i]; };
    auto vertexOn = [&](int i, int j, int l, int ca, int cb) -> uint32_t {
      const int lo = ca & cb, dir = ca ^ cb;
      const int hi = lo | dir;
      const int li = i + (lo & 1), lj = j + ((lo >> 1) & 1), ll = l + ((lo >> 2) & 1);
      const int hi_i = i + (hi & 1), hi_j = j + ((hi >> 1) & 1), hi_l = l + ((hi >> 2) & 1);
      const double a = at(li, lj, ll), b = at(hi_i, hi_j, hi_l);
      const uint64_t key = (uint64_t)((((int64_t)l0 + ll) * n1 + ((int64_t)j0 + lj)) * n0 + ((int64_t)i0 + li)) * 8 + (uint64_t)dir;
      if (const uint32_t* v = edgeVerts.find(key)) return *v;
      const double t = a / (a - b);
      const double pa0 = o0 + (double)(i0 + li) * edge, pa1 = o1 + (double)(j0 + lj) * edge, pa2 = o2 + (double)(l0 + ll) * edge;
      const double pb0 = o0 + (double)(i0 + hi_i) * edge, pb1 = o1 + (double)(j0 + hi_j) * edge, pb2 = o2 + (double)(l0 + hi_l) * edge;
      const uint32_t v = (uint32_t)(positions.size() / 3);
      positions.push_back(pa0 + (pb0 - pa0) * t);
      positions.push_back(pa1 + (pb1 - pa1) * t);
      positions.push_back(pa2 + (pb2 - pa2) * t);
      vertLeaf.push_back(L);
      edgeVerts.insert(key, v);
      return v;
    };
    auto setMid = [&](int k, int ca, int cb) {
      M[3 * k] = (CP[3 * ca] + CP[3 * cb]) / 2; M[3 * k + 1] = (CP[3 * ca + 1] + CP[3 * cb + 1]) / 2; M[3 * k + 2] = (CP[3 * ca + 2] + CP[3 * cb + 2]) / 2;
    };
    auto tri = [&](uint32_t a, uint32_t b, uint32_t c) {
      const double ux = M[3] - M[0], uy = M[4] - M[1], uz = M[5] - M[2];
      const double vx = M[6] - M[0], vy = M[7] - M[1], vz = M[8] - M[2];
      const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * g[0] + ny * g[1] + nz * g[2] < 0) { indices.push_back(a); indices.push_back(c); indices.push_back(b); }
      else { indices.push_back(a); indices.push_back(b); indices.push_back(c); }
    };
    const int64_t iLim = n0 - 1 - i0, jLim = n1 - 1 - j0, lLim = n2 - 1 - l0;
    const int iEnd = (int)(LEAF < iLim ? LEAF : iLim), jEnd = (int)(LEAF < jLim ? LEAF : jLim), lEnd = (int)(LEAF < lLim ? LEAF : lLim);
    for (int l = 0; l < lEnd; l++) for (int j = 0; j < jEnd; j++) for (int i = 0; i < iEnd; i++) {
      int neg = 0;
      for (int c = 0; c < 8; c++) if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) neg++;
      if (neg == 0 || neg == 8) continue;
      for (int c = 0; c < 8; c++) {   // corner positions, as posOf computes them
        CP[3 * c] = o0 + (double)(i0 + (i + (c & 1))) * edge;
        CP[3 * c + 1] = o1 + (double)(j0 + (j + ((c >> 1) & 1))) * edge;
        CP[3 * c + 2] = o2 + (double)(l0 + (l + ((c >> 2) & 1))) * edge;
      }
      for (const auto& tet : KUHN) {
        int nn = 0, np = 0;
        for (int q = 0; q < 4; q++) {
          const int c = tet[q];
          if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) negC[nn++] = c; else posC[np++] = c;
        }
        if (nn == 0 || nn == 4) continue;
        for (int a = 0; a < 3; a++) {
          double sn = 0, sp = 0;
          for (int q = 0; q < nn; q++) sn += CP[3 * negC[q] + a];
          for (int q = 0; q < np; q++) sp += CP[3 * posC[q] + a];
          g[a] = sp / np - sn / nn;   // inside -> outside
        }
        if (nn == 1 || nn == 3) {
          const int lone = nn == 1 ? negC[0] : posC[0];
          const int* others = nn == 1 ? posC : negC;
          setMid(0, lone, others[0]); setMid(1, lone, others[1]); setMid(2, lone, others[2]);
          const uint32_t va = vertexOn(i, j, l, lone, others[0]);
          const uint32_t vb = vertexOn(i, j, l, lone, others[1]);
          const uint32_t vc = vertexOn(i, j, l, lone, others[2]);
          tri(va, vb, vc);
        } else {
          const int c0 = negC[0], c1 = negC[1], q0 = posC[0], q1 = posC[1];
          const uint32_t v00 = vertexOn(i, j, l, c0, q0);
          const uint32_t v01 = vertexOn(i, j, l, c0, q1);
          const uint32_t v10 = vertexOn(i, j, l, c1, q0);
          const uint32_t v11 = vertexOn(i, j, l, c1, q1);
          setMid(0, c0, q0); setMid(1, c0, q1); setMid(2, c1, q1);
          tri(v00, v01, v11);
          setMid(0, c0, q0); setMid(1, c1, q1); setMid(2, c1, q0);
          tri(v00, v11, v10);
        }
      }
    }
  }
  s.meshed = true;
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

// meshStore over the session's leaf store: 0 ok; nonzero for an unknown session
// or one with nothing sampled.
int ip_mesh(int id) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 2;
  return ipm_mesh::mesh(*s);
}

int ip_vertex_count(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed ? (int)(s->positions.size() / 3) : 0;
}

const double* ip_positions(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed ? s->positions.data() : nullptr;
}

int ip_index_count(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed ? (int)s->indices.size() : 0;
}

const uint32_t* ip_indices(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed ? s->indices.data() : nullptr;
}

const int32_t* ip_vert_leaf(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed ? s->vertLeaf.data() : nullptr;
}

}
