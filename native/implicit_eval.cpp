// C++ port of the implicit engine's evaluator: primitives.js, frames.js's
// xformPoint/xformDir, expr-lower.js's UN/BIN/TER tables, textures.js's
// sampleTexture and program.js's runProgram/evalBatch. See implicit_eval.h.
//
// What bit-exact parity needs, beyond native/README.md's rules:
//   - every expression keeps the JS's association: `a - b + c` is (a - b) + c,
//     `m - s * k * 0.25` is m - ((s * k) * 0.25), Math.min(a, b, c) is
//     jsmin(jsmin(a, b), c) (NaN propagates either way, -0 still beats +0);
//   - comparisons are the JS's: `v === v` is v == v, `!==` is != (NaN != NaN);
//   - the JS compares opcode operands with === (warp kind, mirror axis, get
//     component), so a value that is not 1 or 2 is the taper, not 0 or 1 is z
//     — kept as double comparisons;
//   - texels are float32, read and promoted to double, all arithmetic double;
//   - UNION/INTER gather a lane's operands in program order, so arg-min/arg-max
//     ties go to the first operand, as in unionN/intersectN.
// Layout differs from the JS only in that register files are flat vectors of
// BATCH-lane blocks and a UNION's operand registers are resolved once per op.
#include "implicit_eval.h"

#include <cmath>
#include <cstring>

#include "implicit_math.h"
#include "js_math.h"

namespace ipe {

using jsmath::hypot3;
using jsmath::jsmax;
using jsmath::jsmin;

namespace {

enum Op { END = 0, XFORM = 1, XDIR = 2, PRIM = 3, UNION = 4, INTER = 5, NEG = 6, MIN2 = 7, MIRRORP = 8, ADDC = 9,
          ONION = 10, WARP = 11, DISP = 12, SANITIZE = 13, GET = 20, CONST = 21, UN = 22, BIN = 23, TER = 24, TEX = 25 };

// FN_CODES (program.js), pinned by test/implicit-program.test.js.
enum Un { U_NEG, U_ABS, U_FLOOR, U_FRACT, U_SQRT, U_SIN, U_COS, U_NOT, U_COUNT };
enum Bin { B_ADD, B_SUB, B_MUL, B_DIV, B_MIN, B_MAX, B_MOD, B_STEP, B_LT, B_GT, B_LE, B_GE, B_EQ, B_NE, B_AND, B_OR, B_COUNT };
enum Ter { T_CLAMP, T_MIX, T_SMOOTHSTEP, T_SMIN, T_SMAX, T_SELECT, T_COUNT };

inline double sgn(double v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

inline double sanitize(double v) { return v == v ? (v > BIG ? BIG : v < -BIG ? -BIG : v) : BIG; }
inline double clamp_unit(double v) { return v > -1 ? (v < 1 ? v : 1) : v == v ? -1 : 0; }

double union_n(const double* v, int n, double k) {
  double m = v[0];
  int am = 0;
  for (int i = 1; i < n; i++) if (v[i] < m) { m = v[i]; am = i; }
  if (!(k > 0)) return m;
  double s = 0;
  for (int i = 0; i < n; i++) {
    if (i == am) continue;
    const double g = k - (v[i] - m);
    if (g > 0) { const double h = g / k; s += h * h; }
  }
  return m - s * k * 0.25;
}

double intersect_n(const double* v, int n, double k) {
  double M = v[0];
  int aM = 0;
  for (int i = 1; i < n; i++) if (v[i] > M) { M = v[i]; aM = i; }
  if (!(k > 0)) return M;
  double s = 0;
  for (int i = 0; i < n; i++) {
    if (i == aM) continue;
    const double g = k - (M - v[i]);
    if (g > 0) { const double h = g / k; s += h * h; }
  }
  return M + s * k * 0.25;
}

inline void warp_point(double* out, double kind, const double* W, double x, double y, double z) {
  if (kind == 1) {
    const double a = -W[0] * z, c = ipm::pf_cos(a), s = ipm::pf_sin(a);
    out[0] = c * x - s * y; out[1] = s * x + c * y; out[2] = z;
  } else if (kind == 2) {
    const double R = W[0], u = R - x, rho = std::sqrt(u * u + z * z);
    out[0] = R - rho; out[1] = y; out[2] = R * ipm::pf_atan2(z, u);
  } else {
    double t = (z - W[0]) / (W[2] - W[0]);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const double s = W[1] + (W[3] - W[1]) * t;
    out[0] = x / s; out[1] = y / s; out[2] = z;
  }
}

inline void mirror_point(double* out, double axis, double x, double y, double z) {
  out[0] = axis == 0 ? -x : x; out[1] = axis == 1 ? -y : y; out[2] = axis == 2 ? -z : z;
}

inline void xform_point(double* out, const double* M, double x, double y, double z) {
  out[0] = M[0] * x + M[1] * y + M[2] * z + M[9];
  out[1] = M[3] * x + M[4] * y + M[5] * z + M[10];
  out[2] = M[6] * x + M[7] * y + M[8] * z + M[11];
}

inline void xform_dir(double* out, const double* M, double x, double y, double z) {
  out[0] = M[0] * x + M[1] * y + M[2] * z;
  out[1] = M[3] * x + M[4] * y + M[5] * z;
  out[2] = M[6] * x + M[7] * y + M[8] * z;
}

// expr-lower.js's smin2 / smax2.
inline double smin2(double a, double b, double k) {
  if (!(k > 0)) return jsmin(a, b);
  const double h = jsmax(k - std::fabs(a - b), 0) / k;
  return jsmin(a, b) - h * h * k * 0.25;
}
inline double smax2(double a, double b, double k) { return -smin2(-a, -b, k); }

inline double un_fn(int f, double a) {
  switch (f) {
    case U_NEG: return -a;
    case U_ABS: return std::fabs(a);
    case U_FLOOR: return std::floor(a);
    case U_FRACT: return a - std::floor(a);
    case U_SQRT: return std::sqrt(a);
    case U_SIN: return ipm::pf_sin(a);
    case U_COS: return ipm::pf_cos(a);
    default: return a == 0 ? 1 : 0;   // U_NOT
  }
}

inline double bin_fn(int f, double a, double b) {
  switch (f) {
    case B_ADD: return a + b;
    case B_SUB: return a - b;
    case B_MUL: return a * b;
    case B_DIV: return a / b;
    case B_MIN: return jsmin(a, b);
    case B_MAX: return jsmax(a, b);
    case B_MOD: return a - b * std::floor(a / b);
    case B_STEP: return b < a ? 0 : 1;    // step(e = a, x = b)
    case B_LT: return a < b ? 1 : 0;
    case B_GT: return a > b ? 1 : 0;
    case B_LE: return a <= b ? 1 : 0;
    case B_GE: return a >= b ? 1 : 0;
    case B_EQ: return a == b ? 1 : 0;
    case B_NE: return a != b ? 1 : 0;
    case B_AND: return a != 0 && b != 0 ? 1 : 0;
    default: return a != 0 || b != 0 ? 1 : 0;   // B_OR
  }
}

inline double ter_fn(int f, double a, double b, double c) {
  switch (f) {
    case T_CLAMP: return jsmin(jsmax(a, b), c);
    case T_MIX: return a * (1 - c) + b * c;
    case T_SMOOTHSTEP: {
      const double t = jsmin(jsmax((c - a) / (b - a), 0), 1);
      return t * t * (3 - 2 * t);
    }
    case T_SMIN: return smin2(a, b, c);
    case T_SMAX: return smax2(a, b, c);
    default: return a != 0 ? b : c;   // T_SELECT
  }
}

// Highest P index each primitive reads, plus one (evalPrim).
int prim_params(double code) {
  if (code == 1) return 1;
  if (code == 2) return 3;
  if (code == 3) return 7;
  if (code == 4) return 12;
  if (code == 5) return 4;
  if (code == 6) return 3;
  if (code == 7) return 2;
  if (code == 8) return 4;
  return -1;   // evalPrim throws on an unknown code
}

inline bool is_index(double v, double limit) { return v >= 0 && v < limit && v == std::floor(v); }

std::vector<Session*> g_sessions;   // id = index + 1; null once destroyed

}  // namespace

double eval_prim(int code, const double* P, double x, double y, double z) {
  switch (code) {
    case 1: return hypot3(x, y, z) - P[0];
    case 2: return jsmin(jsmin(P[0], P[1]), P[2]) * (hypot3(x / P[0], y / P[1], z / P[2]) - 1);
    case 3: {
      const double px = x - P[0], py = y - P[1], pz = z - P[2];
      const double bx = P[3] - P[0], by = P[4] - P[1], bz = P[5] - P[2];
      const double bb = bx * bx + by * by + bz * bz;
      double h = bb > 0 ? (px * bx + py * by + pz * bz) / bb : 0;
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      return hypot3(px - bx * h, py - by * h, pz - bz * h) - P[6];
    }
    case 4: {
      const double pax = x - P[0], pay = y - P[1], paz = z - P[2];
      const double bax = P[3], bay = P[4], baz = P[5], l2 = P[6], rr = P[7], a2 = P[8], il2 = P[9];
      const double yv = pax * bax + pay * bay + paz * baz, zv = yv - l2;
      const double xx = pax * l2 - bax * yv, xy = pay * l2 - bay * yv, xz = paz * l2 - baz * yv;
      const double x2 = xx * xx + xy * xy + xz * xz, y2 = yv * yv * l2, z2 = zv * zv * l2;
      const double k = sgn(rr) * rr * rr * x2;
      if (sgn(zv) * a2 * z2 > k) return std::sqrt(x2 + z2) * il2 - P[11];
      if (sgn(yv) * a2 * y2 < k) return std::sqrt(x2 + y2) * il2 - P[10];
      return (std::sqrt(x2 * a2 * il2) + yv * rr) * il2 - P[10];
    }
    case 5: {
      const double r = P[3];
      const double qx = std::fabs(x) - P[0] + r, qy = std::fabs(y) - P[1] + r, qz = std::fabs(z) - P[2] + r;
      return hypot3(jsmax(qx, 0), jsmax(qy, 0), jsmax(qz, 0)) + jsmin(jsmax(jsmax(qx, qy), qz), 0) - r;
    }
    case 6: {
      const double r = P[2];
      const double dx = std::sqrt(x * x + y * y) - P[1] + r, dz = std::fabs(z) - P[0] + r;
      const double mx = jsmax(dx, 0), mz = jsmax(dz, 0);
      return std::sqrt(mx * mx + mz * mz) + jsmin(jsmax(dx, dz), 0) - r;
    }
    case 7: {
      const double q = std::sqrt(x * x + y * y) - P[0];
      return std::sqrt(q * q + z * z) - P[1];
    }
    default: return P[0] * x + P[1] * y + P[2] * z - P[3];   // 8; validate() refuses others
  }
}

double sample_texture(const Texture& t, double u, double v) {
  const double uc = u > 0 ? (u < 1 ? u : 1) : 0;   // NaN fails `u > 0` -> 0
  const double vc = v > 0 ? (v < 1 ? v : 1) : 0;
  const double fx = uc * (t.width - 1), fy = vc * (t.height - 1);
  const double x0 = std::floor(fx), y0 = std::floor(fy);
  const double x1 = x0 + 1 < t.width ? x0 + 1 : x0, y1 = y0 + 1 < t.height ? y0 + 1 : y0;
  const double ax = fx - x0, ay = fy - y0;
  const float* d = t.data.data();
  const int w = t.width, ix0 = (int)x0, ix1 = (int)x1, iy0 = (int)y0, iy1 = (int)y1;
  const double top = (double)d[iy0 * w + ix0] * (1 - ax) + (double)d[iy0 * w + ix1] * ax;
  const double bot = (double)d[iy1 * w + ix0] * (1 - ax) + (double)d[iy1 * w + ix1] * ax;
  return top * (1 - ay) + bot * ay;
}

void validate(Program& p) {
  p.ok = false;
  p.maxSlot = -1;
  const std::vector<double>& c = p.code;
  const size_t len = c.size();
  if (len < 2) return;
  const double nP = c[0], nV = c[1];
  if (!(nP >= 1 && nP <= 1e7 && nP == std::floor(nP)) || !(nV >= 0 && nV <= 1e7 && nV == std::floor(nV))) return;
  p.nP = (int)nP;
  p.nV = (int)nV;
  size_t pc = 2;
  auto has = [&](size_t k) { return pc + k <= len; };
  auto isP = [&](size_t at) { return is_index(c[at], nP); };
  auto isV = [&](size_t at) { return is_index(c[at], nV); };
  for (;;) {
    if (!has(1)) return;   // ran off the end: the JS reads undefined -> bad opcode
    const double op = c[pc];
    if (op != std::floor(op)) return;
    switch ((int)op) {
      case END:
        if (!has(2) || !isV(pc + 1)) return;
        p.ok = true;
        return;
      case XFORM: case XDIR:
        if (!has(15) || !isP(pc + 1) || !isP(pc + 2)) return;
        pc += 15; break;
      case PRIM: {
        if (!has(5) || !isV(pc + 2) || !isP(pc + 3) || !is_index(c[pc + 4], 1e9)) return;
        const int need = prim_params(c[pc + 1]);
        const size_t np = (size_t)c[pc + 4];
        if (need < 0 || np < (size_t)need || !has(5 + np)) return;
        pc += 5 + np; break;
      }
      case UNION: case INTER: {
        if (!has(4) || !isV(pc + 1) || !is_index(c[pc + 3], 1e9) || c[pc + 3] < 1) return;
        const size_t cnt = (size_t)c[pc + 3];
        if (!has(4 + cnt)) return;
        for (size_t j = 0; j < cnt; j++) if (!isV(pc + 4 + j)) return;
        pc += 4 + cnt; break;
      }
      case NEG: case SANITIZE:
        if (!has(3) || !isV(pc + 1) || !isV(pc + 2)) return;
        pc += 3; break;
      case MIN2:
        if (!has(4) || !isV(pc + 1) || !isV(pc + 2) || !isV(pc + 3)) return;
        pc += 4; break;
      case MIRRORP:
        if (!has(4) || !isP(pc + 1) || !isP(pc + 2)) return;
        pc += 4; break;
      case ADDC: case ONION:
        if (!has(4) || !isV(pc + 1) || !isV(pc + 2)) return;
        pc += 4; break;
      case WARP: {
        if (!has(5) || !isP(pc + 2) || !isP(pc + 3) || !is_index(c[pc + 4], 1e9)) return;
        const double kind = c[pc + 1];
        const size_t need = kind == 1 || kind == 2 ? 1 : 4, np = (size_t)c[pc + 4];
        if (np < need || !has(5 + np)) return;
        pc += 5 + np; break;
      }
      case DISP:
        if (!has(5) || !isV(pc + 1) || !isV(pc + 2) || !isV(pc + 3)) return;
        pc += 5; break;
      case GET:
        if (!has(4) || !isV(pc + 1) || !isP(pc + 2)) return;
        pc += 4; break;
      case CONST:
        if (!has(3) || !isV(pc + 1)) return;
        pc += 3; break;
      case UN:
        if (!has(4) || !is_index(c[pc + 1], U_COUNT) || !isV(pc + 2) || !isV(pc + 3)) return;
        pc += 4; break;
      case BIN:
        if (!has(5) || !is_index(c[pc + 1], B_COUNT) || !isV(pc + 2) || !isV(pc + 3) || !isV(pc + 4)) return;
        pc += 5; break;
      case TER:
        if (!has(6) || !is_index(c[pc + 1], T_COUNT) || !isV(pc + 2) || !isV(pc + 3) || !isV(pc + 4) || !isV(pc + 5)) return;
        pc += 6; break;
      case TEX:
        if (!has(5) || !isV(pc + 1) || !is_index(c[pc + 2], 1e9) || !isV(pc + 3) || !isV(pc + 4)) return;
        if ((int)c[pc + 2] > p.maxSlot) p.maxSlot = (int)c[pc + 2];
        pc += 5; break;
      default: return;
    }
  }
}

void run(Session& s, const Program& p, const double* X, const double* Y, const double* Z, int n, double* out) {
  const size_t needP = (size_t)p.nP * BATCH, needV = (size_t)(p.nV > 0 ? p.nV : 1) * BATCH;
  if (s.PX.size() < needP) { s.PX.resize(needP); s.PY.resize(needP); s.PZ.resize(needP); }
  if (s.V.size() < needV) s.V.resize(needV);
  double* PX = s.PX.data();
  double* PY = s.PY.data();
  double* PZ = s.PZ.data();
  double* V = s.V.data();
  auto px = [&](double r) { return PX + (size_t)r * BATCH; };
  auto py = [&](double r) { return PY + (size_t)r * BATCH; };
  auto pz = [&](double r) { return PZ + (size_t)r * BATCH; };
  auto vr = [&](double r) { return V + (size_t)r * BATCH; };
  std::memcpy(PX, X, sizeof(double) * n);
  std::memcpy(PY, Y, sizeof(double) * n);
  std::memcpy(PZ, Z, sizeof(double) * n);
  const double* c = p.code.data();
  size_t pc = 2;
  double tmp[3];
  for (;;) {
    switch ((int)c[pc]) {
      case END: {
        const double* v = vr(c[pc + 1]);
        for (int i = 0; i < n; i++) out[i] = v[i];
        return;
      }
      case XFORM: case XDIR: {
        const bool point = (int)c[pc] == XFORM;
        const double* M = c + pc + 3;
        const double *sx = px(c[pc + 2]), *sy = py(c[pc + 2]), *sz = pz(c[pc + 2]);
        double *dx = px(c[pc + 1]), *dy = py(c[pc + 1]), *dz = pz(c[pc + 1]);
        for (int i = 0; i < n; i++) {
          if (point) xform_point(tmp, M, sx[i], sy[i], sz[i]); else xform_dir(tmp, M, sx[i], sy[i], sz[i]);
          dx[i] = tmp[0]; dy[i] = tmp[1]; dz[i] = tmp[2];
        }
        pc += 15; break;
      }
      case PRIM: {
        const int code = (int)c[pc + 1];
        double* dv = vr(c[pc + 2]);
        const double *sx = px(c[pc + 3]), *sy = py(c[pc + 3]), *sz = pz(c[pc + 3]);
        const size_t np = (size_t)c[pc + 4];
        const double* P = c + pc + 5;
        for (int i = 0; i < n; i++) dv[i] = eval_prim(code, P, sx[i], sy[i], sz[i]);
        pc += 5 + np; break;
      }
      case UNION: case INTER: {
        const bool uni = (int)c[pc] == UNION;
        double* dv = vr(c[pc + 1]);
        const double k = c[pc + 2];
        const int cnt = (int)c[pc + 3];
        if ((int)s.gather.size() < cnt) { s.gather.resize(cnt); s.gsrc.resize(cnt); }
        double* g = s.gather.data();
        const double** src = s.gsrc.data();
        for (int j = 0; j < cnt; j++) src[j] = vr(c[pc + 4 + j]);
        for (int i = 0; i < n; i++) {
          for (int j = 0; j < cnt; j++) g[j] = src[j][i];
          dv[i] = uni ? union_n(g, cnt, k) : intersect_n(g, cnt, k);
        }
        pc += 4 + cnt; break;
      }
      case NEG: {
        double* d = vr(c[pc + 1]);
        const double* a = vr(c[pc + 2]);
        for (int i = 0; i < n; i++) d[i] = -a[i];
        pc += 3; break;
      }
      case MIN2: {
        double* d = vr(c[pc + 1]);
        const double *a = vr(c[pc + 2]), *b = vr(c[pc + 3]);
        for (int i = 0; i < n; i++) d[i] = jsmin(a[i], b[i]);
        pc += 4; break;
      }
      case MIRRORP: {
        const double axis = c[pc + 3];
        const double *sx = px(c[pc + 2]), *sy = py(c[pc + 2]), *sz = pz(c[pc + 2]);
        double *dx = px(c[pc + 1]), *dy = py(c[pc + 1]), *dz = pz(c[pc + 1]);
        for (int i = 0; i < n; i++) {
          mirror_point(tmp, axis, sx[i], sy[i], sz[i]);
          dx[i] = tmp[0]; dy[i] = tmp[1]; dz[i] = tmp[2];
        }
        pc += 4; break;
      }
      case ADDC: {
        double* d = vr(c[pc + 1]);
        const double* a = vr(c[pc + 2]);
        const double k = c[pc + 3];
        for (int i = 0; i < n; i++) d[i] = a[i] + k;
        pc += 4; break;
      }
      case ONION: {
        double* d = vr(c[pc + 1]);
        const double* a = vr(c[pc + 2]);
        const double t = c[pc + 3];
        for (int i = 0; i < n; i++) d[i] = std::fabs(a[i]) - t;
        pc += 4; break;
      }
      case WARP: {
        const double kind = c[pc + 1];
        const size_t np = (size_t)c[pc + 4];
        const double* W = c + pc + 5;
        const double *sx = px(c[pc + 3]), *sy = py(c[pc + 3]), *sz = pz(c[pc + 3]);
        double *dx = px(c[pc + 2]), *dy = py(c[pc + 2]), *dz = pz(c[pc + 2]);
        for (int i = 0; i < n; i++) {
          warp_point(tmp, kind, W, sx[i], sy[i], sz[i]);
          dx[i] = tmp[0]; dy[i] = tmp[1]; dz[i] = tmp[2];
        }
        pc += 5 + np; break;
      }
      case DISP: {
        double* d = vr(c[pc + 1]);
        const double *a = vr(c[pc + 2]), *b = vr(c[pc + 3]);
        const double amt = c[pc + 4];
        for (int i = 0; i < n; i++) d[i] = a[i] - amt * clamp_unit(b[i]);
        pc += 5; break;
      }
      case SANITIZE: {
        double* d = vr(c[pc + 1]);
        const double* a = vr(c[pc + 2]);
        for (int i = 0; i < n; i++) d[i] = sanitize(a[i]);
        pc += 3; break;
      }
      case GET: {
        double* d = vr(c[pc + 1]);
        const double comp = c[pc + 3];
        const double* src = comp == 0 ? px(c[pc + 2]) : comp == 1 ? py(c[pc + 2]) : pz(c[pc + 2]);
        for (int i = 0; i < n; i++) d[i] = src[i];
        pc += 4; break;
      }
      case CONST: {
        double* d = vr(c[pc + 1]);
        const double k = c[pc + 2];
        for (int i = 0; i < n; i++) d[i] = k;
        pc += 3; break;
      }
      case UN: {
        const int f = (int)c[pc + 1];
        double* d = vr(c[pc + 2]);
        const double* a = vr(c[pc + 3]);
        for (int i = 0; i < n; i++) d[i] = un_fn(f, a[i]);
        pc += 4; break;
      }
      case BIN: {
        const int f = (int)c[pc + 1];
        double* d = vr(c[pc + 2]);
        const double *a = vr(c[pc + 3]), *b = vr(c[pc + 4]);
        for (int i = 0; i < n; i++) d[i] = bin_fn(f, a[i], b[i]);
        pc += 5; break;
      }
      case TER: {
        const int f = (int)c[pc + 1];
        double* d = vr(c[pc + 2]);
        const double *a = vr(c[pc + 3]), *b = vr(c[pc + 4]), *e = vr(c[pc + 5]);
        for (int i = 0; i < n; i++) d[i] = ter_fn(f, a[i], b[i], e[i]);
        pc += 6; break;
      }
      case TEX: {
        double* d = vr(c[pc + 1]);
        const Texture& t = s.textures[(size_t)c[pc + 2]];
        const double *u = vr(c[pc + 3]), *v = vr(c[pc + 4]);
        for (int i = 0; i < n; i++) d[i] = sample_texture(t, u[i], v[i]);
        pc += 5; break;
      }
      default: return;   // unreachable for a validated program
    }
  }
}

int eval(Session& s, const Program& p, const double* X, const double* Y, const double* Z, int n, double* out) {
  if (!p.ok || p.maxSlot >= (int)s.textures.size() || n < 0) return 1;
  for (int at = 0; at < n; at += BATCH) {
    const int m = n - at < BATCH ? n - at : BATCH;
    run(s, p, X + at, Y + at, Z + at, m, out + at);
  }
  return 0;
}

Session* session(int id) {
  if (id < 1 || (size_t)id > g_sessions.size()) return nullptr;
  return g_sessions[id - 1];
}

}  // namespace ipe

extern "C" {

int ip_session_create() {
  ipe::Session* s = new ipe::Session();
  for (size_t i = 0; i < ipe::g_sessions.size(); i++) {
    if (!ipe::g_sessions[i]) { ipe::g_sessions[i] = s; return (int)i + 1; }
  }
  ipe::g_sessions.push_back(s);
  return (int)ipe::g_sessions.size();
}

void ip_session_destroy(int id) {
  ipe::Session* s = ipe::session(id);
  if (!s) return;
  delete s;
  ipe::g_sessions[id - 1] = nullptr;
}

// Copies width*height float32 texels; returns the slot, or -1 (unknown session,
// empty image).
int ip_tex_add(int id, int width, int height, const float* data) {
  ipe::Session* s = ipe::session(id);
  if (!s || width < 1 || height < 1) return -1;
  ipe::Texture t;
  t.width = width;
  t.height = height;
  t.data.assign(data, data + (size_t)width * (size_t)height);
  s->textures.push_back(std::move(t));
  return (int)s->textures.size() - 1;
}

// Copies the program and validates it; returns its index, or -1 for an
// unknown session. A malformed program still gets an index (ip_eval refuses it).
int ip_prog_add(int id, const double* prog, int len) {
  ipe::Session* s = ipe::session(id);
  if (!s || len < 0) return -1;
  ipe::Program p;
  p.code.assign(prog, prog + len);
  ipe::validate(p);
  s->programs.push_back(std::move(p));
  return (int)s->programs.size() - 1;
}

// evalBatch: 0 ok; nonzero for an unknown session/program, a malformed program
// or a texture slot the session does not have.
int ip_eval(int id, int prog, const double* X, const double* Y, const double* Z, int n, double* out) {
  ipe::Session* s = ipe::session(id);
  if (!s || prog < 0 || (size_t)prog >= s->programs.size()) return 2;
  return ipe::eval(*s, s->programs[prog], X, Y, Z, n, out);
}

}
