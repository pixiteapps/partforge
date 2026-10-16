// C++ port of the implicit engine's surface detail: detail.js's
// applySurfaceDetail (refine where an entry applies, project the new vertices,
// displace along the normals by the summed heights). See implicit_mesh.h for the
// stages it follows; it reads and writes the session mesh in place.
//
// What bit-exact parity needs, beyond native/README.md's rules:
//   - the entries arrive as detail.js's flattened layout (DETAIL_STRIDE doubles
//     each) and are read only through it, as the JS reads them; the kind, the
//     projection and the axis are compared as doubles, as the JS does;
//   - TWO_PI is 2 * Math.PI (an exact doubling of the same double); cosines,
//     atan2 and noise are the ported ipm:: functions; Math.max/min are jsmath's;
//   - weight: the side ramp (d - 0.15) / 0.5 clamped, the early 0 return, then
//     the radius falloff (r2 >= 1 -> 0, w *= (1 - r2)^2), in that order;
//   - heights in the JS's operation order: -amplitude * max(0, cos) * w,
//     amplitude * 2 * noise * w, amplitude * v * w; triplanar weights n^4 as
//     ((n*n)*n)*n and the three reads summed left to right; an expr height runs
//     its program on ONE lane and NaN reads as 0;
//   - each round's targets are computed for every vertex before any split; the
//     midpoint key is the unordered pair {a, b} (the JS's a < b ? a*nv + b :
//     b*nv + a, exact below 2^53, names the same pair), a refused edge answers -1
//     every time (the JS remembers it as -1; the test is re-run instead), and midpoints are
//     numbered in creation order: triangles in order, edges (v0v1, v1v2, v2v0)
//     left to right. The map (per-vertex chains here) is only found and
//     inserted, never iterated;
//   - splitTri's four cases with the JS's canonical rotations;
//   - the new vertices are projected by ipm_mesh::project (maxStep = edge, with
//     normals) in creation order, then a midpoint left without a normal takes
//     its endpoints' normalized sum (midpointNormal), in creation order;
//   - the final loop skips a zero normal, sums the entries' heights from +0 in
//     entry order, skips h === 0 and moves p += n * h.
#include <cmath>
#include <cstdint>
#include <vector>

#include "implicit_eval.h"
#include "implicit_math.h"
#include "implicit_mesh.h"
#include "js_math.h"

namespace ipm_detail {

namespace {

constexpr int STRIDE = 28;            // detail.js's DETAIL_STRIDE
constexpr int MAX_REFINE_ROUNDS = 3;  // detail.js's MAX_REFINE_ROUNDS
constexpr double TWO_PI = 2 * 3.141592653589793;   // 2 * Math.PI
// detail.js's DF offsets.
enum { KIND = 0, HAS_INV = 1, INV = 2, RADIUS = 14, HAS_SIDE = 15, SIDE = 16, AMPLITUDE = 19, WAVELENGTH = 20,
       AXIS = 21, SLOT = 22, PROJECTION = 23, SIZE0 = 24, SIZE1 = 25, TARGET = 26, PROG = 27 };

// p[a] for a JS number index: undefined (NaN in arithmetic) unless a is 0, 1 or 2.
inline double at3(const double* p, double a) { return a == 0 ? p[0] : a == 1 ? p[1] : a == 2 ? p[2] : NAN; }

struct Ctx {
  ipe::Session& s;
  const double* F;
  int count;
  std::vector<const ipe::Program*> progs;   // per entry: its expr program, or null
};

// Entry o's local point, and its local direction (the entry's frame, when it
// has one) — computed separately, so a vertex outside the entry's radius never
// pays for the normal: the same products and sums as frames.js, per component.
inline void localPoint(double* p, const double* F, int o, double x, double y, double z) {
  if (F[o + HAS_INV] != 0) {
    const double* M = F + o + INV;
    p[0] = M[0] * x + M[1] * y + M[2] * z + M[9];
    p[1] = M[3] * x + M[4] * y + M[5] * z + M[10];
    p[2] = M[6] * x + M[7] * y + M[8] * z + M[11];
  } else { p[0] = x; p[1] = y; p[2] = z; }
}
inline void localDir(double* n, const double* F, int o, double nx, double ny, double nz) {
  if (F[o + HAS_INV] != 0) {
    const double* M = F + o + INV;
    n[0] = M[0] * nx + M[1] * ny + M[2] * nz;
    n[1] = M[3] * nx + M[4] * ny + M[5] * nz;
    n[2] = M[6] * nx + M[7] * ny + M[8] * nz;
  } else { n[0] = nx; n[1] = ny; n[2] = nz; }
}

// detail.js's weight at local point p (world normal nx, ny, nz). The JS tests the
// side first and the radius second, returning 0 from whichever fails; both
// return 0, so testing the radius first returns the same value and lets a
// vertex outside the radius skip the normal's transform. A weight that passes
// both is computed as the JS computes it: the side ramp, then w *= (1 - r2)^2.
// When the side test transformed the normal, it is left in `n` and `haveN` set,
// so the caller does not transform it again.
inline double weight(const double* F, int o, const double* p, double nx, double ny, double nz, double* n, bool& haveN) {
  const double radius = F[o + RADIUS];
  double r2 = 0;
  if (radius >= 0) {
    r2 = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / (radius * radius);
    if (r2 >= 1) return 0;
  }
  double w = 1;
  if (F[o + HAS_SIDE] != 0) {
    localDir(n, F, o, nx, ny, nz);
    haveN = true;
    const double d = n[0] * F[o + SIDE] + n[1] * F[o + SIDE + 1] + n[2] * F[o + SIDE + 2];
    const double s = (d - 0.15) / 0.5;
    w = s < 0 ? 0 : s > 1 ? 1 : s;
    if (w == 0) return 0;
  }
  if (radius >= 0) {
    const double f = 1 - r2;
    w *= f * f;
  }
  return w;
}

inline double planar(const ipe::Texture& t, double axis, double lx, double ly, double lz, double size0, double size1) {
  const double u = axis == 2 ? lx : axis == 0 ? ly : lz, v = axis == 2 ? ly : axis == 0 ? lz : lx;
  return ipe::sample_texture(t, u / size0 + 0.5, v / size1 + 0.5);
}

double entryHeight(Ctx& c, int k, double x, double y, double z, double nx, double ny, double nz) {
  const double* F = c.F;
  const int o = STRIDE * k;
  double p[3], n[3];
  localPoint(p, F, o, x, y, z);
  bool haveN = false;
  const double w = weight(F, o, p, nx, ny, nz, n, haveN);
  if (w == 0) return 0;
  if (!haveN) localDir(n, F, o, nx, ny, nz);
  const double kind = F[o + KIND], axis = F[o + AXIS], amplitude = F[o + AMPLITUDE], wavelength = F[o + WAVELENGTH];
  if (kind == 1) return -amplitude * jsmath::jsmax(0, ipm::pf_cos((TWO_PI * at3(p, axis)) / wavelength)) * w;
  if (kind == 2) return amplitude * 2 * ipm::value_noise(p[0] / wavelength, p[1] / wavelength, p[2] / wavelength) * w;
  if (kind == 3) {
    const ipe::Texture& t = c.s.textures[(size_t)F[o + SLOT]];
    const double projection = F[o + PROJECTION], size0 = F[o + SIZE0], size1 = F[o + SIZE1];
    double v;
    if (projection == 1) {
      const double u = ipm::pf_atan2(at3(p, std::fmod(axis + 2, 3)), at3(p, std::fmod(axis + 1, 3))) / TWO_PI + 0.5;
      v = ipe::sample_texture(t, u, at3(p, axis) / size1 + 0.5);
    } else if (projection == 2) {
      const double ax = n[0] * n[0] * n[0] * n[0], ay = n[1] * n[1] * n[1] * n[1], az = n[2] * n[2] * n[2] * n[2], s = ax + ay + az;
      v = (planar(t, 0, p[0], p[1], p[2], size0, size1) * ax + planar(t, 1, p[0], p[1], p[2], size0, size1) * ay
           + planar(t, 2, p[0], p[1], p[2], size0, size1) * az) / s;
    } else v = planar(t, axis, p[0], p[1], p[2], size0, size1);
    return amplitude * v * w;
  }
  if (kind == 4) {
    double out;
    ipe::run(c.s, *c.progs[(size_t)k], &p[0], &p[1], &p[2], 1, &out);
    return (out == out ? out : 0) * w;
  }
  return 0;
}

// detail.js's targetAt.
double targetAt(Ctx& c, const std::vector<double>& P, const std::vector<double>& N, size_t v, double edge) {
  const double* F = c.F;
  double t = INFINITY, lp[3], ln[3];
  for (int k = 0; k < c.count; k++) {
    const int o = STRIDE * k;
    const double target = F[o + TARGET];
    const double tk = target == INFINITY ? edge / 2 : target;
    // jsmin(t, tk) is t whenever t <= tk and t is not a zero (whose sign jsmin
    // may change): the weight cannot matter then, so it is not computed.
    if (t <= tk && t != 0) continue;
    localPoint(lp, F, o, P[3 * v], P[3 * v + 1], P[3 * v + 2]);
    bool haveN = false;
    if (weight(F, o, lp, N[3 * v], N[3 * v + 1], N[3 * v + 2], ln, haveN) > 0) t = jsmath::jsmin(t, tk);
  }
  return jsmath::jsmax(edge / 8, t);
}

// detail.js's splitTri.
inline void splitTri(std::vector<uint32_t>& out, const int64_t* v, const int64_t* m) {
  const int k = (m[0] >= 0) + (m[1] >= 0) + (m[2] >= 0);
  if (k == 0) { out.push_back((uint32_t)v[0]); out.push_back((uint32_t)v[1]); out.push_back((uint32_t)v[2]); return; }
  if (k == 3) {
    const int64_t q[12] = {v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]};
    for (int i = 0; i < 12; i++) out.push_back((uint32_t)q[i]);
    return;
  }
  int r;
  if (k == 1) r = m[0] >= 0 ? 0 : m[1] >= 0 ? 1 : 2;
  else r = m[2] < 0 ? 0 : m[0] < 0 ? 1 : 2;
  const int64_t V[3] = {v[r], v[(r + 1) % 3], v[(r + 2) % 3]}, M[3] = {m[r], m[(r + 1) % 3], m[(r + 2) % 3]};
  if (k == 1) {
    const int64_t q[6] = {V[0], M[0], V[2], M[0], V[1], V[2]};
    for (int i = 0; i < 6; i++) out.push_back((uint32_t)q[i]);
  } else {
    const int64_t q[9] = {M[0], V[1], M[1], V[0], M[0], M[1], V[0], M[1], V[2]};
    for (int i = 0; i < 9; i++) out.push_back((uint32_t)q[i]);
  }
}

// detail.js's midpointNormal.
inline void midpointNormal(std::vector<double>& N, size_t a, size_t b, size_t m) {
  if (N[3 * m] != 0 || N[3 * m + 1] != 0 || N[3 * m + 2] != 0) return;
  const double x = N[3 * a] + N[3 * b], y = N[3 * a + 1] + N[3 * b + 1], z = N[3 * a + 2] + N[3 * b + 2];
  const double l = std::sqrt(x * x + y * y + z * z);
  if (!(l > 0)) return;
  N[3 * m] = x / l; N[3 * m + 1] = y / l; N[3 * m + 2] = z / l;
}

}  // namespace

int detail(ipe::Session& s, const double* F, int count, const int32_t* progIndex, int progCount) {
  if (!s.meshed || s.normals.size() != s.positions.size() || count < 0 || progCount < 0) return 1;
  Ctx c{s, F, count, std::vector<const ipe::Program*>((size_t)count, nullptr)};
  // Refuse before touching the mesh: every texture an entry reads and every expr
  // program must be one the session can run.
  for (int k = 0; k < count; k++) {
    const int o = STRIDE * k;
    if (F[o + KIND] == 3) {
      const double slot = F[o + SLOT];
      if (!(slot >= 0 && slot < (double)s.textures.size() && slot == std::floor(slot))) return 2;
    } else if (F[o + KIND] == 4) {
      const double q = F[o + PROG];
      if (!(q >= 0 && q < (double)progCount && q == std::floor(q))) return 3;
      const int32_t pi = progIndex[(size_t)q];
      if (pi < 0 || (size_t)pi >= s.programs.size()) return 3;
      const ipe::Program& p = s.programs[(size_t)pi];
      if (!p.ok || p.maxSlot >= (int)s.textures.size()) return 3;
      c.progs[(size_t)k] = &p;
    }
  }
  std::vector<double>& P = s.positions;
  std::vector<double>& N = s.normals;
  std::vector<int32_t>& VL = s.vertLeaf;
  const double edge = s.edge;
  std::vector<double> target;
  std::vector<int32_t> added;
  std::vector<uint32_t> ends, out;
  std::vector<int32_t> head, nodeNext;
  std::vector<uint32_t> nodeHi;
  std::vector<int64_t> nodeVal;
  for (int round = 0; round < MAX_REFINE_ROUNDS; round++) {
    const size_t nv = P.size() / 3;
    // A vertex's target reads only its own position and normal, the entries and
    // the edge, and a round moves only the vertices it adds (projection and
    // midpointNormal touch `added` alone): every older vertex keeps last round's
    // target, so only the new ones are computed.
    const size_t known = target.size();
    target.resize(nv);
    for (size_t v = known; v < nv; v++) target[v] = targetAt(c, P, N, v, edge);
    // The midpoint map, as per-vertex chains: an edge lives in the chain of its
    // lower endpoint, nodes appended in creation order. Only found and inserted
    // (never iterated), like the JS Map it stands for; chains keep the lookups
    // near the triangles that make them, where a hash table scattered them.
    head.assign(nv, -1);
    nodeNext.clear(); nodeHi.clear(); nodeVal.clear();
    added.clear();
    ends.clear();
    auto midpoint = [&](int64_t a, int64_t b) -> int64_t {
      // The refusal test reads only the two endpoints, which no split moves, so
      // it answers the same every time the edge is met: a refused edge returns
      // -1 straight away instead of being remembered as -1 (the JS's map entry
      // for it is only ever read back by this same test).
      const double lim = jsmath::jsmin(target[(size_t)a], target[(size_t)b]);
      if (!(lim < INFINITY)) return -1;
      const double dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
      if (dx * dx + dy * dy + dz * dz <= lim * lim) return -1;
      const uint32_t lo = (uint32_t)(a < b ? a : b), hi = (uint32_t)(a < b ? b : a);
      for (int32_t e = head[lo]; e >= 0; e = nodeNext[(size_t)e]) if (nodeHi[(size_t)e] == hi) return nodeVal[(size_t)e];
      const int64_t m = (int64_t)(P.size() / 3);
      nodeNext.push_back(head[lo]); nodeHi.push_back(hi); nodeVal.push_back(m);
      head[lo] = (int32_t)(nodeVal.size() - 1);
      const double mx = (P[3 * a] + P[3 * b]) / 2, my = (P[3 * a + 1] + P[3 * b + 1]) / 2, mz = (P[3 * a + 2] + P[3 * b + 2]) / 2;
      P.push_back(mx); P.push_back(my); P.push_back(mz);
      N.push_back(0); N.push_back(0); N.push_back(0);
      VL.push_back(VL[(size_t)a]);
      added.push_back((int32_t)m);
      ends.push_back((uint32_t)a); ends.push_back((uint32_t)b);
      return m;
    };
    const std::vector<uint32_t>& T = s.indices;
    out.clear();
    out.reserve(T.size());
    for (size_t t = 0; t < T.size(); t += 3) {
      const int64_t v[3] = {T[t], T[t + 1], T[t + 2]};
      int64_t m[3];
      m[0] = midpoint(v[0], v[1]);
      m[1] = midpoint(v[1], v[2]);
      m[2] = midpoint(v[2], v[0]);
      splitTri(out, v, m);
    }
    if (added.empty()) break;
    s.indices.swap(out);
    // Cannot fail here (a meshed session, fresh distinct indices); if it ever did,
    // the mesh is half refined, so say so and let the caller run the JS instead.
    if (ipm_mesh::project(s, added.data(), (int)added.size(), edge, true) != 0) return 5;
    for (size_t q = 0; q < added.size(); q++) midpointNormal(N, ends[2 * q], ends[2 * q + 1], (size_t)added[q]);
  }
  const size_t nv = P.size() / 3;
  for (size_t v = 0; v < nv; v++) {
    const double nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2];
    if (nx == 0 && ny == 0 && nz == 0) continue;   // no direction to move along
    double h = 0;
    for (int k = 0; k < count; k++) h += entryHeight(c, k, P[3 * v], P[3 * v + 1], P[3 * v + 2], nx, ny, nz);
    if (h == 0) continue;
    P[3 * v] += nx * h; P[3 * v + 1] += ny * h; P[3 * v + 2] += nz * h;
  }
  return 0;
}

}  // namespace ipm_detail

extern "C" {

// applySurfaceDetail over the session mesh, in place (positions, indices,
// vertLeaf, normals): `entries` is detail.js's flattened layout, `progIndex` the
// session program index of each expr-height program (in flattenDetail order).
// 0 ok; 1-4 (the mesh untouched) for an unknown session, no cleaned mesh
// (no normals), a texture slot or expr program the session cannot run; 5 if
// projecting the new vertices failed (the mesh is then partly refined).
int ip_detail(int id, const double* entries, int entryCount, const int32_t* progIndex, int progCount) {
  ipe::Session* s = ipe::session(id);
  if (!s) return 4;
  return ipm_detail::detail(*s, entries, entryCount, progIndex, progCount);
}

}
