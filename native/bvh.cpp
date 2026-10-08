// C++ port of partforge's bvh.js + min-wall.js. See those
// files for WHY; comments here note only what bit-exact parity needs:
//   - vertices stay in their source precision (float for a Manifold soup,
//     double otherwise), arithmetic is double, as in the JS;
//   - the build's median split is a STABLE sort (JS TypedArray#sort is);
//   - traversal stacks push and pop in the JS's order, ties keep the first;
//   - hypot is partforge's own (js_math.h / js-math.js); Math.round is
//     round-half-up.
//
// The tree is the JS's tree, node for node; only its memory layout differs,
// and none of these changes moves a bit of any answer:
//   - the index is templated on the vertex type, so no read branches on it;
//   - a node is one struct — its box in the vertex type (a box's corners ARE
//     vertex coordinates, so a float box is exact) and its two links — rather
//     than parallel bounds/meta arrays: a float mesh's node is 32 bytes;
//   - after the build, triangles are copied into LEAF order, so a leaf's
//     triangles are contiguous; `order` maps a leaf slot back to the source
//     triangle id every query reports;
//   - traversal stacks are fixed arrays (a median split bounds the depth by
//     log2 of the triangle count), not a heap vector per query — min-wall
//     casts one ray per triangle;
//   - min-wall casts its rays in leaf order, so consecutive rays reuse the
//     nodes the last one pulled into cache (ties still go to the JS's first;
//     see minWall);
//   - the build's stable sort runs on (key, id) pairs in reused buffers, and
//     skips or radix-sorts where that gives the same permutation (see
//     stableSortIds).
#include "bvh.h"

#include <cmath>

#include "js_math.h"
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

constexpr uint32_t LEAF = 4;
// Stack bounds. A median split halves every range, so a tree over at most
// 2^32 triangles is at most 32 internal levels deep: a single-tree walk holds
// at most depth+1 entries, a pair walk at most depthA+depthB+1 pairs.
constexpr int STACK = 64;
constexpr int PAIR_STACK = 2 * 2 * STACK;

double jsHypot(double a, double b, double c) { return jsmath::hypot3(a, b, c); }

struct V3 { double x, y, z; };
inline V3 sub(V3 p, V3 q) { return {p.x - q.x, p.y - q.y, p.z - q.z}; }
inline V3 add(V3 p, V3 q) { return {p.x + q.x, p.y + q.y, p.z + q.z}; }
inline V3 mul(V3 p, double s) { return {p.x * s, p.y * s, p.z * s}; }
inline double dot(V3 p, V3 q) { return p.x * q.x + p.y * q.y + p.z * q.z; }

// A node: its AABB (lo, hi), then either a leaf — first = its first leaf
// slot, packed = triangle count + 1 — or an internal node: the left child is
// the next node, first = the right child, packed = 0. (bvh.js's meta pair.)
template <class T>
struct Node {
  T lo[3], hi[3];
  uint32_t first, packed;
};

template <class T>
struct Index {
  uint32_t count = 0;
  T* verts = nullptr;              // 9 coords per triangle, in leaf order
  std::vector<uint32_t> order;     // leaf slot -> source triangle id
  std::vector<Node<T>> nodes;
  ~Index() { std::free(verts); }
  inline V3 at(size_t base) const { return {(double)verts[base], (double)verts[base + 1], (double)verts[base + 2]}; }
};

template <class T>
bool rayHitsBox(double ox, double oy, double oz, double ix, double iy, double iz,
                const Node<T>& N, double tMin, double best) {
  double t0 = tMin, t1 = best;
  double lo = ((double)N.lo[0] - ox) * ix, hi = ((double)N.hi[0] - ox) * ix;
  if (lo > hi) { const double s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  if (t0 > t1) return false;
  lo = ((double)N.lo[1] - oy) * iy; hi = ((double)N.hi[1] - oy) * iy;
  if (lo > hi) { const double s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  if (t0 > t1) return false;
  lo = ((double)N.lo[2] - oz) * iz; hi = ((double)N.hi[2] - oz) * iz;
  if (lo > hi) { const double s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  return t0 <= t1;
}

template <class T>
double distSqBox(double px, double py, double pz, const Node<T>& N) {
  const double x0 = N.lo[0], y0 = N.lo[1], z0 = N.lo[2], x1 = N.hi[0], y1 = N.hi[1], z1 = N.hi[2];
  const double x = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const double y = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  const double z = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return x * x + y * y + z * z;
}

template <class T>
double nodeExtent(const Node<T>& N) {
  return ((double)N.hi[0] - (double)N.lo[0]) + ((double)N.hi[1] - (double)N.lo[1]) + ((double)N.hi[2] - (double)N.lo[2]);
}

template <class A, class B>
double boxBoxDistSq(const Node<A>& P, const Node<B>& Q) {
  double s = 0;
  for (int ax = 0; ax < 3; ax++) {
    const double plo = P.lo[ax], phi = P.hi[ax], qlo = Q.lo[ax], qhi = Q.hi[ax];
    const double v = plo > qhi ? plo - qhi : qlo > phi ? qlo - phi : 0;
    s += v * v;
  }
  return s;
}

// Möller–Trumbore; t > tMin or Infinity.
template <class T>
double rayTri(double ox, double oy, double oz, double dx, double dy, double dz, const T* V, size_t base, double tMin) {
  const double ax = V[base], ay = V[base + 1], az = V[base + 2];
  const double e1x = V[base + 3] - ax, e1y = V[base + 4] - ay, e1z = V[base + 5] - az;
  const double e2x = V[base + 6] - ax, e2y = V[base + 7] - ay, e2z = V[base + 8] - az;
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
template <class T>
double closestOnTri(V3 P, const Index<T>& I, size_t base, V3& Q) {
  const V3 A = I.at(base), B = I.at(base + 3), C = I.at(base + 6);
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

template <class TA, class TB>
Best triTriDist(const Index<TA>& I1, size_t b1, const Index<TB>& I2, size_t b2) {
  const V3 t1[3] = {I1.at(b1), I1.at(b1 + 3), I1.at(b1 + 6)};
  const V3 t2[3] = {I2.at(b2), I2.at(b2 + 3), I2.at(b2 + 6)};
  for (int i = 0; i < 3; i++) {
    const V3 p = t1[i], q = t1[(i + 1) % 3];
    const V3 d = {q.x - p.x, q.y - p.y, q.z - p.z};
    const double t = rayTri(p.x, p.y, p.z, d.x, d.y, d.z, I2.verts, b2, 0);
    if (t <= 1) { const V3 at = {p.x + d.x * t, p.y + d.y * t, p.z + d.z * t}; return {0, true, at, at}; }
  }
  for (int i = 0; i < 3; i++) {
    const V3 p = t2[i], q = t2[(i + 1) % 3];
    const V3 d = {q.x - p.x, q.y - p.y, q.z - p.z};
    const double t = rayTri(p.x, p.y, p.z, d.x, d.y, d.z, I1.verts, b1, 0);
    if (t <= 1) { const V3 at = {p.x + d.x * t, p.y + d.y * t, p.z + d.z * t}; return {0, true, at, at}; }
  }
  Best best;
  for (const V3& v : t2) {
    V3 Q; const double d2 = closestOnTri(v, I1, b1, Q);
    if (d2 < best.d2) best = {d2, true, Q, v};
  }
  for (const V3& v : t1) {
    V3 Q; const double d2 = closestOnTri(v, I2, b2, Q);
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

// The hit's source triangle id, or -1; tOut = the hit's t (tMax on a miss).
// skipTri is a source id, as in the JS.
template <class T>
int32_t raycast(const Index<T>& I, V3 o, V3 d, double tMin, double tMax, int32_t skipTri, double& tOut) {
  const double ix = 1 / d.x, iy = 1 / d.y, iz = 1 / d.z;
  double best = tMax; int32_t bestTri = -1;
  uint32_t stack[STACK]; int sp = 0;
  stack[sp++] = 0;
  const Node<T>* nodes = I.nodes.data();
  while (sp) {
    const uint32_t n = stack[--sp];
    const Node<T>& N = nodes[n];
    if (!rayHitsBox(o.x, o.y, o.z, ix, iy, iz, N, tMin, best)) continue;
    if (N.packed) {
      for (uint32_t k = N.first, end = N.first + N.packed - 1; k < end; k++) {
        const uint32_t tri = I.order[k];
        if ((int32_t)tri == skipTri) continue;
        const double t = rayTri(o.x, o.y, o.z, d.x, d.y, d.z, I.verts, (size_t)k * 9, tMin);
        if (t < best) { best = t; bestTri = (int32_t)tri; }
      }
    } else { stack[sp++] = n + 1; stack[sp++] = N.first; }
  }
  tOut = best;
  return bestTri;
}

uint32_t countNodes(uint32_t len, std::vector<uint32_t>& memoLen, std::vector<uint32_t>& memoN) {
  if (len <= LEAF) return 1;
  for (size_t i = 0; i < memoLen.size(); i++) if (memoLen[i] == len) return memoN[i];
  const uint32_t mid = len >> 1;
  const uint32_t n = 1 + countNodes(mid, memoLen, memoN) + countNodes(len - mid, memoLen, memoN);
  memoLen.push_back(len); memoN.push_back(n);
  return n;
}

// Stable sort of ids[0, len) by cent[id*3 + axis] under `<` — the same
// permutation std::stable_sort with that comparator gives (a stable sort's
// result is unique; build() refuses NaN keys, so `<` is a strict weak order
// here). Keys are gathered next to their ids so the work streams through
// memory instead of indexing `cent` per comparison. Then, cheapest first:
//   - a range already in order is left alone (a stable sort of a sorted range
//     is the identity) — every node split along its parent's axis, which an
//     elongated part does level after level;
//   - a large range is LSD-radix-sorted on an order-preserving integer form of
//     the key, stable by construction and the same order as `<` once -0 is
//     folded into +0 (`<` calls them equal);
//   - otherwise a merge sort with `<` itself.
struct Keyed { double k; uint32_t id; };

inline uint64_t orderKey(double k) {
  if (k == 0) k = 0;  // -0 -> +0
  uint64_t b;
  std::memcpy(&b, &k, 8);
  return (b >> 63) ? ~b : (b | 0x8000000000000000ULL);
}

void stableSortIds(uint32_t* ids, uint32_t len, const double* cent, int axis,
                   std::vector<Keyed>& a, std::vector<Keyed>& b) {
  constexpr uint32_t RUN = 24, RADIX_MIN = 2048;
  Keyed* A = a.data();
  Keyed* B = b.data();
  bool sorted = true;
  for (uint32_t i = 0; i < len; i++) {
    const double k = cent[(size_t)ids[i] * 3 + axis];
    A[i] = {k, ids[i]};
    if (i && k < A[i - 1].k) sorted = false;
  }
  if (sorted) return;

  if (len >= RADIX_MIN) {
    uint32_t hist[8][256];
    std::memset(hist, 0, sizeof hist);
    for (uint32_t i = 0; i < len; i++) {
      const uint64_t u = orderKey(A[i].k);
      for (int d = 0; d < 8; d++) hist[d][(u >> (8 * d)) & 255]++;
    }
    for (int d = 0; d < 8; d++) {
      uint32_t* h = hist[d];
      bool constant = false;
      for (int v = 0; v < 256; v++) if (h[v] == len) { constant = true; break; }
      if (constant) continue;  // every key shares this digit: the pass is the identity
      uint32_t sum = 0;
      for (int v = 0; v < 256; v++) { const uint32_t c = h[v]; h[v] = sum; sum += c; }
      for (uint32_t i = 0; i < len; i++) B[h[(orderKey(A[i].k) >> (8 * d)) & 255]++] = A[i];
      Keyed* t = A; A = B; B = t;
    }
    for (uint32_t i = 0; i < len; i++) ids[i] = A[i].id;
    return;
  }

  for (uint32_t s = 0; s < len; s += RUN) {  // insertion-sort each run
    const uint32_t e = s + RUN < len ? s + RUN : len;
    for (uint32_t i = s + 1; i < e; i++) {
      const Keyed x = A[i];
      uint32_t j = i;
      while (j > s && x.k < A[j - 1].k) { A[j] = A[j - 1]; j--; }
      A[j] = x;
    }
  }
  for (uint32_t w = RUN; w < len; w *= 2) {  // merge runs; take right only if strictly less
    for (uint32_t s = 0; s < len; s += 2 * w) {
      const uint32_t m = s + w < len ? s + w : len, e = s + 2 * w < len ? s + 2 * w : len;
      uint32_t i = s, j = m, o = s;
      while (i < m && j < e) B[o++] = A[j].k < A[i].k ? A[j++] : A[i++];
      while (i < m) B[o++] = A[i++];
      while (j < e) B[o++] = A[j++];
    }
    Keyed* t = A; A = B; B = t;
  }
  for (uint32_t i = 0; i < len; i++) ids[i] = A[i].id;
}

template <class T>
Index<T>* build(T* src, uint32_t count) {
  Index<T>* I = new Index<T>();
  I->count = count;
  std::vector<uint32_t>& order = I->order;
  order.resize(count);
  {
    std::vector<double> cent((size_t)count * 3);
    for (uint32_t t = 0; t < count; t++) {
      order[t] = t;
      const size_t o = (size_t)t * 9;
      for (int a = 0; a < 3; a++) {
        const double p = src[o + a], q = src[o + 3 + a], r = src[o + 6 + a];
        const double lo = p < q ? (p < r ? p : r) : (q < r ? q : r);
        const double hi = p > q ? (p > r ? p : r) : (q > r ? q : r);
        const double c = (lo + hi) / 2;
        // A NaN centroid (a NaN vertex, or a ±Infinity span) is refused: the
        // JS sorts with the engine's comparison sort, which reads a NaN
        // comparison as "equal" — no ordering at all, so its result depends on
        // that sort's algorithm and nothing here can reproduce it.
        if (c != c) { delete I; return nullptr; }
        cent[(size_t)t * 3 + a] = c;
      }
    }
    std::vector<uint32_t> memoLen, memoN;
    I->nodes.resize(countNodes(count, memoLen, memoN));
    std::vector<Keyed> sa(count), sb(count);
    uint32_t next = 0;

    // Pre-order emit, iterative over an explicit work list so deep meshes can't
    // overflow the native stack; the slot order matches the JS recursion.
    auto emitNode = [&](uint32_t start, uint32_t len) -> uint32_t {
      const uint32_t self = next++;
      double x0 = INFINITY, y0 = INFINITY, z0 = INFINITY, x1 = -INFINITY, y1 = -INFINITY, z1 = -INFINITY;
      for (uint32_t k = 0; k < len; k++) {
        const T* v = src + (size_t)order[start + k] * 9;
        for (int j = 0; j < 9; j += 3) {
          const double x = v[j], y = v[j + 1], z = v[j + 2];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
      }
      Node<T>& N = I->nodes[self];
      // Each corner is a vertex coordinate (or ±Infinity for an empty mesh),
      // so it converts back to T exactly.
      N.lo[0] = (T)x0; N.lo[1] = (T)y0; N.lo[2] = (T)z0; N.hi[0] = (T)x1; N.hi[1] = (T)y1; N.hi[2] = (T)z1;
      if (len <= LEAF) { N.first = start; N.packed = len + 1; return self; }
      const double ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
      const int axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      stableSortIds(order.data() + start, len, cent.data(), axis, sa, sb);
      return self;
    };
    struct Frame { uint32_t start, len, self, stage; };
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
        I->nodes[f.self].first = next;                 // right child's slot
        I->nodes[f.self].packed = 0;
        const uint32_t start = f.start + mid, len = f.len - mid;
        work.push_back({start, len, 0, 0});
      } else {
        work.pop_back();
      }
    }
  }
  // Triangles into leaf order (the build's scratch is released first).
  I->verts = (T*)std::malloc(count ? (size_t)count * 9 * sizeof(T) : 1);
  for (uint32_t k = 0; k < count; k++) std::memcpy(I->verts + (size_t)k * 9, src + (size_t)order[k] * 9, 9 * sizeof(T));
  return I;
}

template <class T>
int32_t closestPoint(const Index<T>& I, V3 P, double* out) {
  double best2 = INFINITY; V3 bestPt{NAN, NAN, NAN}; int32_t bestTri = -1;
  uint32_t stack[STACK]; int sp = 0;
  stack[sp++] = 0;
  const Node<T>* nodes = I.nodes.data();
  while (sp) {
    const uint32_t n = stack[--sp];
    const Node<T>& N = nodes[n];
    if (distSqBox(P.x, P.y, P.z, N) > best2) continue;
    if (N.packed) {
      for (uint32_t k = N.first, end = N.first + N.packed - 1; k < end; k++) {
        V3 Q; const double d2 = closestOnTri(P, I, (size_t)k * 9, Q);
        if (d2 < best2) { best2 = d2; bestPt = Q; bestTri = (int32_t)I.order[k]; }
      }
    } else {
      const uint32_t l = n + 1, r = N.first;
      const double dl = distSqBox(P.x, P.y, P.z, nodes[l]), dr = distSqBox(P.x, P.y, P.z, nodes[r]);
      if (dl < dr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
    }
  }
  out[0] = bestPt.x; out[1] = bestPt.y; out[2] = bestPt.z; out[3] = std::sqrt(best2);
  return bestTri;
}

template <class TA, class TB>
int32_t distanceTo(const Index<TA>& A, const Index<TB>& O, double* out) {
  Best best;
  uint32_t stack[PAIR_STACK]; int sp = 0;
  stack[sp++] = 0; stack[sp++] = 0;
  const Node<TA>* nA = A.nodes.data();
  const Node<TB>* nO = O.nodes.data();
  while (sp && best.d2 > 0) {
    const uint32_t nb = stack[--sp];
    const uint32_t na = stack[--sp];
    const Node<TA>& NA = nA[na];
    const Node<TB>& NB = nO[nb];
    if (boxBoxDistSq(NA, NB) >= best.d2) continue;
    const uint32_t pa = NA.packed, pb = NB.packed;
    if (pa && pb) {
      for (uint32_t i = 0; i < pa - 1; i++)
        for (uint32_t j = 0; j < pb - 1; j++) {
          const Best r = triTriDist(A, (size_t)(NA.first + i) * 9, O, (size_t)(NB.first + j) * 9);
          if (r.d2 < best.d2) best = r;
        }
    } else if (!pa && (pb || nodeExtent(NA) >= nodeExtent(NB))) {
      const uint32_t l = na + 1, r = NA.first;
      const double dl = boxBoxDistSq(nA[l], NB), dr = boxBoxDistSq(nA[r], NB);
      if (dl < dr) { stack[sp++] = r; stack[sp++] = nb; stack[sp++] = l; stack[sp++] = nb; }
      else { stack[sp++] = l; stack[sp++] = nb; stack[sp++] = r; stack[sp++] = nb; }
    } else {
      const uint32_t l = nb + 1, r = NB.first;
      const double dl = boxBoxDistSq(NA, nO[l]), dr = boxBoxDistSq(NA, nO[r]);
      if (dl < dr) { stack[sp++] = na; stack[sp++] = r; stack[sp++] = na; stack[sp++] = l; }
      else { stack[sp++] = na; stack[sp++] = l; stack[sp++] = na; stack[sp++] = r; }
    }
  }
  if (!best.has) { out[0] = INFINITY; return 0; }
  out[0] = std::sqrt(best.d2);
  out[1] = (best.a.x + best.b.x) / 2; out[2] = (best.a.y + best.b.y) / 2; out[3] = (best.a.z + best.b.z) / 2;
  out[4] = best.a.x; out[5] = best.a.y; out[6] = best.a.z;
  out[7] = best.b.x; out[8] = best.b.y; out[9] = best.b.z;
  return 1;
}

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

template <class T>
int32_t minWall(const Index<T>& I, int32_t hasMaxThickness, double maxThickness, double maxSamples,
                int32_t hasBand, double bandMin, double bandMax, double* out) {
  const uint32_t n = I.count;
  if (n == 0) return 0;
  if (!hasMaxThickness) {
    const Node<T>& R = I.nodes[0];
    maxThickness = jsHypot((double)R.hi[0] - (double)R.lo[0], (double)R.hi[1] - (double)R.lo[1], (double)R.hi[2] - (double)R.lo[2]) + 1;
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

  // Which triangles the walk samples, and when: sample[t] is triangle t's
  // step in the stride walk (SOURCE order), or NONE if a sampled pass skips
  // it. The rays are then cast in LEAF order instead — neighbouring triangles,
  // whose rays cross the same nodes while they are still in cache. Each ray's
  // answer is its own, so only the tie-breaks depend on order, and they keep
  // the walk's: the minimum's location is the earliest step's, as is the
  // band's worst.
  constexpr uint32_t NONE = 0xffffffffu;
  std::vector<uint32_t> sample(n, NONE);
  {
    uint32_t t = 0;
    for (uint32_t s = 0; s < budget; s++, t = t + stride < n ? t + stride : t + stride - n) sample[t] = s;
  }

  double best = INFINITY; V3 loc{NAN, NAN, NAN}; uint32_t bestStep = NONE, bandStep = NONE;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t t = I.order[k], step = sample[t];
    if (step == NONE) continue;
    const T* tri = I.verts + (size_t)k * 9;
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
    const int32_t hit = raycast(I, origin, dir, 1e-6, maxThickness, (int32_t)t, ht);
    if (hit < 0) continue;
    if (ht < best || (ht == best && step < bestStep)) { best = ht; loc = c; bestStep = step; }
    if (hasBand && ht >= bandLo && ht <= bandHi) {
      members++;
      const double score = bandScore(ht);
      if (score > bandWorst || (score == bandWorst && step < bandStep)) { bandWorst = score; bandValue = ht; bandLoc = c; bandStep = step; }
    }
  }
  out[0] = best == INFINITY ? NAN : best;
  out[1] = loc.x; out[2] = loc.y; out[3] = loc.z;
  out[4] = sampled ? 1 : 0; out[5] = budget; out[6] = n;
  out[7] = bandValue; out[8] = bandLoc.x; out[9] = bandLoc.y; out[10] = bandLoc.z; out[11] = members;
  return 1;
}

}  // namespace

// One of the two, by the source precision.
struct BVH {
  Index<float>* f = nullptr;
  Index<double>* d = nullptr;
};

namespace {
template <class Fn>
auto visit(const BVH* T, Fn fn) { return T->f ? fn(*T->f) : fn(*T->d); }
}  // namespace

extern "C" BVH* bvh_build(void* verts, uint32_t count, int32_t f64, int32_t adopt) {
  BVH* T = new BVH();
  // build() copies into leaf order, so the source is only read; free it here
  // when adopted.
  if (f64) T->d = build((double*)verts, count);
  else T->f = build((float*)verts, count);
  if (adopt) std::free(verts);
  if (!T->f && !T->d) { delete T; return nullptr; }
  return T;
}

extern "C" uint32_t bvh_triangle_count(const BVH* T) { return visit(T, [](const auto& I) { return I.count; }); }
extern "C" void bvh_root_bounds(const BVH* T, double* out) {
  visit(T, [&](const auto& I) {
    const auto& R = I.nodes[0];
    for (int i = 0; i < 3; i++) { out[i] = (double)R.lo[i]; out[i + 3] = (double)R.hi[i]; }
    return 0;
  });
}

extern "C" int32_t bvh_raycast(const BVH* T, const double* o, const double* d, double tMin, double tMax, int32_t skipTri, double* out) {
  return visit(T, [&](const auto& I) {
    double t;
    const int32_t tri = raycast(I, {o[0], o[1], o[2]}, {d[0], d[1], d[2]}, tMin, tMax, skipTri, t);
    out[0] = t;
    return tri;
  });
}

extern "C" int32_t bvh_closest_point(const BVH* T, const double* p, double* out) {
  return visit(T, [&](const auto& I) { return closestPoint(I, {p[0], p[1], p[2]}, out); });
}

extern "C" int32_t bvh_distance_to(const BVH* A, const BVH* O, double* out) {
  return visit(A, [&](const auto& IA) { return visit(O, [&](const auto& IO) { return distanceTo(IA, IO, out); }); });
}

extern "C" int32_t bvh_min_wall(const BVH* T, int32_t hasMaxThickness, double maxThickness, double maxSamples,
                                int32_t hasBand, double bandMin, double bandMax, double* out) {
  return visit(T, [&](const auto& I) { return minWall(I, hasMaxThickness, maxThickness, maxSamples, hasBand, bandMin, bandMax, out); });
}

extern "C" void bvh_destroy(BVH* T) {
  if (!T) return;
  delete T->f;
  delete T->d;
  delete T;
}
