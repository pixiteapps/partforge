// C++ port of the implicit engine's sharpen stage: implicit/sharpen.js (sharpenMesh, its edge
// rounds, readSides, newtonStep, solve, commit), sharpen-corners.js (cornerPass, commitCorners)
// and sharpen-mesh.js (adjacency, subdivide, checkTris, triNormal, fieldFlips). It runs on the
// session mesh after cleanup (and the crease cut on the owner path) and before untangle and
// detail. See implicit_mesh.h.
//
// Every field read is of points with a leaf's program, through eval_points: bucketed by program,
// which decides nothing because the interpreter is lane-local (the JS groups by leaf). What else
// bit-exact parity needs, beyond native/README.md's rules (no FMA: the build's -ffp-contract=off
// covers this file too):
//   - Every expression keeps the JS's operation order: the angle test's dot against
//     SHARP_ANGLE_COS * lA * lB, the tangent-plane solve, the side reads' mean (f0 + ... + f5) / 6
//     and differences over 2e, Newton's det3 expansion and Cramer's rule by columns, the corner
//     pass's crosses, determinant and (d0·c12 + d1·c20 + d2·c01) / det, and the merge and move
//     radii as (CORNER_MERGE * edge * CORNER_MERGE) * edge, left to right.
//   - Edge keys are lo * nv + hi in 64 bits (a JS double holds them exactly below 2^53).
//   - The orders that decide a result are the JS's: candidates in the order the triangle list
//     first names their edge; the density rule per leaf program, counted before any read; moves,
//     then splits, in candidate order; the changed triangles (`touched`) in the order they were
//     first touched (an insertion-ordered list, never an unordered map), each with its candidates
//     in touch order; the corner groups in candidate order, each taking the member with the fewest
//     mesher planes, then the largest clearance, the first on a tie; a group's search against its
//     first member's point; the earlier corner vertex found as the first in `made` order; the
//     across pass's offers in u's fan order, each edge point once; and step 7's retry list in the
//     new mesh's edge order.
//   - A JS Map's delete (splitOf) is a -1 sentinel in flat::Map, and get of a deleted or absent
//     key is -1, as `?? -1` gives; set after delete writes the slot again.
//   - The SHARP_APART guard (ApartView) is a question of existence, so its grid's layout and
//     order decide nothing; it is asked at the same places, in the same order, as the JS asks it.
//   - Reads past an array's end in the JS keep their JS meaning: a vertex past the round's input
//     count is free and has no mesher plane (its N0 entry is undefined, so unit gives null).
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "flat_map.h"
#include "implicit_mesh.h"
#include "js_math.h"

namespace ipm_mesh {

namespace {

using jsmath::hypot3;
using jsmath::jsmax;
using jsmath::jsmin;

// sharpen.js
constexpr double SHARP_ANGLE_COS = 0.9063077870366499;
constexpr double SHARP_TOL = 0.05;
constexpr double SHARP_MAX_MOVE = 1.5;
constexpr double SHARP_SNAP = 0.15;
constexpr double SHARP_CORNER_DET = 0.05;
constexpr double SHARP_DENSE_PER_CELL = 2;   // sharpen.js's (see there for the measurements)
constexpr int SHARP_DENSE_MIN = 400;
constexpr int NEWTON_STEPS = 10;
constexpr double STEP_CAP = 0.25, SIDE = 0.02;
constexpr double DIFF = 0.005, MIN_ALTITUDE = 0.001;
constexpr double FLIP_NEAR = 1e-4;
constexpr double CONVERGED = 1e-5;
constexpr double CORNER_MERGE = 0.05;
constexpr double SHARP_APART = 0.001;
constexpr int SIDE_PTS = 6;
constexpr int FLAT_READS = 3;
// sharpen-corners.js
constexpr double ACROSS_TOL = 0.005;
constexpr int TRIES = 4;
constexpr int CORNER_STEPS = 12;
constexpr double CORNER_SIDE_MAX = 0.5;
// The ring read's directions (readCorners): cos and sin of k·22.5°.
constexpr int CORNER_RING = 16;
constexpr double RING_C1 = 0.9238795325112867, RING_S1 = 0.3826834323650898, RING_R2 = 0.7071067811865476;

constexpr double INF = INFINITY;

inline double dot(const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline double det3(const double* a, const double* b, const double* c) {
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}
// unit(v): false (JS null) when the length is not above 0.
inline bool unit(const double* v, double* out) {
  const double l = hypot3(v[0], v[1], v[2]);
  if (!(l > 0)) return false;
  out[0] = v[0] / l; out[1] = v[1] / l; out[2] = v[2] / l;
  return true;
}
inline void cross(const double* u, const double* v, double* out) {
  out[0] = u[1] * v[2] - u[2] * v[1];
  out[1] = u[2] * v[0] - u[0] * v[2];
  out[2] = u[0] * v[1] - u[1] * v[0];
}

// The mesh one round works on: sharpenRound's `mesh`. The owner fields are present (owner) on an
// owner mesh, `crease` once cut (hasCrease); `sharp` and `planes` after a round (hasSharp).
struct Mesh {
  std::vector<double> P, N;
  std::vector<uint32_t> T;
  std::vector<int32_t> VL;
  bool owner = false, hasCrease = false, hasSharp = false;
  std::vector<int32_t> VO;
  std::vector<uint8_t> held, pin, crease;
  std::vector<uint8_t> sharp;
  std::vector<int32_t> planes;
};

// Which vertices a change may move (`free`: not held, pinned or crease; a vertex past the round's
// input count always, except a corner point on the across pass, `sh` 2) and which give no plane
// (`noPlane`: past the input count, as the JS's N0 has no entry there, or pinned or crease).
struct FreeRule {
  const Mesh* m;
  size_t nv0;
  const std::vector<uint8_t>* sh;
  bool marked(size_t v) const { return (m->owner && m->pin[v]) || (m->hasCrease && m->crease[v]); }
  bool free(size_t v) const {
    if (sh && (*sh)[v] == 2) return false;
    return v >= nv0 || (!(m->owner && m->held[v]) && !marked(v));
  }
  bool noPlane(size_t v) const { return v >= nv0 || marked(v); }
};

// sharpen-mesh.js's adjacency: one counting sort. fan(v) is v's triangles in index order.
struct Adj {
  size_t nv = 0;
  const std::vector<uint32_t>* T = nullptr;
  std::vector<uint32_t> off, tri;
  void build(const std::vector<uint32_t>& TT, size_t n) {
    T = &TT; nv = n;
    off.assign(nv + 1, 0);
    tri.assign(TT.size(), 0);
    for (size_t i = 0; i < TT.size(); i++) off[TT[i] + 1]++;
    for (size_t v = 0; v < nv; v++) off[v + 1] += off[v];
    std::vector<uint32_t> at(off.begin(), off.end() - 1);
    const size_t nt = TT.size() / 3;
    for (size_t t = 0; t < nt; t++) for (int k = 0; k < 3; k++) tri[at[TT[3 * t + k]]++] = (uint32_t)t;
  }
  bool holds(uint32_t t, uint32_t v) const {
    const std::vector<uint32_t>& X = *T;
    return X[3 * (size_t)t] == v || X[3 * (size_t)t + 1] == v || X[3 * (size_t)t + 2] == v;
  }
  const uint32_t* fanBegin(uint32_t v) const { return tri.data() + off[v]; }
  const uint32_t* fanEnd(uint32_t v) const { return tri.data() + off[v + 1]; }
  // byEdge: the triangles of lo's fan that hold hi, in fan order.
  void byEdge(uint32_t lo, uint32_t hi, std::vector<uint32_t>& out) const {
    out.clear();
    for (uint32_t i = off[lo]; i < off[lo + 1]; i++) if (holds(tri[i], hi)) out.push_back(tri[i]);
  }
  // Whether triangle t is the first to name edge (lo, hi).
  bool first(uint32_t t, uint32_t lo, uint32_t hi) const {
    for (uint32_t i = off[lo]; i < off[lo + 1] && tri[i] < t; i++) if (holds(tri[i], hi)) return false;
    return true;
  }
};

// splitOf: a JS Map edge key -> vertex, with delete as the -1 sentinel.
struct SplitMap {
  uint64_t nv;
  flat::Map<int64_t> m{64};
  explicit SplitMap(uint64_t n) : nv(n) {}
  uint64_t key(uint32_t a, uint32_t b) const { return a < b ? (uint64_t)a * nv + b : (uint64_t)b * nv + a; }
  int64_t get(uint32_t a, uint32_t b) { const int64_t* v = m.find(key(a, b)); return v ? *v : -1; }
  void set(uint32_t a, uint32_t b, int64_t v) { m.insert(key(a, b), v) = v; }
  void del(uint32_t a, uint32_t b) { int64_t* v = m.find(key(a, b)); if (v) *v = -1; }
};

// subdivide: triangle t of T split at splitOf's points, appended to out (a part with a repeated
// vertex is dropped, except the unsplit triangle, pushed as it is).
void subdivide(const std::vector<uint32_t>& T, uint32_t t, SplitMap& sp, std::vector<uint32_t>& out) {
  const int64_t v[3] = {T[3 * (size_t)t], T[3 * (size_t)t + 1], T[3 * (size_t)t + 2]};
  const int64_t s[3] = {sp.get((uint32_t)v[0], (uint32_t)v[1]), sp.get((uint32_t)v[1], (uint32_t)v[2]), sp.get((uint32_t)v[2], (uint32_t)v[0])};
  const int n = (s[0] >= 0) + (s[1] >= 0) + (s[2] >= 0);
  auto put = [&](int64_t a, int64_t b, int64_t c) {
    if (a != b && b != c && c != a) { out.push_back((uint32_t)a); out.push_back((uint32_t)b); out.push_back((uint32_t)c); }
  };
  if (n == 0) { out.push_back((uint32_t)v[0]); out.push_back((uint32_t)v[1]); out.push_back((uint32_t)v[2]); return; }
  if (n == 3) { put(v[0], s[0], s[2]); put(v[1], s[1], s[0]); put(v[2], s[2], s[1]); put(s[0], s[1], s[2]); return; }
  int r = 0;
  if (n == 1) { while (s[r] < 0) r++; }
  else { while (!(s[r] >= 0 && s[(r + 2) % 3] >= 0)) r++; }
  const int64_t A = v[r], B = v[(r + 1) % 3], C = v[(r + 2) % 3], sAB = s[r], sCA = s[(r + 2) % 3];
  if (n == 1) { put(A, sAB, C); put(sAB, B, C); }
  else { put(A, sAB, sCA); put(sAB, B, C); put(sAB, C, sCA); }
}

// retriangulate: T split at sp's points, as subdivide over every triangle in order gives it. The
// triangles in `cut` (those on a split edge, any order, repeats allowed) are subdivided and every
// other one is copied as it is, since a triangle on no split edge subdivides to itself.
void retriangulate(const std::vector<uint32_t>& T, std::vector<uint32_t> cut, SplitMap& sp, std::vector<uint32_t>& out) {
  std::sort(cut.begin(), cut.end());
  cut.erase(std::unique(cut.begin(), cut.end()), cut.end());
  out.clear();
  out.reserve(T.size() + 9 * cut.size());
  size_t from = 0;
  for (const uint32_t t : cut) {
    out.insert(out.end(), T.begin() + 3 * from, T.begin() + 3 * (size_t)t);
    subdivide(T, t, sp, out);
    from = (size_t)t + 1;
  }
  out.insert(out.end(), T.begin() + 3 * from, T.end());
}

// triNormal: the (unnormalized) normal, or false when an altitude is under MIN_ALTITUDE.
bool triNormal(const double* P, uint32_t i, uint32_t j, uint32_t k, double* n) {
  const size_t a = 3 * (size_t)i, b = 3 * (size_t)j, c = 3 * (size_t)k;
  const double u[3] = {P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]}, w[3] = {P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]};
  const double x[3] = {P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]};
  n[0] = u[1] * w[2] - u[2] * w[1];
  n[1] = u[2] * w[0] - u[0] * w[2];
  n[2] = u[0] * w[1] - u[1] * w[0];
  const double longest = std::sqrt(jsmax(jsmax(dot(u, u), dot(w, w)), dot(x, x)));
  return longest > 0 && hypot3(n[0], n[1], n[2]) >= MIN_ALTITUDE * longest;
}

// checkTris: 0, 1 ("sliver") or 2 ("flip") over what `tris` become when split at sp.
int checkTris(const std::vector<uint32_t>& T, const uint32_t* tb, const uint32_t* te, SplitMap& sp, const double* P, const double* N,
              std::vector<uint32_t>& out) {
  out.clear();
  for (const uint32_t* t = tb; t != te; t++) subdivide(T, *t, sp, out);
  for (size_t i = 0; i < out.size(); i += 3) {
    double n[3];
    if (!triNormal(P, out[i], out[i + 1], out[i + 2], n)) return 1;
    const size_t a = 3 * (size_t)out[i], b = 3 * (size_t)out[i + 1], c = 3 * (size_t)out[i + 2];
    if (n[0] * (N[a] + N[b] + N[c]) + n[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + n[2] * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) return 2;
  }
  return 0;
}

// The changed triangles of a commit, in the order first touched, each with the candidates that
// changed it (and, for the edge rounds, how: the moved end, or -1 for a split), in touch order.
struct Touched {
  std::vector<uint32_t> keys;
  std::vector<std::vector<int32_t>> by, how;
  flat::Map<uint32_t> idx{256};
  void add(uint32_t t, int32_t c, int32_t h) {
    bool inserted = false;
    const uint32_t i = idx.insert(t, (uint32_t)keys.size(), &inserted);
    if (inserted) { keys.push_back(t); by.emplace_back(); how.emplace_back(); }
    by[i].push_back(c);
    how[i].push_back(h);
  }
};

// fieldFlips' memo across one commit loop's rounds: per triangle, the last read's candidates,
// how each changed it, and whether it was flipped.
struct MemoEntry { bool has = false, bad = false; std::vector<int32_t> by, how; };
// Keyed by triangle: only the triangles a commit touched have an entry.
struct Memo {
  flat::Map<uint32_t> idx{64};
  std::vector<MemoEntry> e;
  const MemoEntry* find(uint32_t t) { const uint32_t* i = idx.find(t); return i ? &e[*i] : nullptr; }
  MemoEntry& get(uint32_t t) {
    bool inserted = false;
    const uint32_t i = idx.insert(t, (uint32_t)e.size(), &inserted);
    if (inserted) e.emplace_back();
    return e[i];
  }
};

// fieldFlips: the triangles of `tc.keys` one of whose parts faces against the field at its
// centre (read with its first corner's leaf program along the part's normal at FLIP_NEAR·edge and
// at DIFF·edge), in tc.keys order. `withHow` (the edge rounds) compares and records `how`, with
// the memo. Returns 0, or nonzero when an evaluation fails.
int fieldFlips(ipe::Session& s, const double* P, SplitMap& sp, const Touched& tc, bool withHow, const std::vector<int32_t>& VL0,
               const std::vector<uint32_t>& T, double edge, Memo* memo, std::vector<uint32_t>& flipped) {
  flipped.clear();
  const double e = DIFF * edge, en = FLIP_NEAR * edge;
  // Per entry of tc.keys (each triangle once): known from the memo, or read and flipped.
  std::vector<uint8_t> bad(tc.keys.size(), 0);
  std::vector<uint32_t> fresh, out;
  std::vector<size_t> owner, freshAt;
  Points pts;
  for (size_t q = 0; q < tc.keys.size(); q++) {
    const uint32_t t = tc.keys[q];
    const MemoEntry* m = withHow && memo ? memo->find(t) : nullptr;
    if (m && m->has && m->by == tc.by[q] && m->how == tc.how[q]) { if (m->bad) bad[q] = 1; continue; }
    fresh.push_back(t); freshAt.push_back(q);
    out.clear();
    subdivide(T, t, sp, out);
    for (size_t i = 0; i < out.size(); i += 3) {
      double n[3], u[3];
      if (!triNormal(P, out[i], out[i + 1], out[i + 2], n) || !unit(n, u)) continue;
      const size_t a = 3 * (size_t)out[i], b = 3 * (size_t)out[i + 1], c = 3 * (size_t)out[i + 2];
      const double cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      const int32_t pr = leaf_prog(s, VL0[T[3 * (size_t)t]]);
      pts.add(cx + e * u[0], cy + e * u[1], cz + e * u[2], pr);
      pts.add(cx - e * u[0], cy - e * u[1], cz - e * u[2], pr);
      pts.add(cx + en * u[0], cy + en * u[1], cz + en * u[2], pr);
      pts.add(cx - en * u[0], cy - en * u[1], cz - en * u[2], pr);
      owner.push_back(q);
    }
  }
  std::vector<double> d(pts.size());
  if (eval_points(s, pts, d.data(), nullptr, nullptr, nullptr) != 0) return 2;
  for (size_t q = 0; q < owner.size(); q++) if (d[4 * q] - d[4 * q + 1] < 0 || d[4 * q + 2] - d[4 * q + 3] < 0) bad[owner[q]] = 1;
  if (memo && withHow) {
    for (size_t i = 0; i < fresh.size(); i++) {
      MemoEntry& me = memo->get(fresh[i]);
      me.has = true; me.by = tc.by[freshAt[i]]; me.how = tc.how[freshAt[i]]; me.bad = bad[freshAt[i]] != 0;
    }
  }
  for (size_t q = 0; q < tc.keys.size(); q++) if (bad[q]) flipped.push_back(tc.keys[q]);
  return 0;
}

// The SHARP_APART guard's index (sharpen-mesh.js apartIndex): a hash grid of cells
// 2·SHARP_APART·edge wide. The JS keys a cell by its integer coordinates as a string; here a hash
// of them keys a flat map, and two cells that share a hash share a list, which only adds vertices
// to the exact distance test. Whether a vertex is near is a question of existence, so no order
// decides it. A cell index that is not a safe integer is never filed and never near (the JS's
// Number.isSafeInteger), which also keeps the cast defined.
struct ApartCells {
  flat::Map<uint32_t> idx{64};
  std::vector<std::vector<uint32_t>> lists;
  static uint64_t key(int64_t i, int64_t j, int64_t k) {
    const uint64_t h = (uint64_t)i * 0x9E3779B97F4A7C15ULL ^ (uint64_t)j * 0xC2B2AE3D27D4EB4FULL ^ (uint64_t)k * 0x165667B19E3779F9ULL;
    return h == flat::Map<uint32_t>::EMPTY ? h - 1 : h;
  }
  void file(uint64_t k, uint32_t v) {
    bool inserted = false;
    const uint32_t i = idx.insert(k, (uint32_t)lists.size(), &inserted);
    if (inserted) lists.emplace_back();
    lists[i].push_back(v);
  }
  const std::vector<uint32_t>* get(uint64_t k) { const uint32_t* i = idx.find(k); return i ? &lists[*i] : nullptr; }
};

struct ApartBase {
  double ap = 0, size = 0, A2 = 0;
  size_t nv = 0;
  ApartCells cells;
  // The asked cells (their exact indices, keyed by hash: a hash shared by two cells answers the
  // second by the full test, never by a cell list it did not file), the 27 cells around each, and
  // their x indices.
  flat::Map<uint32_t> asked{64};
  std::vector<int64_t> askedCell;
  flat::Map<uint8_t> want{64}, wantX{64};
  bool cellOf(double x, double y, double z, int64_t* c) const {
    const double q[3] = {std::floor(x / size), std::floor(y / size), std::floor(z / size)};
    for (int i = 0; i < 3; i++) if (!(std::fabs(q[i]) <= 9007199254740991.0)) return false;   // NaN fails too
    for (int i = 0; i < 3; i++) c[i] = (int64_t)q[i];
    return true;
  }
  // `asks`: the points the commit will ask about, 3 doubles each.
  void build(const double* P, size_t n, double edge, const std::vector<double>& asks) {
    nv = n;
    ap = SHARP_APART * edge; size = 2 * ap; A2 = ap * ap;
    for (size_t q = 0; q + 2 < asks.size(); q += 3) {
      int64_t c[3];
      if (!cellOf(asks[q], asks[q + 1], asks[q + 2], c)) continue;
      bool inserted = false;
      asked.insert(ApartCells::key(c[0], c[1], c[2]), (uint32_t)(askedCell.size() / 3), &inserted);
      if (inserted) askedCell.insert(askedCell.end(), c, c + 3);
      for (int i = -1; i <= 1; i++) {
        wantX.insert(ApartCells::key(c[0] + i, 0, 0), 1);
        for (int j = -1; j <= 1; j++) for (int k = -1; k <= 1; k++) want.insert(ApartCells::key(c[0] + i, c[1] + j, c[2] + k), 1);
      }
    }
    if (!want.size()) return;
    // The x test is a table over the asked x range when that is not too wide.
    int64_t x0 = INT64_MAX, x1 = INT64_MIN;
    for (size_t q = 0; q < askedCell.size(); q += 3) { if (askedCell[q] - 1 < x0) x0 = askedCell[q] - 1; if (askedCell[q] + 1 > x1) x1 = askedCell[q] + 1; }
    std::vector<uint8_t> table;
    if (x1 - x0 < (1 << 22)) {
      table.assign((size_t)(x1 - x0 + 1), 0);
      for (size_t q = 0; q < askedCell.size(); q += 3) for (int i = -1; i <= 1; i++) table[(size_t)(askedCell[q] + i - x0)] = 1;
    }
    for (size_t v = 0; v < nv; v++) {
      const double qx = std::floor(P[3 * v] / size);
      if (!(std::fabs(qx) <= 9007199254740991.0)) continue;
      const int64_t ix = (int64_t)qx;
      if (!table.empty() ? (ix < x0 || ix > x1 || !table[(size_t)(ix - x0)]) : !wantX.find(ApartCells::key(ix, 0, 0))) continue;
      int64_t c[3];
      if (!cellOf(P[3 * v], P[3 * v + 1], P[3 * v + 2], c)) continue;
      const uint64_t k = ApartCells::key(c[0], c[1], c[2]);
      if (want.find(k)) cells.file(k, (uint32_t)v);
    }
  }
  bool isAsked(const int64_t* c) {
    const uint32_t* i = asked.find(ApartCells::key(c[0], c[1], c[2]));
    return i && askedCell[3 * (size_t)*i] == c[0] && askedCell[3 * (size_t)*i + 1] == c[1] && askedCell[3 * (size_t)*i + 2] == c[2];
  }
};

// One commit's view: Q its live positions, `over` the vertices it placed or moved.
struct ApartView {
  ApartBase& b;
  const double* Q;
  ApartCells over;
  std::vector<uint32_t> placed;
  ApartView(ApartBase& base, const double* q) : b(base), Q(q) {}
  void add(uint32_t v) {
    placed.push_back(v);
    int64_t c[3];
    if (b.cellOf(Q[3 * (size_t)v], Q[3 * (size_t)v + 1], Q[3 * (size_t)v + 2], c)) over.file(ApartCells::key(c[0], c[1], c[2]), v);
  }
  bool near(uint32_t v, const double* p) const {
    const double x = Q[3 * (size_t)v] - p[0], y = Q[3 * (size_t)v + 1] - p[1], z = Q[3 * (size_t)v + 2] - p[2];
    return x * x + y * y + z * z < b.A2;
  }
  bool has(const double* p, int64_t skip) {
    int64_t c[3];
    if (!b.cellOf(p[0], p[1], p[2], c)) return false;
    // A point the index was not built for: every vertex (sharpen-mesh.js apartIndex says why the
    // answer is the same).
    if (!b.isAsked(c)) {
      for (size_t v = 0; v < b.nv; v++) if ((int64_t)v != skip && near((uint32_t)v, p)) return true;
      for (const uint32_t v : placed) if ((int64_t)v != skip && near(v, p)) return true;
      return false;
    }
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) for (int k = -1; k <= 1; k++) {
      const uint64_t key = ApartCells::key(c[0] + i, c[1] + j, c[2] + k);
      for (ApartCells* cells : {&b.cells, &over}) {
        const std::vector<uint32_t>* l = cells->get(key);
        if (l) for (const uint32_t v : *l) if ((int64_t)v != skip && near(v, p)) return true;
      }
    }
    return false;
  }
};

// ---------------------------------------------------------------------------
// The edge rounds (sharpen.js)

struct ECand {
  uint32_t a = 0, b = 0;
  double m[3] = {0, 0, 0}, p[3] = {0, 0, 0}, uA[3] = {0, 0, 0}, uB[3] = {0, 0, 0}, pn[3] = {0, 0, 0};
  bool hasPn = false;
  double sigma = 1;
  bool ok = false, hasW = false, solved = false;
  double w[2][3] = {{0, 0, 0}, {0, 0, 0}};
  int32_t leaf = 0;
  uint32_t ev = 0;
  int flat = 0;
  double len = INF, lastLen = INF;   // `c.len ?? Infinity`
};

struct Side { double f, g[3]; };
struct Read { bool present = true; double f = NAN; Side A{}, B{}; };

// sides: each side's direction along its own plane, away from the other.
void sides(ECand& c) {
  const double k = dot(c.uA, c.uB), ns = -c.sigma;
  double a[3], b[3];
  for (int i = 0; i < 3; i++) { a[i] = ns * (c.uB[i] - k * c.uA[i]); b[i] = ns * (c.uA[i] - k * c.uB[i]); }
  const bool okA = unit(a, c.w[0]), okB = unit(b, c.w[1]);
  c.hasW = okA && okB;
}

// readSides: one read of `live` (indices into C): each side's mean value and gradient, and with
// withCentre the field at the point itself (else f is NaN).
int readSides(ipe::Session& s, std::vector<ECand>& C, const std::vector<uint32_t>& live, double edge, bool withCentre, std::vector<Read>& rs) {
  const int per = SIDE_PTS, c0 = withCentre ? 1 : 0, PTS = 2 * per + c0;
  const double h = SIDE * edge, e = DIFF * edge;
  Points pts;
  for (const uint32_t q : live) {
    ECand& c = C[q];
    sides(c);
    const double x = c.p[0], y = c.p[1], z = c.p[2];
    const int32_t pr = leaf_prog(s, c.leaf);
    if (withCentre) pts.add(x, y, z, pr);
    for (int sd = 0; sd < 2; sd++) {
      const double zero[3] = {0, 0, 0};
      const double* w = c.hasW ? c.w[sd] : zero;
      const double sx = x + h * w[0], sy = y + h * w[1], sz = z + h * w[2];
      pts.add(sx + e, sy, sz, pr); pts.add(sx - e, sy, sz, pr);
      pts.add(sx, sy + e, sz, pr); pts.add(sx, sy - e, sz, pr);
      pts.add(sx, sy, sz + e, pr); pts.add(sx, sy, sz - e, pr);
    }
  }
  std::vector<double> d(pts.size());
  if (eval_points(s, pts, d.data(), nullptr, nullptr, nullptr) != 0) return 2;
  rs.assign(live.size(), Read{});
  for (size_t q = 0; q < live.size(); q++) {
    const size_t o = (size_t)PTS * q;
    auto side = [&](int sd, Side& out) {
      const size_t b = o + c0 + (size_t)per * sd;
      const double f0 = d[b], f1 = d[b + 1], f2 = d[b + 2], f3 = d[b + 3], f4 = d[b + 4], f5 = d[b + 5];
      out.f = (f0 + f1 + f2 + f3 + f4 + f5) / 6;
      out.g[0] = (f0 - f1) / (2 * e); out.g[1] = (f2 - f3) / (2 * e); out.g[2] = (f4 - f5) / (2 * e);
    };
    rs[q].f = withCentre ? d[o] : NAN;
    side(0, rs[q].A);
    side(1, rs[q].B);
  }
  return 0;
}

// newtonStep: 0 (the step cannot be taken), 1 (taken) or 2 (converged: not taken).
int newtonStep(ECand& c, const Read& r, double edge) {
  const double h = SIDE * edge;
  const double* Ag = r.A.g;
  const double* Bg = r.B.g;
  const double rA = -r.A.f + h * dot(Ag, c.w[0]), rB = -r.B.f + h * dot(Bg, c.w[1]);
  double dx[3];
  bool have = false;
  if (c.hasPn) {
    const double* a = Ag;
    const double* b = Bg;
    const double* n = c.pn;
    const double D = det3(a, b, n), scale = hypot3(a[0], a[1], a[2]) * hypot3(b[0], b[1], b[2]);
    if (std::fabs(D) > 1e-6 * scale) {
      const double rP = -((c.p[0] - c.m[0]) * n[0] + (c.p[1] - c.m[1]) * n[1] + (c.p[2] - c.m[2]) * n[2]);
      // Cramer's rule: column k of the rows (a, b, n) replaced by (rA, rB, rP).
      const double a0[3] = {rA, a[1], a[2]}, b0[3] = {rB, b[1], b[2]}, n0[3] = {rP, n[1], n[2]};
      const double a1[3] = {a[0], rA, a[2]}, b1[3] = {b[0], rB, b[2]}, n1[3] = {n[0], rP, n[2]};
      const double a2[3] = {a[0], a[1], rA}, b2[3] = {b[0], b[1], rB}, n2[3] = {n[0], n[1], rP};
      dx[0] = det3(a0, b0, n0) / D;
      dx[1] = det3(a1, b1, n1) / D;
      dx[2] = det3(a2, b2, n2) / D;
      have = true;
    }
  }
  if (!have) {
    const double aa = dot(Ag, Ag), bb = dot(Bg, Bg), ab = dot(Ag, Bg), det = aa * bb - ab * ab;
    if (!(det > 1e-12)) return 0;
    const double l0 = (rA * bb - rB * ab) / det, l1 = (rB * aa - rA * ab) / det;
    for (int k = 0; k < 3; k++) dx[k] = Ag[k] * l0 + Bg[k] * l1;
  }
  const double len = hypot3(dx[0], dx[1], dx[2]);
  if (!std::isfinite(len)) return 0;
  c.lastLen = c.len; c.len = len;
  const bool done = len <= CONVERGED * edge;
  const double sc = len > STEP_CAP * edge ? (STEP_CAP * edge) / len : 1;
  if (!done) for (int k = 0; k < 3; k++) c.p[k] += dx[k] * sc;
  double uA[3], uB[3];
  const bool okA = unit(Ag, uA), okB = unit(Bg, uB);
  if (okA && okB) for (int k = 0; k < 3; k++) { c.uA[k] = uA[k]; c.uB[k] = uB[k]; }
  return done ? 2 : 1;
}

// agree: the sides' gradients within the angle (or either without a direction).
bool agree(const Read& r) {
  double gA[3], gB[3];
  const bool okA = unit(r.A.g, gA), okB = unit(r.B.g, gB);
  return !okA || !okB || dot(gA, gB) >= SHARP_ANGLE_COS;
}

// solve: steps 2 and 3 (Newton onto the crease, then the judge). Sets `solved` on each kept.
int solve(ipe::Session& s, std::vector<ECand>& C, const std::vector<int32_t>& VL0, double edge) {
  std::vector<uint32_t> live, next, redo;
  for (size_t q = 0; q < C.size(); q++) if (C[q].ok) live.push_back((uint32_t)q);
  std::vector<uint32_t> judged;
  std::vector<Read> reads, rs, r2;
  for (int it = 0; it < NEWTON_STEPS && !live.empty(); it++) {
    if (readSides(s, C, live, edge, it == 0, rs) != 0) return 2;
    if (it == 0) {
      redo.clear();
      for (size_t q = 0; q < live.size(); q++) if (!std::isfinite(rs[q].f)) redo.push_back(live[q]);
      for (const uint32_t q : redo) { C[q].leaf = VL0[C[q].b]; C[q].ev = C[q].b; }
      if (!redo.empty()) {
        if (readSides(s, C, redo, edge, true, r2) != 0) return 2;
        size_t j = 0;
        for (size_t q = 0; q < live.size(); q++) if (j < redo.size() && live[q] == redo[j]) rs[q] = r2[j++];
      }
    }
    next.clear();
    for (size_t q = 0; q < live.size(); q++) {
      ECand& c = C[live[q]];
      if (it < FLAT_READS && agree(rs[q])) c.flat++;
      const int st = c.hasW ? newtonStep(c, rs[q], edge) : 0;
      if (!st) { c.ok = false; continue; }
      if (st == 2) { judged.push_back(live[q]); reads.push_back(rs[q]); continue; }
      // Flat on every one of its first FLAT_READS reads, and Newton's step is not getting shorter.
      if (it == FLAT_READS - 1 && c.flat == FLAT_READS && !(c.len < c.lastLen)) {
        c.ok = false; judged.push_back(live[q]); Read none; none.present = false; reads.push_back(none); continue;
      }
      next.push_back(live[q]);
    }
    live.swap(next);
  }
  if (!live.empty()) {
    if (readSides(s, C, live, edge, true, rs) != 0) return 2;
    for (size_t q = 0; q < live.size(); q++) { judged.push_back(live[q]); reads.push_back(rs[q]); }
  }
  // The point itself, for those judged on a read without it.
  {
    Points pts;
    std::vector<size_t> at;
    for (size_t q = 0; q < judged.size(); q++) {
      const ECand& c = C[judged[q]];
      if (reads[q].present && !std::isfinite(reads[q].f) && c.ok) { pts.add(c.p[0], c.p[1], c.p[2], leaf_prog(s, c.leaf)); at.push_back(q); }
    }
    if (!at.empty()) {
      std::vector<double> d(pts.size());
      if (eval_points(s, pts, d.data(), nullptr, nullptr, nullptr) != 0) return 2;
      for (size_t i = 0; i < at.size(); i++) reads[at[i]].f = d[i];
    }
  }
  for (size_t q = 0; q < judged.size(); q++) {
    ECand& c = C[judged[q]];
    if (!reads[q].present) continue;
    const Read& r = reads[q];
    double gA[3], gB[3];
    const bool okA = unit(r.A.g, gA), okB = unit(r.B.g, gB);
    const double dm = hypot3(c.p[0] - c.m[0], c.p[1] - c.m[1], c.p[2] - c.m[2]);
    if (!c.hasW || !std::isfinite(r.f) || !okA || !okB) c.ok = false;
    else if (!(dm <= SHARP_MAX_MOVE * edge)) c.ok = false;
    else if (!(std::fabs(r.f) <= SHARP_TOL * edge)) c.ok = false;
    else if (!(dot(gA, gB) < SHARP_ANGLE_COS)) c.ok = false;
    else c.solved = true;
  }
  return 0;
}

// Each edge point's two plane normals (the side gradients Newton ended on), six numbers, by vertex;
// a vertex with no entry reads 0 (the JS's planeN Map).
struct PlaneN {
  flat::Map<uint32_t> at{64};
  std::vector<double> v;
  void set(uint32_t vert, const double* a, const double* b) {
    bool inserted = false;
    const uint32_t i = at.insert(vert, (uint32_t)(v.size() / 6), &inserted);
    if (inserted) v.resize(v.size() + 6);
    for (int k = 0; k < 3; k++) { v[6 * (size_t)i + k] = a[k]; v[6 * (size_t)i + 3 + k] = b[k]; }
  }
  void clear(uint32_t vert) { const uint32_t* i = at.find(vert); if (i) for (int k = 0; k < 6; k++) v[6 * (size_t)*i + k] = 0; }
  double get(uint32_t vert, int k) { const uint32_t* i = at.find(vert); return i ? v[6 * (size_t)*i + k] : 0; }
  void swap(PlaneN& o) { std::swap(at, o.at); v.swap(o.v); }
};

// A commit's result (sharpen.js commit / sharpen-corners.js commitCorners).
struct Commit {
  std::vector<double> P, N;
  SplitMap sp;
  std::vector<uint8_t> sharp;
  std::vector<int32_t> planes;
  PlaneN planeN;
  std::vector<uint32_t> added;    // candidate indices, in vertex order
  std::vector<uint32_t> marked;   // corners: the vertices made corners where they are or by a move
  std::vector<uint32_t> cut;      // the triangles on a split edge
  std::vector<uint32_t> pts;      // edge rounds: the vertices made edge points
  // Kept from one commit of a loop to the next (P, N, sharp, planes, planeN at their room for
  // the first commit's candidates): `moved` and the vertices it moved (`dirty`), put back in place;
  // a corner commit keeps their positions and normals before the move (`was`, six each).
  std::vector<uint8_t> moved;
  std::vector<uint32_t> dirty;
  std::vector<double> was;
  // Takes the buffers of the commit before it in the loop.
  void takeBuffers(Commit& o) {
    P.swap(o.P); N.swap(o.N); sharp.swap(o.sharp); planes.swap(o.planes); planeN.swap(o.planeN); moved.swap(o.moved); dirty.swap(o.dirty);
    was.swap(o.was);
  }
  // At the end of the loop: the arrays at the vertex count.
  void trim(bool edgeRound) {
    P.resize(3 * nv); N.resize(3 * nv);
    if (edgeRound) { sharp.resize(nv); planes.resize(2 * nv); }
  }
  Touched touched;
  size_t nv = 0;
  explicit Commit(uint64_t keyNv) : sp(keyNv) {}
};

// commit: the kept candidates (ok), in order: every move, then every split on an edge with
// neither end moved.
int commit(std::vector<ECand>& C, const Mesh& mesh, const Adj& adj, Commit& S, const FreeRule& freeV, ApartBase& apartBase) {
  const size_t nv0 = mesh.P.size() / 3;
  std::vector<uint32_t> kept;
  for (size_t q = 0; q < C.size(); q++) if (C[q].ok) kept.push_back((uint32_t)q);
  if (S.P.empty()) {
    // The first commit of the loop: room for a vertex per kept candidate (a later one keeps fewer).
    const size_t cap = nv0 + kept.size();
    S.P.reserve(3 * cap); S.N.reserve(3 * cap);
    S.P.assign(mesh.P.begin(), mesh.P.end()); S.N.assign(mesh.N.begin(), mesh.N.end());
    S.P.resize(3 * cap); S.N.resize(3 * cap);
    S.moved.assign(nv0, 0);
    S.sharp.assign(cap, 0); S.planes.assign(2 * cap, -1);
    if (mesh.hasSharp) {
      for (size_t i = 0; i < mesh.sharp.size(); i++) S.sharp[i] = mesh.sharp[i];
      for (size_t i = 0; i < mesh.planes.size(); i++) S.planes[i] = mesh.planes[i];
    }
  } else for (const uint32_t v : S.dirty) {
    for (int i = 0; i < 3; i++) S.P[3 * (size_t)v + i] = mesh.P[3 * (size_t)v + i];
    S.planeN.clear(v);
    S.moved[v] = 0;
    S.sharp[v] = mesh.hasSharp ? mesh.sharp[v] : 0;
    S.planes[2 * (size_t)v] = mesh.hasSharp ? mesh.planes[2 * (size_t)v] : -1;
    S.planes[2 * (size_t)v + 1] = mesh.hasSharp ? mesh.planes[2 * (size_t)v + 1] : -1;
  }
  S.dirty.clear();
  std::vector<uint8_t>& moved = S.moved;
  ApartView apart(apartBase, S.P.data());   // S.P is never resized before the loop ends
  size_t nv = nv0;
  auto setPlanes = [&](size_t v, const ECand& c) { S.planeN.set((uint32_t)v, c.uA, c.uB); };
  const std::vector<double>& P0 = mesh.P;
  const std::vector<double>& N0 = mesh.N;
  std::vector<uint32_t> scratch, edgeTris;
  std::vector<int64_t> ends(kept.size());
  for (size_t q = 0; q < kept.size(); q++) {
    const ECand& c = C[kept[q]];
    const double ax = P0[3 * (size_t)c.a], ay = P0[3 * (size_t)c.a + 1], az = P0[3 * (size_t)c.a + 2];
    const double ux = P0[3 * (size_t)c.b] - ax, uy = P0[3 * (size_t)c.b + 1] - ay, uz = P0[3 * (size_t)c.b + 2] - az;
    const double t = ((c.p[0] - ax) * ux + (c.p[1] - ay) * uy + (c.p[2] - az) * uz) / (ux * ux + uy * uy + uz * uz);
    ends[q] = t < SHARP_SNAP ? (int64_t)c.a : t > 1 - SHARP_SNAP ? (int64_t)c.b : -1;
  }
  // Moves first.
  for (size_t q = 0; q < kept.size(); q++) {
    const ECand& c = C[kept[q]];
    const int64_t end = ends[q];
    if (end < 0) continue;
    if (moved[c.a] || moved[c.b]) continue;
    if (!freeV.free((size_t)end)) { ends[q] = -1; continue; }
    if (apart.has(c.p, end)) continue;   // not tried as a split either: the same point
    const size_t e3 = 3 * (size_t)end;
    const double was[3] = {S.P[e3], S.P[e3 + 1], S.P[e3 + 2]};
    S.P[e3] = c.p[0]; S.P[e3 + 1] = c.p[1]; S.P[e3 + 2] = c.p[2];
    if (checkTris(mesh.T, adj.fanBegin((uint32_t)end), adj.fanEnd((uint32_t)end), S.sp, S.P.data(), S.N.data(), scratch)) {
      S.P[e3] = was[0]; S.P[e3 + 1] = was[1]; S.P[e3 + 2] = was[2];
      ends[q] = -1;
      continue;
    }
    moved[(size_t)end] = 1; S.sharp[(size_t)end] = 1; S.planes[2 * (size_t)end] = (int32_t)c.a; S.planes[2 * (size_t)end + 1] = (int32_t)c.b;
    setPlanes((size_t)end, c);
    apart.add((uint32_t)end); S.pts.push_back((uint32_t)end); S.dirty.push_back((uint32_t)end);
    for (const uint32_t* t = adj.fanBegin((uint32_t)end); t != adj.fanEnd((uint32_t)end); t++) S.touched.add(*t, (int32_t)kept[q], (int32_t)end);
  }
  // Then splits, on edges with neither end moved.
  for (size_t q = 0; q < kept.size(); q++) {
    const ECand& c = C[kept[q]];
    if (ends[q] >= 0) continue;
    if (moved[c.a] || moved[c.b]) continue;
    if (apart.has(c.p, -1)) continue;
    const size_t v = nv;
    const double sum[3] = {N0[3 * (size_t)c.a] + N0[3 * (size_t)c.b], N0[3 * (size_t)c.a + 1] + N0[3 * (size_t)c.b + 1], N0[3 * (size_t)c.a + 2] + N0[3 * (size_t)c.b + 2]};
    double n[3];
    if (!unit(sum, n)) n[0] = n[1] = n[2] = 0;
    for (int i = 0; i < 3; i++) { S.P[3 * v + i] = c.p[i]; S.N[3 * v + i] = n[i]; }
    S.sp.set(c.a, c.b, (int64_t)v);
    adj.byEdge(c.a < c.b ? c.a : c.b, c.a < c.b ? c.b : c.a, edgeTris);
    if (checkTris(mesh.T, edgeTris.data(), edgeTris.data() + edgeTris.size(), S.sp, S.P.data(), S.N.data(), scratch)) {
      S.sp.del(c.a, c.b);
      continue;
    }
    nv++; S.sharp[v] = 1; S.planes[2 * v] = (int32_t)c.a; S.planes[2 * v + 1] = (int32_t)c.b; setPlanes(v, c); S.added.push_back(kept[q]);
    apart.add((uint32_t)v); S.pts.push_back((uint32_t)v);
    for (const uint32_t t : edgeTris) S.touched.add(t, (int32_t)kept[q], -1);
    S.cut.insert(S.cut.end(), edgeTris.begin(), edgeTris.end());
  }
  // An earlier commit of the loop may have split more edges: its vertices past this one's count
  // keep no planes, so a vertex with no entry has none.
  for (size_t v = nv; v < S.P.size() / 3; v++) S.planeN.clear((uint32_t)v);
  S.nv = nv;
  return 0;
}

// ---------------------------------------------------------------------------
// Corners (sharpen-corners.js)

struct Plane { double n[3]; double d; uint32_t v; };

struct KCand {
  uint32_t a = 0, b = 0;
  double m[3] = {0, 0, 0}, p[3] = {0, 0, 0}, n[3] = {0, 0, 0};
  // The solve: the three faces' current unit normals, the read distance, and each face's
  // directions (four quadrants, or the ring's CORNER_RING; hasW false: none to read).
  double u[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
  double h = 0;
  double W[3][CORNER_RING][3] = {};
  bool hasW[3][CORNER_RING] = {};
  // Its start (point, planes, read distance), and whether it went back there (solveCorners).
  double p0[3] = {0, 0, 0}, u0[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}};
  double h0 = 0;
  bool back = false;
  int rough = 0;
  double clear = INF;
  int32_t leaf = 0;
  uint32_t ev = 0;
  bool ok = true;
  int from = 0, took = -1;
};

// The corner solve (sharpen-corners.js readCorners, cornerStep, solveCorners).
struct CSide { bool present = false; double f = 0, g[3] = {0, 0, 0}, w[3] = {0, 0, 0}; };
struct CRead { double f = NAN; CSide S[3]; };

// readCorners: one read of `live` (indices into C): each face at its four quadrant points (with
// `ring`, its CORNER_RING ring points), the face the one whose mean is nearest zero (the first on
// a tie); with withCentre the point too.
int readCorners(ipe::Session& s, std::vector<KCand>& C, const std::vector<uint32_t>& live, double edge, bool withCentre, std::vector<CRead>& rs,
                bool ring = false) {
  static const double QUAD[4][2] = {{-1, -1}, {-1, 1}, {1, -1}, {1, 1}};
  static const double RING[CORNER_RING][2] = {{1, 0}, {RING_C1, RING_S1}, {RING_R2, RING_R2}, {RING_S1, RING_C1}, {0, 1}, {-RING_S1, RING_C1},
    {-RING_R2, RING_R2}, {-RING_C1, RING_S1}, {-1, 0}, {-RING_C1, -RING_S1}, {-RING_R2, -RING_R2}, {-RING_S1, -RING_C1}, {0, -1},
    {RING_S1, -RING_C1}, {RING_R2, -RING_R2}, {RING_C1, -RING_S1}};
  const int nd = ring ? CORNER_RING : 4;
  const int per = SIDE_PTS, c0 = withCentre ? 1 : 0, PTS = c0 + 3 * nd * per;
  const double e = DIFF * edge;
  Points pts;
  for (const uint32_t q : live) {
    KCand& c = C[q];
    for (int i = 0; i < 3; i++) {
      const double* ni = c.u[i];
      const double* nj = c.u[(i + 1) % 3];
      const double* nk = c.u[(i + 2) % 3];
      const double dj = dot(ni, nj), dk = dot(ni, nk);
      const double pa[3] = {nj[0] - dj * ni[0], nj[1] - dj * ni[1], nj[2] - dj * ni[2]};
      const double pb[3] = {nk[0] - dk * ni[0], nk[1] - dk * ni[1], nk[2] - dk * ni[2]};
      double a[3], b[3];
      const bool okA = unit(pa, a);
      if (ring) {
        // The ring: from a, round ni (b = ni × a), not made unit again.
        if (okA) cross(ni, a, b);
        for (int t = 0; t < CORNER_RING; t++) {
          c.hasW[i][t] = okA;
          if (!okA) continue;
          const double ca = RING[t][0], sb = RING[t][1];
          c.W[i][t][0] = ca * a[0] + sb * b[0]; c.W[i][t][1] = ca * a[1] + sb * b[1]; c.W[i][t][2] = ca * a[2] + sb * b[2];
        }
        continue;
      }
      const bool okB = unit(pb, b);
      for (int t = 0; t < 4; t++) {
        c.hasW[i][t] = false;
        if (!okA || !okB) continue;
        const double sa = QUAD[t][0], sb = QUAD[t][1];
        const double v[3] = {sa * a[0] + sb * b[0], sa * a[1] + sb * b[1], sa * a[2] + sb * b[2]};
        c.hasW[i][t] = unit(v, c.W[i][t]);
      }
    }
    const double x = c.p[0], y = c.p[1], z = c.p[2];
    const int32_t pr = leaf_prog(s, c.leaf);
    if (withCentre) pts.add(x, y, z, pr);
    for (int i = 0; i < 3; i++) for (int t = 0; t < nd; t++) {
      const double zero[3] = {0, 0, 0};
      const double* w = c.hasW[i][t] ? c.W[i][t] : zero;
      const double sx = x + c.h * w[0], sy = y + c.h * w[1], sz = z + c.h * w[2];
      pts.add(sx + e, sy, sz, pr); pts.add(sx - e, sy, sz, pr);
      pts.add(sx, sy + e, sz, pr); pts.add(sx, sy - e, sz, pr);
      pts.add(sx, sy, sz + e, pr); pts.add(sx, sy, sz - e, pr);
    }
  }
  std::vector<double> d(pts.size());
  if (eval_points(s, pts, d.data(), nullptr, nullptr, nullptr) != 0) return 2;
  rs.assign(live.size(), CRead{});
  for (size_t q = 0; q < live.size(); q++) {
    const KCand& c = C[live[q]];
    const size_t o = (size_t)PTS * q;
    rs[q].f = withCentre ? d[o] : NAN;
    for (int i = 0; i < 3; i++) {
      CSide& best = rs[q].S[i];
      for (int t = 0; t < nd; t++) {
        if (!c.hasW[i][t]) continue;
        const size_t b = o + c0 + (size_t)per * (nd * i + t);
        const double f0 = d[b], f1 = d[b + 1], f2 = d[b + 2], f3 = d[b + 3], f4 = d[b + 4], f5 = d[b + 5];
        const double f = (f0 + f1 + f2 + f3 + f4 + f5) / 6;
        if (!std::isfinite(f) || (best.present && !(std::fabs(f) < std::fabs(best.f)))) continue;
        best.present = true; best.f = f;
        best.g[0] = (f0 - f1) / (2 * e); best.g[1] = (f2 - f3) / (2 * e); best.g[2] = (f4 - f5) / (2 * e);
        for (int k = 0; k < 3; k++) best.w[k] = c.W[i][t][k];
      }
    }
  }
  return 0;
}

// cornerDelta: the move that zeroes the three faces' linear models (Cramer's rule); false when it
// cannot be found (a face not read, the determinant under SHARP_CORNER_DET of the gradients'
// lengths' product, or a move that is not finite).
bool cornerDelta(const KCand& c, const CRead& r, double* dx) {
  const CSide& A = r.S[0];
  const CSide& B = r.S[1];
  const CSide& Cc = r.S[2];
  if (!A.present || !B.present || !Cc.present) return false;
  const double rA = -A.f + c.h * dot(A.g, A.w), rB = -B.f + c.h * dot(B.g, B.w), rC = -Cc.f + c.h * dot(Cc.g, Cc.w);
  const double* a = A.g;
  const double* b = B.g;
  const double* n = Cc.g;
  const double D = det3(a, b, n), scale = hypot3(a[0], a[1], a[2]) * hypot3(b[0], b[1], b[2]) * hypot3(n[0], n[1], n[2]);
  if (!(std::fabs(D) >= SHARP_CORNER_DET * scale)) return false;
  const double a0[3] = {rA, a[1], a[2]}, b0[3] = {rB, b[1], b[2]}, n0[3] = {rC, n[1], n[2]};
  const double a1[3] = {a[0], rA, a[2]}, b1[3] = {b[0], rB, b[2]}, n1[3] = {n[0], rC, n[2]};
  const double a2[3] = {a[0], a[1], rA}, b2[3] = {b[0], b[1], rB}, n2[3] = {n[0], n[1], rC};
  dx[0] = det3(a0, b0, n0) / D; dx[1] = det3(a1, b1, n1) / D; dx[2] = det3(a2, b2, n2) / D;
  return std::isfinite(hypot3(dx[0], dx[1], dx[2]));
}

// atStart: whether a candidate back at its start is the corner of the faces read there.
bool atStart(const KCand& c, const CRead& r, double edge) {
  double dx[3];
  return cornerDelta(c, r, dx) && hypot3(dx[0], dx[1], dx[2]) <= CONVERGED * edge;
}

// cornerStep: 0 (the step cannot be taken), 1 (taken) or 2 (converged: not taken).
int cornerStep(KCand& c, const CRead& r, double edge) {
  double dx[3];
  if (!cornerDelta(c, r, dx)) return 0;
  const double* a = r.S[0].g;
  const double* b = r.S[1].g;
  const double* n = r.S[2].g;
  const double len = hypot3(dx[0], dx[1], dx[2]);
  const double floor = SIDE * edge;
  const bool done = c.h <= floor && len <= CONVERGED * edge;
  const double sc = len > STEP_CAP * edge ? (STEP_CAP * edge) / len : 1;
  if (!done) for (int k = 0; k < 3; k++) c.p[k] += dx[k] * sc;
  double uA[3], uB[3], uC[3];
  const bool okA = unit(a, uA), okB = unit(b, uB), okC = unit(n, uC);
  if (okA && okB && okC) for (int k = 0; k < 3; k++) { c.u[0][k] = uA[k]; c.u[1][k] = uB[k]; c.u[2][k] = uC[k]; }
  const double half = c.h / 2;
  c.h = half > floor ? half : floor;
  return done ? 2 : 1;
}

// solveCorners: each candidate solved on the field; sets ok false on those not kept.
int solveCorners(ipe::Session& s, std::vector<KCand>& C, const std::vector<int32_t>& VL, double edge, double tol) {
  std::vector<uint32_t> live, next, redo, judged, back;
  for (size_t q = 0; q < C.size(); q++) live.push_back((uint32_t)q);
  std::vector<CRead> reads, rs, r2;
  for (int it = 0; it < CORNER_STEPS && !live.empty(); it++) {
    if (readCorners(s, C, live, edge, it == 0, rs) != 0) return 2;
    if (it == 0) {
      redo.clear();
      for (size_t q = 0; q < live.size(); q++) if (!std::isfinite(rs[q].f)) redo.push_back(live[q]);
      for (const uint32_t q : redo) { C[q].leaf = VL[C[q].b]; C[q].ev = C[q].b; }
      if (!redo.empty()) {
        if (readCorners(s, C, redo, edge, true, r2) != 0) return 2;
        size_t j = 0;
        for (size_t q = 0; q < live.size(); q++) if (j < redo.size() && live[q] == redo[j]) rs[q] = r2[j++];
      }
    }
    next.clear();
    for (size_t q = 0; q < live.size(); q++) {
      KCand& c = C[live[q]];
      const int st = cornerStep(c, rs[q], edge);
      if (!st) { back.push_back(live[q]); continue; }
      if (st == 2) { judged.push_back(live[q]); reads.push_back(rs[q]); continue; }
      next.push_back(live[q]);
    }
    live.swap(next);
  }
  if (!live.empty()) {
    if (readCorners(s, C, live, edge, true, rs) != 0) return 2;
    for (size_t q = 0; q < live.size(); q++) { judged.push_back(live[q]); reads.push_back(rs[q]); }
  }
  if (!back.empty()) {
    for (const uint32_t q : back) {
      KCand& c = C[q];
      for (int i = 0; i < 3; i++) { c.p[i] = c.p0[i]; for (int k = 0; k < 3; k++) c.u[i][k] = c.u0[i][k]; }
      c.h = c.h0; c.back = true;
    }
    if (readCorners(s, C, back, edge, true, rs, true) != 0) return 2;
    for (size_t q = 0; q < back.size(); q++) { judged.push_back(back[q]); reads.push_back(rs[q]); }
  }
  // The point itself, for those judged on a read without it.
  {
    Points pts;
    std::vector<size_t> at;
    for (size_t q = 0; q < judged.size(); q++) {
      const KCand& c = C[judged[q]];
      if (!std::isfinite(reads[q].f)) { pts.add(c.p[0], c.p[1], c.p[2], leaf_prog(s, c.leaf)); at.push_back(q); }
    }
    if (!at.empty()) {
      std::vector<double> d(pts.size());
      if (eval_points(s, pts, d.data(), nullptr, nullptr, nullptr) != 0) return 2;
      for (size_t i = 0; i < at.size(); i++) reads[at[i]].f = d[i];
    }
  }
  for (size_t q = 0; q < judged.size(); q++) {
    KCand& c = C[judged[q]];
    const CRead& r = reads[q];
    double u[3][3];
    bool okU = true;
    for (int i = 0; i < 3; i++) okU = (r.S[i].present && unit(r.S[i].g, u[i])) && okU;
    const double dm = hypot3(c.p[0] - c.m[0], c.p[1] - c.m[1], c.p[2] - c.m[2]);
    if (!okU || !std::isfinite(r.f) || (c.back && !atStart(c, r, edge))) c.ok = false;
    else if (!(dm <= SHARP_MAX_MOVE * edge)) c.ok = false;
    else if (!(std::fabs(r.f) <= tol)) c.ok = false;
    else if (!(dot(u[0], u[1]) < SHARP_ANGLE_COS && dot(u[1], u[2]) < SHARP_ANGLE_COS && dot(u[0], u[2]) < SHARP_ANGLE_COS)) c.ok = false;
    else {
      const double sum[3] = {u[0][0] + u[1][0] + u[2][0], u[0][1] + u[1][1] + u[2][1], u[0][2] + u[1][2] + u[2][2]};
      if (!unit(sum, c.n)) c.ok = false;
    }
  }
  return 0;
}

// What a corner pass gives the round: the re-triangulated list, the candidates that made a
// vertex (their leaf and evaluating end) in vertex order, and the vertices made corners.
struct CornerOut {
  std::vector<uint32_t> out;
  std::vector<int32_t> addedLeaf;
  std::vector<uint32_t> addedEv;
  std::vector<uint32_t> marked;
};

struct CornerCtx {
  ipe::Session& s;
  std::vector<double>& P;     // the current positions and normals; replaced by the pass
  std::vector<double>& N;
  const std::vector<uint32_t>& T;
  const std::vector<int32_t>& VL;
  const std::vector<double>& P0;
  const std::vector<double>& N0;
  const std::vector<uint8_t>& sharp;
  PlaneN& planeN;
  const FreeRule& rule;                  // free and noPlane, per vertex
  double edge;
  bool across;
  const std::vector<uint32_t>& pts;      // every vertex with sharp 1, any order
  const std::vector<uint32_t>& have;     // across: every vertex with sharp 2
};

// commitCorners: the kept candidates, each by its first try (from c.from) with no flip or sliver.
void commitCorners(std::vector<KCand>& C, CornerCtx& x, const Adj& adj, Commit& S, ApartBase& apartBase, size_t nv1) {
  if (S.P.empty()) {
    // The first commit of the loop takes the pass's positions and normals (cornerPass gives them
    // back at the end), with room for a vertex per candidate.
    const size_t cap = nv1 + C.size();
    S.P.swap(x.P); S.N.swap(x.N);
    S.P.resize(3 * cap); S.N.resize(3 * cap);
    S.moved.assign(nv1, 0);
  } else for (size_t q = 0; q < S.dirty.size(); q++) {
    const size_t v = S.dirty[q];
    for (int i = 0; i < 3; i++) { S.P[3 * v + i] = S.was[6 * q + i]; S.N[3 * v + i] = S.was[6 * q + 3 + i]; }
    S.moved[v] = 0;
  }
  S.dirty.clear(); S.was.clear();
  std::vector<uint8_t>& moved = S.moved;
  ApartView apart(apartBase, S.P.data());   // S.P is never resized before the loop ends
  size_t nv = nv1;
  struct Made { uint32_t v; };
  std::vector<Made> made;
  const double edge = x.edge;
  const double R2 = CORNER_MERGE * edge * CORNER_MERGE * edge, M2 = SHARP_MAX_MOVE * edge * SHARP_MAX_MOVE * edge;
  auto d2 = [&](size_t v, const double* p) {
    const double a = S.P[3 * v] - p[0], b = S.P[3 * v + 1] - p[1], c = S.P[3 * v + 2] - p[2];
    return a * a + b * b + c * c;
  };
  std::vector<uint32_t> scratch, edgeTris;
  auto nextTo = [&](uint32_t v, const KCand& c) {
    adj.byEdge(c.a < c.b ? c.a : c.b, c.a < c.b ? c.b : c.a, edgeTris);
    for (const uint32_t t : edgeTris) {
      const uint32_t p = x.T[3 * (size_t)t], q = x.T[3 * (size_t)t + 1], r = x.T[3 * (size_t)t + 2];
      if (p == v || q == v || r == v || S.sp.get(p, q) == (int64_t)v || S.sp.get(q, r) == (int64_t)v || S.sp.get(r, p) == (int64_t)v) return true;
    }
    return false;
  };
  auto moveTo = [&](uint32_t v, size_t ci) {
    const KCand& c = C[ci];
    if (moved[v] || !x.rule.free(v) || d2(v, c.p) > M2) return false;
    if (apart.has(c.p, v)) return false;
    const size_t o = 3 * (size_t)v;
    const double was[3] = {S.P[o], S.P[o + 1], S.P[o + 2]}, wn[3] = {S.N[o], S.N[o + 1], S.N[o + 2]};
    for (int i = 0; i < 3; i++) { S.P[o + i] = c.p[i]; S.N[o + i] = c.n[i]; }
    if (checkTris(x.T, adj.fanBegin(v), adj.fanEnd(v), S.sp, S.P.data(), S.N.data(), scratch)) {
      for (int i = 0; i < 3; i++) { S.P[o + i] = was[i]; S.N[o + i] = wn[i]; }
      return false;
    }
    moved[v] = 1; S.marked.push_back(v); made.push_back(Made{v}); S.dirty.push_back(v);
    S.was.insert(S.was.end(), was, was + 3); S.was.insert(S.was.end(), wn, wn + 3);
    apart.add(v);
    for (const uint32_t* t = adj.fanBegin(v); t != adj.fanEnd(v); t++) S.touched.add(*t, (int32_t)ci, 0);
    return true;
  };
  for (size_t ci = 0; ci < C.size(); ci++) {
    KCand& c = C[ci];
    if (!c.ok) continue;
    c.took = -1;
    int64_t v = -1;
    for (const Made& q : made) if (d2(q.v, c.p) <= R2) { v = q.v; break; }
    if (v == (int64_t)c.a || v == (int64_t)c.b) { c.took = c.from; continue; }   // already the corner
    if (v >= 0 && !nextTo((uint32_t)v, c)) continue;   // a corner vertex not next to the edge
    const uint32_t near = d2(c.a, c.p) <= d2(c.b, c.p) ? c.a : c.b, far = near == c.a ? c.b : c.a;
    for (int k = c.from; k < TRIES && c.took < 0; k++) {
      if (k == 0) { if (v < 0 && d2(near, c.p) <= R2 && moveTo(near, ci)) c.took = k; continue; }
      if (k == 2 || k == 3) { if (v < 0 && moveTo(k == 2 ? near : far, ci)) c.took = k; continue; }
      // k == 1: split, at the shared vertex when there is one.
      const bool fresh = v < 0;
      const size_t u = fresh ? nv : (size_t)v;
      if (fresh && apart.has(c.p, -1)) continue;
      if (fresh) for (int i = 0; i < 3; i++) { S.P[3 * u + i] = c.p[i]; S.N[3 * u + i] = c.n[i]; }
      S.sp.set(c.a, c.b, (int64_t)u);
      adj.byEdge(c.a < c.b ? c.a : c.b, c.a < c.b ? c.b : c.a, edgeTris);
      const std::vector<uint32_t> tris = edgeTris;
      if (checkTris(x.T, tris.data(), tris.data() + tris.size(), S.sp, S.P.data(), S.N.data(), scratch)) {
        S.sp.del(c.a, c.b);
        continue;
      }
      if (fresh) { nv++; made.push_back(Made{(uint32_t)u}); S.added.push_back((uint32_t)ci); apart.add((uint32_t)u); }
      for (const uint32_t t : tris) S.touched.add(t, (int32_t)ci, 0);
      S.cut.insert(S.cut.end(), tris.begin(), tris.end());
      c.took = k;
    }
  }
  S.nv = nv;
}

// cornerPass: step 6 on the split mesh x.T. Returns 0, or nonzero when an evaluation fails.
int cornerPass(CornerCtx& x, CornerOut& res) {
  ipe::Session& s = x.s;
  const std::vector<uint32_t>& T = x.T;
  const std::vector<double>& P = x.P;
  const size_t nv1 = P.size() / 3;
  const double edge = x.edge;
  const std::vector<uint32_t>& have = x.have;
  auto planesOf = [&](uint32_t v, std::vector<Plane>& out) {
    if (x.sharp[v] == 1) {
      const double px = P[3 * (size_t)v], py = P[3 * (size_t)v + 1], pz = P[3 * (size_t)v + 2];
      for (int j = 0; j < 6; j += 3) {
        Plane q;
        q.n[0] = x.planeN.get(v, j); q.n[1] = x.planeN.get(v, j + 1); q.n[2] = x.planeN.get(v, j + 2);
        q.d = q.n[0] * px + q.n[1] * py + q.n[2] * pz; q.v = v;
        out.push_back(q);
      }
      return;
    }
    // Past the round's input count N0 has no entry: unit(undefined…) is null in the JS.
    if (x.rule.noPlane(v)) return;
    Plane q;
    if (!unit(&x.N0[3 * (size_t)v], q.n)) return;
    q.d = q.n[0] * x.P0[3 * (size_t)v] + q.n[1] * x.P0[3 * (size_t)v + 1] + q.n[2] * x.P0[3 * (size_t)v + 2]; q.v = v;
    out.push_back(q);
  };
  Adj adj;
  adj.build(T, nv1);
  std::vector<KCand> cand;
  const double R = CORNER_MERGE * edge;
  auto offer = [&](const std::vector<Plane>& ordered, uint32_t lo, uint32_t hi) {
    const Plane* set[3];
    int ns = 0;
    for (const Plane& q : ordered) {
      bool every = true;
      for (int i = 0; i < ns && i < 3; i++) if (!(dot(set[i]->n, q.n) < SHARP_ANGLE_COS)) { every = false; break; }
      if (every) { if (ns < 3) set[ns] = &q; ns++; }
    }
    if (ns != 3) return;
    const double* n0 = set[0]->n;
    const double* n1 = set[1]->n;
    const double* n2 = set[2]->n;
    double c12[3], c20[3], c01[3];
    cross(n1, n2, c12); cross(n2, n0, c20); cross(n0, n1, c01);
    const double det = dot(n0, c12);
    if (!(std::fabs(det) >= SHARP_CORNER_DET)) return;
    double p[3];
    for (int i = 0; i < 3; i++) p[i] = (set[0]->d * c12[i] + set[1]->d * c20[i] + set[2]->d * c01[i]) / det;
    KCand c;
    c.m[0] = (P[3 * (size_t)lo] + P[3 * (size_t)hi]) / 2; c.m[1] = (P[3 * (size_t)lo + 1] + P[3 * (size_t)hi + 1]) / 2;
    c.m[2] = (P[3 * (size_t)lo + 2] + P[3 * (size_t)hi + 2]) / 2;
    if (!(hypot3(c.m[0] - p[0], c.m[1] - p[1], c.m[2] - p[2]) <= SHARP_MAX_MOVE * edge)) return;
    // A start on a corner made so far is that corner: not solved again.
    for (const uint32_t v : have) if (hypot3(P[3 * (size_t)v] - p[0], P[3 * (size_t)v + 1] - p[1], P[3 * (size_t)v + 2] - p[2]) <= R) return;
    const double sum[3] = {n0[0] + n1[0] + n2[0], n0[1] + n1[1] + n2[1], n0[2] + n1[2] + n2[2]};
    double sn[3];
    if (!unit(sum, sn)) return;   // the three normals cancel: no side to face
    int rough = 0;
    double clear = INF, reach = 0;
    for (int i = 0; i < 3; i++) {
      const uint32_t w = set[i]->v;
      if (x.sharp[w] != 1) rough++;
      const double dd = hypot3(P[3 * (size_t)w] - p[0], P[3 * (size_t)w + 1] - p[1], P[3 * (size_t)w + 2] - p[2]);
      clear = jsmin(clear, dd);
      reach = jsmax(reach, dd);
    }
    c.h = reach < SIDE * edge ? SIDE * edge : reach > CORNER_SIDE_MAX * edge ? CORNER_SIDE_MAX * edge : reach;
    c.a = lo; c.b = hi;
    for (int i = 0; i < 3; i++) { c.p[i] = p[i]; c.u[0][i] = n0[i]; c.u[1][i] = n1[i]; c.u[2][i] = n2[i]; }
    for (int i = 0; i < 3; i++) { c.p0[i] = p[i]; c.u0[0][i] = n0[i]; c.u0[1][i] = n1[i]; c.u0[2][i] = n2[i]; }
    c.h0 = c.h;
    c.rough = rough; c.clear = clear; c.leaf = x.VL[lo]; c.ev = lo;
    cand.push_back(c);
  };
  std::vector<Plane> ordered;
  std::vector<uint32_t> seen;
  // Only a triangle with an edge point can hold a candidate edge: the edge points' fans, in index order.
  std::vector<uint32_t> near;
  for (const uint32_t v : x.pts) near.insert(near.end(), adj.fanBegin(v), adj.fanEnd(v));
  std::sort(near.begin(), near.end());
  near.erase(std::unique(near.begin(), near.end()), near.end());
  for (const uint32_t tt : near) for (int k = 0; k < 3; k++) {
    const size_t t = 3 * (size_t)tt;
    const uint32_t a = T[t + k], b = T[t + (k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
    if ((x.sharp[lo] != 1 && x.sharp[hi] != 1) || !adj.first((uint32_t)(t / 3), lo, hi)) continue;
    // The distinct planes: an edge point's first (a mesher vertex's normal is the rougher one).
    const uint32_t v = x.sharp[lo] == 1 ? lo : hi, u = v == lo ? hi : lo;
    if (!x.across) { ordered.clear(); planesOf(v, ordered); planesOf(u, ordered); offer(ordered, lo, hi); continue; }
    // When u is not an edge point: v's planes with those of each edge point w across u, in u's fan order.
    if (x.sharp[u] == 1) continue;
    seen.clear();
    for (const uint32_t* f = adj.fanBegin(u); f != adj.fanEnd(u); f++) for (int j = 0; j < 3; j++) {
      const uint32_t w = T[3 * (size_t)*f + j];
      if (w == v || w == u || x.sharp[w] != 1) continue;
      bool dup = false;
      for (const uint32_t z : seen) if (z == w) { dup = true; break; }
      if (dup) continue;
      seen.push_back(w);
      ordered.clear(); planesOf(v, ordered); planesOf(w, ordered); offer(ordered, lo, hi);
    }
  }
  // Each candidate solved on the field's faces; then, on the across pass, its solved point clear of
  // the corners made so far too. Only those kept go on.
  const double tol = (x.across ? ACROSS_TOL : SHARP_TOL) * edge;
  if (!cand.empty()) {
    if (solveCorners(s, cand, x.VL, edge, tol) != 0) return 2;
    std::vector<KCand> kept;
    for (const KCand& c : cand) {
      if (!c.ok) continue;
      bool near = false;
      for (const uint32_t v : have) if (hypot3(P[3 * (size_t)v] - c.p[0], P[3 * (size_t)v + 1] - c.p[1], P[3 * (size_t)v + 2] - c.p[2]) <= R) { near = true; break; }
      if (!near) kept.push_back(c);
    }
    cand.swap(kept);
  }
  if (cand.empty()) { res.out = T; return 0; }
  // One point per corner: grouped against each group's first point; the best member's point.
  {
    std::vector<std::vector<size_t>> groups;
    for (size_t q = 0; q < cand.size(); q++) {
      const KCand& c = cand[q];
      bool found = false;
      for (std::vector<size_t>& g : groups) {
        const KCand& f = cand[g[0]];
        if (hypot3(f.p[0] - c.p[0], f.p[1] - c.p[1], f.p[2] - c.p[2]) <= R) { g.push_back(q); found = true; break; }
      }
      if (!found) groups.push_back(std::vector<size_t>{q});
    }
    for (const std::vector<size_t>& g : groups) {
      size_t best = g[0];
      for (const size_t q : g) {
        const KCand& c = cand[q];
        const KCand& b = cand[best];
        if (c.rough < b.rough || (c.rough == b.rough && c.clear > b.clear)) best = q;
      }
      const KCand bc = cand[best];
      for (const size_t q : g) for (int i = 0; i < 3; i++) { cand[q].p[i] = bc.p[i]; cand[q].n[i] = bc.n[i]; }
    }
  }
  // The field at each point, with its first end's leaf program, or its other end's when the first
  // gives a non-finite value.
  {
    Points pts;
    for (const KCand& c : cand) pts.add(c.p[0], c.p[1], c.p[2], leaf_prog(s, c.leaf));
    std::vector<double> d(cand.size());
    if (eval_points(s, pts, d.data(), nullptr, nullptr, nullptr) != 0) return 2;
    std::vector<size_t> redo;
    for (size_t q = 0; q < cand.size(); q++) if (!std::isfinite(d[q])) redo.push_back(q);
    for (const size_t q : redo) { cand[q].leaf = x.VL[cand[q].b]; cand[q].ev = cand[q].b; }
    std::vector<double> d2(redo.size());
    if (!redo.empty()) {
      pts.clear();
      for (const size_t q : redo) pts.add(cand[q].p[0], cand[q].p[1], cand[q].p[2], leaf_prog(s, cand[q].leaf));
      if (eval_points(s, pts, d2.data(), nullptr, nullptr, nullptr) != 0) return 2;
    }
    size_t r = 0;
    for (size_t q = 0; q < cand.size(); q++) {
      const double f = std::isfinite(d[q]) ? d[q] : d2[r++];
      if (!(std::fabs(f) <= tol)) cand[q].ok = false;
    }
  }
  // Commit, then the field-flip rounds: a candidate whose change flipped one goes on to its next try.
  std::unique_ptr<Commit> S;
  std::vector<uint32_t> flipped;
  ApartBase apartBase;
  {
    std::vector<double> asks;
    for (const KCand& c : cand) if (c.ok) asks.insert(asks.end(), c.p, c.p + 3);
    apartBase.build(P.data(), nv1, edge, asks);
  }
  for (;;) {
    std::unique_ptr<Commit> next(new Commit((uint64_t)nv1));
    if (S) next->takeBuffers(*S);
    S = std::move(next);
    commitCorners(cand, x, adj, *S, apartBase, nv1);
    if (fieldFlips(s, S->P.data(), S->sp, S->touched, false, x.VL, T, edge, nullptr, flipped) != 0) {
      S->trim(false); x.P.swap(S->P); x.N.swap(S->N);   // give the positions back, as they stand
      return 2;
    }
    if (flipped.empty()) break;
    for (const uint32_t t : flipped) {
      const uint32_t* i = S->touched.idx.find(t);
      for (const int32_t ci : S->touched.by[*i]) {
        KCand& c = cand[(size_t)ci];
        if (c.ok && c.from <= c.took) {
          c.from = c.took + 1;
          if (c.from >= TRIES) c.ok = false;
        }
      }
    }
  }
  retriangulate(T, S->cut, S->sp, res.out);
  for (const uint32_t ci : S->added) { res.addedLeaf.push_back(cand[ci].leaf); res.addedEv.push_back(cand[ci].ev); }
  res.marked = S->marked;
  S->trim(false);
  x.P.swap(S->P);
  x.N.swap(S->N);
  return 0;
}

// ---------------------------------------------------------------------------
// One round (sharpen.js sharpenRound): steps 1 to 5, then with `corners` step 6 and step 7.
// `retry` is null for the first round; in step 7 it is the first round's solved candidates.
// `mesh` is replaced by the result, or left as it is when there is no candidate.
int sharpenRound(ipe::Session& s, Mesh& mesh, bool corners, const std::vector<ECand>* retry) {
  const double edge = s.edge;
  const size_t nv0 = mesh.P.size() / 3;
  const std::vector<double>& N0 = mesh.N;
  const std::vector<double>& P0 = mesh.P;
  const std::vector<uint32_t>& T = mesh.T;
  const std::vector<int32_t>& VL0 = mesh.VL;
  auto pinned = [&](size_t v) { return mesh.owner ? mesh.pin[v] : 0; };
  auto creased = [&](size_t v) { return mesh.hasCrease ? mesh.crease[v] : 0; };
  auto prior = [&](size_t v) { return mesh.hasSharp ? mesh.sharp[v] : 0; };

  // 1. The candidate edges, in the order the triangle list first names them. The first round tests
  // every edge's angle before it builds anything else; step 7 with nothing to retry costs nothing.
  if (retry && retry->empty()) return 0;
  std::vector<uint32_t> hits;   // the first round's half-edges past the angle test (t + k), in order
  std::vector<double> lens;      // each normal's length, taken once per vertex
  if (!retry) {
    lens.resize(nv0);
    for (size_t v = 0; v < nv0; v++) lens[v] = hypot3(N0[3 * v], N0[3 * v + 1], N0[3 * v + 2]);
    for (size_t t = 0; t < T.size(); t += 3) for (int k = 0; k < 3; k++) {
      const uint32_t a = T[t + k], b = T[t + (k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
      if (pinned(lo) || pinned(hi) || creased(lo) || creased(hi) || prior(lo) || prior(hi)) continue;
      const size_t x = 3 * (size_t)lo, y = 3 * (size_t)hi;
      const double ax = N0[x], ay = N0[x + 1], az = N0[x + 2], bx = N0[y], by = N0[y + 1], bz = N0[y + 2];
      const double lA = lens[lo], lB = lens[hi];
      if (!(lA > 0.5 && lB > 0.5) || ax * bx + ay * by + az * bz >= SHARP_ANGLE_COS * lA * lB) continue;
      hits.push_back((uint32_t)(t + k));
    }
    if (hits.empty()) return 0;
  }
  Adj adj;
  adj.build(T, nv0);
  std::vector<ECand> cand;
  // lo * nv0 + hi in 64 bits (exact in a JS double below 2^53).
  flat::Map<uint32_t> again(retry ? retry->size() * 2 + 16 : 16);
  if (retry) for (size_t q = 0; q < retry->size(); q++) again.insert((uint64_t)(*retry)[q].a * nv0 + (*retry)[q].b, (uint32_t)q);
  // The density rule: each edge belongs to the leaf program of its lower end's sparse-grid leaf.
  int32_t maxProg = -1;
  for (size_t L = 0; L < s.leaves.size() / 4; L++) { const int32_t pr = leaf_prog(s, (int32_t)L); if (pr > maxProg) maxProg = pr; }
  const size_t nProg = (size_t)(1 + maxProg);
  auto progOf = [&](size_t v) { return (size_t)leaf_prog(s, VL0[v]); };
  // And each triangle to its lowest vertex's: progArea sums twice each triangle's area, in triangle order.
  std::vector<double> progArea(nProg, 0.0);
  std::vector<int32_t> progCand(nProg, 0);
  if (!retry) {
    for (size_t t = 0; t < T.size(); t += 3) {
      const uint32_t a = T[t], b = T[t + 1], c = T[t + 2], lo = a < b ? (a < c ? a : c) : (b < c ? b : c);
      const double ux = P0[3 * b] - P0[3 * a], uy = P0[3 * b + 1] - P0[3 * a + 1], uz = P0[3 * b + 2] - P0[3 * a + 2];
      const double vx = P0[3 * c] - P0[3 * a], vy = P0[3 * c + 1] - P0[3 * a + 1], vz = P0[3 * c + 2] - P0[3 * a + 2];
      const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      progArea[progOf(lo)] += std::sqrt(nx * nx + ny * ny + nz * nz);
    }
  }
  if (retry) {
    // Step 7 looks only at its own edges (the first of a repeated one): each where a scan of the
    // triangle list would first find it (the first triangle holding both ends, the place in it).
    std::vector<std::pair<size_t, uint32_t>> at;
    std::vector<uint32_t> tris;
    for (size_t q = 0; q < retry->size(); q++) {
      const uint32_t lo = (*retry)[q].a, hi = (*retry)[q].b;
      const uint32_t* w = again.find((uint64_t)lo * nv0 + hi);
      if (!w || *w != q) continue;
      if (pinned(lo) || pinned(hi) || creased(lo) || creased(hi) || prior(lo) || prior(hi)) continue;
      adj.byEdge(lo, hi, tris);
      if (tris.empty()) continue;
      const size_t t = 3 * (size_t)tris[0];
      for (int k = 0; k < 3; k++) {
        const uint32_t a = T[t + k], b = T[t + (k + 1) % 3];
        if ((a == lo && b == hi) || (a == hi && b == lo)) at.push_back({t + k, (uint32_t)q});
      }
    }
    std::sort(at.begin(), at.end());
    for (const auto& e : at) { ECand c = (*retry)[e.second]; c.ok = true; cand.push_back(c); }
  }
  if (!retry) for (const uint32_t i : hits) {
    const size_t t = i - i % 3;
    const uint32_t a = T[i], b = T[t + (i % 3 + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
    const size_t x = 3 * (size_t)lo, y = 3 * (size_t)hi;
    const double lA = lens[lo], lB = lens[hi];
    if (!adj.first((uint32_t)(t / 3), lo, hi)) continue;
    progCand[progOf(lo)]++;
    ECand c;
    double pA[3], pB[3], ab[3];
    for (int i = 0; i < 3; i++) {
      c.uA[i] = N0[x + i] / lA; c.uB[i] = N0[y + i] / lB; pA[i] = P0[x + i]; pB[i] = P0[y + i];
    }
    for (int i = 0; i < 3; i++) { c.m[i] = (pA[i] + pB[i]) / 2; ab[i] = pB[i] - pA[i]; }
    // The point nearest the middle on both tangent planes: m + α·nA + β·nB.
    const double cc = dot(c.uA, c.uB), det = 1 - cc * cc;
    if (!(det > 1e-9)) continue;   // normals (anti)parallel: the planes do not meet in a line
    const double ra = -(c.uA[0] * (c.m[0] - pA[0]) + c.uA[1] * (c.m[1] - pA[1]) + c.uA[2] * (c.m[2] - pA[2]));
    const double rb = -(c.uB[0] * (c.m[0] - pB[0]) + c.uB[1] * (c.m[1] - pB[1]) + c.uB[2] * (c.m[2] - pB[2]));
    const double al = (ra - cc * rb) / det, be = (rb - cc * ra) / det;
    for (int i = 0; i < 3; i++) c.p[i] = c.m[i] + al * c.uA[i] + be * c.uB[i];
    const double conv = ab[0] * (c.uB[0] - c.uA[0]) + ab[1] * (c.uB[1] - c.uA[1]) + ab[2] * (c.uB[2] - c.uA[2]);
    const double sm[3] = {c.uA[0] + c.uB[0], c.uA[1] + c.uB[1], c.uA[2] + c.uB[2]};
    const double cr[3] = {ab[1] * sm[2] - ab[2] * sm[1], ab[2] * sm[0] - ab[0] * sm[2], ab[0] * sm[1] - ab[1] * sm[0]};
    c.hasPn = unit(cr, c.pn);
    c.a = lo; c.b = hi; c.sigma = conv > 0 ? 1 : -1; c.ok = conv != 0; c.leaf = VL0[lo]; c.ev = lo;
    cand.push_back(c);
  }
  if (!retry) {
    // A program with more than SHARP_DENSE_PER_CELL candidates per cell of its area is a texture
    // or facets finer than the grid: none of its candidates is tried (sharpen.js's dense).
    std::vector<ECand> kept;
    for (const ECand& c : cand) {
      const int32_t n = progCand[progOf(c.a)];
      if (!(2 * (double)n * (edge * edge) > SHARP_DENSE_PER_CELL * progArea[progOf(c.a)] && n > SHARP_DENSE_MIN)) kept.push_back(c);
    }
    cand.swap(kept);
  }
  if (cand.empty()) return 0;
  if (!retry && solve(s, cand, VL0, edge) != 0) return 2;

  // 4. Commit, in candidate order; then every changed triangle's final form is read against the
  // field, and the candidates that changed one facing against it are dropped and the commit run again.
  const FreeRule freeV{&mesh, nv0, nullptr};
  std::unique_ptr<Commit> S;
  Memo memo;
  std::vector<uint32_t> flipped;
  ApartBase apartBase;
  {
    std::vector<double> asks;
    for (const ECand& c : cand) if (c.ok) asks.insert(asks.end(), c.p, c.p + 3);
    apartBase.build(P0.data(), nv0, edge, asks);
  }
  for (;;) {
    std::unique_ptr<Commit> next(new Commit((uint64_t)nv0));
    if (S) next->takeBuffers(*S);
    S = std::move(next);
    commit(cand, mesh, adj, *S, freeV, apartBase);
    if (fieldFlips(s, S->P.data(), S->sp, S->touched, true, VL0, T, edge, &memo, flipped) != 0) return 2;
    if (flipped.empty()) break;
    for (const uint32_t t : flipped) {
      const uint32_t* i = S->touched.idx.find(t);
      for (const int32_t ci : S->touched.by[*i]) if (cand[(size_t)ci].ok) cand[(size_t)ci].ok = false;
    }
  }

  // 5. Re-triangulate. A new vertex takes its evaluating end's leaf and owner.
  Mesh res;
  res.owner = mesh.owner; res.hasCrease = mesh.hasCrease; res.hasSharp = true;
  retriangulate(T, S->cut, S->sp, res.T);
  res.VL = VL0;
  if (mesh.owner) { res.VO = mesh.VO; res.held = mesh.held; res.pin = mesh.pin; }
  if (mesh.hasCrease) res.crease = mesh.crease;
  auto grow = [&](int32_t leaf, uint32_t ev) {
    res.VL.push_back(leaf);
    if (res.owner) { res.VO.push_back(res.VO[ev]); res.held.push_back(0); res.pin.push_back(0); }
    if (res.hasCrease) res.crease.push_back(0);
  };
  for (const uint32_t ci : S->added) grow(cand[ci].leaf, cand[ci].ev);
  std::vector<double> P, N;
  S->trim(true);
  P.swap(S->P); N.swap(S->N);
  const size_t nv1 = P.size() / 3;
  std::vector<uint32_t> marked;
  // The `sharp` table for the current vertices: step 5's, then 2 for every corner point so far.
  auto sharpNow = [&]() {
    std::vector<uint8_t> r(P.size() / 3, 2);
    for (size_t v = 0; v < nv1; v++) r[v] = S->sharp[v];
    for (const uint32_t v : marked) r[v] = 2;
    return r;
  };
  // The edge points for the corner passes: those of an earlier round (a mesh given with `sharp`),
  // then this commit's. The corner points of an earlier round.
  std::vector<uint32_t> pts, had;
  if (mesh.hasSharp) for (size_t v = 0; v < nv0; v++) { if (mesh.sharp[v] == 1) pts.push_back((uint32_t)v); else if (mesh.sharp[v] == 2) had.push_back((uint32_t)v); }
  pts.insert(pts.end(), S->pts.begin(), S->pts.end());
  if (corners) {
    {
      std::vector<uint32_t> Tin;
      Tin.swap(res.T);
      const std::vector<uint32_t> none;
      CornerCtx x{s, P, N, Tin, res.VL, P0, N0, S->sharp, S->planeN, freeV, edge, false, pts, none};
      CornerOut C;
      if (cornerPass(x, C) != 0) return 2;
      res.T.swap(C.out);
      marked.insert(marked.end(), C.marked.begin(), C.marked.end());
      for (size_t i = 0; i < C.addedLeaf.size(); i++) grow(C.addedLeaf[i], C.addedEv[i]);
    }
    // 6b. Corners across a bevel vertex, where the first pass made none. A corner point made so
    // far never moves.
    {
      const std::vector<uint8_t> sh = sharpNow();
      std::vector<uint32_t> have(had), pts2;
      have.insert(have.end(), marked.begin(), marked.end());
      for (size_t v = nv1; v < P.size() / 3; v++) have.push_back((uint32_t)v);
      for (const uint32_t v : pts) if (sh[v] == 1) pts2.push_back(v);
      const FreeRule freeD{&mesh, nv0, &sh};
      std::vector<uint32_t> Tin;
      Tin.swap(res.T);
      CornerCtx x{s, P, N, Tin, res.VL, P0, N0, sh, S->planeN, freeD, edge, true, pts2, have};
      CornerOut D;
      if (cornerPass(x, D) != 0) return 2;
      res.T.swap(D.out);
      marked.insert(marked.end(), D.marked.begin(), D.marked.end());
      for (size_t i = 0; i < D.addedLeaf.size(); i++) grow(D.addedLeaf[i], D.addedEv[i]);
    }
  }
  const size_t nvF = P.size() / 3;
  res.sharp = sharpNow();
  res.planes.assign(2 * nvF, -1);
  for (size_t i = 0; i < S->planes.size(); i++) res.planes[i] = S->planes[i];
  for (const uint32_t v : marked) { res.planes[2 * (size_t)v] = -1; res.planes[2 * (size_t)v + 1] = -1; }
  res.P.swap(P);
  res.N.swap(N);
  std::vector<ECand> solved;
  if (corners) for (const ECand& c : cand) if (c.solved) solved.push_back(c);
  mesh = std::move(res);
  // 7. One more edge round, on edges with neither end an edge or corner point.
  if (corners) return sharpenRound(s, mesh, false, &solved);
  return 0;
}

}  // namespace

int sharpen(ipe::Session& s) {
  if (!s.meshed || s.normals.size() != s.positions.size() || s.vertLeaf.size() * 3 != s.positions.size()) return 1;
  const size_t nv = s.positions.size() / 3;
  if (s.ownerMesh && (s.vertOwner.size() != nv || s.ownerHeld.size() != nv || s.pinned.size() != nv
      || (s.hasCrease && s.creaseMark.size() != nv))) return 1;
  for (const int32_t L : s.vertLeaf) if (L < 0 || (size_t)L >= s.leaves.size() / 4) return 1;
  for (const uint32_t v : s.indices) if (v >= nv) return 1;
  Mesh m;
  m.P.swap(s.positions); m.N.swap(s.normals); m.T.swap(s.indices); m.VL.swap(s.vertLeaf);
  m.owner = s.ownerMesh; m.hasCrease = s.ownerMesh && s.hasCrease;
  if (m.owner) { m.VO.swap(s.vertOwner); m.held.swap(s.ownerHeld); m.pin.swap(s.pinned); }
  if (m.hasCrease) m.crease.swap(s.creaseMark);
  const int rc = sharpenRound(s, m, true, nullptr);
  // Back into the session, whatever the answer (a refusal leaves a mesh the JS re-runs from scratch).
  s.positions.swap(m.P); s.normals.swap(m.N); s.indices.swap(m.T); s.vertLeaf.swap(m.VL);
  if (m.owner) { s.vertOwner.swap(m.VO); s.ownerHeld.swap(m.held); s.pinned.swap(m.pin); }
  if (m.hasCrease) s.creaseMark.swap(m.crease);
  clear_sharp(s);
  if (rc == 0 && m.hasSharp) { s.sharp.swap(m.sharp); s.sharpPlanes.swap(m.planes); }
  return rc;
}

void clear_sharp(ipe::Session& s) {
  std::vector<uint8_t>().swap(s.sharp);
  std::vector<int32_t>().swap(s.sharpPlanes);
}

}  // namespace ipm_mesh

extern "C" {

// sharpen.js's sharpenMesh on the session mesh (cleaned, with normals; on an owner mesh after the
// crease cut). 0 ok; nonzero for an unknown session, no mesh, or a failed evaluation.
int ip_sharpen(int id) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 9;
  return ipm_mesh::sharpen(*s);
}

// TEST ONLY (test/implicit-sharpen-native.test.js): the stage's constants, in this order:
// SHARP_ANGLE_COS, SHARP_TOL, SHARP_MAX_MOVE, SHARP_SNAP, SHARP_CORNER_DET, SHARP_DENSE_PER_CELL,
// SHARP_DENSE_MIN, NEWTON_STEPS, STEP_CAP, SIDE, DIFF, MIN_ALTITUDE, FLIP_NEAR, CONVERGED,
// CORNER_MERGE, SIDE_PTS, FLAT_READS, ACROSS_TOL, TRIES, SHARP_APART, CORNER_STEPS, CORNER_SIDE_MAX,
// CORNER_RING, RING_C1, RING_S1, RING_R2. Writes them to `out` and returns the count.
int ip_sharpen_constants(double* out) {
  using namespace ipm_mesh;
  const double v[] = {SHARP_ANGLE_COS, SHARP_TOL, SHARP_MAX_MOVE, SHARP_SNAP, SHARP_CORNER_DET, SHARP_DENSE_PER_CELL,
                      (double)SHARP_DENSE_MIN, (double)NEWTON_STEPS, STEP_CAP, SIDE, DIFF, MIN_ALTITUDE, FLIP_NEAR, CONVERGED,
                      CORNER_MERGE, (double)SIDE_PTS, (double)FLAT_READS, ACROSS_TOL, (double)TRIES, SHARP_APART,
                      (double)CORNER_STEPS, CORNER_SIDE_MAX, (double)CORNER_RING, RING_C1, RING_S1, RING_R2};
  const int n = (int)(sizeof v / sizeof v[0]);
  for (int i = 0; i < n; i++) out[i] = v[i];
  return n;
}

// TEST ONLY: fieldFlips with its memo, as the JS unit test "the flip memo" drives it. One
// triangle (0, 1, 2), its four vertices on leaf `leaf` of the sampled session, one candidate (0):
// call 1 with positions P1 (3 vertices) and the candidate moving end 0; call 2 with positions P2
// (4 vertices), edge (1, 2) split at vertex 3 and the candidate splitting (how -1); call 3 the
// same as call 2 again. out[k] = how many triangles call k + 1 flagged. Returns 0, or nonzero.
int ip_flip_probe(int id, int leaf, const double* P1, const double* P2, double edge, int32_t* out) {
  using namespace ipm_mesh;
  ipe::Session* s = ipe::session(id);
  if (!s || !s->sampled || leaf < 0 || (size_t)leaf >= s->leaves.size() / 4) return 1;
  const std::vector<uint32_t> T = {0, 1, 2};
  const std::vector<int32_t> VL0(4, leaf);
  Memo memo;
  std::vector<uint32_t> flipped;
  for (int k = 0; k < 3; k++) {
    SplitMap sp(4);
    Touched tc;
    if (k == 0) tc.add(0, 0, 0);
    else { sp.set(1, 2, 3); tc.add(0, 0, -1); }
    if (fieldFlips(*s, k == 0 ? P1 : P2, sp, tc, true, VL0, T, edge, &memo, flipped) != 0) return 2;
    out[k] = (int32_t)flipped.size();
  }
  return 0;
}

// The sharpen stage's count of vertices with sharp == kind (1 edge points, 2 corner points) in
// the session mesh: after untangle on the owner path, before detail (which drops the table).
int ip_sharp_count(int id, int kind) {
  ipe::Session* s = ipe::session(id);
  if (!s) return -1;
  int n = 0;
  for (const uint8_t x : s->sharp) if (x == kind) n++;
  return n;
}

}
