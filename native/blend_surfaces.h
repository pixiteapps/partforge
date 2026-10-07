// C++ port of partforge's blend-surfaces.js evaluator: the
// exact normal field of a mesh fillet band, per descriptor kind. Internal to
// creased_normals.cpp; the C interface carries descriptors as flat doubles.
//
// Flat descriptor layout (one Float64Array slice per descriptor):
//   [kind, closed, n, ...]
//   kind 0 none   — evaluates to "no normal" (an unknown kind in the JS)
//   kind 1 line   — p(3) d(3)
//   kind 2 point  — c(3)
//   kind 3 circle — c(3) a(3) R
//   kind 4 path   — kf kd f(3) pts(n*3) dirs(n*3)
//   kind 5 spine  — r pts(n*3)
//   kind 6 planes — tol, then n planes as (nx, ny, nz, d)   (n = plane count)
#pragma once
#include <cstdint>
#include <memory>
#include <vector>

namespace blend {

struct Vec { double x, y, z; };

struct Descriptor {
  int kind = 0;
  bool closed = false;
  Vec p{}, d{}, c{}, a{}, f{};
  double R = 0, kf = 0, kd = 0, r = 0;
  bool hasKfKd = false, hasR = false;
  std::vector<Vec> pts, dirs;
  // planes: unit normal + offset (n·x = d) per plane, and the on-plane tolerance
  std::vector<Vec> planeN;
  std::vector<double> planeD;
  double tol = 0;
  // Lazily built segment grid (nearestSegment), as the JS caches on the descriptor.
  struct Grid;
  std::shared_ptr<Grid> grid;
};

bool parse(const double* data, uint32_t len, Descriptor& out);

// A run's evaluator: descriptor + the inverse of the run transform. `valid` is
// false when the transform is singular (runEvaluator's null).
struct Evaluator {
  Descriptor* desc = nullptr;
  double inv[12];
  bool valid = false;
};
Evaluator makeEvaluator(Descriptor* desc, const double M[12]);
// World-frame unit normal at x; false where the JS returns null.
bool evaluate(Evaluator& ev, const double x[3], double out[3]);

}  // namespace blend
