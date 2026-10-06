// See blend_surfaces.h. Ported line for line from blend-surfaces.js so its
// output matches bit for bit: double arithmetic in the JS's order, partforge's
// hypot (js_math.h), the same hash, the same grid traversal
// and tie-breaking.
#include "blend_surfaces.h"

#include <cmath>

#include "js_math.h"
#include <unordered_map>

namespace blend {
namespace {

constexpr double EPS = 1e-12;
constexpr uint32_t GRID_MIN_SEGS = 16;

double jsHypot(double a, double b, double c) { return jsmath::hypot3(a, b, c); }

// JS norm(): unit vector, or null when the length is not above EPS.
bool norm(double x, double y, double z, Vec& out) {
  const double l = jsHypot(x, y, z);
  if (!(l > EPS)) return false;
  out = {x / l, y / l, z / l};
  return true;
}

int32_t toInt32(double d) {
  if (!std::isfinite(d)) return 0;
  double m = std::fmod(std::trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (int32_t)(uint32_t)m;
}
int32_t imul(int32_t a, int32_t b) { return (int32_t)((uint32_t)a * (uint32_t)b); }
int32_t cellKey(double a, double b, double c) {
  return imul(toInt32(a), 73856093) ^ imul(toInt32(b), 19349663) ^ imul(toInt32(c), 83492791);
}

}  // namespace

struct Descriptor::Grid {
  double h = 0;
  std::unordered_map<int32_t, std::vector<uint32_t>> cells;
  std::vector<uint32_t> stamp;
  uint32_t epoch = 0;
};

bool parse(const double* v, uint32_t len, Descriptor& o) {
  if (len < 3) return false;
  o.kind = (int)v[0];
  o.closed = v[1] != 0;
  const uint32_t n = (uint32_t)v[2];
  uint32_t i = 3;
  auto vec = [&](Vec& out) { out = {v[i], v[i + 1], v[i + 2]}; i += 3; };
  switch (o.kind) {
    case 1: vec(o.p); vec(o.d); break;
    case 2: vec(o.c); break;
    case 3: vec(o.c); vec(o.a); o.R = v[i++]; break;
    case 4:
      o.kf = v[i++]; o.kd = v[i++]; o.hasKfKd = true; vec(o.f);
      o.pts.resize(n); for (auto& p : o.pts) vec(p);
      o.dirs.resize(n); for (auto& d : o.dirs) vec(d);
      break;
    case 5:
      o.r = v[i++]; o.hasR = true;
      o.pts.resize(n); for (auto& p : o.pts) vec(p);
      break;
    case 6:
      o.tol = v[i++];
      o.planeN.resize(n); o.planeD.resize(n);
      for (uint32_t k = 0; k < n; k++) { vec(o.planeN[k]); o.planeD[k] = v[i++]; }
      break;
    default: o.kind = 0;
  }
  return i <= len;
}

namespace {

// squared distance from x to segment pq; the clamped parameter in t
double segDist2(const Vec& p, const Vec& q, const double x[3], double& tOut) {
  const double dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
  const double dd = dx * dx + dy * dy + dz * dz;
  double t = dd > EPS ? ((x[0] - p.x) * dx + (x[1] - p.y) * dy + (x[2] - p.z) * dz) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  tOut = t;
  const double ex = x[0] - p.x - t * dx, ey = x[1] - p.y - t * dy, ez = x[2] - p.z - t * dz;
  return ex * ex + ey * ey + ez * ez;
}

Descriptor::Grid& segmentGrid(Descriptor& desc) {
  if (desc.grid) return *desc.grid;
  auto g = std::make_shared<Descriptor::Grid>();
  const auto& pts = desc.pts;
  const uint32_t n = (uint32_t)pts.size(), nSeg = desc.closed ? n : n - 1;
  double total = 0;
  for (uint32_t i = 0; i < nSeg; i++) {
    const Vec& p = pts[i]; const Vec& q = pts[(i + 1) % n];
    total += jsHypot(q.x - p.x, q.y - p.y, q.z - p.z);
  }
  // Math.max(total / Math.max(1, nSeg), |kf ?? 0| + |kd ?? 0| + (r ?? 0), 1e-6)
  const double kf = desc.hasKfKd ? desc.kf : 0, kd = desc.hasKfKd ? desc.kd : 0, r = desc.hasR ? desc.r : 0;
  g->h = jsmath::jsmax(jsmath::jsmax(total / jsmath::jsmax(1.0, (double)nSeg), std::fabs(kf) + std::fabs(kd) + r), 1e-6);
  const double h = g->h;
  for (uint32_t i = 0; i < nSeg; i++) {
    const Vec& p = pts[i]; const Vec& q = pts[(i + 1) % n];
    const double pa[3] = {p.x, p.y, p.z}, qa[3] = {q.x, q.y, q.z};
    double lo[3], hi[3];
    for (int ax = 0; ax < 3; ax++) {
      lo[ax] = std::floor(jsmath::jsmin(pa[ax], qa[ax]) / h);
      hi[ax] = std::floor(jsmath::jsmax(pa[ax], qa[ax]) / h);
    }
    for (double a = lo[0]; a <= hi[0]; a++)
      for (double b = lo[1]; b <= hi[1]; b++)
        for (double c = lo[2]; c <= hi[2]; c++) g->cells[cellKey(a, b, c)].push_back(i);
  }
  g->stamp.assign(nSeg, 0);
  desc.grid = g;
  return *g;
}

bool nearestSegment(Descriptor& desc, const double x[3], uint32_t& biOut, double& btOut) {
  const auto& pts = desc.pts;
  const uint32_t n = (uint32_t)pts.size();
  if (n == 0) return false;
  const uint32_t nSeg = desc.closed ? n : n - 1;
  int64_t bi = -1; double bt = 0, bestD = INFINITY, t = 0;
  auto scanAll = [&]() {
    for (uint32_t i = 0; i < nSeg; i++) {
      const double D = segDist2(pts[i], pts[(i + 1) % n], x, t);
      if (D < bestD) { bestD = D; bi = i; bt = t; }
    }
  };
  if (nSeg < GRID_MIN_SEGS) {
    scanAll();
  } else {
    Descriptor::Grid& g = segmentGrid(desc);
    const uint32_t epoch = ++g.epoch;
    const double h = g.h;
    const double c0 = std::floor(x[0] / h), c1 = std::floor(x[1] / h), c2 = std::floor(x[2] / h);
    for (int ring = 0;; ring++) {
      if (bi >= 0 && (ring - 1) * h > std::sqrt(bestD)) break;
      bool any = false;
      for (int a = -ring; a <= ring; a++)
        for (int b = -ring; b <= ring; b++)
          for (int c = -ring; c <= ring; c++) {
            if (std::max(std::abs(a), std::max(std::abs(b), std::abs(c))) != ring) continue;
            auto it = g.cells.find(cellKey(c0 + a, c1 + b, c2 + c));
            if (it == g.cells.end()) continue;
            any = true;
            for (uint32_t i : it->second) {
              if (g.stamp[i] == epoch) continue;
              g.stamp[i] = epoch;
              const double D = segDist2(pts[i], pts[(i + 1) % n], x, t);
              if (D < bestD) { bestD = D; bi = i; bt = t; }
            }
          }
      if (!any && bi < 0 && ring >= 3) { scanAll(); break; }
    }
  }
  if (bi < 0) return false;
  biOut = (uint32_t)bi; btOut = bt;
  return true;
}

bool pathNormal(Descriptor& desc, const double x[3], Vec& out) {
  const auto& pts = desc.pts; const auto& dirs = desc.dirs;
  const uint32_t n = (uint32_t)pts.size();
  uint32_t bi; double bt;
  if (!nearestSegment(desc, x, bi, bt)) return false;
  const Vec& p = pts[bi]; const Vec& q = pts[(bi + 1) % n];
  const Vec& d0 = dirs[bi]; const Vec& d1 = dirs[(bi + 1) % n];
  Vec dir;
  if (!norm(d0.x + (d1.x - d0.x) * bt, d0.y + (d1.y - d0.y) * bt, d0.z + (d1.z - d0.z) * bt, dir)) return false;
  const Vec& f = desc.f; const double kf = desc.kf, kd = desc.kd;
  const Vec e = {p.x + (q.x - p.x) * bt, p.y + (q.y - p.y) * bt, p.z + (q.z - p.z) * bt};
  const Vec c = {e.x + kf * f.x + kd * dir.x, e.y + kf * f.y + kd * dir.y, e.z + kf * f.z + kd * dir.z};
  const Vec v = {x[0] - c.x, x[1] - c.y, x[2] - c.z};
  const double h = v.x * f.x + v.y * f.y + v.z * f.z;
  Vec segN, perp;
  if (!norm(q.x - p.x, q.y - p.y, q.z - p.z, segN)) return false;
  if (!norm(f.y * segN.z - f.z * segN.y, f.z * segN.x - f.x * segN.z, f.x * segN.y - f.y * segN.x, perp)) return false;
  const double sgn = perp.x * dir.x + perp.y * dir.y + perp.z * dir.z >= 0 ? 1 : -1;
  const double w = sgn * (v.x * perp.x + v.y * perp.y + v.z * perp.z);
  return norm(h * f.x + w * dir.x, h * f.y + w * dir.y, h * f.z + w * dir.z, out);
}

bool surfaceNormal(Descriptor& desc, const double x[3], Vec& out) {
  switch (desc.kind) {
    case 6: {
      // planeNormal: the one plane x lies on (within tol), or none — off every
      // plane, or on two at once.
      bool hit = false;
      for (size_t k = 0; k < desc.planeN.size(); k++) {
        const Vec& n = desc.planeN[k];
        if (std::fabs(n.x * x[0] + n.y * x[1] + n.z * x[2] - desc.planeD[k]) > desc.tol) continue;
        if (hit) return false;
        hit = true;
        out = n;
      }
      return hit;
    }
    case 4: return pathNormal(desc, x, out);
    case 5: {
      uint32_t bi; double bt;
      if (!nearestSegment(desc, x, bi, bt)) return false;
      const Vec& p = desc.pts[bi]; const Vec& q = desc.pts[(bi + 1) % desc.pts.size()];
      const Vec c = {p.x + (q.x - p.x) * bt, p.y + (q.y - p.y) * bt, p.z + (q.z - p.z) * bt};
      return norm(x[0] - c.x, x[1] - c.y, x[2] - c.z, out);
    }
    case 2: return norm(x[0] - desc.c.x, x[1] - desc.c.y, x[2] - desc.c.z, out);
    case 1: {
      const Vec& p = desc.p; const Vec& d = desc.d;
      const double t = (x[0] - p.x) * d.x + (x[1] - p.y) * d.y + (x[2] - p.z) * d.z;
      const Vec s = {p.x + t * d.x, p.y + t * d.y, p.z + t * d.z};
      return norm(x[0] - s.x, x[1] - s.y, x[2] - s.z, out);
    }
    case 3: {
      const Vec& c = desc.c; const Vec& a = desc.a; const double R = desc.R;
      const Vec q = {x[0] - c.x, x[1] - c.y, x[2] - c.z};
      const double t = q.x * a.x + q.y * a.y + q.z * a.z;
      Vec rad, s;
      if (!norm(q.x - t * a.x, q.y - t * a.y, q.z - t * a.z, rad)) {
        if (R > 0) return false;
        s = c;
      } else {
        s = {c.x + R * rad.x, c.y + R * rad.y, c.z + R * rad.z};
      }
      return norm(x[0] - s.x, x[1] - s.y, x[2] - s.z, out);
    }
    default: return false;
  }
}

}  // namespace

Evaluator makeEvaluator(Descriptor* desc, const double M[12]) {
  Evaluator ev;
  ev.desc = desc;
  const double a = M[0], b = M[1], c = M[2], d = M[3], e = M[4], f = M[5], g = M[6], h = M[7], i = M[8];
  const double A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  if (!(std::fabs(det) > EPS)) return ev;
  const double s = 1 / det;
  const double L[9] = {
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  };
  // applyDir(L, translation)
  const double tx = L[0] * M[9] + L[3] * M[10] + L[6] * M[11];
  const double ty = L[1] * M[9] + L[4] * M[10] + L[7] * M[11];
  const double tz = L[2] * M[9] + L[5] * M[10] + L[8] * M[11];
  for (int k = 0; k < 9; k++) ev.inv[k] = L[k];
  ev.inv[9] = -tx; ev.inv[10] = -ty; ev.inv[11] = -tz;
  ev.valid = true;
  return ev;
}

bool evaluate(Evaluator& ev, const double x[3], double out[3]) {
  const double* M = ev.inv;
  const double px[3] = {
    M[0] * x[0] + M[3] * x[1] + M[6] * x[2] + M[9],
    M[1] * x[0] + M[4] * x[1] + M[7] * x[2] + M[10],
    M[2] * x[0] + M[5] * x[1] + M[8] * x[2] + M[11],
  };
  Vec n0;
  if (!surfaceNormal(*ev.desc, px, n0)) return false;
  Vec n;
  if (!norm(M[0] * n0.x + M[1] * n0.y + M[2] * n0.z,
            M[3] * n0.x + M[4] * n0.y + M[5] * n0.z,
            M[6] * n0.x + M[7] * n0.y + M[8] * n0.z, n)) return false;
  out[0] = n.x; out[1] = n.y; out[2] = n.z;
  return true;
}

}  // namespace blend
