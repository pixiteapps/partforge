// C++ port of partforge's bvh.js + min-wall.js. See those
// files for WHY; comments here note only what bit-exact parity needs:
//   - vertices stay in their source precision (float for a Manifold soup,
//     double otherwise), arithmetic is double, as in the JS;
//   - the build is the JS's binned surface-area heuristic, step for step (no
//     sort, a stable partition, the same bin and cost expressions);
//   - traversal stacks push and pop in the JS's order, ties keep the first;
//   - hypot is partforge's own (js_math.h / js-math.js); Math.round is
//     round-half-up.
//
// The tree is the JS's tree, node for node — the build (Builder) follows
// bvh.js's binned surface-area heuristic expression for expression: no sort, a
// stable partition, the same bin index, the same costs in the same order, the
// same first-wins ties. Only its memory layout differs, and none of that moves a
// bit of any answer:
//   - the index is templated on the vertex type, so no read branches on it;
//   - a node is one struct — its box in the vertex type (a box's corners ARE
//     vertex coordinates, so a float box is exact) and its two links — rather
//     than parallel bounds/meta arrays: a float mesh's node is 32 bytes;
//   - after the build, triangles are copied into LEAF order, so a leaf's
//     triangles are contiguous; `order` maps a leaf slot back to the source
//     triangle id every query reports;
//   - traversal stacks are fixed arrays (the build's depth limit bounds them),
//     not a heap vector per query — min-wall casts one ray per triangle;
//   - min-wall casts its rays in leaf order, so consecutive rays reuse the
//     nodes the last one pulled into cache (ties still go to the JS's first;
//     see minWall).
#include "bvh.h"

#include <cmath>

#include "js_math.h"
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

// bvh.js's build constants.
constexpr uint32_t BINS = 16, MAX_LEAF = 8, DEPTH_LIMIT = 48;
// Stack bounds. The build splits by area down to DEPTH_LIMIT and halves ranges
// below it, so a tree over at most 2^32 triangles is at most DEPTH_LIMIT + 32
// internal levels deep: a single-tree walk holds at most depth + 1 entries, a
// pair walk at most depthA + depthB + 1 pairs.
constexpr int STACK = 128;
constexpr int PAIR_STACK = 4 * STACK;

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

// Where the ray enters N's box within (tMin, best], or Infinity if it doesn't
// meet it there (bvh.js's rayEntry).
template <class T>
double rayEntry(double ox, double oy, double oz, double ix, double iy, double iz,
                const Node<T>& N, double tMin, double best) {
  double t0 = tMin, t1 = best;
  double lo = ((double)N.lo[0] - ox) * ix, hi = ((double)N.hi[0] - ox) * ix;
  if (lo > hi) { const double s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  if (t0 > t1) return INFINITY;
  lo = ((double)N.lo[1] - oy) * iy; hi = ((double)N.hi[1] - oy) * iy;
  if (lo > hi) { const double s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  if (t0 > t1) return INFINITY;
  lo = ((double)N.lo[2] - oz) * iz; hi = ((double)N.hi[2] - oz) * iz;
  if (lo > hi) { const double s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo;
  if (hi < t1) t1 = hi;
  return t0 <= t1 ? t0 : INFINITY;
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
// skipTri is a source id, as in the JS. Nearer child first, each pushed with
// its entry distance, as in the JS.
template <class T>
int32_t raycast(const Index<T>& I, V3 o, V3 d, double tMin, double tMax, int32_t skipTri, double& tOut) {
  const double ix = 1 / d.x, iy = 1 / d.y, iz = 1 / d.z;
  double best = tMax; int32_t bestTri = -1;
  uint32_t stack[STACK]; double entry[STACK]; int sp = 0;
  const Node<T>* nodes = I.nodes.data();
  const double e0 = rayEntry(o.x, o.y, o.z, ix, iy, iz, nodes[0], tMin, best);
  if (e0 != INFINITY) { stack[sp] = 0; entry[sp++] = e0; }
  while (sp) {
    --sp;
    const uint32_t n = stack[sp];
    if (entry[sp] > best) continue;
    const Node<T>& N = nodes[n];
    if (N.packed) {
      for (uint32_t k = N.first, end = N.first + N.packed - 1; k < end; k++) {
        const uint32_t tri = I.order[k];
        if ((int32_t)tri == skipTri) continue;
        const double t = rayTri(o.x, o.y, o.z, d.x, d.y, d.z, I.verts, (size_t)k * 9, tMin);
        if (t < best) { best = t; bestTri = (int32_t)tri; }
      }
    } else {
      const uint32_t l = n + 1, r = N.first;
      const double tl = rayEntry(o.x, o.y, o.z, ix, iy, iz, nodes[l], tMin, best);
      const double tr = rayEntry(o.x, o.y, o.z, ix, iy, iz, nodes[r], tMin, best);
      if (tl <= tr) {
        if (tr != INFINITY) { stack[sp] = r; entry[sp++] = tr; }
        if (tl != INFINITY) { stack[sp] = l; entry[sp++] = tl; }
      } else {
        if (tl != INFINITY) { stack[sp] = l; entry[sp++] = tl; }
        if (tr != INFINITY) { stack[sp] = r; entry[sp++] = tr; }
      }
    }
  }
  tOut = best;
  return bestTri;
}

// Half a box's surface area (bvh.js's halfArea).
inline double halfArea(double x0, double y0, double z0, double x1, double y1, double z1) {
  const double x = x1 - x0, y = y1 - y0, z = z1 - z0;
  return x * y + y * z + z * x;
}
// bvh.js's binOf: which bin a centroid coordinate falls in; NaN lands in 0.
inline uint32_t binOf(double c, double lo, double scale) {
  // floor() written as a truncating cast: the same value wherever the cast is
  // reached (0 <= v < BINS).
  const double v = (c - lo) * scale;
  return v >= BINS ? BINS - 1 : v >= 0 ? (uint32_t)v : 0;
}
// The JS's `if (l < lo) lo = l; if (h > hi) hi = h;`, as selects rather than
// branches (the same values, NaN and ±0 included: an equal or NaN candidate
// keeps the old one).
inline void grow(double& lo, double& hi, double l, double h) { lo = l < lo ? l : lo; hi = h > hi ? h : hi; }

// What a node needs to know about its range before choosing a split: its box
// and its centroids' box. The parent's partition pass computes both for each
// child (same elements, same order, so the same values as a pass of their own).
struct RangeBox {
  double lo[3] = {INFINITY, INFINITY, INFINITY}, hi[3] = {-INFINITY, -INFINITY, -INFINITY};
  double cLo[3] = {INFINITY, INFINITY, INFINITY}, cHi[3] = {-INFINITY, -INFINITY, -INFINITY};
  template <class T>
  void add(const T* b) {
    for (int a = 0; a < 3; a++) {
      const double l = b[a], h = b[3 + a], c = (l + h) / 2;
      grow(lo[a], hi[a], l, h);
      grow(cLo[a], cHi[a], c, c);
    }
  }
};

// bvh.js's buildBVH, step for step (see the comments there for the why).
template <class T>
struct Builder {
  Index<T>* I;
  std::vector<T> tb, tbTmp;          // per-triangle boxes, in build order
  std::vector<uint32_t> orderTmp;
  // Bin scratch, reused by every node: it is done with before a node recurses,
  // and on the WebAssembly stack (64 KB) one copy per tree level would not fit.
  double binN[BINS], binB[BINS][6], rightArea[BINS], rightN[BINS];

  RangeBox measure(uint32_t start, uint32_t len) const {
    RangeBox r;
    for (uint32_t k = start; k < start + len; k++) r.add(&tb[(size_t)k * 6]);
    return r;
  }

  uint32_t emit(uint32_t start, uint32_t len, uint32_t depth, const RangeBox& rb) {
    std::vector<Node<T>>& nodes = I->nodes;
    std::vector<uint32_t>& order = I->order;
    const uint32_t self = (uint32_t)nodes.size();
    nodes.push_back({});
    const double x0 = rb.lo[0], y0 = rb.lo[1], z0 = rb.lo[2], x1 = rb.hi[0], y1 = rb.hi[1], z1 = rb.hi[2];
    const double* cLo = rb.cLo;
    const double* cHi = rb.cHi;
    {
      Node<T>& N = nodes[self];
      // Each corner is a vertex coordinate (or ±Infinity), so it converts back exactly.
      N.lo[0] = (T)x0; N.lo[1] = (T)y0; N.lo[2] = (T)z0; N.hi[0] = (T)x1; N.hi[1] = (T)y1; N.hi[2] = (T)z1;
    }
    auto leaf = [&]() { nodes[self].first = start; nodes[self].packed = len + 1; return self; };
    if (len <= 1) return leaf();

    if (depth < DEPTH_LIMIT) {
      // bvh.js's split search: the axis of the widest centroid spread, its
      // 16 bins, the cheapest plane between them.
      const double ex = cHi[0] - cLo[0], ey = cHi[1] - cLo[1], ez = cHi[2] - cLo[2];
      const int axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const double ext = cHi[axis] - cLo[axis];
      double bestCost = INFINITY; int bestAxis = -1; uint32_t bestSplit = 0;
      if (ext > 0) {
        const double lo = cLo[axis], scale = BINS / ext;
        // A bin is reset on first use rather than all 16 per node: most nodes
        // are small, and resetting every bin cost more than binning them.
        uint32_t touched = 0;  // bit i: bin i is in use
        for (uint32_t k = start; k < start + len; k++) {
          const T* b = &tb[(size_t)k * 6];
          const uint32_t bin = binOf(((double)b[axis] + (double)b[3 + axis]) / 2, lo, scale);
          double* B = binB[bin];
          if (!(touched >> bin & 1)) {
            touched |= 1u << bin;
            binN[bin] = 0;
            B[0] = B[1] = B[2] = INFINITY;
            B[3] = B[4] = B[5] = -INFINITY;
          }
          binN[bin]++;
          for (int j = 0; j < 3; j++) grow(B[j], B[3 + j], b[j], b[3 + j]);
        }
        // The cost sweep, over the NON-EMPTY bins only. bvh.js sweeps all 16;
        // every plane between two consecutive non-empty bins splits the range
        // the same way at the same cost, and its strict `<` keeps the first of
        // them — the plane right after the left bin, which is the one costed
        // here. Empty bins add nothing to a box or a count, so each cost is the
        // same number.
        uint32_t used[BINS], m = 0;
        for (uint32_t bits = touched; bits; bits &= bits - 1) used[m++] = (uint32_t)__builtin_ctz(bits);
        if (m >= 2) {
          double rx0 = INFINITY, ry0 = INFINITY, rz0 = INFINITY, rx1 = -INFINITY, ry1 = -INFINITY, rz1 = -INFINITY, rn = 0;
          for (uint32_t j = m - 1; j > 0; j--) {  // rightArea[j]: bins used[j..m-1]
            const double* B = binB[used[j]];
            grow(rx0, rx1, B[0], B[3]); grow(ry0, ry1, B[1], B[4]); grow(rz0, rz1, B[2], B[5]);
            rn += binN[used[j]];
            rightArea[j] = halfArea(rx0, ry0, rz0, rx1, ry1, rz1); rightN[j] = rn;
          }
          double lx0 = INFINITY, ly0 = INFINITY, lz0 = INFINITY, lx1 = -INFINITY, ly1 = -INFINITY, lz1 = -INFINITY, ln = 0;
          for (uint32_t j = 0; j + 1 < m; j++) {  // the plane after bin used[j]
            const double* B = binB[used[j]];
            grow(lx0, lx1, B[0], B[3]); grow(ly0, ly1, B[1], B[4]); grow(lz0, lz1, B[2], B[5]);
            ln += binN[used[j]];
            const double cost = halfArea(lx0, ly0, lz0, lx1, ly1, lz1) * ln + rightArea[j + 1] * rightN[j + 1];
            if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestSplit = used[j]; }
          }
        }
      }
      if (bestAxis >= 0) {
        const double area = halfArea(x0, y0, z0, x1, y1, z1);
        if (len <= MAX_LEAF && area + bestCost >= area * (double)len) return leaf();
        const double lo = cLo[bestAxis], scale = BINS / (cHi[bestAxis] - lo);
        uint32_t l = start, r = 0;
        RangeBox lb, rbx;
        for (uint32_t k = start; k < start + len; k++) {
          T* b = &tb[(size_t)k * 6];
          if (binOf(((double)b[bestAxis] + (double)b[3 + bestAxis]) / 2, lo, scale) <= bestSplit) {
            lb.add(b);
            order[l] = order[k];
            for (int j = 0; j < 6; j++) tb[(size_t)l * 6 + j] = b[j];
            l++;
          } else {
            rbx.add(b);
            orderTmp[r] = order[k];
            for (int j = 0; j < 6; j++) tbTmp[(size_t)r * 6 + j] = b[j];
            r++;
          }
        }
        for (uint32_t i = 0; i < r; i++) {
          order[l + i] = orderTmp[i];
          for (int j = 0; j < 6; j++) tb[(size_t)(l + i) * 6 + j] = tbTmp[(size_t)i * 6 + j];
        }
        emit(start, l - start, depth + 1, lb);
        const uint32_t right = emit(l, len - (l - start), depth + 1, rbx);
        nodes[self].first = right;
        nodes[self].packed = 0;
        return self;
      }
    }
    // No plane separates the centroids (they coincide), or the depth limit:
    // halve the range as it stands.
    if (len <= MAX_LEAF) return leaf();
    const uint32_t mid = len >> 1;
    emit(start, mid, depth + 1, measure(start, mid));
    const uint32_t right = emit(start + mid, len - mid, depth + 1, measure(start + mid, len - mid));
    nodes[self].first = right;
    nodes[self].packed = 0;
    return self;
  }
};

template <class T>
Index<T>* build(T* src, uint32_t count) {
  Index<T>* I = new Index<T>();
  I->count = count;
  I->order.resize(count);
  {
    Builder<T> B{I, std::vector<T>((size_t)count * 6), std::vector<T>((size_t)count * 6), std::vector<uint32_t>(count), {}, {}, {}, {}};
    for (uint32_t t = 0; t < count; t++) {
      I->order[t] = t;
      double x0 = INFINITY, y0 = INFINITY, z0 = INFINITY, x1 = -INFINITY, y1 = -INFINITY, z1 = -INFINITY;
      const T* v = src + (size_t)t * 9;
      for (int j = 0; j < 9; j += 3) { grow(x0, x1, v[j], v[j]); grow(y0, y1, v[j + 1], v[j + 1]); grow(z0, z1, v[j + 2], v[j + 2]); }
      T* b = &B.tb[(size_t)t * 6];
      b[0] = (T)x0; b[1] = (T)y0; b[2] = (T)z0; b[3] = (T)x1; b[4] = (T)y1; b[5] = (T)z1;
    }
    I->nodes.reserve(count > 1 ? (size_t)count * 2 - 1 : 1);
    B.emit(0, count, 0, B.measure(0, count));
    I->nodes.shrink_to_fit();
  }
  // Triangles into leaf order (the build's scratch is released first).
  I->verts = (T*)std::malloc(count ? (size_t)count * 9 * sizeof(T) : 1);
  for (uint32_t k = 0; k < count; k++) std::memcpy(I->verts + (size_t)k * 9, src + (size_t)I->order[k] * 9, 9 * sizeof(T));
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

// FNV-1a over the tree: each node's box as doubles (low word first), its two
// links, then the leaf order. Tests compute the same over the JS BVH's arrays
// to hold the two builds to the same tree, not merely to the same answers.
extern "C" uint32_t bvh_fingerprint(const BVH* T) {
  return visit(T, [](const auto& I) {
    uint32_t h = 2166136261u;
    auto mixWord = [&](uint32_t w) { for (int i = 0; i < 4; i++) { h ^= (w >> (8 * i)) & 255; h *= 16777619u; } };
    for (const auto& N : I.nodes) {
      for (int a = 0; a < 6; a++) {
        const double v = a < 3 ? (double)N.lo[a] : (double)N.hi[a - 3];
        uint64_t b; std::memcpy(&b, &v, 8);
        mixWord((uint32_t)b); mixWord((uint32_t)(b >> 32));
      }
      mixWord(N.first); mixWord(N.packed);
    }
    for (uint32_t id : I.order) mixWord(id);
    return h;
  });
}

extern "C" void bvh_destroy(BVH* T) {
  if (!T) return;
  delete T->f;
  delete T->d;
  delete T;
}
