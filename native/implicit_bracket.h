// bracket.js's solveBrackets: the sign change of g on [0, 1] in each of n lanes (g < 0 the low
// side, anything else - NaN too - the high side), by the Illinois method with the bracket kept:
// the secant of the bracket's ends when both are on their side of zero, it lands strictly inside
// and the step before was not a secant step that failed to halve the bracket (the safeguard),
// else the midpoint; the retained end's (secant) value halved when the same end is kept twice
// running. Every two steps at least halve the bracket, so MAX_BRACKET_STEPS (2 x 24) bounds
// every lane. A lane stops once hi - lo <= BRACKET_TOL or g is exactly 0 and answers the
// bracket's midpoint; one the cap stops wider answers the end with the smaller |g| as
// evaluated (the low end on a tie or when only the high end is NaN). evalAt(lanes, ts, count, g)
// writes g at ts[k] of lane lanes[k] (nonzero: abort). Without f0/f1 both ends are evaluated
// first, lane k's at slots 2k and 2k + 1. The same arithmetic in the same order as the JS.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace ipm_bracket {

constexpr double BRACKET_TOL = 1e-7;
constexpr int MAX_BRACKET_STEPS = 48;

template <class EvalAt>
int solve_brackets(size_t n, int maxSteps, EvalAt&& evalAt, const double* f0, const double* f1, std::vector<double>& t) {
  std::vector<double> lo(n, 0.0), hi(n, 1.0), flo(n), fhi(n), glo(n), ghi(n);
  std::vector<int8_t> side(n, 0);
  std::vector<uint8_t> mid(n, 0);
  const size_t cap = n ? 2 * n : 1;
  std::vector<uint32_t> lanes(cap);
  std::vector<double> ts(cap), g(cap);
  std::vector<uint8_t> secant(n ? n : 1);
  if (!f0 || !f1) {
    for (size_t k = 0; k < n; k++) { lanes[2 * k] = (uint32_t)k; ts[2 * k] = 0; lanes[2 * k + 1] = (uint32_t)k; ts[2 * k + 1] = 1; }
    if (n && evalAt(lanes.data(), ts.data(), 2 * n, g.data()) != 0) return 2;
    for (size_t k = 0; k < n; k++) { flo[k] = g[2 * k]; fhi[k] = g[2 * k + 1]; }
  } else {
    for (size_t k = 0; k < n; k++) { flo[k] = f0[k]; fhi[k] = f1[k]; }
  }
  for (size_t k = 0; k < n; k++) { glo[k] = flo[k]; ghi[k] = fhi[k]; }
  size_t na = 0;
  for (size_t k = 0; k < n; k++) lanes[na++] = (uint32_t)k;
  for (int it = 0; it < maxSteps && na > 0; it++) {
    for (size_t q = 0; q < na; q++) {
      const uint32_t k = lanes[q];
      double x = (lo[k] + hi[k]) / 2;
      secant[q] = 0;
      if (!mid[k] && flo[k] < 0 && fhi[k] > 0) {
        const double sec = lo[k] + (hi[k] - lo[k]) * (flo[k] / (flo[k] - fhi[k]));
        if (sec > lo[k] && sec < hi[k]) { x = sec; secant[q] = 1; }
      }
      ts[q] = x;
    }
    if (evalAt(lanes.data(), ts.data(), na, g.data()) != 0) return 2;
    size_t keep = 0;
    for (size_t q = 0; q < na; q++) {
      const uint32_t k = lanes[q];
      const double x = ts[q], v = g[q], w = hi[k] - lo[k];
      if (v < 0) {
        if (side[k] == -1) fhi[k] *= 0.5;
        lo[k] = x; flo[k] = v; glo[k] = v; side[k] = -1;
      } else if (v == 0) {
        lo[k] = x; hi[k] = x; glo[k] = v; ghi[k] = v;
      } else {
        if (side[k] == 1) flo[k] *= 0.5;
        hi[k] = x; fhi[k] = v; ghi[k] = v; side[k] = 1;
      }
      mid[k] = secant[q] && hi[k] - lo[k] > 0.5 * w ? 1 : 0;
      if (hi[k] - lo[k] > BRACKET_TOL) lanes[keep++] = k;
    }
    na = keep;
  }
  t.resize(n);
  for (size_t k = 0; k < n; k++) {
    if (!(hi[k] - lo[k] > BRACKET_TOL)) t[k] = (lo[k] + hi[k]) / 2;
    else t[k] = std::fabs(ghi[k]) < std::fabs(glo[k]) || (glo[k] != glo[k] && ghi[k] == ghi[k]) ? hi[k] : lo[k];
  }
  return 0;
}

}  // namespace ipm_bracket
