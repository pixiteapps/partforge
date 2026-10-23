// C++ port of the implicit engine's meshing stages: sparse.js's evaluateLeaves
// and mesher.js's meshStore. See implicit_mesh.h.
//
// What bit-exact parity needs, beyond native/README.md's rules:
//   - a sample's coordinate is origin[a] + (i0 + i) * edge with the INTEGER sum
//     first (exact in both), then one multiply and one add, as the JS writes it;
//   - samples run (l, j, i) with i fastest, so the store's layout and the order
//     zero samples are collected in (the nudge batch) are the JS's;
//   - consecutive leaves sharing a program ride one interpreter call (the
//     interpreter is lane-local, so batching changes no value); the nudge batch
//     stays per leaf;
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
//     same; it passes 2^32 on large grids). Only edges in a leaf block's face
//     planes go through it (flat_map.h's); an edge inside a block is welded in a
//     per-leaf local table. Both are only found and inserted, never iterated, and
//     a vertex is numbered when it is created, so neither decides an order;
//   - each cell's inside mask is computed once from the same `< 0` comparisons
//     and each tet's corner split read from it, in the same corner order;
//   - a crossing is interpolated low -> high, t = a / (a - b) on the float32
//     samples promoted to double, positions as posOf computes them;
//   - a triangle's three vertexOn calls run left to right (locals, since C++
//     leaves argument evaluation order unspecified), and its orientation is the
//     JS's topological test with the same sums, divisions and cross product.
#include "implicit_mesh.h"

#include <cmath>
#include <vector>

#include "flat_map.h"
#include "js_math.h"

namespace ipm_mesh {

// A plain mesh (or none) carries no owner fields.
void clear_owner_mesh(ipe::Session& s) {
  s.ownerMesh = false;
  s.hasCrease = false;
  std::vector<int32_t>().swap(s.vertOwner);
  std::vector<uint8_t>().swap(s.ownerHeld);
  std::vector<uint8_t>().swap(s.pinned);
  std::vector<uint8_t>().swap(s.creaseMark);
  std::vector<int32_t>().swap(s.triOwner);
}

namespace {
constexpr double ZERO_DIR1 = 0.7071067811865476, ZERO_DIR2 = 0.5773502691896258;   // sparse.js's ZERO_DIR
constexpr int RUN = 32;   // leaves per interpreter call (4000 lanes) when consecutive leaves share a program
}

// Precondition: every leaf satisfies 0 <= i0,j0,l0 < n-1 (enforced by implicit-core.js;
// the weld keys rely on it).
int sample(ipe::Session& s, const int32_t* leaves, int count, const double* origin, double edge, const int32_t* n, int ownerK) {
  if (count < 0) return 1;
  if (ownerK < 0 || ownerK > ipe::MAX_OWNER_K) return 5;
  // Refuse before touching the store: every leaf's program must be one eval would run.
  for (int L = 0; L < count; L++) {
    const int32_t pi = leaves[4 * L + 3];
    if (pi < 0 || (size_t)pi >= s.programs.size()) return 2;
    const ipe::Program& p = s.programs[(size_t)pi];
    if (!p.ok || p.maxSlot >= (int)s.textures.size()) return 3;
    if (ownerK > 0 && p.maxKid >= ownerK) return 5;   // a child the owner store cannot name
  }
  s.sampled = false;
  s.meshed = false;   // a new store invalidates the mesh built from the last one
  std::vector<double>().swap(s.positions);
  std::vector<uint32_t>().swap(s.indices);
  std::vector<int32_t>().swap(s.vertLeaf);
  std::vector<double>().swap(s.normals);
  clear_owner_mesh(s);
  s.leaves.assign(leaves, leaves + (size_t)count * 4);
  const size_t need = (size_t)count * S3;
  if (need > s.valsCap) {
    s.vals.reset();
    s.valsCap = 0;
    s.vals.reset(new float[need]);
    s.valsCap = need;
  }
  for (int a = 0; a < 3; a++) { s.origin[a] = origin[a]; s.n[a] = n[a]; }
  s.edge = edge;
  const bool owned = ownerK > 0;
  s.ownerK = ownerK;
  if (owned) s.owners.resize(need); else std::vector<int8_t>().swap(s.owners);
  bool clipped = false;

  // Consecutive leaves running the same program are evaluated in one interpreter
  // call (up to RUN leaves): the interpreter is lane-local, so a lane's value does
  // not depend on which batch it rides in. The outer-layer and zero passes then
  // run per leaf, in leaf order, exactly as before.
  std::vector<double> buf((size_t)S3 * (4 * RUN + 4));
  double *X = buf.data(), *Y = X + RUN * S3, *Z = Y + RUN * S3, *out = Z + RUN * S3;
  double *ZX = out + RUN * S3, *ZY = ZX + S3, *ZZ = ZY + S3, *Zout = ZZ + S3;
  int ZI[S3];
  // An owner plan captures each lane's piece (evalBatchContact's `piece`) alongside its
  // value: RUN leaves' worth, then the nudge batch's own.
  if (owned && s.cap32.size() < (size_t)S3 * (RUN + 1)) s.cap32.resize((size_t)S3 * (RUN + 1));
  int32_t* piece = owned ? s.cap32.data() : nullptr;
  int32_t* Zpiece = owned ? piece + RUN * S3 : nullptr;
  ipe::Capture cap, zcap;
  cap.K = zcap.K = ownerK;
  cap.piece = piece;
  zcap.piece = Zpiece;
  const double nudge0 = 1e-6 * edge, nudge1 = 1e-6 * edge * ZERO_DIR1, nudge2 = 1e-6 * edge * ZERO_DIR2;
  const int n0 = n[0], n1 = n[1], n2 = n[2];

  for (int L0 = 0; L0 < count;) {
    const int32_t pi = leaves[4 * L0 + 3];
    int R = 1;
    while (R < RUN && L0 + R < count && leaves[4 * (L0 + R) + 3] == pi) R++;
    const ipe::Program& prog = s.programs[(size_t)pi];
    for (int r = 0; r < R; r++) {
      const int L = L0 + r;
      const int32_t i0 = leaves[4 * L], j0 = leaves[4 * L + 1], l0 = leaves[4 * L + 2];
      double *x = X + r * S3, *y = Y + r * S3, *zc = Z + r * S3;
      int q = 0;
      for (int l = 0; l < S; l++) for (int j = 0; j < S; j++) for (int i = 0; i < S; i++, q++) {
        x[q] = origin[0] + (double)(i0 + i) * edge; y[q] = origin[1] + (double)(j0 + j) * edge; zc[q] = origin[2] + (double)(l0 + l) * edge;
      }
    }
    if (owned) ipe::eval_contact(s, prog, X, Y, Z, R * S3, out, cap); else ipe::eval(s, prog, X, Y, Z, R * S3, out);
    for (int r = 0; r < R; r++) {
      const int L = L0 + r;
      const int32_t i0 = leaves[4 * L], j0 = leaves[4 * L + 1], l0 = leaves[4 * L + 2];
      const double *x = X + r * S3, *y = Y + r * S3, *zc = Z + r * S3, *o = out + r * S3;
      float* vals = s.vals.get() + (size_t)L * S3;
      int zeros = 0;
      int q = 0;
      for (int l = 0; l < S; l++) for (int j = 0; j < S; j++) for (int i = 0; i < S; i++, q++) {
        double v = o[q];
        const int gi = i0 + i, gj = j0 + j, gl = l0 + l;
        if (gi == 0 || gj == 0 || gl == 0 || gi >= n0 - 1 || gj >= n1 - 1 || gl >= n2 - 1) {
          if (v <= 0) clipped = true;
          if (v < 0.5 * edge) v = 0.5 * edge;
        }
        const float f = (float)v;   // the value as stored
        vals[q] = f;
        if (f == 0) ZI[zeros++] = q;
      }
      if (zeros > 0) {   // per leaf, in sample order, as the JS batches it
        for (int z = 0; z < zeros; z++) { const int k = ZI[z]; ZX[z] = x[k] + nudge0; ZY[z] = y[k] + nudge1; ZZ[z] = zc[k] + nudge2; }
        if (owned) ipe::eval_contact(s, prog, ZX, ZY, ZZ, zeros, Zout, zcap); else ipe::eval(s, prog, ZX, ZY, ZZ, zeros, Zout);
        for (int z = 0; z < zeros; z++) {
          const float f = (float)Zout[z];
          vals[ZI[z]] = f == 0 ? (Zout[z] < 0 ? -1e-30f : 1e-30f) : f;
          if (owned) piece[r * S3 + ZI[z]] = Zpiece[z];
        }
      }
      if (owned) {   // AIR where the stored value is >= 0, as evaluateLeaves marks it
        int8_t* own = s.owners.data() + (size_t)L * S3;
        const int32_t* pc = piece + r * S3;
        for (int k = 0; k < S3; k++) own[k] = vals[k] >= 0 ? (int8_t)-1 : (int8_t)pc[k];
      }
    }
    L0 += R;
  }
  s.clipped = clipped;
  s.sampled = true;
  return 0;
}

namespace {
constexpr int KUHN[6][4] = {{0, 1, 3, 7}, {0, 1, 5, 7}, {0, 2, 3, 7}, {0, 2, 6, 7}, {0, 4, 5, 7}, {0, 4, 6, 7}};
constexpr int CELLS = LEAF * LEAF * LEAF;          // cells per leaf
constexpr int LOCAL_EDGES = S3 * 8;               // local weld slots: low corner x direction bits

// Triangles a cell emits for each 8-bit inside mask (bit c: corner c < 0): one per
// tet with 1 or 3 corners inside, two per tet with 2. Only a COUNT, for reserving.
struct TriCount {
  uint8_t t[256];
  TriCount() {
    for (int m = 0; m < 256; m++) {
      int k = 0;
      for (const auto& tet : KUHN) {
        int nn = 0;
        for (int q = 0; q < 4; q++) nn += (m >> tet[q]) & 1;
        k += nn == 2 ? 2 : (nn == 1 || nn == 3) ? 1 : 0;
      }
      t[m] = (uint8_t)k;
    }
  }
};
}

int mesh(ipe::Session& s) {
  if (!s.sampled) return 1;
  static const TriCount TRIS;
  s.meshed = false;
  std::vector<double>& positions = s.positions;
  std::vector<uint32_t>& indices = s.indices;
  std::vector<int32_t>& vertLeaf = s.vertLeaf;
  positions.clear(); indices.clear(); vertLeaf.clear(); s.normals.clear();
  clear_owner_mesh(s);
  const int count = (int)(s.leaves.size() / 4);
  const double edge = s.edge, o0 = s.origin[0], o1 = s.origin[1], o2 = s.origin[2];
  const int64_t n0 = s.n[0], n1 = s.n[1], n2 = s.n[2];

  // Pass 1: each cell's inside mask (the same `at(...) < 0` comparisons the cell
  // loop made), and the exact triangle count for reserving the outputs.
  std::vector<uint8_t> masks((size_t)count * CELLS);
  size_t tris = 0;
  for (int L = 0; L < count; L++) {
    const int32_t i0 = s.leaves[4 * (size_t)L], j0 = s.leaves[4 * (size_t)L + 1], l0 = s.leaves[4 * (size_t)L + 2];
    const float* vals = s.vals.get() + (size_t)L * S3;
    uint8_t* mk = masks.data() + (size_t)L * CELLS;
    const int64_t iLim = n0 - 1 - i0, jLim = n1 - 1 - j0, lLim = n2 - 1 - l0;
    const int iEnd = (int)(LEAF < iLim ? LEAF : iLim), jEnd = (int)(LEAF < jLim ? LEAF : jLim), lEnd = (int)(LEAF < lLim ? LEAF : lLim);
    for (int l = 0; l < lEnd; l++) for (int j = 0; j < jEnd; j++) for (int i = 0; i < iEnd; i++) {
      int m = 0;
      for (int c = 0; c < 8; c++) if ((double)vals[((l + ((c >> 2) & 1)) * S + j + ((c >> 1) & 1)) * S + i + (c & 1)] < 0) m |= 1 << c;
      mk[(l * LEAF + j) * LEAF + i] = (uint8_t)m;
      tris += TRIS.t[m];
    }
  }
  // A closed surface has V = T/2 + 2 per component (less 2 per handle): reserve that with room to spare.
  const size_t vertsGuess = tris / 2 + tris / 32 + 64;
  indices.reserve(tris * 3);
  positions.reserve(vertsGuess * 3);
  vertLeaf.reserve(vertsGuess);

  // Welding: an edge interior to a leaf's block is seen by that leaf's cells only,
  // so it is welded in a per-leaf table (stamped with the leaf, never cleared);
  // only an edge lying in one of the block's face planes can be shared with
  // another leaf and goes through the global map. Which table finds a vertex does
  // not change when it is created, so the numbering is still creation order.
  flat::Map<uint32_t> edgeVerts(vertsGuess / 2 + 16);
  std::vector<uint32_t> localV(LOCAL_EDGES), localStamp(LOCAL_EDGES, 0);
  double CP[24], g[3], M[9];
  int negC[4], posC[4];

  for (int L = 0; L < count; L++) {
    const int32_t i0 = s.leaves[4 * (size_t)L], j0 = s.leaves[4 * (size_t)L + 1], l0 = s.leaves[4 * (size_t)L + 2];
    const float* vals = s.vals.get() + (size_t)L * S3;
    const uint8_t* mk = masks.data() + (size_t)L * CELLS;
    const uint32_t stamp = (uint32_t)L + 1;
    auto at = [vals](int i, int j, int l) -> double { return vals[(l * S + j) * S + i]; };
    auto vertexOn = [&](int i, int j, int l, int ca, int cb) -> uint32_t {
      const int lo = ca & cb, dir = ca ^ cb;
      const int hi = lo | dir;
      const int li = i + (lo & 1), lj = j + ((lo >> 1) & 1), ll = l + ((lo >> 2) & 1);
      const int hi_i = i + (hi & 1), hi_j = j + ((hi >> 1) & 1), hi_l = l + ((hi >> 2) & 1);
      const bool face = (!(dir & 1) && (li == 0 || li == LEAF)) || (!(dir & 2) && (lj == 0 || lj == LEAF)) || (!(dir & 4) && (ll == 0 || ll == LEAF));
      const int lk = ((ll * S + lj) * S + li) * 8 + dir;
      uint64_t key = 0;
      if (face) {
        key = (uint64_t)((((int64_t)l0 + ll) * n1 + ((int64_t)j0 + lj)) * n0 + ((int64_t)i0 + li)) * 8 + (uint64_t)dir;
        if (const uint32_t* v = edgeVerts.find(key)) return *v;
      } else if (localStamp[lk] == stamp) {
        return localV[lk];
      }
      const double a = at(li, lj, ll), b = at(hi_i, hi_j, hi_l);
      const double t = a / (a - b);
      const double pa0 = o0 + (double)(i0 + li) * edge, pa1 = o1 + (double)(j0 + lj) * edge, pa2 = o2 + (double)(l0 + ll) * edge;
      const double pb0 = o0 + (double)(i0 + hi_i) * edge, pb1 = o1 + (double)(j0 + hi_j) * edge, pb2 = o2 + (double)(l0 + hi_l) * edge;
      const uint32_t v = (uint32_t)(positions.size() / 3);
      positions.push_back(pa0 + (pb0 - pa0) * t);
      positions.push_back(pa1 + (pb1 - pa1) * t);
      positions.push_back(pa2 + (pb2 - pa2) * t);
      vertLeaf.push_back(L);
      if (face) edgeVerts.insert(key, v);
      else { localStamp[lk] = stamp; localV[lk] = v; }
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
      const int mask = mk[(l * LEAF + j) * LEAF + i];
      if (mask == 0 || mask == 255) continue;
      for (int c = 0; c < 8; c++) {   // corner positions, as posOf computes them
        CP[3 * c] = o0 + (double)(i0 + (i + (c & 1))) * edge;
        CP[3 * c + 1] = o1 + (double)(j0 + (j + ((c >> 1) & 1))) * edge;
        CP[3 * c + 2] = o2 + (double)(l0 + (l + ((c >> 2) & 1))) * edge;
      }
      for (const auto& tet : KUHN) {
        int nn = 0, np = 0;
        for (int q = 0; q < 4; q++) {
          const int c = tet[q];
          if ((mask >> c) & 1) negC[nn++] = c; else posC[np++] = c;
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


// ---------------------------------------------------------------------------
// project.js (projectVertices) and cleanup.js (cleanupMesh).
//
// What bit-exact parity needs here:
//   - projection: the 7-point stencil in the JS's order (centre, +x, -x, +y, -y,
//     +z, -z), e = 0.1 * edge, the central differences divided by (2 * e), the
//     `!(g2 > 1e-12)` early return (NaN included), the normal as g / |g|, and the
//     step d / |g| clamped to +-maxStep, subtracted as (g / |g|) * t.
//     The JS batches vertices per leaf in first-appearance order; here they are
//     batched per PROGRAM (counting sort, vertex order within a program). That
//     decides no value: a vertex's move reads only its own position and its own
//     leaf's program, writes only its own position and normal, and the
//     interpreter is lane-local, so neither the batch a vertex rides in nor the
//     order the batches run in can change a bit. (A vertex named twice by
//     `which` is a different matter: in the JS both copies always land in the
//     same leaf group, both stencils read the OLD position, and the move is
//     applied twice. Here the program-batched 512-vertex chunks could split such
//     a pair across calls, so the second copy would read the first's result;
//     `which` is therefore refused if it names a vertex twice.)
//   - collapse: triangles in order, corners c = 0, 1, 2 and the edge (c, c+1);
//     the `locked` test, the squared length `>= min2`, the common-neighbour count
//     of the two rings (sets, so the count is order-free), the no-flip test with
//     the midpoint substituted for a and b (the same values the JS's write/
//     restore of P produces, read in the same arithmetic), the kill/rename walk
//     over b's incident triangles in incidence order, break after a collapse, and
//     first-use compaction. The incident lists are CSR (filled in triangle order,
//     corner order, as the JS pushes them). The JS also appends b's renamed
//     triangles to vt[a]; that list is never read again — a and b are locked by
//     the same collapse, and only an unlocked vertex's list is read (ring and the
//     flip test of an edge whose ends are both unlocked) — so the CSR omits the
//     append. test/core-structures.test.js holds the lists to the JS.
//   - decimation (the preview tier): further whole passes of the same collapse,
//     each over the previous pass's compacted mesh (so each rebuilds its incident
//     lists and clears `locked`, as the JS's fresh call does), stopping after a
//     pass that collapses nothing. The angle guard reads each corner's sharpness
//     as the JS writes it — dot > 0 ? (dot * dot) / (|u|^2 * |v|^2) : 0, each sum
//     left to right — takes the triangle's max as jsmax(jsmax(s_i, s_j), s_k) and
//     the running max with jsmax, all on the substituted midpoint (`after`) like
//     the flip test; only when that passes cos2 does it read the current corners
//     around a then b (dead triangles skipped, the edge's own two included). cos2
//     comes from JS (guardCos2), never a libm cos here. A decimation pass also
//     refuses an edge whose endpoints' rings both have 3 distinct members (counted
//     while the rings are marked; the JS's Set sizes), refuses a surviving
//     triangle whose normal turns past ncos2 (turn = n0 . n1 > 0 and
//     turn * turn < ncos2 * (|n0|^2 * |n1|^2), sums left to right), and runs the
//     spread guard on the new normals in the flip test's order: their sum N
//     accumulated in that order, then each n refused when n . N <= 0 or
//     (n . N)^2 < scos2 * (|n|^2 * |N|^2).
//     The tests run in a cheaper order than the JS's, which decides nothing:
//     each test only refuses, so the answer is their AND whatever the order, as
//     long as each sees the values the JS's would. One walk over the surviving
//     triangles (a's list, then b's, the JS's flip-test order) computes every
//     new normal and the running max of the new corners; then the corner guard,
//     the spread guard (its fan is every surviving triangle's, which is what the
//     JS's is whenever its flip test passed), the flip/turn test reusing the
//     walk's new normals, and the ring count and tetrahedron test last. A
//     triangle's three corners share its edge vectors (sharpFromEdges: the other
//     two corners read them negated, which is exact).
//     Two early answers, both exact. (1) Once the running max passes cos2 the
//     walk takes the current corners' max and refuses as soon as the running max
//     passes it: a max only grows, so the JS's final comparison refuses too —
//     unless a later corner came out NaN (jsmax would carry it and the JS's
//     `after > before` would then refuse nothing). So this runs only in a pass
//     whose positions all pass sharpnessCannotBeNaN (finite, 0 or in [1e-50,
//     1e75): no 0/0, no inf/inf, midpoints included); otherwise the guard runs
//     after the walk. (2) That after-walk guard stops reading the current
//     corners at the first one not below the new max: the max is then not below
//     it, or NaN, and refuses nothing either way.
//     A decimation pass caches each triangle's current normal and sharpness
//     (computed together, as the new ones are) until a collapse moves or renames
//     one of its vertices: a collapse moves only a and renames only b, and every
//     triangle holding either is on a's or b's incident list (b's renamed ones
//     included, and a, locked, is never collapsed again this pass), so clearing
//     the flags over both lists before the collapse leaves no stale entry. The
//     first (plain) collapse pass recomputes instead: there the cache cost more
//     than it saved. Every short edge is tested again each pass — skipping the
//     ones nothing near had changed since the last pass refused them was exact
//     too, but measured a wash.
//     The test itself is one lambda, `allowed`, shared by the pass and the first pass's probe (every edge of every
//     PROBE_STRIDE-th triangle, counted as doubles and compared as the JS's
//     `ok < minAccept * tried`); the early stop compares the triangles removed with
//     minGain * triangles before, in doubles, as the JS does.
//   - relax: the per-triangle edge accumulation a += P[b], b += P[a] in the JS
//     order, the zero-normal skip, and the same divisions and clamp.
namespace {

// cleanup.js's triNormal, reading coordinates through `at`.
template <class At>
inline void triNormal(At at, uint32_t a, uint32_t b, uint32_t c, double* out) {
  const double* A = at(a);
  const double* B = at(b);
  const double* C = at(c);
  const double ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
  const double vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
}

constexpr size_t PROBE_STRIDE = 32;   // cleanup.js's PROBE_STRIDE

// cleanup.js's triSharpness (its corners' max, jsmax(jsmax(s_i, s_j), s_k), where
// sharpness(a, b, c) is dot > 0 ? (dot * dot) / (|u|^2 * |v|^2) : 0 with u = b - a,
// v = c - a, each sum left to right: cos^2 of the corner angle at a when acute,
// else 0), from the triangle's three edge vectors u = B - A, v = C - A,
// w = C - B, each computed once. The corners at B and C read
// the other two edges negated — sharpness(j, k, i) has u' = w, v' = -u, and
// sharpness(k, i, j) has u'' = -v, v'' = -w — and negation is exact (P_i - P_j
// is -(P_j - P_i) to the bit), so each corner's dot is the JS's to the bit:
// w' . v' = -(w . u) (each product negated, summed in the same order), and
// (-v) . (-w) = v . w; each squared length is its edge's own; the denominators
// keep the JS's operand order (|w|^2 * |u|^2 for B, |v|^2 * |w|^2 for C).
inline double sharpFromEdges(const double* u, const double* v, const double* w) {
  const double uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
  const double vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double ww = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
  const double di = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const double si = di > 0 ? (di * di) / (uu * vv) : 0;
  const double dj = w[0] * u[0] + w[1] * u[1] + w[2] * u[2];   // the corner at B's dot is -dj
  const double sj = dj < 0 ? (dj * dj) / (ww * uu) : 0;
  const double dk = v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
  const double sk = dk > 0 ? (dk * dk) / (vv * ww) : 0;
  return jsmath::jsmax(jsmath::jsmax(si, sj), sk);
}

// triNormal and (when `sh`) triSharpness of one triangle, sharing its edge vectors.
template <class At>
inline void normalAndSharpness(At at, uint32_t i, uint32_t j, uint32_t k, double* n, double* sh) {
  const double* A = at(i);
  const double* B = at(j);
  const double* C = at(k);
  const double u[3] = {B[0] - A[0], B[1] - A[1], B[2] - A[2]};
  const double v[3] = {C[0] - A[0], C[1] - A[1], C[2] - A[2]};
  n[0] = u[1] * v[2] - u[2] * v[1]; n[1] = u[2] * v[0] - u[0] * v[2]; n[2] = u[0] * v[1] - u[1] * v[0];
  if (sh) {
    const double w[3] = {C[0] - B[0], C[1] - B[1], C[2] - B[2]};
    *sh = sharpFromEdges(u, v, w);
  }
}

// Whether no corner sharpness can come out NaN on these positions or on any
// midpoint of two of them: every coordinate finite and either 0 or of magnitude
// in [1e-50, 1e75). NaN needs 0/0 or inf/inf, and dot > 0 rules both out here.
// Each coordinate (and so each midpoint, a half-sum) is a multiple of 2^-220,
// so a nonzero edge component is at least 2^-220, a nonzero product at least
// 2^-440 (a multiple of 2^-492 once rounded), and a positive dot at least
// 2^-492: dot^2 >= 2^-984 and |u|^2 |v|^2 >= 2^-880 are both above zero. And
// every component is below 2e75, so each squared length and the dot are below
// 1.3e151 and their squares and products below 1.7e302: finite.
bool sharpnessCannotBeNaN(const std::vector<double>& P) {
  for (const double x : P) {
    const double m = std::fabs(x);
    if (!(m == 0 || (m >= 1e-50 && m < 1e75))) return false;
  }
  return true;
}

// One collapse pass. `dec` (a decimation pass) adds cleanup.js's decimation
// guards: not both endpoints of ring size 3 (a tetrahedron), the corner guard
// (cos2 > 0), the normal-turn guard (ncos2 > 0) and the spread guard (scos2 > 0).
// Returns the collapses made.
size_t collapse(ipe::Session& s, double minLen, bool dec, double cos2, double ncos2, double scos2, double minAccept) {
  std::vector<double>& P = s.positions;
  std::vector<uint32_t>& T = s.indices;
  std::vector<int32_t>& VL = s.vertLeaf;
  // An owner mesh (cleanup.js's `own`): never merge different owners or a pinned vertex, a
  // merged vertex is held when either end was, and the owner fields follow the compaction.
  const bool own = s.ownerMesh;
  std::vector<int32_t>& VO = s.vertOwner;
  std::vector<uint8_t>& VH = s.ownerHeld;
  std::vector<uint8_t>& VP = s.pinned;
  auto apart = [&](uint32_t a, uint32_t b) { return own && (VP[a] || VP[b] || VO[a] != VO[b]); };
  const size_t nv = P.size() / 3, nt = T.size() / 3;
  // Incident triangles per vertex, CSR, in triangle order.
  std::vector<uint32_t> off(nv + 1, 0), inc(nt * 3);
  for (size_t q = 0; q < nt * 3; q++) off[T[q] + 1]++;
  for (size_t v = 0; v < nv; v++) off[v + 1] += off[v];
  {
    std::vector<uint32_t> fill(off.begin(), off.end() - 1);
    for (size_t t = 0; t < nt; t++) for (int c = 0; c < 3; c++) inc[fill[T[3 * t + c]]++] = (uint32_t)t;
  }
  std::vector<uint8_t> alive(nt, 1), locked(nv, 0);
  std::vector<uint32_t> markA(nv, 0), markB(nv, 0);   // ring membership, stamped per test
  uint32_t stamp = 0;
  const double min2 = minLen * minLen;
  double mid[3];
  size_t collapsed = 0;
  std::vector<double> fan;      // the new normals of the surviving triangles, in walk order
  std::vector<uint32_t> fanT;   // and those triangles
  // Decimation only (and wherever the corner guard reads them): each triangle's current
  // normal (bit 1) and sharpness (bit 2), cached until a collapse touches it (see the
  // top comment).
  const bool cache = dec || cos2 > 0;
  std::vector<uint8_t> have(cache ? nt : 0, 0);
  std::vector<double> curN(cache ? 3 * nt : 0), curS(cache ? nt : 0);
  // The early corner refusal holds only where no sharpness can be NaN.
  const bool earlySharp = cos2 > 0 && sharpnessCannotBeNaN(P);

  auto before = [&](uint32_t v) -> const double* { return &P[3 * (size_t)v]; };
  auto curSharp = [&](uint32_t tt) -> double {
    if (have[tt] & 2) return curS[tt];
    double* n = &curN[3 * (size_t)tt];
    normalAndSharpness(before, T[3 * tt], T[3 * tt + 1], T[3 * tt + 2], n, &curS[tt]);
    have[tt] = 3;
    return curS[tt];
  };
  auto curNormal = [&](uint32_t tt, double* tmp) -> const double* {
    if (!cache) { triNormal(before, T[3 * tt], T[3 * tt + 1], T[3 * tt + 2], tmp); return tmp; }
    double* n = &curN[3 * (size_t)tt];
    if (!(have[tt] & 1)) { triNormal(before, T[3 * tt], T[3 * tt + 1], T[3 * tt + 2], n); have[tt] |= 1; }
    return n;
  };
  auto isShort = [&](uint32_t a, uint32_t b) {
    const double dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
    return dx * dx + dy * dy + dz * dz < min2;
  };
  // cleanup.js's allowed: may edge (a, b) collapse to its midpoint (left in `mid`)?
  // The JS's tests in a cheaper order (each only refuses; see the top comment).
  auto allowed = [&](uint32_t a, uint32_t b) -> bool {
    mid[0] = (P[3 * a] + P[3 * b]) / 2; mid[1] = (P[3 * a + 1] + P[3 * b + 1]) / 2; mid[2] = (P[3 * a + 2] + P[3 * b + 2]) / 2;
    auto after = [&](uint32_t v) -> const double* { return v == a || v == b ? mid : &P[3 * (size_t)v]; };
    // One walk over the surviving triangles around a then b: each one's new normal
    // and, with the corner guard on, the sharpest corner the collapse would leave.
    fan.clear(); fanT.clear();
    const bool sharpOn = cos2 > 0;
    double sharpAfter = 0, sharpBefore = 0;
    bool haveBefore = false;
    for (int side = 0; side < 2; side++) {
      const uint32_t v = side == 0 ? a : b;
      for (uint32_t q = off[v]; q < off[v + 1]; q++) {
        const uint32_t tt = inc[q];
        if (!alive[tt]) continue;
        const uint32_t i = T[3 * tt], j = T[3 * tt + 1], k = T[3 * tt + 2];
        if ((i == a || j == a || k == a) && (i == b || j == b || k == b)) continue;
        double n1[3], sh = 0;
        normalAndSharpness(after, i, j, k, n1, sharpOn ? &sh : nullptr);
        fan.push_back(n1[0]); fan.push_back(n1[1]); fan.push_back(n1[2]);
        fanT.push_back(tt);
        if (!sharpOn) continue;
        sharpAfter = jsmath::jsmax(sharpAfter, sh);
        if (earlySharp && sharpAfter > cos2) {
          // The running max only grows, so it already refuses.
          if (!haveBefore) {
            for (int sb = 0; sb < 2; sb++) {
              const uint32_t x = sb == 0 ? a : b;
              for (uint32_t r = off[x]; r < off[x + 1]; r++) if (alive[inc[r]]) sharpBefore = jsmath::jsmax(sharpBefore, curSharp(inc[r]));
            }
            haveBefore = true;
          }
          if (sharpAfter > sharpBefore) return false;
        }
      }
    }
    // The corner guard: too sharp is allowed only if the corners around a and b now
    // (the edge's own two triangles included) already had one at least as sharp.
    if (sharpOn && sharpAfter > cos2) {
      if (haveBefore) {
        if (sharpAfter > sharpBefore) return false;
      } else {
        // The max of the corners now refuses iff every one is below sharpAfter (a NaN
        // makes the max NaN, which refuses nothing), so stop at the first that is not.
        bool refuse = true;
        for (int side = 0; side < 2 && refuse; side++) {
          const uint32_t v = side == 0 ? a : b;
          for (uint32_t q = off[v]; q < off[v + 1]; q++) {
            if (!alive[inc[q]]) continue;
            if (!(curSharp(inc[q]) < sharpAfter)) { refuse = false; break; }
          }
        }
        if (refuse) return false;
      }
    }
    // The spread guard on the new normals: their sum N, then each n refused when
    // n . N <= 0 or (n . N)^2 < scos2 * (|n|^2 * |N|^2).
    if (scos2 > 0) {
      double Nx = 0, Ny = 0, Nz = 0;
      for (size_t q = 0; q < fan.size(); q += 3) { Nx += fan[q]; Ny += fan[q + 1]; Nz += fan[q + 2]; }
      const double NN = Nx * Nx + Ny * Ny + Nz * Nz;
      for (size_t q = 0; q < fan.size(); q += 3) {
        const double d = fan[q] * Nx + fan[q + 1] * Ny + fan[q + 2] * Nz;
        if (d <= 0 || d * d < scos2 * ((fan[q] * fan[q] + fan[q + 1] * fan[q + 1] + fan[q + 2] * fan[q + 2]) * NN)) return false;
      }
    }
    // No flips: every surviving triangle keeps its orientation (and, with ncos2,
    // turns no further than that).
    for (size_t f = 0; f < fanT.size(); f++) {
      double tmp[3];
      const double* n0 = curNormal(fanT[f], tmp);
      const double* n1 = &fan[3 * f];
      const double turn = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
      if (turn <= 0) return false;
      if (ncos2 > 0 && turn * turn < ncos2 * ((n0[0] * n0[0] + n0[1] * n0[1] + n0[2] * n0[2]) * (n1[0] * n1[0] + n1[1] * n1[1] + n1[2] * n1[2]))) return false;
    }
    // |ring(a) ∩ ring(b)|: mark ring(a), then count ring(b)'s distinct members marked.
    stamp++;
    int sizeA = 0, sizeB = 0;   // |ring(a)|, |ring(b)| (distinct members)
    for (uint32_t q = off[a]; q < off[a + 1]; q++) {
      const uint32_t tt = inc[q];
      if (!alive[tt]) continue;
      for (int k = 0; k < 3; k++) {
        const uint32_t w = T[3 * tt + k];
        if (w != a && markA[w] != stamp) { markA[w] = stamp; sizeA++; }
      }
    }
    int common = 0;
    for (uint32_t q = off[b]; q < off[b + 1]; q++) {
      const uint32_t tt = inc[q];
      if (!alive[tt]) continue;
      for (int k = 0; k < 3; k++) {
        const uint32_t w = T[3 * tt + k];
        if (w == b || markB[w] == stamp) continue;
        markB[w] = stamp;
        sizeB++;
        if (markA[w] == stamp) common++;
      }
    }
    if (dec && sizeA == 3 && sizeB == 3) return false;   // a tetrahedron: it would fold into a pillow
    return common == 2;
  };
  // cleanup.js's probe (see there): every edge of every PROBE_STRIDE-th triangle,
  // nothing collapsed; too few allowed and the pass is skipped, mesh untouched.
  if (dec && minAccept > 0) {
    double tried = 0, accepted = 0;
    for (size_t t = 0; t < nt; t += PROBE_STRIDE) for (int c = 0; c < 3; c++) {
      const uint32_t a = T[3 * t + c], b = T[3 * t + (c + 1) % 3];
      if (!isShort(a, b) || apart(a, b)) continue;
      tried++;
      if (allowed(a, b)) accepted++;
    }
    if (accepted < minAccept * tried) return 0;
  }

  for (size_t t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    for (int c = 0; c < 3; c++) {
      const uint32_t a = T[3 * t + c], b = T[3 * t + (c + 1) % 3];
      if (locked[a] || locked[b] || apart(a, b)) continue;
      if (!isShort(a, b)) continue;
      if (!allowed(a, b)) continue;
      // Every triangle holding a or b is on one of their lists: forget what was cached.
      if (cache) for (int side = 0; side < 2; side++) {
        const uint32_t v = side == 0 ? a : b;
        for (uint32_t q = off[v]; q < off[v + 1]; q++) have[inc[q]] = 0;
      }
      P[3 * a] = mid[0]; P[3 * a + 1] = mid[1]; P[3 * a + 2] = mid[2];
      if (own && VH[b]) VH[a] = 1;
      for (uint32_t q = off[b]; q < off[b + 1]; q++) {
        const uint32_t tt = inc[q];
        if (!alive[tt]) continue;
        uint32_t* tri = &T[3 * (size_t)tt];
        if (tri[0] == a || tri[1] == a || tri[2] == a) { alive[tt] = 0; continue; }
        for (int k = 0; k < 3; k++) if (tri[k] == b) tri[k] = a;
        // (the JS appends tt to vt[a] here; never read again, see above)
      }
      locked[a] = locked[b] = 1;
      collapsed++;
      break;   // triangle t is gone; move on
    }
  }
  // Compact: vertices renumbered in order of first use by a surviving triangle,
  // into outputs sized for the most they can hold, trimmed after.
  size_t aliveCount = 0;
  for (size_t t = 0; t < nt; t++) aliveCount += alive[t];
  std::vector<int32_t> map(nv, -1);
  std::vector<double> outP(3 * nv);
  std::vector<uint32_t> outT(3 * aliveCount);
  std::vector<int32_t> outL(nv), outO(own ? nv : 0);
  std::vector<uint8_t> outH(own ? nv : 0), outPin(own ? nv : 0);
  {
    int32_t* mp = map.data();
    double* oP = outP.data();
    uint32_t* oT = outT.data();
    int32_t* oL = outL.data();
    const uint32_t* Tp = T.data();
    const double* Pp = P.data();
    size_t nOut = 0, w = 0;
    for (size_t t = 0; t < nt; t++) {
      if (!alive[t]) continue;
      for (int c = 0; c < 3; c++) {
        const uint32_t v = Tp[3 * t + c];
        int32_t id = mp[v];
        if (id < 0) {
          id = mp[v] = (int32_t)nOut;
          oP[3 * nOut] = Pp[3 * (size_t)v]; oP[3 * nOut + 1] = Pp[3 * (size_t)v + 1]; oP[3 * nOut + 2] = Pp[3 * (size_t)v + 2];
          oL[nOut] = VL[v];
          if (own) { outO[nOut] = VO[v]; outH[nOut] = VH[v]; outPin[nOut] = VP[v]; }
          nOut++;
        }
        oT[w++] = (uint32_t)id;
      }
    }
    outP.resize(3 * nOut); outL.resize(nOut);
    if (own) { outO.resize(nOut); outH.resize(nOut); outPin.resize(nOut); }
  }
  P.swap(outP); T.swap(outT); VL.swap(outL);
  if (own) { VO.swap(outO); VH.swap(outH); VP.swap(outPin); }
  return collapsed;
}

// cleanup.js's relax: tangential Laplacian smoothing.
void relax(std::vector<double>& P, const std::vector<uint32_t>& T, const std::vector<double>& N, double weight, double maxMove) {
  const size_t nv = P.size() / 3;
  std::vector<double> sum(3 * nv, 0.0);
  std::vector<uint32_t> cnt(nv, 0);
  for (size_t t = 0; t < T.size(); t += 3) for (int c = 0; c < 3; c++) {
    const uint32_t a = T[t + c], b = T[t + (c + 1) % 3];
    sum[3 * a] += P[3 * b]; sum[3 * a + 1] += P[3 * b + 1]; sum[3 * a + 2] += P[3 * b + 2]; cnt[a]++;
    sum[3 * b] += P[3 * a]; sum[3 * b + 1] += P[3 * a + 1]; sum[3 * b + 2] += P[3 * a + 2]; cnt[b]++;
  }
  for (size_t v = 0; v < nv; v++) {
    if (!cnt[v]) continue;
    if (N[3 * v] == 0 && N[3 * v + 1] == 0 && N[3 * v + 2] == 0) continue;
    const double cn = (double)cnt[v];
    double dx = sum[3 * v] / cn - P[3 * v], dy = sum[3 * v + 1] / cn - P[3 * v + 1], dz = sum[3 * v + 2] / cn - P[3 * v + 2];
    const double nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2], dn = dx * nx + dy * ny + dz * nz;
    dx = (dx - dn * nx) * weight; dy = (dy - dn * ny) * weight; dz = (dz - dn * nz) * weight;
    const double l = std::sqrt(dx * dx + dy * dy + dz * dz);
    if (l > maxMove) { const double sc = maxMove / l; dx *= sc; dy *= sc; dz *= sc; }
    P[3 * v] += dx; P[3 * v + 1] += dy; P[3 * v + 2] += dz;
  }
}

constexpr int PROJ_CHUNK = 512;   // vertices per interpreter call (7 lanes each)
}  // namespace

int project(ipe::Session& s, const int32_t* which, int whichCount, double maxStep, bool wantNormals) {
  if (!s.meshed) return 1;
  std::vector<double>& P = s.positions;
  const size_t nv = P.size() / 3;
  const size_t count = which ? (size_t)(whichCount < 0 ? 0 : whichCount) : nv;
  if (which) {
    if (whichCount < 0) return 2;
    std::vector<uint8_t> seen(nv, 0);
    for (size_t q = 0; q < count; q++) {
      const int32_t v = which[q];
      if (v < 0 || (size_t)v >= nv || seen[v]) return 2;
      seen[v] = 1;
    }
  }
  if (wantNormals && s.normals.size() != 3 * nv) s.normals.assign(3 * nv, 0.0);
  // Bucket the vertices by their leaf's program, vertex order within a bucket.
  const size_t nProg = s.programs.size();
  std::vector<uint32_t> start(nProg + 1, 0), order(count);
  auto progOf = [&](size_t q) -> uint32_t {
    const size_t v = which ? (size_t)which[q] : q;
    return (uint32_t)s.leaves[4 * (size_t)s.vertLeaf[v] + 3];
  };
  for (size_t q = 0; q < count; q++) start[progOf(q) + 1]++;
  for (size_t p = 0; p < nProg; p++) start[p + 1] += start[p];
  {
    std::vector<uint32_t> fill(start.begin(), start.end() - 1);
    for (size_t q = 0; q < count; q++) order[fill[progOf(q)]++] = which ? (uint32_t)which[q] : (uint32_t)q;
  }
  const double e = 0.1 * s.edge;
  std::vector<double> buf((size_t)PROJ_CHUNK * 7 * 4);
  double *X = buf.data(), *Y = X + PROJ_CHUNK * 7, *Z = Y + PROJ_CHUNK * 7, *out = Z + PROJ_CHUNK * 7;
  double* N = wantNormals ? s.normals.data() : nullptr;
  for (size_t p = 0; p < nProg; p++) {
    const ipe::Program& prog = s.programs[p];
    for (uint32_t q0 = start[p]; q0 < start[p + 1]; q0 += PROJ_CHUNK) {
      const int m = (int)(start[p + 1] - q0 < (uint32_t)PROJ_CHUNK ? start[p + 1] - q0 : PROJ_CHUNK);
      for (int k = 0; k < m; k++) {
        const size_t v = order[q0 + k];
        const double x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
        const int o = 7 * k;
        X[o] = x; Y[o] = y; Z[o] = z;
        X[o + 1] = x + e; Y[o + 1] = y; Z[o + 1] = z;
        X[o + 2] = x - e; Y[o + 2] = y; Z[o + 2] = z;
        X[o + 3] = x; Y[o + 3] = y + e; Z[o + 3] = z;
        X[o + 4] = x; Y[o + 4] = y - e; Z[o + 4] = z;
        X[o + 5] = x; Y[o + 5] = y; Z[o + 5] = z + e;
        X[o + 6] = x; Y[o + 6] = y; Z[o + 6] = z - e;
      }
      ipe::eval(s, prog, X, Y, Z, 7 * m, out);   // the program passed sample()'s check
      for (int k = 0; k < m; k++) {
        const size_t v = order[q0 + k];
        const int o = 7 * k;
        const double d = out[o];
        const double gx = (out[o + 1] - out[o + 2]) / (2 * e), gy = (out[o + 3] - out[o + 4]) / (2 * e), gz = (out[o + 5] - out[o + 6]) / (2 * e);
        const double g2 = gx * gx + gy * gy + gz * gz;
        if (!(g2 > 1e-12)) continue;
        const double gl = std::sqrt(g2);
        if (N) { N[3 * v] = gx / gl; N[3 * v + 1] = gy / gl; N[3 * v + 2] = gz / gl; }
        double t = d / gl;   // signed distance estimate along the gradient
        if (t > maxStep) t = maxStep; else if (t < -maxStep) t = -maxStep;
        P[3 * v] -= (gx / gl) * t; P[3 * v + 1] -= (gy / gl) * t; P[3 * v + 2] -= (gz / gl) * t;
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The owner path's evaluation and projection.
//
// eval_points: points bucketed by program (a counting sort, point order within a
// program) and evaluated in chunks, each point's results scattered back to its own
// slot. A point's value and capture read only its own coordinates and its own program
// (the interpreter is lane-local), so neither the bucket nor the chunk it rides in can
// change a bit — the same argument as projection's per-program batching above.
namespace {
constexpr int EVAL_CHUNK = 1024;
}

int eval_points(ipe::Session& s, const Points& pts, double* out, int32_t* piece, double* cuts, double* shares) {
  const size_t n = pts.size();
  const bool capture = piece || cuts || shares;
  const int K = s.ownerK;
  if (capture && K < 1) return 1;
  if (n == 0) return 0;
  const size_t nProg = s.programs.size();
  for (size_t q = 0; q < n; q++) if (pts.prog[q] < 0 || (size_t)pts.prog[q] >= nProg) return 1;
  std::vector<uint32_t> start(nProg + 1, 0), order(n);
  for (size_t q = 0; q < n; q++) start[(size_t)pts.prog[q] + 1]++;
  for (size_t p = 0; p < nProg; p++) start[p + 1] += start[p];
  {
    std::vector<uint32_t> fill(start.begin(), start.end() - 1);
    for (size_t q = 0; q < n; q++) order[fill[(size_t)pts.prog[q]]++] = (uint32_t)q;
  }
  std::vector<double> buf((size_t)EVAL_CHUNK * 4);
  double *X = buf.data(), *Y = X + EVAL_CHUNK, *Z = Y + EVAL_CHUNK, *o = Z + EVAL_CHUNK;
  std::vector<int32_t> cp(piece ? EVAL_CHUNK : 0);
  std::vector<double> cc(cuts ? (size_t)EVAL_CHUNK * K : 0), cs(shares ? (size_t)EVAL_CHUNK * K : 0);
  ipe::Capture cap;
  cap.K = K;
  cap.piece = piece ? cp.data() : nullptr;
  cap.cuts = cuts ? cc.data() : nullptr;
  cap.shares = shares ? cs.data() : nullptr;
  for (size_t p = 0; p < nProg; p++) {
    const ipe::Program& prog = s.programs[p];
    for (uint32_t q0 = start[p]; q0 < start[p + 1]; q0 += EVAL_CHUNK) {
      const int m = (int)(start[p + 1] - q0 < (uint32_t)EVAL_CHUNK ? start[p + 1] - q0 : EVAL_CHUNK);
      for (int k = 0; k < m; k++) { const uint32_t q = order[q0 + k]; X[k] = pts.X[q]; Y[k] = pts.Y[q]; Z[k] = pts.Z[q]; }
      const int rc = capture ? ipe::eval_contact(s, prog, X, Y, Z, m, o, cap) : ipe::eval(s, prog, X, Y, Z, m, o);
      if (rc != 0) return 2;
      for (int k = 0; k < m; k++) {
        const size_t q = order[q0 + k];
        out[q] = o[k];
        if (piece) piece[q] = cp[k];
        if (cuts) for (int j = 0; j < K; j++) cuts[q * K + j] = cc[(size_t)k * K + j];
        if (shares) for (int j = 0; j < K; j++) shares[q * K + j] = cs[(size_t)k * K + j];
      }
    }
  }
  return 0;
}

// project.js's owner mode (projectOwnedGroup): every vertex takes newtonStep (DIST_RATIO cap,
// then maxStep) on the field, or — when held, or when its owner's share is above the field at
// it by more than tol — on its owner's share, if that share is finite over the stencil, its
// stencil gradient is distance-like (<= HELD_GRAD_MAX) and the landing passes the jump guard.
//
// What bit-exact parity needs beyond project()'s: the same newtonStep (d, the central
// differences over 2e, the `!(g2 > 1e-12)` return, t = d / gl clamped to DIST_RATIO * |d| and
// then to maxStep); the share step's guards in the JS's order (the try test on the centre
// share, the finite test over the 7 stencil shares, the gradient cap); the landing at
// p - (g / gl) * t, judged on predicted = d - gl * t with the continuity bound
// HELD_CONTINUITY * |t| + tol and mine = landed - field <= tol; and the step applied as
// project() applies it. Lanes are laid out differently here — the centres of a chunk first
// (evaluated with share capture), then their six stencil points (no capture: the field is
// evalBatch's either way), and only a candidate's stencil shares evaluated again with
// capture — which changes no value: every number a vertex reads is its own lane's.
namespace {
constexpr double HELD_FIELD_TOL = 1e-3, HELD_GRAD_MAX = 3, HELD_CONTINUITY = 0.5, DIST_RATIO = 2;

struct Step { double d, gx, gy, gz, gl, t; bool ok; };

// project.js's newtonStep on stencil values f[0..6].
inline Step newtonStep(const double* f, double e, double maxStep) {
  Step st{0, 0, 0, 0, 0, 0, false};
  const double d = f[0], gx = (f[1] - f[2]) / (2 * e), gy = (f[3] - f[4]) / (2 * e), gz = (f[5] - f[6]) / (2 * e);
  const double g2 = gx * gx + gy * gy + gz * gz;
  if (!(g2 > 1e-12)) return st;
  const double gl = std::sqrt(g2);
  double t = d / gl;
  const double far = DIST_RATIO * std::fabs(d);
  if (t > far) t = far; else if (t < -far) t = -far;
  if (t > maxStep) t = maxStep; else if (t < -maxStep) t = -maxStep;
  st = Step{d, gx, gy, gz, gl, t, true};
  return st;
}
}  // namespace

int project_owned(ipe::Session& s, const int32_t* which, int whichCount, double maxStep, bool wantNormals, uint8_t* unsettled) {
  if (!s.meshed || !s.ownerMesh || s.ownerK < 1) return 1;
  std::vector<double>& P = s.positions;
  const size_t nv = P.size() / 3;
  const size_t count = which ? (size_t)(whichCount < 0 ? 0 : whichCount) : nv;
  const int K = s.ownerK;
  if (which) {
    if (whichCount < 0) return 2;
    std::vector<uint8_t> seen(nv, 0);
    for (size_t q = 0; q < count; q++) {
      const int32_t v = which[q];
      if (v < 0 || (size_t)v >= nv || seen[v]) return 2;
      seen[v] = 1;
    }
  }
  for (size_t q = 0; q < count; q++) {   // the JS indexes the shares by the owner
    const size_t v = which ? (size_t)which[q] : q;
    if (s.vertOwner[v] < 0 || s.vertOwner[v] >= K) return 3;
  }
  if (wantNormals && s.normals.size() != 3 * nv) s.normals.assign(3 * nv, 0.0);
  const size_t nProg = s.programs.size();
  std::vector<uint32_t> start(nProg + 1, 0), order(count);
  auto progOf = [&](size_t q) -> uint32_t {
    const size_t v = which ? (size_t)which[q] : q;
    return (uint32_t)leaf_prog(s, s.vertLeaf[v]);
  };
  for (size_t q = 0; q < count; q++) start[progOf(q) + 1]++;
  for (size_t p = 0; p < nProg; p++) start[p + 1] += start[p];
  {
    std::vector<uint32_t> fill(start.begin(), start.end() - 1);
    for (size_t q = 0; q < count; q++) order[fill[progOf(q)]++] = which ? (uint32_t)which[q] : (uint32_t)q;
  }
  const double e = 0.1 * s.edge, tol = HELD_FIELD_TOL * s.edge;
  constexpr int M = PROJ_CHUNK;
  // Centres (M lanes), their stencils (6M), a candidate's stencil again (6M) and landings (M).
  std::vector<double> X(14 * M), Y(14 * M), Z(14 * M), out(14 * M);
  std::vector<double> shC((size_t)M * K), shS((size_t)6 * M * K), shL((size_t)M * K);
  std::vector<Step> field(M), share(M);
  std::vector<int> cand, tries;
  std::vector<uint8_t> accepted(M), selected(M);
  double* N = wantNormals ? s.normals.data() : nullptr;
  ipe::Capture capC, capS, capL;
  capC.K = capS.K = capL.K = K;
  capC.shares = shC.data(); capS.shares = shS.data(); capL.shares = shL.data();
  double *cX = X.data(), *cY = Y.data(), *cZ = Z.data(), *cO = out.data();
  double *sX = cX + M, *sY = cY + M, *sZ = cZ + M, *sO = cO + M;
  double *tX = cX + 7 * M, *tY = cY + 7 * M, *tZ = cZ + 7 * M, *tO = cO + 7 * M;
  double *lX = cX + 13 * M, *lY = cY + 13 * M, *lZ = cZ + 13 * M, *lO = cO + 13 * M;
  for (size_t p = 0; p < nProg; p++) {
    const ipe::Program& prog = s.programs[p];
    for (uint32_t q0 = start[p]; q0 < start[p + 1]; q0 += M) {
      const int m = (int)(start[p + 1] - q0 < (uint32_t)M ? start[p + 1] - q0 : M);
      for (int k = 0; k < m; k++) {
        const size_t v = order[q0 + k];
        const double x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
        cX[k] = x; cY[k] = y; cZ[k] = z;
        double* ax = sX + 6 * k; double* ay = sY + 6 * k; double* az = sZ + 6 * k;
        ax[0] = x + e; ay[0] = y; az[0] = z;
        ax[1] = x - e; ay[1] = y; az[1] = z;
        ax[2] = x; ay[2] = y + e; az[2] = z;
        ax[3] = x; ay[3] = y - e; az[3] = z;
        ax[4] = x; ay[4] = y; az[4] = z + e;
        ax[5] = x; ay[5] = y; az[5] = z - e;
      }
      if (ipe::eval_contact(s, prog, cX, cY, cZ, m, cO, capC) != 0) return 4;
      if (ipe::eval(s, prog, sX, sY, sZ, 6 * m, sO) != 0) return 4;
      cand.clear();
      for (int k = 0; k < m; k++) {
        const size_t v = order[q0 + k];
        double f[7] = {cO[k], sO[6 * k], sO[6 * k + 1], sO[6 * k + 2], sO[6 * k + 3], sO[6 * k + 4], sO[6 * k + 5]};
        field[k] = newtonStep(f, e, maxStep);
        share[k].ok = false;
        accepted[k] = 0;
        selected[k] = 0;
        const int w = s.vertOwner[v];
        // Not held, and its owner makes the field here: the field step is its own skin's.
        if (!s.ownerHeld[v] && !(shC[(size_t)k * K + w] - cO[k] > tol)) continue;
        selected[k] = 1;
        cand.push_back(k);
      }
      // The candidates' stencil shares (their field values are the stencil's above).
      const int nc = (int)cand.size();
      for (int c = 0; c < nc; c++) {
        const int k = cand[c];
        for (int q = 0; q < 6; q++) { tX[6 * c + q] = sX[6 * k + q]; tY[6 * c + q] = sY[6 * k + q]; tZ[6 * c + q] = sZ[6 * k + q]; }
      }
      if (nc && ipe::eval_contact(s, prog, tX, tY, tZ, 6 * nc, tO, capS) != 0) return 4;
      tries.clear();
      for (int c = 0; c < nc; c++) {
        const int k = cand[c];
        const int w = s.vertOwner[order[q0 + k]];
        double f[7];
        f[0] = shC[(size_t)k * K + w];
        for (int q = 0; q < 6; q++) f[q + 1] = shS[((size_t)6 * c + q) * K + w];
        bool finite = true;
        for (int q = 0; q < 7 && finite; q++) if (!std::isfinite(f[q])) finite = false;
        if (!finite) continue;
        const Step st = newtonStep(f, e, maxStep);
        if (!st.ok || st.gl > HELD_GRAD_MAX) continue;   // the stencil straddles a jump in the share
        share[k] = st;
        tries.push_back(k);
      }
      // Where each share step lands: the field and the vertex's owner's share there.
      const int nt = (int)tries.size();
      for (int c = 0; c < nt; c++) {
        const int k = tries[c];
        const size_t v = order[q0 + k];
        const Step& st = share[k];
        lX[c] = P[3 * v] - (st.gx / st.gl) * st.t; lY[c] = P[3 * v + 1] - (st.gy / st.gl) * st.t; lZ[c] = P[3 * v + 2] - (st.gz / st.gl) * st.t;
      }
      if (nt && ipe::eval_contact(s, prog, lX, lY, lZ, nt, lO, capL) != 0) return 4;
      for (int c = 0; c < nt; c++) {
        const int k = tries[c];
        const Step& st = share[k];
        const double predicted = st.d - st.gl * st.t, landed = shL[(size_t)c * K + s.vertOwner[order[q0 + k]]];
        const bool continuous = std::fabs(landed - predicted) <= HELD_CONTINUITY * std::fabs(st.t) + tol, mine = landed - lO[c] <= tol;
        if (mine && (std::fabs(lO[c]) <= tol || continuous)) accepted[k] = 1;
      }
      for (int k = 0; k < m; k++) {
        const size_t v = order[q0 + k];
        const Step& st = accepted[k] ? share[k] : field[k];
        if (unsettled) unsettled[v] = selected[k] || (st.ok && std::fabs(st.t) > tol) ? 1 : 0;
        if (!st.ok) continue;
        if (N) { N[3 * v] = st.gx / st.gl; N[3 * v + 1] = st.gy / st.gl; N[3 * v + 2] = st.gz / st.gl; }
        P[3 * v] -= (st.gx / st.gl) * st.t; P[3 * v + 1] -= (st.gy / st.gl) * st.t; P[3 * v + 2] -= (st.gz / st.gl) * st.t;
      }
    }
  }
  return 0;
}

int cleanup(ipe::Session& s, double collapseFrac, int relaxPasses, double relaxWeight, double maxMoveCells,
            double decimateFrac, int decimatePasses, double guardCos2, double normalCos2, double spreadCos2,
            double minAccept, double minGain) {
  if (!s.meshed) return 1;
  const double edge = s.edge;
  collapse(s, collapseFrac * edge, false, -1, -1, -1, 0);
  if (decimateFrac > 0) {
    for (int pass = 0; pass < decimatePasses; pass++) {
      const double before = (double)(s.indices.size() / 3);
      const size_t n = collapse(s, decimateFrac * edge, true, guardCos2, normalCos2, spreadCos2, pass == 0 ? minAccept : 0);
      if (n == 0 || before - (double)(s.indices.size() / 3) < minGain * before) break;
    }
  }
  s.normals.assign(s.positions.size(), 0.0);
  const double maxStep = maxMoveCells * edge;
  if (!s.ownerMesh) {
    project(s, nullptr, 0, maxStep, true);
    for (int pass = 0; pass < relaxPasses; pass++) {
      relax(s.positions, s.indices, s.normals, relaxWeight, maxStep);
      project(s, nullptr, 0, maxStep, true);
    }
    return 0;
  }
  // An owner mesh (cleanup.js): pinned vertices keep a zero normal until the end, so relax
  // leaves them where they are; one more projection after the last relaxation, for the free
  // vertices that projection left unsettled (in vertex order); then the pinned vertices take
  // their normals from a zero-step projection.
  std::vector<int32_t> freeV, pins;
  for (size_t v = 0; v < s.pinned.size(); v++) (s.pinned[v] ? pins : freeV).push_back((int32_t)v);
  const int nf = (int)freeV.size();
  static const int32_t none = 0;
  const int32_t* fw = nf ? freeV.data() : &none;   // a real pointer: null means every vertex
  std::vector<uint8_t> unsettled(s.pinned.size(), 0);
  if (project_owned(s, fw, nf, maxStep, true, unsettled.data()) != 0) return 3;
  for (int pass = 0; pass < relaxPasses; pass++) {
    relax(s.positions, s.indices, s.normals, relaxWeight, maxStep);
    if (project_owned(s, fw, nf, maxStep, true, unsettled.data()) != 0) return 3;
  }
  std::vector<int32_t> again;
  for (const int32_t v : freeV) if (unsettled[(size_t)v]) again.push_back(v);
  // A vertex skipped here keeps the position and normal its last projection gave it.
  if (!again.empty() && project_owned(s, again.data(), (int)again.size(), maxStep, true) != 0) return 3;
  if (!pins.empty() && project_owned(s, pins.data(), (int)pins.size(), 0, true) != 0) return 3;
  return 0;
}

}  // namespace ipm_mesh

extern "C" {

// evaluateLeaves over `count` leaves (i0, j0, l0, program index each; programs
// already added in plan order): 0 ok; nonzero for an unknown session, a program
// index it lacks or a program it refuses (the store is left as it was).
int ip_sample(int id, const int32_t* leaves, int count, const double* origin3, double edge, const int32_t* n3, int ownerK) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 4;
  return ipm_mesh::sample(*s, leaves, count, origin3, edge, n3, ownerK);
}

// The leaf store's owners (owner plans only): (LEAF+1)^3 int8 per leaf, in plan order.
const int8_t* ip_leaf_owners(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->sampled && s->ownerK > 0 ? s->owners.data() : nullptr;
}

// The leaf store: (LEAF+1)^3 float32 samples per leaf, in plan order.
const float* ip_leaf_vals(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->sampled ? s->vals.get() : nullptr;
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

// Replaces the session mesh with the given one (a test seam: the stages after
// meshing on a mesh the mesher does not make), with its normals (double x3 per
// vertex) when `normals` is not null. Needs a sampled store; every index must
// name a vertex and every vertLeaf a leaf of the store. 0 ok.
int ip_mesh_load(int id, const double* positions, int nv, const uint32_t* indices, int ni, const int32_t* vertLeaf, const double* normals) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 2;
  if (!s->sampled || nv < 0 || ni < 0 || ni % 3) return 1;
  const int leaves = (int)(s->leaves.size() / 4);
  for (int q = 0; q < ni; q++) if (indices[q] >= (uint32_t)nv) return 1;
  for (int v = 0; v < nv; v++) if (vertLeaf[v] < 0 || vertLeaf[v] >= leaves) return 1;
  ipm_mesh::clear_owner_mesh(*s);
  s->positions.assign(positions, positions + (size_t)nv * 3);
  s->indices.assign(indices, indices + ni);
  s->vertLeaf.assign(vertLeaf, vertLeaf + nv);
  if (normals) s->normals.assign(normals, normals + (size_t)nv * 3);
  else s->normals.clear();
  s->meshed = true;
  return 0;
}

// projectVertices over the session mesh (`which` null: every vertex): 0 ok;
// nonzero for an unknown session, no mesh, or a `which` out of range / repeated.
int ip_project(int id, const int32_t* which, int whichCount, double maxStep, int wantNormals) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 3;
  return ipm_mesh::project(*s, which, whichCount, maxStep, wantNormals != 0);
}

// cleanupMesh over the session mesh, in place; fills the normals. 0 ok. With
// decimateFrac > 0, up to decimatePasses decimation passes follow the first
// collapse, guarded by guardCos2 (corners), normalCos2 (normal turn) and
// spreadCos2 (fan spread) — each cleanup.js's guardCos2 of an angle; <= 0: off —
// with the first pass's probe (minAccept) and the early stop (minGain).
int ip_cleanup(int id, double collapseFrac, int relaxPasses, double relaxWeight, double maxMoveCells,
               double decimateFrac, int decimatePasses, double guardCos2, double normalCos2, double spreadCos2,
            double minAccept, double minGain) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 2;
  return ipm_mesh::cleanup(*s, collapseFrac, relaxPasses, relaxWeight, maxMoveCells, decimateFrac, decimatePasses, guardCos2, normalCos2, spreadCos2,
                           minAccept, minGain);
}

// The normals (double x3 per vertex), or null when none have been written.
const double* ip_normals(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed && !s->normals.empty() ? s->normals.data() : nullptr;
}

}
