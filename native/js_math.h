// partforge's own hypot — the C++ twin of src/framework/geometry/js-math.js.
//
// The core's passes must produce the same bits as their JS, and Math.hypot is
// not one function: JavaScriptCore computes it as libc++'s fused
// std::hypot(x, y, z) and V8 as a Kahan-summed sum of scaled squares, and the
// two disagree in the last bit on about a third of inputs. So the passes the
// core ports call this instead, in JS and here: three multiplies, two adds and
// a correctly rounded square root, each rounded in order — the same on every
// JS engine, and reproduced exactly here as long as the compiler does not
// fuse the multiply-adds (the build passes -ffp-contract=off; WebAssembly has
// no FMA instruction to fuse into anyway).
//
// No overflow scaling: inputs are millimetre coordinates and their
// differences, nowhere near 1e154.
#pragma once
#include <cmath>

namespace jsmath {

inline double hypot3(double x, double y, double z) {
  return std::sqrt(x * x + y * y + z * z);
}

// Math.max / Math.min of two numbers: NaN if EITHER is NaN (std::fmax/fmin
// drop it), and +0 beats -0 for max, -0 beats +0 for min.
inline double jsmax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0 && b == 0) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}
inline double jsmin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0 && b == 0) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}

}  // namespace jsmath
