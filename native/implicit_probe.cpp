// TEST-ONLY exports: let test/implicit-native-math.test.js compare the native implicit math,
// and test/implicit-bracket.test.js the edge solver, against their JS twins bit for bit.
// Nothing in the product calls them.
#include <cstdint>
#include <vector>

#include "implicit_bracket.h"
#include "implicit_math.h"

extern "C" {
// fn: 0 sin(a), 1 cos(a), 2 atan2(a, b), 3 hash(a, b, c), 4 noise(a, b, c).
double ip_math_probe(int fn, double a, double b, double c) {
  switch (fn) {
    case 0: return ipm::pf_sin(a);
    case 1: return ipm::pf_cos(a);
    case 2: return ipm::pf_atan2(a, b);
    case 3: return ipm::lattice_hash(a, b, c);
    case 4: return ipm::value_noise(a, b, c);
    default: return NAN;
  }
}

// solve_brackets on n lanes of the test family (7 doubles per lane: r, p,
// a, b, ja, jb, nanAbove): g(t) = NaN when t > nanAbove, else for t < r
// -(a * (r - t)^p + ja), else b * (t - r)^p + jb, the power a product of p factors from 1.
// f0/f1 may be null (the ends are evaluated). tOut gets the n answers; counts[0] the points
// evaluated, counts[1] the evaluation calls. Returns solve_brackets' code.
int ip_bracket_probe(const double* params, int n, int maxSteps, const double* f0, const double* f1, double* tOut, int32_t* counts) {
  if (n < 0) return 1;
  int32_t points = 0, calls = 0;
  std::vector<double> t;
  const int rc = ipm_bracket::solve_brackets((size_t)n, maxSteps, [&](const uint32_t* lanes, const double* ts, size_t c, double* g) -> int {
    calls++;
    points += (int32_t)c;
    for (size_t k = 0; k < c; k++) {
      const double* P = params + (size_t)lanes[k] * 7;
      const double x = ts[k];
      if (x > P[6]) { g[k] = NAN; continue; }
      const double d = x < P[0] ? P[0] - x : x - P[0];
      double y = 1;
      for (int i = 0; i < (int)P[1]; i++) y *= d;
      g[k] = x < P[0] ? -(P[2] * y + P[4]) : P[3] * y + P[5];
    }
    return 0;
  }, f0, f1, t);
  counts[0] = points; counts[1] = calls;
  if (rc != 0) return rc;
  for (int k = 0; k < n; k++) tOut[k] = t[(size_t)k];
  return 0;
}
}
