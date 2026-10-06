// C++ port of partforge's bvh.js + min-wall.js. See those
// files for WHY; comments here note only what bit-exact parity needs:
//   - vertices stay in their source precision (float for a Manifold soup,
//     double otherwise), arithmetic is double, as in the JS;
//   - the build's median split is a STABLE sort (JS TypedArray#sort is);
//   - traversal stacks push and pop in the JS's order, ties keep the first;
//   - hypot is partforge's own (js_math.h / js-math.js); Math.round is
//     round-half-up.
#include "bvh.h"

#include <algorithm>
#include <cmath>

#include "js_math.h"
#include <cstdlib>
#include <cstring>
#include <unordered_map>
#include <vector>

namespace {

constexpr uint32_t LEAF = 4;

double jsHypot(double a, double b, double c) { return jsmath::hypot3(a, b, c); }

struct V3 { double x, y, z; };
inline V3 sub(V3 p, V3 q) { return {p.x - q.x, p.y - q.y, p.z - q.z}; }
inline V3 add(V3 p, V3 q) { return {p.x + q.x, p.y + q.y, p.z + q.z}; }
inline V3 mul(V3 p, double s) { return {p.x * s, p.y * s, p.z * s}; }
inline double dot(V3 p, V3 q) { return p.x * q.x + p.y * q.y + p.z * q.z; }

uint32_t countNodes(uint32_t len, std::unordered_map<uint32_t, uint32_t>& memo) {
  if (len <= LEAF) return 1;
  auto it = memo.find(len);
  if (it != memo.end()) return it->second;
  const uint32_t mid = len >> 1;
  const uint32_t n = 1 + countNodes(mid, memo) + countNodes(len - mid, memo);
  memo.emplace(len, n);
  return n;
}

bool rayHitsBox(double ox, double oy, double oz, double ix, double iy, double iz,
                const double* B, size_t nb, double tMin, double best) {
  double t0 = tMin, t1 = best;
  double lo = (B[nb] - ox) * ix, hi = (B[nb + 3] - ox) * ix;
  if (lo > hi) std::swap(lo, hi);
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  if (t0 > t1) return false;
  lo = (B[nb + 1] - oy) * iy; hi = (B[nb + 4] - oy) * iy;
  if (lo > hi) std::swap(lo, hi);
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  if (t0 > t1) return false;
  lo = (B[nb + 2] - oz) * iz; hi = (B[nb + 5] - oz) * iz;
  if (lo > hi) std::swap(lo, hi);
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  return t0 <= t1;
}

double distSqBox(double px, double py, double pz, const double* B, size_t nb) {
  const double x = px < B[nb] ? B[nb] - px : px > B[nb + 3] ? px - B[nb + 3] : 0;
  const double y = py < B[nb + 1] ? B[nb + 1] - py : py > B[nb + 4] ? py - B[nb + 4] : 0;
  const double z = pz < B[nb + 2] ? B[nb + 2] - pz : pz > B[nb + 5] ? pz - B[nb + 5] : 0;
  return x * x + y * y + z * z;
}

double nodeExtent(const double* B, size_t nb) {
  return (B[nb + 3] - B[nb]) + (B[nb + 4] - B[nb + 1]) + (B[nb + 5] - B[nb + 2]);
}

double boxBoxDistSq(const double* A, size_t na, const double* B, size_t nb) {
  double s = 0;
  for (int ax = 0; ax < 3; ax++) {
    const double v = A[na + ax] > B[nb + 3 + ax] ? A[na + ax] - B[nb + 3 + ax]
                     : B[nb + ax] > A[na + 3 + ax] ? B[nb + ax] - A[na + 3 + ax] : 0;
    s += v * v;
  }
  return s;
}

}  // namespace

// Vertex access is the one place float vs double differs.
struct BVH {
  void* raw = nullptr;
  bool f64 = false;
  uint32_t count = 0;
  std::vector<uint32_t> order;
  std::vector<double> bounds;
  std::vector<uint32_t> meta;

  inline double v(size_t i) const { return f64 ? ((const double*)raw)[i] : (double)((const float*)raw)[i]; }
  inline V3 at(size_t base) const { return {v(base), v(base + 1), v(base + 2)}; }
};

namespace {

// Möller–Trumbore; t > tMin or Infinity.
double rayTri(double ox, double oy, double oz, double dx, double dy, double dz, const BVH& V, size_t base, double tMin) {
  const double ax = V.v(base), ay = V.v(base + 1), az = V.v(base + 2);
  const double e1x = V.v(base + 3) - ax, e1y = V.v(base + 4) - ay, e1z = V.v(base + 5) - az;
  const double e2x = V.v(base + 6) - ax, e2y = V.v(base + 7) - ay, e2z = V.v(base + 8) - az;
  const double px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const double det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return INFINITY;
  const double inv = 1 / det;
  const double tx = ox - ax, ty = oy - ay, tz = oz - az;
  const double u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return INFINITY;
  const double qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const double v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return INFINITY;
  const double t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > tMin ? t : INFINITY;
}

// Ericson closest point on triangle; returns d2, point in Q.
double closestOnTri(V3 P, const BVH& V, size_t base, V3& Q) {
  const V3 A = V.at(base), B = V.at(base + 3), C = V.at(base + 6);
  const V3 ab = sub(B, A), ac = sub(C, A), ap = sub(P, A);
  const double d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) Q = A;
  else {
    const V3 bp = sub(P, B);
    const double d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) Q = B;
    else {
      const double vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) Q = add(A, mul(ab, d1 / (d1 - d3)));
      else {
        const V3 cp = sub(P, C);
        const double d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) Q = C;
        else {
          const double vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) Q = add(A, mul(ac, d2 / (d2 - d6)));
          else {
            const double va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) Q = add(B, mul(sub(C, B), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
            else { const double denom = 1 / (va + vb + vc); Q = add(add(A, mul(ab, vb * denom)), mul(ac, vc * denom)); }
          }
        }
      }
    }
  }
  const V3 pq = sub(P, Q);
  return dot(pq, pq);
}

inline double clamp01(double x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

double closestSegSeg(V3 P1, V3 Q1, V3 P2, V3 Q2, V3& Aout, V3& Bout) {
  const V3 d1 = sub(Q1, P1), d2v = sub(Q2, P2), r = sub(P1, P2);
  const double a = dot(d1, d1), e = dot(d2v, d2v), f = dot(d2v, r);
  const double EPS = 1e-12;
  double s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const double c = dot(d1, r);
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const double b = dot(d1, d2v), denom = a * e - b * b;
      s = denom != 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  Aout = {P1.x + d1.x * s, P1.y + d1.y * s, P1.z + d1.z * s};
  Bout = {P2.x + d2v.x * t, P2.y + d2v.y * t, P2.z + d2v.z * t};
  const V3 pq = sub(Aout, Bout);
  return dot(pq, pq);
}

struct Best { double d2 = INFINITY; bool has = false; V3 a{}, b{}; };

Best triTriDist(const BVH& V1, size_t b1, const BVH& V2, size_t b2) {
  const V3 t1[3] = {V1.at(b1), V1.at(b1 + 3), V1.at(b1 + 6)};
  const V3 t2[3] = {V2.at(b2), V2.at(b2 + 3), V2.at(b2 + 6)};
  for (int i = 0; i < 3; i++) {
    const V3 p = t1[i], q = t1[(i + 1) % 3];
    const V3 d = {q.x - p.x, q.y - p.y, q.z - p.z};
    const double t = rayTri(p.x, p.y, p.z, d.x, d.y, d.z, V2, b2, 0);
    if (t <= 1) { const V3 at = {p.x + d.x * t, p.y + d.y * t, p.z + d.z * t}; return {0, true, at, at}; }
  }
  for (int i = 0; i < 3; i++) {
    const V3 p = t2[i], q = t2[(i + 1) % 3];
    const V3 d = {q.x - p.x, q.y - p.y, q.z - p.z};
    const double t = rayTri(p.x, p.y, p.z, d.x, d.y, d.z, V1, b1, 0);
    if (t <= 1) { const V3 at = {p.x + d.x * t, p.y + d.y * t, p.z + d.z * t}; return {0, true, at, at}; }
  }
  Best best;
  for (const V3& v : t2) {
    V3 Q; const double d2 = closestOnTri(v, V1, b1, Q);
    if (d2 < best.d2) best = {d2, true, Q, v};
  }
  for (const V3& v : t1) {
    V3 Q; const double d2 = closestOnTri(v, V2, b2, Q);
    if (d2 < best.d2) best = {d2, true, v, Q};
  }
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) {
      V3 A, B;
      const double d2 = closestSegSeg(t1[i], t1[(i + 1) % 3], t2[j], t2[(j + 1) % 3], A, B);
      if (d2 < best.d2) best = {d2, true, A, B};
    }
  return best;
}

int32_t raycast(const BVH& T, V3 o, V3 d, double tMin, double tMax, int32_t skipTri, double& tOut) {
  const double ix = 1 / d.x, iy = 1 / d.y, iz = 1 / d.z;
  double best = tMax; int32_t bestTri = -1;
  std::vector<uint32_t> stack{0};
  while (!stack.empty()) {
    const uint32_t n = stack.back(); stack.pop_back();
    if (!rayHitsBox(o.x, o.y, o.z, ix, iy, iz, T.bounds.data(), (size_t)n * 6, tMin, best)) continue;
    const uint32_t packed = T.meta[n * 2 + 1];
    if (packed) {
      const uint32_t start = T.meta[n * 2];
      for (uint32_t k = 0; k < packed - 1; k++) {
        const uint32_t tri = T.order[start + k];
        if ((int32_t)tri == skipTri) continue;
        const double t = rayTri(o.x, o.y, o.z, d.x, d.y, d.z, T, (size_t)tri * 9, tMin);
        if (t < best) { best = t; bestTri = (int32_t)tri; }
      }
    } else { stack.push_back(n + 1); stack.push_back(T.meta[n * 2]); }
  }
  tOut = best;
  return bestTri;
}

}  // namespace

extern "C" BVH* bvh_build(void* verts, uint32_t count, int32_t f64, int32_t adopt) {
  BVH* T = new BVH();
  T->f64 = f64 != 0;
  T->count = count;
  const size_t bytes = (size_t)count * 9 * (T->f64 ? 8 : 4);
  if (adopt) T->raw = verts;
  else { T->raw = std::malloc(bytes ? bytes : 1); if (bytes) std::memcpy(T->raw, verts, bytes); }

  T->order.resize(count);
  std::vector<double> cent((size_t)count * 3);
  for (uint32_t t = 0; t < count; t++) {
    T->order[t] = t;
    const size_t o = (size_t)t * 9;
    for (int a = 0; a < 3; a++) {
      const double p = T->v(o + a), q = T->v(o + 3 + a), r = T->v(o + 6 + a);
      const double lo = p < q ? (p < r ? p : r) : (q < r ? q : r);
      const double hi = p > q ? (p > r ? p : r) : (q > r ? q : r);
      cent[(size_t)t * 3 + a] = (lo + hi) / 2;
    }
  }
  std::unordered_map<uint32_t, uint32_t> memo;
  const uint32_t nodes = countNodes(count, memo);
  T->bounds.assign((size_t)nodes * 6, 0);
  T->meta.assign((size_t)nodes * 2, 0);
  uint32_t next = 0;

  // Pre-order emit, iterative over an explicit work list so deep meshes can't
  // overflow the native stack; the slot order matches the JS recursion.
  struct Frame { uint32_t start, len, self, stage; };
  auto emitNode = [&](uint32_t start, uint32_t len) -> uint32_t {
    const uint32_t self = next++;
    const size_t nb = (size_t)self * 6;
    double x0 = INFINITY, y0 = INFINITY, z0 = INFINITY, x1 = -INFINITY, y1 = -INFINITY, z1 = -INFINITY;
    for (uint32_t k = 0; k < len; k++) {
      const size_t o = (size_t)T->order[start + k] * 9;
      for (int j = 0; j < 9; j += 3) {
        const double x = T->v(o + j), y = T->v(o + j + 1), z = T->v(o + j + 2);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
    }
    double* B = T->bounds.data();
    B[nb] = x0; B[nb + 1] = y0; B[nb + 2] = z0; B[nb + 3] = x1; B[nb + 4] = y1; B[nb + 5] = z1;
    if (len <= LEAF) { T->meta[self * 2] = start; T->meta[self * 2 + 1] = len + 1; return self; }
    const double ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
    const int axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    std::stable_sort(T->order.begin() + start, T->order.begin() + start + len,
                     [&](uint32_t p, uint32_t q) { return cent[(size_t)p * 3 + axis] < cent[(size_t)q * 3 + axis]; });
    return self;
  };
  std::vector<Frame> work;
  work.push_back({0, count, 0, 0});
  while (!work.empty()) {
    Frame& f = work.back();
    if (f.stage == 0) {
      f.self = emitNode(f.start, f.len);
      if (f.len <= LEAF) { work.pop_back(); continue; }
      f.stage = 1;
      const uint32_t mid = f.len >> 1, start = f.start;
      work.push_back({start, mid, 0, 0});            // left child: slot self+1
    } else if (f.stage == 1) {
      f.stage = 2;
      const uint32_t mid = f.len >> 1;
      T->meta[f.self * 2] = next;                     // right child's slot
      T->meta[f.self * 2 + 1] = 0;
      const uint32_t start = f.start + mid, len = f.len - mid;
      work.push_back({start, len, 0, 0});
    } else {
      work.pop_back();
    }
  }
  return T;
}

extern "C" uint32_t bvh_triangle_count(const BVH* T) { return T->count; }
extern "C" void bvh_root_bounds(const BVH* T, double* out) { for (int i = 0; i < 6; i++) out[i] = T->bounds[i]; }

extern "C" int32_t bvh_raycast(const BVH* T, const double* o, const double* d, double tMin, double tMax, int32_t skipTri, double* out) {
  double t;
  const int32_t tri = raycast(*T, {o[0], o[1], o[2]}, {d[0], d[1], d[2]}, tMin, tMax, skipTri, t);
  out[0] = t;
  return tri;
}

extern "C" int32_t bvh_closest_point(const BVH* T, const double* p, double* out) {
  const V3 P = {p[0], p[1], p[2]};
  double best2 = INFINITY; V3 bestPt{NAN, NAN, NAN}; int32_t bestTri = -1;
  std::vector<uint32_t> stack{0};
  const double* B = T->bounds.data();
  while (!stack.empty()) {
    const uint32_t n = stack.back(); stack.pop_back();
    if (distSqBox(P.x, P.y, P.z, B, (size_t)n * 6) > best2) continue;
    const uint32_t packed = T->meta[n * 2 + 1];
    if (packed) {
      const uint32_t start = T->meta[n * 2];
      for (uint32_t k = 0; k < packed - 1; k++) {
        const uint32_t tri = T->order[start + k];
        V3 Q; const double d2 = closestOnTri(P, *T, (size_t)tri * 9, Q);
        if (d2 < best2) { best2 = d2; bestPt = Q; bestTri = (int32_t)tri; }
      }
    } else {
      const uint32_t l = n + 1, r = T->meta[n * 2];
      const double dl = distSqBox(P.x, P.y, P.z, B, (size_t)l * 6), dr = distSqBox(P.x, P.y, P.z, B, (size_t)r * 6);
      if (dl < dr) { stack.push_back(r); stack.push_back(l); } else { stack.push_back(l); stack.push_back(r); }
    }
  }
  out[0] = bestPt.x; out[1] = bestPt.y; out[2] = bestPt.z; out[3] = std::sqrt(best2);
  return bestTri;
}

extern "C" int32_t bvh_distance_to(const BVH* A, const BVH* O, double* out) {
  Best best;
  std::vector<uint32_t> stack{0, 0};
  const double* bA = A->bounds.data();
  const double* bO = O->bounds.data();
  while (!stack.empty() && best.d2 > 0) {
    const uint32_t nb = stack.back(); stack.pop_back();
    const uint32_t na = stack.back(); stack.pop_back();
    if (boxBoxDistSq(bA, (size_t)na * 6, bO, (size_t)nb * 6) >= best.d2) continue;
    const uint32_t pa = A->meta[na * 2 + 1], pb = O->meta[nb * 2 + 1];
    if (pa && pb) {
      const uint32_t sa = A->meta[na * 2], sb = O->meta[nb * 2];
      for (uint32_t i = 0; i < pa - 1; i++)
        for (uint32_t j = 0; j < pb - 1; j++) {
          const Best r = triTriDist(*A, (size_t)A->order[sa + i] * 9, *O, (size_t)O->order[sb + j] * 9);
          if (r.d2 < best.d2) best = r;
        }
    } else if (!pa && (pb || nodeExtent(bA, (size_t)na * 6) >= nodeExtent(bO, (size_t)nb * 6))) {
      const uint32_t l = na + 1, r = A->meta[na * 2];
      const double dl = boxBoxDistSq(bA, (size_t)l * 6, bO, (size_t)nb * 6), dr = boxBoxDistSq(bA, (size_t)r * 6, bO, (size_t)nb * 6);
      if (dl < dr) { stack.insert(stack.end(), {r, nb, l, nb}); } else { stack.insert(stack.end(), {l, nb, r, nb}); }
    } else {
      const uint32_t l = nb + 1, r = O->meta[nb * 2];
      const double dl = boxBoxDistSq(bA, (size_t)na * 6, bO, (size_t)l * 6), dr = boxBoxDistSq(bA, (size_t)na * 6, bO, (size_t)r * 6);
      if (dl < dr) { stack.insert(stack.end(), {na, r, na, l}); } else { stack.insert(stack.end(), {na, l, na, r}); }
    }
  }
  if (!best.has) { out[0] = INFINITY; return 0; }
  out[0] = std::sqrt(best.d2);
  out[1] = (best.a.x + best.b.x) / 2; out[2] = (best.a.y + best.b.y) / 2; out[3] = (best.a.z + best.b.z) / 2;
  out[4] = best.a.x; out[5] = best.a.y; out[6] = best.a.z;
  out[7] = best.b.x; out[8] = best.b.y; out[9] = best.b.z;
  return 1;
}

namespace {
uint32_t gcd(uint32_t a, uint32_t b) { while (b) { const uint32_t t = a % b; a = b; b = t; } return a; }
// sampleStride (min-wall.js): near n/φ, coprime to n.
uint32_t sampleStride(uint32_t n) {
  // Math.round is round-half-up; n * φ⁻¹ is never negative here.
  double r = std::floor(n * 0.6180339887498949 + 0.5);
  uint32_t s = (uint32_t)std::fmax(1.0, r) % n;
  if (s == 0) s = 1;
  while (gcd(s, n) != 1) s = s + 1 < n ? s + 1 : 1;
  return s;
}
}  // namespace

extern "C" int32_t bvh_min_wall(const BVH* T, double maxThickness, double maxSamples,
                                int32_t hasBand, double bandMin, double bandMax, double* out) {
  const uint32_t n = T->count;
  if (n == 0) return 0;
  if (std::isnan(maxThickness)) {
    const double* rb = T->bounds.data();
    maxThickness = jsHypot(rb[3] - rb[0], rb[4] - rb[1], rb[5] - rb[2]) + 1;
  }
  const uint32_t budget = maxSamples > 0 && n > maxSamples ? (uint32_t)std::floor(maxSamples) : n;
  const bool sampled = budget < n;
  const uint32_t stride = sampled ? sampleStride(n) : 1;

  double bandLo = 0, bandHi = 0, bandMid = 0;
  if (hasBand) { bandLo = 0.75 * bandMin; bandHi = 1.5 * bandMax; bandMid = (bandMin + bandMax) / 2; }
  auto bandScore = [&](double x) {
    return x > bandMax ? 1 + (x - bandMax) : x < bandMin ? 1 + (bandMin - x)
           : std::fabs(x - bandMid) / (bandMax - bandMin + 1e-9);
  };
  double bandWorst = -1, bandValue = NAN; V3 bandLoc{NAN, NAN, NAN}; uint32_t members = 0;

  double best = INFINITY; V3 loc{NAN, NAN, NAN};
  uint32_t t = 0;
  for (uint32_t s = 0; s < budget; s++, t = t + stride < n ? t + stride : t + stride - n) {
    const size_t o = (size_t)t * 9;
    double tri[9];
    for (int i = 0; i < 9; i++) tri[i] = T->v(o + i);
    const double v0x = tri[0], v0y = tri[1], v0z = tri[2];
    const double e1x = tri[3] - v0x, e1y = tri[4] - v0y, e1z = tri[5] - v0z;
    const double e2x = tri[6] - v0x, e2y = tri[7] - v0y, e2z = tri[8] - v0z;
    double nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const double len = jsHypot(nx, ny, nz);
    if (len < 1e-9) continue;
    nx /= len; ny /= len; nz /= len;
    const V3 c = {(v0x + tri[3] + tri[6]) / 3, (v0y + tri[4] + tri[7]) / 3, (v0z + tri[5] + tri[8]) / 3};
    const V3 dir = {-nx, -ny, -nz};
    const V3 origin = {c.x + dir.x * 1e-4, c.y + dir.y * 1e-4, c.z + dir.z * 1e-4};
    double ht;
    const int32_t hit = raycast(*T, origin, dir, 1e-6, maxThickness, (int32_t)t, ht);
    if (hit >= 0 && ht < best) { best = ht; loc = c; }
    if (hasBand && hit >= 0 && ht >= bandLo && ht <= bandHi) {
      members++;
      const double score = bandScore(ht);
      if (score > bandWorst) { bandWorst = score; bandValue = ht; bandLoc = c; }
    }
  }
  out[0] = best == INFINITY ? NAN : best;
  out[1] = loc.x; out[2] = loc.y; out[3] = loc.z;
  out[4] = sampled ? 1 : 0; out[5] = budget; out[6] = n;
  out[7] = bandValue; out[8] = bandLoc.x; out[9] = bandLoc.y; out[10] = bandLoc.z; out[11] = members;
  return 1;
}

extern "C" void bvh_destroy(BVH* T) {
  if (!T) return;
  std::free(T->raw);
  delete T;
}
