// C++ port of the implicit engine's owner path (a contact root): mesher-owners.js's
// meshStoreOwners, crease.js's cutCreases and untangle, and result.js's triangleOwners. The
// owner modes of cleanup (collapse guards, project_owned) are in implicit_mesh.cpp and the
// detail's seam fade in implicit_detail.cpp. See implicit_mesh.h.
//
// Every evaluation here is of mesh or grid points with a leaf's program, through eval_points
// (implicit_mesh.cpp): bucketed by program, which decides nothing because the interpreter is
// lane-local. What else bit-exact parity needs, beyond native/README.md's rules:
//
// mesh_owners (meshStoreOwners):
//   - pass 1 walks the leaves holding two solid owners in store order, cells (l, j, i), the Kuhn
//     tets in order and each tet's corner pairs (a < b), and numbers each owner-owner grid edge
//     when first met (X its low end's owner, Y its high end's, the leaf that met it);
//   - each edge's bisector is solved (solve_brackets, both ends evaluated first) on
//     s_X - s_Y < 0 (NaN to the high side) along low -> high as A + (B - A) * t, the grid points
//     as origin + i * edge; the edge is open when the field at the solved point is > 0;
//   - emission is meshStore's (implicit_mesh.cpp's mesh(), the same weld tables, masks and tet
//     code) with three additions in the JS's order: each new plain vertex's owner (its inside
//     end's), held mark (its grid edge shares a cell with an open edge) and pinned 0; a cell
//     holding an open edge refines each tet with one (split edges in ascending key order, every
//     sub-tet holding both ends halved, (s1, s2) in that order) and runs subTet's marching
//     tetrahedra on the sub-tets: nodes split inside / outside in node order, the
//     inside -> outside direction summed as gv += p / np then gv -= p / nn, midpoints (a + b) / 2,
//     crossings created left to right; a crossing between a corner and an air node is keyed by
//     the unordered node pair and starts at the linear guess from the inside node;
//   - then placeHeldPlain and nodeCrossings, each solve_brackets from t = 0 (inside) to 1 with
//     the straddle test's end values, and the JS's straddle tests, landing tests and lerps.
// crease (cutCreases): the crossing edges in triangle, corner order (first seen wins); the
//   edge's leaf (its first end's, its other end's when that pruned either piece at the
//   middle); solve_brackets on s_X - s_Y; the planar Newton (Cramer's rule with det3's expansion, the
//   minimal-norm fallback, the move cap); the judge; the retry without the plane; snaps then
//   splits in candidate order; the 1-to-2/3/4 patterns.
// untangle: JS Sets keep insertion order, and here that order decides results (a ring's
//   centroid is summed in ring order; a fan's order is the order a collapse rewrites its
//   triangles in, which is the order they are linked in again; `touched` orders the next
//   round's flipped list, which orders the swaps), so a fan is a vector with Set semantics
//   (append when absent, erase in place), a ring is collected from its fan in that order, and
//   `touched` is an insertion-ordered list. The edge -> triangles lists are only counted or read
//   when they hold two triangles, so their order decides nothing; their contents are the JS's.
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <utility>
#include <vector>

#include "flat_map.h"
#include "implicit_bracket.h"
#include "implicit_mesh.h"
#include "js_math.h"

namespace ipm_mesh {

namespace {

using jsmath::jsmax;
using jsmath::jsmin;
using Tri = std::array<uint32_t, 3>;

constexpr int KUHN[6][4] = {{0, 1, 3, 7}, {0, 1, 5, 7}, {0, 2, 3, 7}, {0, 2, 6, 7}, {0, 4, 5, 7}, {0, 4, 6, 7}};
constexpr int CELLS = LEAF * LEAF * LEAF;
constexpr int LOCAL_EDGES = S3 * 8;
constexpr int OWNER_AIR = -1;            // sparse.js's OWNER_AIR
constexpr int ATTACH_STRIDE = 8;         // contact.js's ATTACH_STRIDE
// bracket.js (implicit_bracket.h)
using ipm_bracket::MAX_BRACKET_STEPS;
// mesher-owners.js
constexpr double PIN_TOL = 1e-4;
// crease.js
constexpr int NEWTON_STEPS = 10;
constexpr double MAX_MOVE_CELLS = 0.25;
constexpr double FLIP_PROBE = 0.03, FOLD_COS = -0.866, SUSPECT_COS = 0.866;
constexpr int UNTANGLE_ROUNDS = 24, REGION_RINGS = 12, REGROW_RINGS = 3;

// contact.js's attachWeight (A: one attachment's 8 doubles).
inline double attachWeight(const double* A, double x, double y, double z) {
  const double dx = x - A[2], dy = y - A[3], dz = z - A[4];
  const double d = std::sqrt(dx * dx + dy * dy + dz * dz);
  double t = (d - A[5]) / A[6];
  t = jsmax(0, jsmin(1, t));
  return 1 - t * t * (3 - 2 * t);
}

// crease.js's pairWeight: the largest weight at p of an attachment joining X and Y (0 if none).
inline double pairWeight(const std::vector<double>& att, int X, int Y, double x, double y, double z) {
  double w = 0;
  const double dX = X, dY = Y;
  for (size_t o = 0; o + ATTACH_STRIDE <= att.size(); o += ATTACH_STRIDE) {
    if ((att[o] == dX && att[o + 1] == dY) || (att[o] == dY && att[o + 1] == dX)) w = jsmax(w, attachWeight(&att[o], x, y, z));
  }
  return w;
}

inline double lerp(double a, double b, double t) { return a + (b - a) * t; }

using ipm_bracket::solve_brackets;

}  // namespace

// ---------------------------------------------------------------------------
// mesh_owners

int mesh_owners(ipe::Session& s) {
  const int count = (int)(s.leaves.size() / 4);
  if (!s.sampled || s.ownerK < 1 || !s.contactSet || s.owners.size() != (size_t)count * S3) return 1;
  s.meshed = false;
  std::vector<double>& positions = s.positions;
  std::vector<uint32_t>& indices = s.indices;
  std::vector<int32_t>& vertLeaf = s.vertLeaf;
  positions.clear(); indices.clear(); vertLeaf.clear(); s.normals.clear();
  clear_owner_mesh(s);
  std::vector<int32_t>& vertOwner = s.vertOwner;
  std::vector<uint8_t>& ownerHeld = s.ownerHeld;
  std::vector<uint8_t>& pinned = s.pinned;
  const int K = s.ownerK;
  const double edge = s.edge, o0 = s.origin[0], o1 = s.origin[1], o2 = s.origin[2];
  const int64_t n0 = s.n[0], n1 = s.n[1], n2 = s.n[2];
  const double cl = s.cl, pinTol = PIN_TOL * edge;
  auto gIndex = [&](int64_t i, int64_t j, int64_t l) -> int64_t { return (l * n1 + j) * n0 + i; };
  auto sampleOf = [](int i, int j, int l, int c) { return ((l + ((c >> 2) & 1)) * S + (j + ((c >> 1) & 1))) * S + (i + (c & 1)); };
  auto leafEnds = [&](int L, int& iEnd, int& jEnd, int& lEnd) {
    const int64_t iLim = n0 - 1 - s.leaves[4 * (size_t)L], jLim = n1 - 1 - s.leaves[4 * (size_t)L + 1], lLim = n2 - 1 - s.leaves[4 * (size_t)L + 2];
    iEnd = (int)(LEAF < iLim ? LEAF : iLim); jEnd = (int)(LEAF < jLim ? LEAF : jLim); lEnd = (int)(LEAF < lLim ? LEAF : lLim);
  };
  // The cells holding both ends of grid edge (gLo, dir), as cellsOfEdge enumerates them.
  auto cellsOfEdge = [&](int64_t gLo, int dir, auto&& fn) {
    const int64_t i = gLo % n0, rest = (gLo - i) / n0, j = rest % n1, l = (rest - j) / n1;
    for (int64_t dl = (dir & 4 ? 0 : -1); dl <= 0; dl++) for (int64_t dj = (dir & 2 ? 0 : -1); dj <= 0; dj++) for (int64_t di = (dir & 1 ? 0 : -1); di <= 0; di++) {
      if (i + di >= 0 && j + dj >= 0 && l + dl >= 0) fn((l + dl) * n1 * n0 + (j + dj) * n0 + i + di);
    }
  };
  auto keyPoint = [&](uint64_t key, int end, double* out) {   // the grid edge's low (0) or high (1) point
    const int dir = (int)(key % 8);
    int64_t gi = (int64_t)((key - dir) / 8);
    if (end) gi += (dir & 1) + ((dir >> 1) & 1) * n0 + ((dir >> 2) & 1) * n0 * n1;
    const int64_t i = gi % n0, rest = (gi - i) / n0, j = rest % n1, l = (rest - j) / n1;
    out[0] = o0 + (double)i * edge; out[1] = o1 + (double)j * edge; out[2] = o2 + (double)l * edge;
  };

  // --- Pass 1: every owner-owner edge of a tet holding two or more solid owners. ---
  struct Rec { uint64_t key; int X, Y, leaf; double bis[3]; double val; bool open; };
  std::vector<Rec> recs;
  flat::Map<uint32_t> edgeRec(64);
  int lab[8];
  auto solidKinds = [&](const int* cs, int cnt) {
    int a = OWNER_AIR, kinds = 0;
    for (int q = 0; q < cnt; q++) {
      const int x = lab[cs[q]];
      if (x == OWNER_AIR || x == a) continue;
      if (a == OWNER_AIR) { a = x; kinds = 1; } else return 2;
    }
    return kinds;
  };
  static const int ALL8[8] = {0, 1, 2, 3, 4, 5, 6, 7};
  for (int L = 0; L < count; L++) {
    const int8_t* own = s.owners.data() + (size_t)L * S3;
    int first = OWNER_AIR;
    bool multi = false;
    for (int q = 0; q < S3 && !multi; q++) if (own[q] != OWNER_AIR) { if (first == OWNER_AIR) first = own[q]; else if (own[q] != first) multi = true; }
    if (!multi) continue;
    const int32_t i0 = s.leaves[4 * (size_t)L], j0 = s.leaves[4 * (size_t)L + 1], l0 = s.leaves[4 * (size_t)L + 2];
    int iEnd, jEnd, lEnd;
    leafEnds(L, iEnd, jEnd, lEnd);
    for (int l = 0; l < lEnd; l++) for (int j = 0; j < jEnd; j++) for (int i = 0; i < iEnd; i++) {
      for (int c = 0; c < 8; c++) lab[c] = own[sampleOf(i, j, l, c)];
      if (solidKinds(ALL8, 8) < 2) continue;
      for (int t = 0; t < 6; t++) {
        const int* tet = KUHN[t];
        if (solidKinds(tet, 4) < 2) continue;
        for (int a = 0; a < 4; a++) for (int b = a + 1; b < 4; b++) {
          const int ca = tet[a], cb = tet[b], A = lab[ca], B = lab[cb];
          if (A == OWNER_AIR || B == OWNER_AIR || A == B) continue;
          const int lo = ca & cb;
          const uint64_t key = (uint64_t)gIndex(i0 + i + (lo & 1), j0 + j + ((lo >> 1) & 1), l0 + l + ((lo >> 2) & 1)) * 8 + (uint64_t)(ca ^ cb);
          bool inserted = false;
          edgeRec.insert(key, (uint32_t)recs.size(), &inserted);
          if (!inserted) continue;
          recs.push_back(Rec{key, lab[lo], lab[lo | (ca ^ cb)], L, {0, 0, 0}, 0, false});
        }
      }
    }
  }

  // --- Resolve each edge on the leaf that first saw it: bisector, open or fused. ---
  const size_t nr = recs.size();
  Points pts;
  std::vector<double> out, cuts, shares;
  std::vector<int32_t> pc;
  if (nr) {
    std::vector<double> A(3 * nr), B(3 * nr);
    for (size_t r = 0; r < nr; r++) { keyPoint(recs[r].key, 0, &A[3 * r]); keyPoint(recs[r].key, 1, &B[3 * r]); }
    out.resize(2 * nr); shares.resize(2 * nr * K);
    auto addAt = [&](size_t r, double t) {
      pts.add(lerp(A[3 * r], B[3 * r], t), lerp(A[3 * r + 1], B[3 * r + 1], t), lerp(A[3 * r + 2], B[3 * r + 2], t), leaf_prog(s, recs[r].leaf));
    };
    // The bisector of the two pieces' shares, s_X - s_Y (negative at X's end, the low one).
    std::vector<double> t;
    const int rc = solve_brackets(nr, MAX_BRACKET_STEPS, [&](const uint32_t* lanes, const double* ts, size_t c, double* g) -> int {
      pts.clear();
      for (size_t k = 0; k < c; k++) addAt(lanes[k], ts[k]);
      if (eval_points(s, pts, out.data(), nullptr, nullptr, shares.data()) != 0) return 2;
      for (size_t k = 0; k < c; k++) { const Rec& rr = recs[lanes[k]]; g[k] = shares[k * K + rr.X] - shares[k * K + rr.Y]; }
      return 0;
    }, nullptr, nullptr, t);
    if (rc != 0) return 2;
    pts.clear();
    for (size_t r = 0; r < nr; r++) addAt(r, t[r]);
    if (eval_points(s, pts, out.data(), nullptr, nullptr, nullptr) != 0) return 2;
    for (size_t r = 0; r < nr; r++) {
      recs[r].bis[0] = pts.X[r]; recs[r].bis[1] = pts.Y[r]; recs[r].bis[2] = pts.Z[r];
      recs[r].val = out[r];
      recs[r].open = out[r] > 0;
    }
  }
  // The cells holding an open edge (they are also the cells refined: splitCells), and the split
  // nodes by grid edge key.
  flat::Map<uint8_t> openCells(64);
  flat::Map<uint32_t> splitAt(64);
  for (size_t r = 0; r < nr; r++) if (recs[r].open) {
    const uint64_t key = recs[r].key;
    const int dir = (int)(key % 8);
    cellsOfEdge((int64_t)((key - dir) / 8), dir, [&](int64_t cell) { openCells.insert((uint64_t)cell, 1); });
    splitAt.insert(key, (uint32_t)r);
  }
  const bool anyOpen = openCells.size() > 0;
  // A speed-up the JS does not need: the leaves an open cell can matter to. A leaf's cells,
  // and the cells of the grid edges its vertices lie on, span [i0 - 1, i0 + LEAF] on each axis,
  // so on a plan of LEAF-aligned leaves (planLeaves' octree) an open cell c can matter only to
  // the leaves at floor(c / LEAF) * LEAF, c + 1 (when that is a multiple of LEAF) and c - LEAF
  // (when c is), per axis. Every other leaf would find no open cell in any lookup, so it makes
  // none. A plan with an unaligned leaf flags every leaf (the lookups decide, as in the JS).
  std::vector<uint8_t> nearOpen(count, anyOpen ? 1 : 0);
  if (anyOpen) {
    bool aligned = true;
    flat::Map<uint32_t> leafAt((size_t)count + 16);
    for (int L = 0; L < count && aligned; L++) {
      const int32_t i0 = s.leaves[4 * (size_t)L], j0 = s.leaves[4 * (size_t)L + 1], l0 = s.leaves[4 * (size_t)L + 2];
      if (i0 % LEAF || j0 % LEAF || l0 % LEAF) aligned = false;
      else leafAt.insert((uint64_t)gIndex(i0, j0, l0), (uint32_t)L);
    }
    if (aligned) {
      std::fill(nearOpen.begin(), nearOpen.end(), 0);
      auto mark = [&](int64_t cell) {
        const int64_t c[3] = {cell % n0, (cell / n0) % n1, cell / (n0 * n1)};
        int64_t cand[3][3];
        int nc[3];
        for (int a = 0; a < 3; a++) {
          nc[a] = 0;
          cand[a][nc[a]++] = c[a] - c[a] % LEAF;
          if ((c[a] + 1) % LEAF == 0) cand[a][nc[a]++] = c[a] + 1;
          if (c[a] % LEAF == 0 && c[a] >= LEAF) cand[a][nc[a]++] = c[a] - LEAF;
        }
        for (int x = 0; x < nc[0]; x++) for (int y = 0; y < nc[1]; y++) for (int z = 0; z < nc[2]; z++) {
          if (const uint32_t* L = leafAt.find((uint64_t)gIndex(cand[0][x], cand[1][y], cand[2][z]))) nearOpen[*L] = 1;
        }
      };
      for (size_t r = 0; r < nr; r++) if (recs[r].open) {
        const uint64_t key = recs[r].key;
        const int dir = (int)(key % 8);
        cellsOfEdge((int64_t)((key - dir) / 8), dir, mark);
      }
    }
  }
  bool leafNearOpen = false;   // the current leaf's flag (pass 2)
  auto bordersOpen = [&](int64_t gLo, int dir) {
    if (!anyOpen || !leafNearOpen) return false;
    bool hit = false;
    cellsOfEdge(gLo, dir, [&](int64_t cell) { if (openCells.find((uint64_t)cell)) hit = true; });
    return hit;
  };

  // --- Pass 2: emission, cell by cell in meshStore's order. ---
  std::vector<uint8_t> masks((size_t)count * CELLS);
  for (int L = 0; L < count; L++) {
    const float* vals = s.vals.get() + (size_t)L * S3;
    uint8_t* mk = masks.data() + (size_t)L * CELLS;
    int iEnd, jEnd, lEnd;
    leafEnds(L, iEnd, jEnd, lEnd);
    for (int l = 0; l < lEnd; l++) for (int j = 0; j < jEnd; j++) for (int i = 0; i < iEnd; i++) {
      int m = 0;
      for (int c = 0; c < 8; c++) if ((double)vals[((l + ((c >> 2) & 1)) * S + j + ((c >> 1) & 1)) * S + i + (c & 1)] < 0) m |= 1 << c;
      mk[(l * LEAF + j) * LEAF + i] = (uint8_t)m;
    }
  }
  flat::Map<uint32_t> edgeVerts(1024);
  std::vector<uint32_t> localV(LOCAL_EDGES), localStamp(LOCAL_EDGES, 0);
  double CP[24], g[3], M[9];
  int negC[4], posC[4];
  // Plain vertices bordering a gap, held to their owner's skin: (v, L, gLo, dir, loInside) each.
  struct Plain { uint32_t v; int32_t L; int64_t gLo; int dir; bool loInside; };
  std::vector<Plain> plainCand;
  // Crossings toward an air node, solved afterwards: v, L, inside xyz, outside xyz.
  struct NodeCand { uint32_t v; int32_t L; double in[3], out[3]; };
  std::vector<NodeCand> nodeCand;
  std::map<std::pair<int64_t, int64_t>, uint32_t> nodeVerts;
  struct Node { int c; double val; int own; double x, y, z; int64_t id; };

  for (int L = 0; L < count; L++) {
    const int32_t i0 = s.leaves[4 * (size_t)L], j0 = s.leaves[4 * (size_t)L + 1], l0 = s.leaves[4 * (size_t)L + 2];
    const float* vals = s.vals.get() + (size_t)L * S3;
    const int8_t* lbl = s.owners.data() + (size_t)L * S3;
    const uint8_t* mk = masks.data() + (size_t)L * CELLS;
    const uint32_t stamp = (uint32_t)L + 1;
    leafNearOpen = nearOpen[L] != 0;
    auto at = [vals](int i, int j, int l) -> double { return vals[(l * S + j) * S + i]; };
    auto vertexOn = [&](int i, int j, int l, int ca, int cb) -> uint32_t {
      const int lo = ca & cb, dir = ca ^ cb;
      const int hi = lo | dir;
      const int li = i + (lo & 1), lj = j + ((lo >> 1) & 1), ll = l + ((lo >> 2) & 1);
      const int hi_i = i + (hi & 1), hi_j = j + ((hi >> 1) & 1), hi_l = l + ((hi >> 2) & 1);
      const bool face = (!(dir & 1) && (li == 0 || li == LEAF)) || (!(dir & 2) && (lj == 0 || lj == LEAF)) || (!(dir & 4) && (ll == 0 || ll == LEAF));
      const int lk = ((ll * S + lj) * S + li) * 8 + dir;
      const int64_t gLo = gIndex((int64_t)i0 + li, (int64_t)j0 + lj, (int64_t)l0 + ll);
      const uint64_t key = (uint64_t)gLo * 8 + (uint64_t)dir;
      if (face) {
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
      const bool loInside = a < 0;
      vertOwner.push_back(loInside ? lbl[(ll * S + lj) * S + li] : lbl[(hi_l * S + hi_j) * S + hi_i]);
      const bool held = bordersOpen(gLo, dir);
      ownerHeld.push_back(held ? 1 : 0);
      pinned.push_back(0);
      if (held) plainCand.push_back(Plain{v, L, gLo, dir, loInside});
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
    // mesher.js's tet(): plain marching tetrahedra on one Kuhn tet of the cell in CP.
    auto plainTet = [&](int i, int j, int l, int mask, const int* tet) {
      int nn = 0, np = 0;
      for (int q = 0; q < 4; q++) {
        const int c = tet[q];
        if ((mask >> c) & 1) negC[nn++] = c; else posC[np++] = c;
      }
      if (nn == 0 || nn == 4) return;
      for (int a = 0; a < 3; a++) {
        double sn = 0, sp = 0;
        for (int q = 0; q < nn; q++) sn += CP[3 * negC[q] + a];
        for (int q = 0; q < np; q++) sp += CP[3 * posC[q] + a];
        g[a] = sp / np - sn / nn;
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
    };
    // The vertex where sub-tet edge (a, b) crosses the field's zero (one end negative).
    auto crossing = [&](int i, int j, int l, const Node& a, const Node& b) -> uint32_t {
      if (a.c >= 0 && b.c >= 0) return vertexOn(i, j, l, a.c, b.c);   // an unsplit grid edge: the plain vertex
      const Node& inn = a.val < 0 ? a : b;
      const Node& outn = a.val < 0 ? b : a;
      const std::pair<int64_t, int64_t> key = inn.id < outn.id ? std::make_pair(inn.id, outn.id) : std::make_pair(outn.id, inn.id);
      auto found = nodeVerts.find(key);
      if (found != nodeVerts.end()) return found->second;
      const double t = inn.val / (inn.val - outn.val);   // a first guess; nodeCrossings solves it
      const uint32_t v = (uint32_t)(positions.size() / 3);
      positions.push_back(inn.x + (outn.x - inn.x) * t);
      positions.push_back(inn.y + (outn.y - inn.y) * t);
      positions.push_back(inn.z + (outn.z - inn.z) * t);
      vertLeaf.push_back(L); vertOwner.push_back(inn.own); ownerHeld.push_back(1); pinned.push_back(0);
      nodeVerts.emplace(key, v);
      nodeCand.push_back(NodeCand{v, L, {inn.x, inn.y, inn.z}, {outn.x, outn.y, outn.z}});
      return v;
    };
    // subTet: plain marching tetrahedra on one sub-tet's four nodes.
    auto subTet = [&](int i, int j, int l, const std::array<Node, 4>& nodes) {
      const Node* negN[4];
      const Node* posN[4];
      int nn = 0, np = 0;
      for (const Node& p : nodes) { if (p.val < 0) negN[nn++] = &p; else posN[np++] = &p; }
      if (nn == 0 || np == 0) return;
      double gv[3] = {0, 0, 0};
      for (int q = 0; q < np; q++) { gv[0] += posN[q]->x / np; gv[1] += posN[q]->y / np; gv[2] += posN[q]->z / np; }
      for (int q = 0; q < nn; q++) { gv[0] -= negN[q]->x / nn; gv[1] -= negN[q]->y / nn; gv[2] -= negN[q]->z / nn; }
      auto mid = [](const Node& a, const Node& b, double* out) { out[0] = (a.x + b.x) / 2; out[1] = (a.y + b.y) / 2; out[2] = (a.z + b.z) / 2; };
      auto stri = [&](const double* A, const double* B, const double* C, uint32_t a, uint32_t b, uint32_t c) {
        const double ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * gv[0] + ny * gv[1] + nz * gv[2] < 0) { indices.push_back(a); indices.push_back(c); indices.push_back(b); }
        else { indices.push_back(a); indices.push_back(b); indices.push_back(c); }
      };
      double m0[3], m1[3], m2[3];
      if (nn == 1 || nn == 3) {
        const Node& lone = nn == 1 ? *negN[0] : *posN[0];
        const Node* const* o = nn == 1 ? posN : negN;
        mid(lone, *o[0], m0); mid(lone, *o[1], m1); mid(lone, *o[2], m2);
        const uint32_t va = crossing(i, j, l, lone, *o[0]);
        const uint32_t vb = crossing(i, j, l, lone, *o[1]);
        const uint32_t vc = crossing(i, j, l, lone, *o[2]);
        stri(m0, m1, m2, va, vb, vc);
      } else {
        const Node &a0 = *negN[0], &a1 = *negN[1], &b0 = *posN[0], &b1 = *posN[1];
        const uint32_t v00 = crossing(i, j, l, a0, b0);
        const uint32_t v01 = crossing(i, j, l, a0, b1);
        const uint32_t v10 = crossing(i, j, l, a1, b0);
        const uint32_t v11 = crossing(i, j, l, a1, b1);
        mid(a0, b0, m0); mid(a0, b1, m1); mid(a1, b1, m2);
        stri(m0, m1, m2, v00, v01, v11);
        mid(a0, b0, m0); mid(a1, b1, m1); mid(a1, b0, m2);
        stri(m0, m1, m2, v00, v11, v10);
      }
    };
    auto cornerNode = [&](int i, int j, int l, int c) -> Node {
      return Node{c, (double)vals[sampleOf(i, j, l, c)], lab[c], CP[3 * c], CP[3 * c + 1], CP[3 * c + 2],
                  gIndex((int64_t)i0 + i + (c & 1), (int64_t)j0 + j + ((c >> 1) & 1), (int64_t)l0 + l + ((c >> 2) & 1)) * 2};
    };
    // Path 3: one tet of a refined cell. Its split edges are split in grid-edge-key order; a split
    // halves every sub-tet holding both of the edge's ends. False (nothing emitted) with none.
    std::vector<std::array<Node, 4>> subs, next;
    auto refineTet = [&](int i, int j, int l, const int* tet) -> bool {
      struct SplitEdge { uint64_t key; int ca, cb; uint32_t rec; };
      SplitEdge edges[6];
      int ne = 0;
      for (int a = 0; a < 4; a++) for (int b = a + 1; b < 4; b++) {
        const int ca = tet[a], cb = tet[b], lo = ca & cb;
        const uint64_t key = (uint64_t)gIndex((int64_t)i0 + i + (lo & 1), (int64_t)j0 + j + ((lo >> 1) & 1), (int64_t)l0 + l + ((lo >> 2) & 1)) * 8 + (uint64_t)(ca ^ cb);
        if (const uint32_t* r = splitAt.find(key)) edges[ne++] = SplitEdge{key, ca, cb, *r};
      }
      if (!ne) return false;
      std::stable_sort(edges, edges + ne, [](const SplitEdge& p, const SplitEdge& q) { return p.key < q.key; });
      subs.clear();
      subs.push_back({cornerNode(i, j, l, tet[0]), cornerNode(i, j, l, tet[1]), cornerNode(i, j, l, tet[2]), cornerNode(i, j, l, tet[3])});
      for (int q = 0; q < ne; q++) {
        const Rec& R = recs[edges[q].rec];
        const Node Mn{-1, R.val, OWNER_AIR, R.bis[0], R.bis[1], R.bis[2], (int64_t)R.key * 2 + 1};
        next.clear();
        for (const auto& sb : subs) {
          int ia = -1, ib = -1;
          for (int k = 0; k < 4; k++) { if (ia < 0 && sb[k].c == edges[q].ca) ia = k; if (ib < 0 && sb[k].c == edges[q].cb) ib = k; }
          if (ia < 0 || ib < 0) { next.push_back(sb); continue; }
          std::array<Node, 4> s1 = sb, s2 = sb;
          s1[ia] = Mn; s2[ib] = Mn;
          next.push_back(s1); next.push_back(s2);
        }
        subs.swap(next);
      }
      for (const auto& sb : subs) subTet(i, j, l, sb);
      return true;
    };
    int iEnd, jEnd, lEnd;
    leafEnds(L, iEnd, jEnd, lEnd);
    for (int l = 0; l < lEnd; l++) for (int j = 0; j < jEnd; j++) for (int i = 0; i < iEnd; i++) {
      const int mask = mk[(l * LEAF + j) * LEAF + i];
      const bool split = leafNearOpen && openCells.find((uint64_t)gIndex((int64_t)i0 + i, (int64_t)j0 + j, (int64_t)l0 + l)) != nullptr;
      if (!split && (mask == 0 || mask == 255)) continue;
      for (int c = 0; c < 8; c++) {
        CP[3 * c] = o0 + (double)(i0 + (i + (c & 1))) * edge;
        CP[3 * c + 1] = o1 + (double)(j0 + (j + ((c >> 1) & 1))) * edge;
        CP[3 * c + 2] = o2 + (double)(l0 + (l + ((c >> 2) & 1))) * edge;
      }
      if (!split) {
        for (const auto& tet : KUHN) plainTet(i, j, l, mask, tet);
        continue;
      }
      for (int c = 0; c < 8; c++) lab[c] = lbl[sampleOf(i, j, l, c)];
      for (const auto& tet : KUHN) if (!refineTet(i, j, l, tet)) plainTet(i, j, l, mask, tet);
    }
  }

  // placeHeldPlain: a plain vertex bordering a gap goes onto its owner's share zero along its grid
  // edge (inside end first) when that share changes sign along it and the field there is zero.
  if (!plainCand.empty()) {
    const size_t nc = plainCand.size();
    std::vector<double> A(3 * nc), B(3 * nc);
    for (size_t e = 0; e < nc; e++) {
      const uint64_t key = (uint64_t)plainCand[e].gLo * 8 + (uint64_t)plainCand[e].dir;
      const bool inLow = plainCand[e].loInside;
      keyPoint(key, inLow ? 0 : 1, &A[3 * e]); keyPoint(key, inLow ? 1 : 0, &B[3 * e]);
    }
    auto addAt = [&](size_t e, double t) {
      pts.add(lerp(A[3 * e], B[3 * e], t), lerp(A[3 * e + 1], B[3 * e + 1], t), lerp(A[3 * e + 2], B[3 * e + 2], t), leaf_prog(s, plainCand[e].L));
    };
    pts.clear();
    for (size_t e = 0; e < nc; e++) { addAt(e, 0); addAt(e, 1); }
    out.resize(2 * nc); shares.resize(2 * nc * K);
    if (eval_points(s, pts, out.data(), nullptr, nullptr, shares.data()) != 0) return 2;
    std::vector<size_t> list;
    std::vector<double> f0, f1;
    for (size_t e = 0; e < nc; e++) {
      const int o = vertOwner[plainCand[e].v];
      if (o < 0 || o >= K) return 6;
      if (shares[2 * e * K + o] < 0 && shares[(2 * e + 1) * K + o] > 0) { list.push_back(e); f0.push_back(shares[2 * e * K + o]); f1.push_back(shares[(2 * e + 1) * K + o]); }
    }
    const size_t cnt = list.size();
    std::vector<double> ts;
    if (cnt) {
      const int rc = solve_brackets(cnt, MAX_BRACKET_STEPS, [&](const uint32_t* lanes, const double* tq, size_t c, double* g) -> int {
        pts.clear();
        for (size_t k = 0; k < c; k++) addAt(list[lanes[k]], tq[k]);
        if (eval_points(s, pts, out.data(), nullptr, nullptr, shares.data()) != 0) return 2;
        for (size_t k = 0; k < c; k++) g[k] = shares[k * K + vertOwner[plainCand[list[lanes[k]]].v]];
        return 0;
      }, f0.data(), f1.data(), ts);
      if (rc != 0) return 2;
      pts.clear();
      for (size_t k = 0; k < cnt; k++) addAt(list[k], ts[k]);
      if (eval_points(s, pts, out.data(), nullptr, nullptr, nullptr) != 0) return 2;
    }
    for (size_t k = 0; k < cnt; k++) {
      if (!(std::fabs(out[k]) <= pinTol)) continue;
      const size_t e = list[k];
      const uint32_t v = plainCand[e].v;
      const double t = ts[k];
      for (int c = 0; c < 3; c++) positions[3 * (size_t)v + c] = A[3 * e + c] + (B[3 * e + c] - A[3 * e + c]) * t;
    }
  }

  // nodeCrossings: each crossing toward an air node goes onto the field's zero along its sub-tet
  // edge, and is pinned when another piece's cut is the clearance there.
  if (!nodeCand.empty()) {
    const size_t nc = nodeCand.size();
    auto addAt = [&](size_t e, double t) {
      const NodeCand& c = nodeCand[e];
      pts.add(lerp(c.in[0], c.out[0], t), lerp(c.in[1], c.out[1], t), lerp(c.in[2], c.out[2], t), leaf_prog(s, c.L));
    };
    pts.clear();
    for (size_t e = 0; e < nc; e++) { addAt(e, 0); addAt(e, 1); }
    out.resize(2 * nc); cuts.resize(2 * nc * K);
    if (eval_points(s, pts, out.data(), nullptr, nullptr, nullptr) != 0) return 2;
    std::vector<size_t> list;
    std::vector<double> f0, f1;
    for (size_t e = 0; e < nc; e++) if (out[2 * e] < 0 && out[2 * e + 1] > 0) { list.push_back(e); f0.push_back(out[2 * e]); f1.push_back(out[2 * e + 1]); }
    const size_t cnt = list.size();
    if (cnt) {
      std::vector<double> ts;
      const int rc = solve_brackets(cnt, MAX_BRACKET_STEPS, [&](const uint32_t* lanes, const double* tq, size_t c, double* g) -> int {
        pts.clear();
        for (size_t k = 0; k < c; k++) addAt(list[lanes[k]], tq[k]);
        if (eval_points(s, pts, out.data(), nullptr, nullptr, nullptr) != 0) return 2;
        for (size_t k = 0; k < c; k++) g[k] = out[k];
        return 0;
      }, f0.data(), f1.data(), ts);
      if (rc != 0) return 2;
      pts.clear();
      for (size_t k = 0; k < cnt; k++) addAt(list[k], ts[k]);
      if (eval_points(s, pts, out.data(), nullptr, cuts.data(), nullptr) != 0) return 2;
      for (size_t k = 0; k < cnt; k++) {
        const uint32_t v = nodeCand[list[k]].v;
        positions[3 * (size_t)v] = pts.X[k]; positions[3 * (size_t)v + 1] = pts.Y[k]; positions[3 * (size_t)v + 2] = pts.Z[k];
        const int X = vertOwner[v];
        for (int W = 0; W < K; W++) if (W != X && std::fabs(cuts[k * K + W] - cl) <= pinTol) pinned[v] = 1;
      }
    }
  }
  // Every later stage indexes the shares by a vertex's owner: one that is not a child index
  // below ownerK (a leaf whose program captured no piece) is left to the JS.
  for (const int32_t o : vertOwner) if (o < 0 || o >= K) { clear_owner_mesh(s); positions.clear(); indices.clear(); vertLeaf.clear(); return 6; }
  s.ownerMesh = true;
  s.meshed = true;
  return 0;
}

// ---------------------------------------------------------------------------
// crease (cutCreases)

int crease(ipe::Session& s) {
  if (!s.meshed || !s.ownerMesh || !s.contactSet || s.normals.size() != s.positions.size()) return 1;
  const int K = s.ownerK;
  const double edge = s.edge;
  std::vector<double>& P = s.positions;
  std::vector<double>& N = s.normals;
  std::vector<int32_t>& VL = s.vertLeaf;
  std::vector<int32_t>& VO = s.vertOwner;
  std::vector<uint8_t>& VH = s.ownerHeld;
  std::vector<uint8_t>& VP = s.pinned;
  const std::vector<double>& att = s.att;
  const size_t nv0 = P.size() / 3;
  Points pts;
  std::vector<double> out, shares;
  std::vector<int32_t> piece;

  // 1. Re-own the free vertices (not held, not pinned): the piece at the final position.
  {
    std::vector<uint32_t> idx;
    for (size_t v = 0; v < nv0; v++) if (!VH[v] && !VP[v]) { pts.add(P[3 * v], P[3 * v + 1], P[3 * v + 2], leaf_prog(s, VL[v])); idx.push_back((uint32_t)v); }
    out.resize(idx.size()); piece.resize(idx.size());
    if (eval_points(s, pts, out.data(), piece.data(), nullptr, nullptr) != 0) return 2;
    for (size_t q = 0; q < idx.size(); q++) if (piece[q] >= 0) VO[idx[q]] = piece[q];
  }

  // The edges whose ends (neither pinned) differ in owner, in first-seen order.
  struct Edge { uint32_t a, b; int X, Y; };
  std::vector<Edge> list;
  {
    flat::Map<uint8_t> seen(1024);
    const std::vector<uint32_t>& T = s.indices;
    for (size_t t = 0; t < T.size(); t += 3) for (int k = 0; k < 3; k++) {
      const uint32_t a = T[t + k], b = T[t + (k + 1) % 3];
      if (VO[a] == VO[b] || VP[a] || VP[b]) continue;
      const uint32_t lo = a < b ? a : b, hi = a < b ? b : a;
      bool inserted = false;
      seen.insert((uint64_t)lo * nv0 + hi, 1, &inserted);
      if (inserted) list.push_back(Edge{lo, hi, VO[lo], VO[hi]});
    }
  }
  const size_t ne = list.size();
  auto along = [&](const Edge& e, double t, double* p) { for (int k = 0; k < 3; k++) p[k] = P[3 * (size_t)e.a + k] + (P[3 * (size_t)e.b + k] - P[3 * (size_t)e.a + k]) * t; };

  // 2. Where on each edge the two shares are equal.
  std::vector<int32_t> leafOfEdge(ne);
  for (size_t q = 0; q < ne; q++) leafOfEdge[q] = VL[list[q].a];
  std::vector<double> params;
  if (ne) {
    pts.clear();
    double p[3];
    for (size_t q = 0; q < ne; q++) { along(list[q], 0.5, p); pts.add(p[0], p[1], p[2], leaf_prog(s, leafOfEdge[q])); }
    out.resize(ne); shares.resize(ne * K);
    if (eval_points(s, pts, out.data(), nullptr, nullptr, shares.data()) != 0) return 2;
    for (size_t q = 0; q < ne; q++) {
      if (!std::isfinite(shares[q * K + list[q].X]) || !std::isfinite(shares[q * K + list[q].Y])) leafOfEdge[q] = VL[list[q].b];
    }
    // s_X - s_Y along each edge (NaN, a pruned share, to the high side).
    out.resize(2 * ne); shares.resize(2 * ne * K);
    const int rc = solve_brackets(ne, MAX_BRACKET_STEPS, [&](const uint32_t* lanes, const double* ts, size_t c, double* g) -> int {
      pts.clear();
      for (size_t k = 0; k < c; k++) { along(list[lanes[k]], ts[k], p); pts.add(p[0], p[1], p[2], leaf_prog(s, leafOfEdge[lanes[k]])); }
      if (eval_points(s, pts, out.data(), nullptr, nullptr, shares.data()) != 0) return 2;
      for (size_t k = 0; k < c; k++) { const Edge& e = list[lanes[k]]; g[k] = shares[k * K + e.X] - shares[k * K + e.Y]; }
      return 0;
    }, nullptr, nullptr, params);
    if (rc != 0) return 2;
  }

  // 3. Each crossing (not where its pair is attached) is taken onto the crease before anything is cut.
  struct Cand { size_t q; double p0[3], p[3], pn[3]; bool hasPn; int32_t leaf; };
  std::vector<Cand> cand;
  for (size_t q = 0; q < ne; q++) {
    const Edge& e = list[q];
    Cand c;
    c.q = q;
    along(e, params[q], c.p0);
    if (pairWeight(att, e.X, e.Y, c.p0[0], c.p0[1], c.p0[2]) > 0) continue;
    for (int k = 0; k < 3; k++) c.p[k] = c.p0[k];
    // planeFor: the plane holding the edge and its surface normal.
    const double ux = P[3 * (size_t)e.b] - P[3 * (size_t)e.a], uy = P[3 * (size_t)e.b + 1] - P[3 * (size_t)e.a + 1], uz = P[3 * (size_t)e.b + 2] - P[3 * (size_t)e.a + 2];
    const double nx = N[3 * (size_t)e.a] + N[3 * (size_t)e.b], ny = N[3 * (size_t)e.a + 1] + N[3 * (size_t)e.b + 1], nz = N[3 * (size_t)e.a + 2] + N[3 * (size_t)e.b + 2];
    const double px = uy * nz - uz * ny, py = uz * nx - ux * nz, pz = ux * ny - uy * nx, pl = std::sqrt(px * px + py * py + pz * pz);
    c.hasPn = pl > 1e-9 * (ux * ux + uy * uy + uz * uz + 1);
    if (c.hasPn) { c.pn[0] = px / pl; c.pn[1] = py / pl; c.pn[2] = pz / pl; } else { c.pn[0] = c.pn[1] = c.pn[2] = 0; }
    c.leaf = leafOfEdge[q];
    cand.push_back(c);
  }
  const double h = 0.02 * edge, cap = MAX_MOVE_CELLS * edge;
  auto det3 = [](const double* a, const double* b, const double* c) {
    return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  };
  auto solve = [&](const std::vector<size_t>& sub) -> int {
    const size_t m = sub.size();
    out.resize(7 * m); shares.resize(7 * m * K);
    for (int it = 0; it < NEWTON_STEPS && m; it++) {
      pts.clear();
      for (size_t q = 0; q < m; q++) {
        const Cand& c = cand[sub[q]];
        const double x = c.p[0], y = c.p[1], z = c.p[2];
        const int32_t pr = leaf_prog(s, c.leaf);
        pts.add(x, y, z, pr); pts.add(x + h, y, z, pr); pts.add(x - h, y, z, pr); pts.add(x, y + h, z, pr);
        pts.add(x, y - h, z, pr); pts.add(x, y, z + h, pr); pts.add(x, y, z - h, pr);
      }
      if (eval_points(s, pts, out.data(), nullptr, nullptr, shares.data()) != 0) return 2;
      for (size_t q = 0; q < m; q++) {
        Cand& c = cand[sub[q]];
        const int X = list[c.q].X, Y = list[c.q].Y;
        // s_X = 0 and s_X = s_Y: both rows smooth.
        double F[7][2];
        for (int k = 0; k < 7; k++) { const size_t o = 7 * q + k; F[k][0] = shares[o * K + X]; F[k][1] = shares[o * K + X] - shares[o * K + Y]; }
        double ja[3], jb[3];
        for (int ax = 0; ax < 3; ax++) {
          ja[ax] = (F[1 + 2 * ax][0] - F[2 + 2 * ax][0]) / (2 * h);
          jb[ax] = (F[1 + 2 * ax][1] - F[2 + 2 * ax][1]) / (2 * h);
        }
        double dx[3];
        bool have = false;
        if (c.hasPn) {   // s_X = 0, s_X = s_Y and the plane: a 3x3 solve (Cramer's rule)
          const double* pn = c.pn;
          const double r2 = -((c.p[0] - c.p0[0]) * pn[0] + (c.p[1] - c.p0[1]) * pn[1] + (c.p[2] - c.p0[2]) * pn[2]);
          const double D = det3(ja, jb, pn), scale = std::sqrt((ja[0] * ja[0] + ja[1] * ja[1] + ja[2] * ja[2]) * (jb[0] * jb[0] + jb[1] * jb[1] + jb[2] * jb[2]));
          if (std::fabs(D) > 1e-6 * scale) {
            const double rhs[3] = {-F[0][0], -F[0][1], r2};
            const double* rows[3] = {ja, jb, pn};
            for (int k = 0; k < 3; k++) {
              double R[3][3];
              for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) R[i][j] = j == k ? rhs[i] : rows[i][j];
              dx[k] = det3(R[0], R[1], R[2]) / D;
            }
            have = true;
          }
        }
        if (!have) {   // no plane, or the crease runs within it: the minimal-norm step
          const double aa = ja[0] * ja[0] + ja[1] * ja[1] + ja[2] * ja[2], bb = jb[0] * jb[0] + jb[1] * jb[1] + jb[2] * jb[2], ab = ja[0] * jb[0] + ja[1] * jb[1] + ja[2] * jb[2];
          const double det = aa * bb - ab * ab;
          if (!(det > 1e-12)) continue;
          const double l0 = ((-F[0][0]) * bb + F[0][1] * ab) / det, l1 = ((-F[0][1]) * aa + F[0][0] * ab) / det;
          for (int k = 0; k < 3; k++) dx[k] = ja[k] * l0 + jb[k] * l1;
        }
        const double len = std::sqrt(dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]);
        if (!std::isfinite(len)) continue;
        const double sc = len > cap ? cap / len : 1;
        for (int k = 0; k < 3; k++) c.p[k] += dx[k] * sc;
      }
    }
    return 0;
  };
  // On the surface, the two shares equal and making the field, outside the pair's attachment.
  auto judge = [&](const std::vector<size_t>& sub, std::vector<uint8_t>& ok) -> int {
    const size_t m = sub.size();
    ok.assign(m, 0);
    if (!m) return 0;
    pts.clear();
    for (size_t q = 0; q < m; q++) { const Cand& c = cand[sub[q]]; pts.add(c.p[0], c.p[1], c.p[2], leaf_prog(s, c.leaf)); }
    out.resize(m); shares.resize(m * K);
    if (eval_points(s, pts, out.data(), nullptr, nullptr, shares.data()) != 0) return 2;
    const double tol = s.creaseTol * edge;
    for (size_t q = 0; q < m; q++) {
      const Cand& c = cand[sub[q]];
      const int X = list[c.q].X, Y = list[c.q].Y;
      const double sX = shares[q * K + X], sY = shares[q * K + Y], d = out[q];
      ok[q] = std::fabs(d) <= tol && std::fabs(sX - sY) <= tol && std::fabs(sX - d) <= tol && !(pairWeight(att, X, Y, c.p[0], c.p[1], c.p[2]) > 0) ? 1 : 0;
    }
    return 0;
  };
  std::vector<size_t> all(cand.size());
  for (size_t q = 0; q < cand.size(); q++) all[q] = q;
  if (solve(all) != 0) return 2;
  std::vector<uint8_t> reached;
  if (judge(all, reached) != 0) return 2;
  // A crossing the planar solve could not bring onto the crease is tried again without the plane.
  std::vector<size_t> retry;
  for (size_t q = 0; q < cand.size(); q++) {
    if (!reached[q] && cand[q].hasPn) {
      Cand& c = cand[q];
      for (int k = 0; k < 3; k++) c.p[k] = c.p0[k];
      c.hasPn = false;
      retry.push_back(q);
    }
  }
  if (!retry.empty()) {
    if (solve(retry) != 0) return 2;
    std::vector<uint8_t> ok;
    if (judge(retry, ok) != 0) return 2;
    for (size_t i = 0; i < retry.size(); i++) reached[retry[i]] = ok[i];
  }

  // 4. Cut: a crease point within CREASE_SNAP of an edge end moves that end (once), else it
  //    splits the edge (not beside a moved end).
  std::vector<uint8_t> creaseV(nv0, 0), snapped(nv0, 0);
  const double snap = s.creaseSnap;
  for (size_t q = 0; q < cand.size(); q++) {
    if (!reached[q]) continue;
    const Cand& c = cand[q];
    const double t = params[c.q];
    const int64_t v = t < snap ? (int64_t)list[c.q].a : t > 1 - snap ? (int64_t)list[c.q].b : -1;
    if (v < 0 || snapped[(size_t)v]) continue;
    snapped[(size_t)v] = 1; creaseV[(size_t)v] = 1; VH[(size_t)v] = 0;
    P[3 * v] = c.p[0]; P[3 * v + 1] = c.p[1]; P[3 * v + 2] = c.p[2];
  }
  flat::Map<uint32_t> splitOf(64);
  for (size_t q = 0; q < cand.size(); q++) {
    const Cand& c = cand[q];
    const double t = params[c.q];
    const Edge& e = list[c.q];
    if (!reached[q] || t < snap || t > 1 - snap || snapped[e.a] || snapped[e.b]) continue;
    const uint32_t v = (uint32_t)(P.size() / 3);
    P.push_back(c.p[0]); P.push_back(c.p[1]); P.push_back(c.p[2]);
    VL.push_back(VL[e.a]); VO.push_back(VO[e.a]); VH.push_back(0); VP.push_back(0); creaseV.push_back(1);
    const double nx = N[3 * (size_t)e.a] + N[3 * (size_t)e.b], ny = N[3 * (size_t)e.a + 1] + N[3 * (size_t)e.b + 1], nz = N[3 * (size_t)e.a + 2] + N[3 * (size_t)e.b + 2];
    double nl = std::sqrt(nx * nx + ny * ny + nz * nz);
    if (nl == 0 || std::isnan(nl)) nl = 1;   // `|| 1`
    N.push_back(nx / nl); N.push_back(ny / nl); N.push_back(nz / nl);
    splitOf.insert((uint64_t)e.a * nv0 + e.b, v);
  }

  // 5. Re-triangulate by how many of a triangle's edges were split.
  const std::vector<uint32_t>& T = s.indices;
  std::vector<uint32_t> outT;
  outT.reserve(T.size() + 12 * splitOf.size());
  auto split = [&](uint32_t a, uint32_t b) -> int64_t {
    const uint32_t* m = splitOf.find(a < b ? (uint64_t)a * nv0 + b : (uint64_t)b * nv0 + a);
    return m ? (int64_t)*m : -1;
  };
  for (size_t t = 0; t < T.size(); t += 3) {
    const uint32_t v[3] = {T[t], T[t + 1], T[t + 2]};
    const int64_t sp[3] = {split(v[0], v[1]), split(v[1], v[2]), split(v[2], v[0])};
    const int ns = (sp[0] >= 0) + (sp[1] >= 0) + (sp[2] >= 0);
    if (ns == 0) { outT.push_back(v[0]); outT.push_back(v[1]); outT.push_back(v[2]); continue; }
    if (ns == 3) {
      const int64_t q[12] = {v[0], sp[0], sp[2], sp[0], v[1], sp[1], sp[2], sp[1], v[2], sp[0], sp[1], sp[2]};
      for (int i = 0; i < 12; i++) outT.push_back((uint32_t)q[i]);
    } else if (ns == 1) {
      const int i = sp[0] >= 0 ? 0 : sp[1] >= 0 ? 1 : 2;
      const int64_t a = v[i], b = v[(i + 1) % 3], c = v[(i + 2) % 3], m = sp[i];
      const int64_t q[6] = {a, m, c, m, b, c};
      for (int k = 0; k < 6; k++) outT.push_back((uint32_t)q[k]);
    } else {   // the unsplit edge is (a, b); the splits are on bc and ca
      const int fr = sp[0] < 0 ? 0 : sp[1] < 0 ? 1 : 2;
      const int64_t a = v[fr], b = v[(fr + 1) % 3], c = v[(fr + 2) % 3], mbc = sp[(fr + 1) % 3], mca = sp[(fr + 2) % 3];
      const int64_t q[9] = {a, b, mbc, a, mbc, mca, mca, mbc, c};
      for (int k = 0; k < 9; k++) outT.push_back((uint32_t)q[k]);
    }
  }
  s.indices.swap(outT);
  s.creaseMark.swap(creaseV);
  s.hasCrease = true;
  return 0;
}

// ---------------------------------------------------------------------------
// untangle

namespace {

// A JS Set of small integers, in insertion order: append when absent, erase in place.
inline bool has(const std::vector<uint32_t>& v, uint32_t x) { return std::find(v.begin(), v.end(), x) != v.end(); }
inline void setAdd(std::vector<uint32_t>& v, uint32_t x) { if (!has(v, x)) v.push_back(x); }
inline void setDel(std::vector<uint32_t>& v, uint32_t x) { auto it = std::find(v.begin(), v.end(), x); if (it != v.end()) v.erase(it); }

struct Untangle {
  ipe::Session& s;
  int K;
  double edge, eps;
  std::vector<double>& P;
  std::vector<double>& N;
  std::vector<int32_t>& VL;
  std::vector<int32_t>& VO;
  std::vector<uint8_t>& CR;
  std::vector<uint8_t>& PIN;
  std::vector<uint8_t>& HELD;
  std::vector<uint32_t>& T;
  std::vector<uint8_t> alive;
  std::vector<std::vector<uint32_t>> fans;   // vertex -> triangles (Set order), linked ones only
  flat::Map<uint32_t> edgeIdx{1024};         // edge key -> its list in edgeLists
  std::vector<std::vector<uint32_t>> edgeLists;
  Points pts;
  std::vector<double> out, shares;
  int rc = 0;

  explicit Untangle(ipe::Session& ss)
      : s(ss), K(ss.ownerK), edge(ss.edge), eps(FLIP_PROBE * ss.edge), P(ss.positions), N(ss.normals), VL(ss.vertLeaf), VO(ss.vertOwner),
        CR(ss.creaseMark), PIN(ss.pinned), HELD(ss.ownerHeld), T(ss.indices) {}

  static uint64_t edgeKey(uint32_t a, uint32_t b) { return a < b ? ((uint64_t)a << 32) | b : ((uint64_t)b << 32) | a; }
  Tri triOf(uint32_t t) const { return Tri{T[3 * (size_t)t], T[3 * (size_t)t + 1], T[3 * (size_t)t + 2]}; }
  void setTri(uint32_t t, const Tri& x) { T[3 * (size_t)t] = x[0]; T[3 * (size_t)t + 1] = x[1]; T[3 * (size_t)t + 2] = x[2]; }
  void normalOf(const Tri& x, double* n) const {
    const uint32_t a = x[0], b = x[1], c = x[2];
    const double ux = P[3 * (size_t)b] - P[3 * (size_t)a], uy = P[3 * (size_t)b + 1] - P[3 * (size_t)a + 1], uz = P[3 * (size_t)b + 2] - P[3 * (size_t)a + 2];
    const double vx = P[3 * (size_t)c] - P[3 * (size_t)a], vy = P[3 * (size_t)c + 1] - P[3 * (size_t)a + 1], vz = P[3 * (size_t)c + 2] - P[3 * (size_t)a + 2];
    const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = std::sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 0) { n[0] = nx / l; n[1] = ny / l; n[2] = nz / l; } else { n[0] = n[1] = n[2] = 0; }
  }
  static double dot(const double* p, const double* r) { return p[0] * r[0] + p[1] * r[1] + p[2] * r[2]; }
  int ownerOf(const Tri& x) const {
    int o = -1;
    for (const uint32_t v : x) { if (CR[v]) continue; if (o == -1) o = VO[v]; else if (VO[v] != o) return -1; }
    return o;
  }
  std::vector<uint32_t>* edgeList(uint64_t key) {
    const uint32_t* i = edgeIdx.find(key);
    return i ? &edgeLists[*i] : nullptr;
  }
  bool edgeHas(uint64_t key) { const std::vector<uint32_t>* l = edgeList(key); return l && !l->empty(); }
  void link(uint32_t t) {
    for (int k = 0; k < 3; k++) {
      const uint64_t key = edgeKey(T[3 * (size_t)t + k], T[3 * (size_t)t + (k + 1) % 3]);
      bool inserted = false;
      const uint32_t i = edgeIdx.insert(key, (uint32_t)edgeLists.size(), &inserted);
      if (inserted) edgeLists.emplace_back();
      edgeLists[i].push_back(t);
      setAdd(fans[T[3 * (size_t)t + k]], t);
    }
  }
  // A triangle edge with no list, or an empty one (the JS deletes an emptied list, so its
  // byEdge.get would be undefined and its splice throw), means the edge table no longer matches
  // the triangles: refuse (rc 3) rather than dereference null or erase end() − 1 of an empty
  // list, so ip_untangle answers nonzero and meshImplicit re-runs the mesh in JS. Callers check
  // rc right after their unlinks, before mutating anything else.
  void unlink(uint32_t t) {
    for (int k = 0; k < 3; k++) {
      std::vector<uint32_t>* lp = edgeList(edgeKey(T[3 * (size_t)t + k], T[3 * (size_t)t + (k + 1) % 3]));
      if (!lp || lp->empty()) { rc = 3; return; }
      std::vector<uint32_t>& l = *lp;
      auto it = std::find(l.begin(), l.end(), t);
      if (it == l.end()) it = l.end() - 1;   // splice(indexOf(t) = -1, 1) drops the last
      l.erase(it);
      setDel(fans[T[3 * (size_t)t + k]], t);
    }
  }
  void ring(uint32_t v, std::vector<uint32_t>& r) const {
    r.clear();
    for (const uint32_t t : fans[v]) for (int k = 0; k < 3; k++) { const uint32_t w = T[3 * (size_t)t + k]; if (w != v) setAdd(r, w); }
  }
  bool nearCrease(uint32_t v) const {
    std::vector<uint32_t> r;
    ring(v, r);
    for (const uint32_t w : r) if (CR[w]) return true;
    return false;
  }

  // Which of `tris` flip (the field, or the owner's share, steps the wrong way across them).
  void flipped(const std::vector<Tri>& tris, std::vector<uint8_t>& res) {
    const size_t m = tris.size();
    res.assign(m, 0);
    if (!m || rc) return;
    std::vector<double> pp(6 * m);
    pts.clear();
    for (size_t q = 0; q < m; q++) {
      const Tri& x = tris[q];
      double n[3];
      normalOf(x, n);
      for (int k = 0; k < 3; k++) {
        const double c = (P[3 * (size_t)x[0] + k] + P[3 * (size_t)x[1] + k] + P[3 * (size_t)x[2] + k]) / 3;
        pp[6 * q + k] = c + eps * n[k]; pp[6 * q + 3 + k] = c - eps * n[k];
      }
      const int32_t pr = leaf_prog(s, VL[x[0]]);
      pts.add(pp[6 * q], pp[6 * q + 1], pp[6 * q + 2], pr);
      pts.add(pp[6 * q + 3], pp[6 * q + 4], pp[6 * q + 5], pr);
    }
    std::vector<double> d(2 * m), sh(2 * m * K);
    if (eval_points(s, pts, d.data(), nullptr, nullptr, sh.data()) != 0) { rc = 2; return; }
    // A share pruned from the first corner's leaf program: read again with the next corner's.
    std::vector<int> owners(m);
    for (size_t q = 0; q < m; q++) owners[q] = ownerOf(tris[q]);
    for (int k = 1; k < 3; k++) {
      std::vector<size_t> redo;
      for (size_t q = 0; q < m; q++) {
        const int o = owners[q];
        if (o >= 0 && !(std::isfinite(sh[2 * q * K + o]) && std::isfinite(sh[(2 * q + 1) * K + o]))) redo.push_back(q);
      }
      if (redo.empty()) break;
      pts.clear();
      for (const size_t q : redo) {
        const int32_t pr = leaf_prog(s, VL[tris[q][k]]);
        pts.add(pp[6 * q], pp[6 * q + 1], pp[6 * q + 2], pr);
        pts.add(pp[6 * q + 3], pp[6 * q + 4], pp[6 * q + 5], pr);
      }
      std::vector<double> d2(2 * redo.size()), sh2(2 * redo.size() * K);
      if (eval_points(s, pts, d2.data(), nullptr, nullptr, sh2.data()) != 0) { rc = 2; return; }
      for (size_t i = 0; i < redo.size(); i++) {
        const size_t q = redo[i];
        for (int s2 = 0; s2 < 2; s2++) {
          d[2 * q + s2] = d2[2 * i + s2];
          for (int j = 0; j < K; j++) sh[(2 * q + s2) * K + j] = sh2[(2 * i + s2) * K + j];
        }
      }
    }
    for (size_t q = 0; q < m; q++) {
      const int o = owners[q];
      const double f0 = o >= 0 ? sh[2 * q * K + o] : d[2 * q], f1 = o >= 0 ? sh[(2 * q + 1) * K + o] : d[2 * q + 1];
      res[q] = f0 < f1 ? 1 : 0;
    }
  }

  // How many of the triangles' edges fold: against another of them, or against a live linked
  // triangle across the edge that is not among `gone`.
  int foldCount(const std::vector<Tri>& tris, const std::vector<uint32_t>& gone) {
    const size_t m = tris.size();
    std::vector<double> ns(3 * m);
    for (size_t i = 0; i < m; i++) normalOf(tris[i], &ns[3 * i]);
    int n = 0;
    double nw[3];
    for (size_t i = 0; i < m; i++) for (int k = 0; k < 3; k++) {
      const uint32_t x = tris[i][k], y = tris[i][(k + 1) % 3];
      for (size_t j = 0; j < m; j++) {
        if (j == i) continue;
        const Tri& tj = tris[j];
        const bool hx = tj[0] == x || tj[1] == x || tj[2] == x, hy = tj[0] == y || tj[1] == y || tj[2] == y;
        if (hx && hy && dot(&ns[3 * i], &ns[3 * j]) < FOLD_COS) n++;
      }
      if (const std::vector<uint32_t>* l = edgeList(edgeKey(x, y))) {
        for (const uint32_t w : *l) {
          if (has(gone, w)) continue;
          normalOf(triOf(w), nw);
          if (dot(&ns[3 * i], nw) < FOLD_COS) n++;
        }
      }
    }
    return n;
  }
  static bool accept(int fB, int fA, int oB, int oA) { return fA < fB || (fA == fB && oA < oB); }
  // `isIn(t)`: membership in the flipped set the change is judged against.
  template <class In>
  bool better(const std::vector<uint32_t>& oldIds, const std::vector<Tri>& tris, int flipsAfter, In isIn) {
    int fB = 0;
    std::vector<Tri> oldTris;
    for (const uint32_t t : oldIds) { if (isIn(t)) fB++; oldTris.push_back(triOf(t)); }
    const int foldB = foldCount(oldTris, oldIds), foldA = foldCount(tris, oldIds);
    return accept(fB, flipsAfter, foldB, foldA);
  }
  std::vector<uint32_t> isBad(const std::vector<uint32_t>& ts) {
    std::vector<uint32_t> live;
    for (const uint32_t t : ts) if (alive[t]) live.push_back(t);
    std::vector<Tri> tris;
    for (const uint32_t t : live) tris.push_back(triOf(t));
    std::vector<uint8_t> f;
    flipped(tris, f);
    std::vector<uint32_t> r;
    for (size_t q = 0; q < live.size(); q++) if (f[q]) r.push_back(live[q]);
    return r;
  }

  // crease.js's projectOnShare: four Newton steps onto each point's owner's share (the field's
  // for owner -1), each at most min(0.25 * edge, 2 * |value|).
  void projectOnShare(std::vector<std::array<double, 3>>& pp, const std::vector<int32_t>& leaves, const std::vector<int>& owners) {
    const double h = 0.05 * edge, cap = 0.25 * edge;
    const size_t m = pp.size();
    std::vector<double> d(7 * m), sh(7 * m * K);
    for (int it = 0; it < 4; it++) {
      pts.clear();
      for (size_t i = 0; i < m; i++) {
        const double x = pp[i][0], y = pp[i][1], z = pp[i][2];
        const int32_t pr = leaf_prog(s, leaves[i]);
        pts.add(x, y, z, pr); pts.add(x + h, y, z, pr); pts.add(x - h, y, z, pr); pts.add(x, y + h, z, pr);
        pts.add(x, y - h, z, pr); pts.add(x, y, z + h, pr); pts.add(x, y, z - h, pr);
      }
      if (eval_points(s, pts, d.data(), nullptr, nullptr, sh.data()) != 0) { rc = 2; return; }
      for (size_t i = 0; i < m; i++) {
        const int o = owners[i];
        auto f = [&](int k) { return o < 0 ? d[7 * i + k] : sh[(7 * i + k) * K + o]; };
        const double dv = f(0);
        const double g[3] = {(f(1) - f(2)) / (2 * h), (f(3) - f(4)) / (2 * h), (f(5) - f(6)) / (2 * h)};
        const double gl = jsmath::hypot3(g[0], g[1], g[2]);
        if (!(gl > 1e-9) || !std::isfinite(dv)) continue;
        double t = dv / gl;
        const double lim = jsmin(cap, 2 * std::fabs(dv));
        if (t > lim) t = lim; else if (t < -lim) t = -lim;
        for (int k = 0; k < 3; k++) pp[i][k] -= (g[k] / gl) * t;
      }
    }
  }

  int run();
};

int Untangle::run() {
  const size_t nt0 = T.size() / 3, nvAll = P.size() / 3;
  alive.assign(nt0, 1);
  // Probed: every triangle at a seam, and elsewhere one turned from a corner's normal.
  std::vector<uint32_t> suspects;
  for (size_t t = 0; t < nt0; t++) {
    const Tri x = triOf((uint32_t)t);
    double n[3];
    normalOf(x, n);
    if (CR[x[0]] || CR[x[1]] || CR[x[2]] || HELD[x[0]] || HELD[x[1]] || HELD[x[2]] || VO[x[0]] != VO[x[1]] || VO[x[1]] != VO[x[2]]) { suspects.push_back((uint32_t)t); continue; }
    for (const uint32_t v : x) {
      const double* nv = &N[3 * (size_t)v];
      if (dot(n, nv) < SUSPECT_COS * jsmath::hypot3(nv[0], nv[1], nv[2])) { suspects.push_back((uint32_t)t); break; }
    }
  }
  std::vector<uint32_t> bad = isBad(suspects);
  if (rc) return rc;
  if (bad.empty()) return 0;
  fans.assign(nvAll, {});
  // The original vertex -> triangle table (CSR); `linked` marks triangles in the adjacency.
  std::vector<uint32_t> vStart(nvAll + 1, 0), vTris(T.size());
  for (size_t i = 0; i < T.size(); i++) vStart[T[i] + 1]++;
  for (size_t v = 0; v < nvAll; v++) vStart[v + 1] += vStart[v];
  {
    std::vector<uint32_t> fillAt(vStart.begin(), vStart.end() - 1);
    for (size_t t = 0; t < nt0; t++) for (int k = 0; k < 3; k++) vTris[fillAt[T[3 * t + k]]++] = (uint32_t)t;
  }
  std::vector<uint8_t> linked(nt0, 0);
  std::vector<uint32_t> seen(nvAll, 0);
  uint32_t seenStamp = 0;
  auto grow = [&](const std::vector<uint32_t>& seeds, int rings) {
    seenStamp++;
    std::vector<uint32_t> front, next, around;
    for (const uint32_t t : seeds) for (const uint32_t v : triOf(t)) if (seen[v] != seenStamp) { seen[v] = seenStamp; front.push_back(v); }
    for (int r = 0; r <= rings && !front.empty(); r++) {
      next.clear();
      for (const uint32_t v : front) {
        around = fans[v];
        for (uint32_t q = vStart[v]; q < vStart[v + 1]; q++) {
          const uint32_t t = vTris[q];
          if (!linked[t] && alive[t]) { linked[t] = 1; link(t); }
          around.push_back(t);
        }
        for (const uint32_t t : around) if (alive[t]) for (const uint32_t w : triOf(t)) if (seen[w] != seenStamp) { seen[w] = seenStamp; next.push_back(w); }
      }
      front.swap(next);
    }
  };
  // Stamped membership for the per-round sets of triangles / vertices.
  std::vector<uint32_t> touchedMark(nt0, 0), setMark(nt0, 0), claimedT(nt0, 0), claimedV(nvAll, 0), dedupe(nt0, 0);
  uint32_t touchedStamp = 0, setStamp = 0, claimStamp = 0, dedupeStamp = 0;
  std::vector<uint32_t> touched;   // insertion order
  auto touch = [&](uint32_t t) { if (touchedMark[t] != touchedStamp) { touchedMark[t] = touchedStamp; touched.push_back(t); } };
  auto isTouched = [&](uint32_t t) { return touchedMark[t] == touchedStamp; };
  auto markSet = [&](const std::vector<uint32_t>& ts) { setStamp++; for (const uint32_t t : ts) setMark[t] = setStamp; };
  auto inSet = [&](uint32_t t) { return setMark[t] == setStamp; };
  std::vector<uint32_t> rk, rg, r;
  std::vector<uint8_t> f;

  grow(bad, REGION_RINGS);
  for (int round = 0; round < UNTANGLE_ROUNDS && !bad.empty(); round++) {
    grow(bad, REGROW_RINGS);
    touchedStamp++;
    touched.clear();
    bool changed = false;
    // 1. Swaps.
    struct Swap { uint32_t t, u; Tri tris[2]; };
    std::vector<Swap> swaps;
    for (const uint32_t t : bad) for (int k = 0; k < 3; k++) {
      const uint32_t a = T[3 * (size_t)t + k], b = T[3 * (size_t)t + (k + 1) % 3], c = T[3 * (size_t)t + (k + 2) % 3];
      if (CR[a] && CR[b]) continue;
      const std::vector<uint32_t>* l = edgeList(edgeKey(a, b));
      if (!l || l->size() != 2) continue;
      const uint32_t u = (*l)[0] == t ? (*l)[1] : (*l)[0];
      int64_t d = -1;
      for (int j = 0; j < 3; j++) if (T[3 * (size_t)u + j] == b && T[3 * (size_t)u + (j + 1) % 3] == a) d = T[3 * (size_t)u + (j + 2) % 3];
      if (d < 0 || d == c || edgeHas(edgeKey(c, (uint32_t)d))) continue;
      swaps.push_back(Swap{t, u, {Tri{a, (uint32_t)d, c}, Tri{(uint32_t)d, b, c}}});
    }
    {
      std::vector<Tri> all;
      for (const Swap& sw : swaps) { all.push_back(sw.tris[0]); all.push_back(sw.tris[1]); }
      flipped(all, f);
      if (rc) return rc;
    }
    markSet(bad);
    for (size_t q = 0; q < swaps.size(); q++) {
      const Swap& sw = swaps[q];
      if (isTouched(sw.t) || isTouched(sw.u)) continue;
      if (!better({sw.t, sw.u}, {sw.tris[0], sw.tris[1]}, f[2 * q] + f[2 * q + 1], inSet)) continue;
      unlink(sw.t);
      if (!rc) unlink(sw.u);
      if (rc) return rc;
      setTri(sw.t, sw.tris[0]); setTri(sw.u, sw.tris[1]);
      link(sw.t); link(sw.u);
      for (int h = 0; h < 2; h++) for (const uint32_t v : sw.tris[h]) for (const uint32_t w : fans[v]) touch(w);
      changed = true;
    }
    // 2. Collapses: vertex `gone` merged into vertex `keep`, an end of an edge of a flipped triangle.
    std::vector<uint32_t> notTouched;
    for (const uint32_t t : bad) if (!isTouched(t)) notTouched.push_back(t);
    const std::vector<uint32_t> still = isBad(notTouched);
    if (rc) return rc;
    struct Col { uint32_t keep, gone; std::vector<uint32_t> goneTris; std::vector<uint8_t> dying; std::vector<Tri> tris; };
    std::vector<Col> cols;
    for (const uint32_t t : still) for (int k = 0; k < 3; k++) for (int side = 0; side < 2; side++) {
      const uint32_t keep = side == 0 ? T[3 * (size_t)t + k] : T[3 * (size_t)t + (k + 1) % 3];
      const uint32_t gone = side == 0 ? T[3 * (size_t)t + (k + 1) % 3] : T[3 * (size_t)t + k];
      if (PIN[gone] || (!CR[gone] && !CR[keep] && VO[keep] != VO[gone] && fans[gone].size() != 3)) continue;
      ring(keep, rk); ring(gone, rg);
      int common = 0;
      for (const uint32_t v : rk) if (has(rg, v)) common++;
      if (common != 2) continue;
      Col c{keep, gone, fans[gone], {}, {}};
      for (const uint32_t u : c.goneTris) {
        const bool dies = has(fans[keep], u);
        c.dying.push_back(dies ? 1 : 0);
        if (dies) continue;
        Tri x = triOf(u);
        for (uint32_t& v : x) if (v == gone) v = keep;
        c.tris.push_back(x);
      }
      cols.push_back(std::move(c));
    }
    {
      std::vector<Tri> all;
      for (const Col& c : cols) all.insert(all.end(), c.tris.begin(), c.tris.end());
      flipped(all, f);
      if (rc) return rc;
    }
    markSet(still);
    size_t o = 0;
    for (const Col& c : cols) {
      int fa = 0;
      for (size_t i = 0; i < c.tris.size(); i++) fa += f[o + i];
      o += c.tris.size();
      bool busy = false;
      for (const uint32_t u : c.goneTris) if (isTouched(u)) busy = true;
      for (const uint32_t u : fans[c.keep]) if (isTouched(u)) busy = true;
      if (busy) continue;
      if (!better(c.goneTris, c.tris, fa, inSet)) continue;
      for (const uint32_t u : c.goneTris) { unlink(u); if (rc) return rc; }
      for (size_t i = 0; i < c.goneTris.size(); i++) if (c.dying[i]) alive[c.goneTris[i]] = 0;
      for (size_t i = 0; i < c.goneTris.size(); i++) {
        if (c.dying[i]) continue;
        const uint32_t u = c.goneTris[i];
        Tri x = triOf(u);
        for (uint32_t& v : x) if (v == c.gone) v = c.keep;
        setTri(u, x);
        link(u);
      }
      const std::vector<uint32_t> keepFan = fans[c.keep];
      for (const uint32_t w : keepFan) { touch(w); for (const uint32_t x : triOf(w)) for (const uint32_t y : fans[x]) touch(y); }
      for (const uint32_t u : c.goneTris) touch(u);
      changed = true;
    }
    // 3. Moves: a corner of a flipped triangle (not pinned, not on the crease) to the middle of
    //    its ring, taken back onto its owner's share (onto the field beside the crease).
    for (int k = 0; k < 3; k++) {
      std::vector<uint32_t> cand;
      for (const uint32_t t : still) if (alive[t] && !isTouched(t)) cand.push_back(t);
      const std::vector<uint32_t> left = isBad(cand);
      if (rc) return rc;
      if (left.empty()) break;
      markSet(left);
      claimStamp++;
      struct Mover { uint32_t v; std::vector<uint32_t> fan; double from[3]; };
      std::vector<Mover> movers;
      std::vector<std::array<double, 3>> to;
      for (const uint32_t t : left) {
        const uint32_t v = T[3 * (size_t)t + k];
        if (PIN[v] || CR[v] || claimedV[v] == claimStamp) continue;
        bool busy = false;
        for (const uint32_t u : fans[v]) if (isTouched(u) || claimedT[u] == claimStamp) busy = true;
        if (busy) continue;
        ring(v, r);
        const double rs = (double)r.size();
        double x = 0, y = 0, z = 0;
        for (const uint32_t w : r) { x += P[3 * (size_t)w] / rs; y += P[3 * (size_t)w + 1] / rs; z += P[3 * (size_t)w + 2] / rs; }
        movers.push_back(Mover{v, fans[v], {P[3 * (size_t)v], P[3 * (size_t)v + 1], P[3 * (size_t)v + 2]}});
        to.push_back({x, y, z});
        claimedV[v] = claimStamp;
        for (const uint32_t u : fans[v]) { claimedT[u] = claimStamp; for (const uint32_t w : triOf(u)) claimedV[w] = claimStamp; }
      }
      if (movers.empty()) continue;
      {
        std::vector<int32_t> leaves;
        std::vector<int> owners;
        for (const Mover& mv : movers) { leaves.push_back(VL[mv.v]); owners.push_back(nearCrease(mv.v) ? -1 : VO[mv.v]); }
        projectOnShare(to, leaves, owners);
        if (rc) return rc;
      }
      std::vector<int> before(movers.size()), foldsBefore(movers.size());
      std::vector<Tri> fanTris;
      for (size_t q = 0; q < movers.size(); q++) {
        int c = 0;
        for (const uint32_t u : movers[q].fan) if (inSet(u)) c++;
        before[q] = c;
        fanTris.clear();
        for (const uint32_t u : movers[q].fan) fanTris.push_back(triOf(u));
        foldsBefore[q] = foldCount(fanTris, movers[q].fan);
      }
      for (size_t q = 0; q < movers.size(); q++) for (int c = 0; c < 3; c++) P[3 * (size_t)movers[q].v + c] = to[q][c];
      {
        std::vector<Tri> all;
        for (const Mover& mv : movers) for (const uint32_t u : mv.fan) all.push_back(triOf(u));
        flipped(all, f);
        if (rc) return rc;
      }
      size_t o2 = 0;
      for (size_t q = 0; q < movers.size(); q++) {
        const Mover& mv = movers[q];
        int fa = 0;
        for (size_t i = 0; i < mv.fan.size(); i++) fa += f[o2 + i];
        o2 += mv.fan.size();
        fanTris.clear();
        for (const uint32_t u : mv.fan) fanTris.push_back(triOf(u));
        const int foldA = foldCount(fanTris, mv.fan);
        if (accept(before[q], fa, foldsBefore[q], foldA)) {
          for (const uint32_t u : mv.fan) touch(u);
          changed = true;
        } else {
          for (int c = 0; c < 3; c++) P[3 * (size_t)mv.v + c] = mv.from[c];
        }
      }
    }
    if (!changed) break;
    dedupeStamp++;
    std::vector<uint32_t> next;
    for (const uint32_t t : bad) if (dedupe[t] != dedupeStamp) { dedupe[t] = dedupeStamp; next.push_back(t); }
    for (const uint32_t t : touched) if (dedupe[t] != dedupeStamp) { dedupe[t] = dedupeStamp; next.push_back(t); }
    bad = isBad(next);
    if (rc) return rc;
  }
  // Compact: surviving triangles in order, vertices in order of first use.
  std::vector<int32_t> map(nvAll, -1);
  std::vector<uint32_t> outT, keepV;
  for (size_t t = 0; t < nt0; t++) if (alive[t]) for (int k = 0; k < 3; k++) {
    const uint32_t v = T[3 * t + k];
    if (map[v] < 0) { map[v] = (int32_t)keepV.size(); keepV.push_back(v); }
    outT.push_back((uint32_t)map[v]);
  }
  const size_t nk = keepV.size();
  std::vector<double> nP(3 * nk), nN(3 * nk);
  std::vector<int32_t> nVL(nk), nVO(nk);
  std::vector<uint8_t> nH(nk), nPin(nk), nCR(nk);
  for (size_t i = 0; i < nk; i++) {
    const uint32_t v = keepV[i];
    for (int k = 0; k < 3; k++) { nP[3 * i + k] = P[3 * (size_t)v + k]; nN[3 * i + k] = N[3 * (size_t)v + k]; }
    nVL[i] = VL[v]; nVO[i] = VO[v]; nH[i] = HELD[v]; nPin[i] = PIN[v]; nCR[i] = CR[v];
  }
  T.swap(outT); P.swap(nP); N.swap(nN); VL.swap(nVL); VO.swap(nVO); HELD.swap(nH); PIN.swap(nPin); CR.swap(nCR);
  return 0;
}

}  // namespace

int untangle(ipe::Session& s) {
  if (!s.meshed || !s.ownerMesh || !s.hasCrease || s.normals.size() != s.positions.size()) return 1;
  Untangle u(s);
  return u.run();
}

int tri_owners(ipe::Session& s) {
  if (!s.meshed || !s.ownerMesh) return 1;
  const std::vector<uint32_t>& I = s.indices;
  const bool hasCr = s.hasCrease;
  s.triOwner.assign(I.size() / 3, 0);
  for (size_t t = 0; t < s.triOwner.size(); t++) {
    int shared = -1;
    bool agree = true;
    for (int k = 0; k < 3; k++) {
      const uint32_t v = I[3 * t + k];
      if (hasCr && s.creaseMark[v]) continue;
      if (shared < 0) shared = s.vertOwner[v]; else if (s.vertOwner[v] != shared) agree = false;
    }
    s.triOwner[t] = agree && shared >= 0 ? shared : s.vertOwner[I[3 * t]];
  }
  return 0;
}

}  // namespace ipm_mesh

extern "C" {

// The contact the owner stages read (see Session): `att` (attLen doubles, ATTACH_STRIDE each; the
// IR node's attWorld, anchors in world space like the mesh positions the stages test),
// the clearance, the gap and contact.js's CREASE_SNAP, CREASE_TOL and DETAIL_SEAM_FADE.
// 0 ok; nonzero for an unknown session or a malformed table.
int ip_set_contact(int id, const double* att, int attLen, double cl, double gap, double creaseSnap, double creaseTol, double seamFade) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 2;
  if (attLen < 0 || attLen % ipm_mesh::ATTACH_STRIDE) return 1;
  s->att.assign(att, att + attLen);
  s->cl = cl; s->gap = gap; s->creaseSnap = creaseSnap; s->creaseTol = creaseTol; s->seamFade = seamFade;
  s->contactSet = true;
  return 0;
}

int ip_mesh_owners(int id) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 9;
  return ipm_mesh::mesh_owners(*s);
}

int ip_crease(int id) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 9;
  return ipm_mesh::crease(*s);
}

int ip_untangle(int id) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 9;
  return ipm_mesh::untangle(*s);
}

// The owner mesh's fields, or null for a plain mesh (crease marks: null until cut).
const int32_t* ip_vert_owner(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed && s->ownerMesh ? s->vertOwner.data() : nullptr;
}
const uint8_t* ip_owner_held(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed && s->ownerMesh ? s->ownerHeld.data() : nullptr;
}
const uint8_t* ip_pinned(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed && s->ownerMesh ? s->pinned.data() : nullptr;
}
const uint8_t* ip_crease_marks(int id) {
  ipe::Session* s = ipe::session(id);
  return s && s->meshed && s->ownerMesh && s->hasCrease ? s->creaseMark.data() : nullptr;
}

// Each triangle's owner (result.js's triangleOwners), or null for a plain mesh.
const int32_t* ip_tri_owners(int id) {
  ipe::Session* s = ipe::session(id);
  if (!s || ipm_mesh::tri_owners(*s) != 0) return nullptr;
  return s->triOwner.data();
}

}
