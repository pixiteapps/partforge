// The implicit engine's math — C++ twins of pfSin/pfCos/pfAtan2
// (src/framework/geometry/js-math.js) and latticeHash/valueNoise
// (src/framework/geometry/implicit/noise.js). Bit-identical to the JS: the same
// constants, the same operation order, only + - * / and floor, each rounded in
// order (the build passes -ffp-contract=off). No std::sin/cos/atan2: libms differ.
#pragma once
#include <cmath>
#include <cstdint>

namespace ipm {

// ECMAScript ToInt32: NaN/+-Inf -> 0, truncate toward zero, wrap modulo 2^32.
inline int32_t to_int32(double x) {
  if (!std::isfinite(x)) return 0;
  double t = std::trunc(x);
  double m = std::fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;            // [0, 2^32)
  uint32_t u = (uint32_t)m;
  return (int32_t)u;
}

namespace detail {
constexpr double INVPIO2 = 6.36619772367581382433e-01;
constexpr double PIO2_1 = 1.57079632673412561417e+00;
constexpr double PIO2_1T = 6.07710050650619224932e-11;
constexpr double S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
                 S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
                 S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
constexpr double C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
                 C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
                 C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
inline double k_sin(double r) {
  double z = r * r, v = z * r;
  return r + v * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}
inline double k_cos(double r) {
  double z = r * r;
  return 1 - (0.5 * z - z * (z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))));
}
// JS ((n % 4) + 4) % 4 — JS % is fmod.
inline double quadrant(double n) { return std::fmod(std::fmod(n, 4.0) + 4.0, 4.0); }

constexpr double ATANHI[4] = {4.63647609000806093515e-01, 7.85398163397448278999e-01,
                              9.82793723247329054082e-01, 1.57079632679489655800e+00};
constexpr double ATANLO[4] = {2.26987774529616870924e-17, 3.06161699786838301793e-17,
                              1.39033110312309984516e-17, 6.12323399573676603587e-17};
constexpr double AT[11] = {3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
                           -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
                           6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
                           -3.65315727442169155270e-02, 1.62858201153657823623e-02};
inline double pf_atan(double x) {
  bool neg = x < 0;
  double ax = neg ? -x : x;
  int id;
  if (ax < 0.4375) id = -1;
  else if (ax < 0.6875) { id = 0; ax = (2 * ax - 1) / (2 + ax); }
  else if (ax < 1.1875) { id = 1; ax = (ax - 1) / (ax + 1); }
  else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1 + 1.5 * ax); }
  else { id = 3; ax = -1 / ax; }
  double z = ax * ax, w = z * z;
  double s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  double s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  double r = id < 0 ? ax - ax * (s1 + s2) : ATANHI[id] - ((ax * (s1 + s2) - ATANLO[id]) - ax);
  return neg ? -r : r;
}
constexpr double PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16,
                 PIO2 = 1.5707963267948965580e+00;
}  // namespace detail

inline double pf_sin(double x) {
  using namespace detail;
  double n = std::floor(x * INVPIO2 + 0.5), r = (x - n * PIO2_1) - n * PIO2_1T, q = quadrant(n);
  return q == 0 ? k_sin(r) : q == 1 ? k_cos(r) : q == 2 ? -k_sin(r) : -k_cos(r);
}
inline double pf_cos(double x) {
  using namespace detail;
  double n = std::floor(x * INVPIO2 + 0.5), r = (x - n * PIO2_1) - n * PIO2_1T, q = quadrant(n);
  return q == 0 ? k_cos(r) : q == 1 ? -k_sin(r) : q == 2 ? -k_cos(r) : k_sin(r);
}
inline double pf_atan2(double y, double x) {
  using namespace detail;
  if (x != x || y != y) return NAN;
  if (x == 0) return y > 0 ? PIO2 : y < 0 ? -PIO2 : 0;
  double a = pf_atan(std::fabs(y / x));
  if (x > 0) return y < 0 ? -a : a;
  return y < 0 ? -(PI - (a - PI_LO)) : PI - (a - PI_LO);
}

// Math.imul and the murmur3 finaliser over int32 bit patterns (uint32 arithmetic).
inline uint32_t fin(uint32_t h) {
  h ^= h >> 15; h *= 0x85ebca6bu; h ^= h >> 13; h *= 0xc2b2ae35u; h ^= h >> 16;
  return h;
}
inline double lattice_hash(double i, double j, double l) {
  uint32_t a = (uint32_t)to_int32(i) * 0x27d4eb2du + (uint32_t)to_int32(j);
  uint32_t b = fin(a) * 0x165667b1u + (uint32_t)to_int32(l);
  return (double)fin(b) / 4294967296.0;
}

inline double fade(double t) { return t * t * (3 - 2 * t); }

inline double value_noise(double x, double y, double z) {
  double fx = std::floor(x), fy = std::floor(y), fz = std::floor(z);
  double ux = fade(x - fx), uy = fade(y - fy), uz = fade(z - fz);
  double acc = 0;
  for (int dz = 0; dz <= 1; dz++) for (int dy = 0; dy <= 1; dy++) for (int dx = 0; dx <= 1; dx++) {
    double w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
    acc += lattice_hash(fx + dx, fy + dy, fz + dz) * w;
  }
  return acc - 0.5;
}

}  // namespace ipm
