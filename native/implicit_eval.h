// The implicit engine's field evaluator — the C++ twin of
// src/framework/geometry/implicit/{primitives.js, frames.js (xformPoint/xformDir),
// expr-lower.js (the UN/BIN/TER tables), textures.js (sampleTexture),
// program.js (runProgram/evalBatch)}. Bit-identical to the JS: the same
// operation order, Math.min/max as jsmath::jsmin/jsmax, the ported pf_* trig,
// float32 texels promoted to double, first-wins ties (native/README.md).
//
// A SESSION holds what one meshing run needs on the native side: the part's
// textures (slots in add order, matching compiled.textures), its emitted
// programs (indices in add order) and the interpreter's register blocks, reused
// across calls so the hot loop never allocates. Several sessions may be live at
// once; the C ABI addresses them by id.
#pragma once
#include <cstdint>
#include <vector>

namespace ipe {

constexpr int BATCH = 256;      // program.js's BATCH
constexpr double BIG = 1e6;     // primitives.js's BIG

struct Texture {
  int width = 0, height = 0;
  std::vector<float> data;      // textures.js stores float32 in 0..1
};

struct Program {
  std::vector<double> code;     // program.js's Float64Array format, verbatim
  bool ok = false;              // passed validate(): every op well-formed
  int nP = 0, nV = 0;
  int maxSlot = -1;             // highest texture slot a TEX op reads
};

struct Session {
  std::vector<Texture> textures;
  std::vector<Program> programs;
  // Register files: nP point registers (x, y, z) and nV value registers, each a
  // block of BATCH lanes; grown on demand, never shrunk, reused across runs.
  std::vector<double> PX, PY, PZ, V;
  std::vector<double> gather;   // UNION/INTER operand gather (program.js's `gather`)
  std::vector<const double*> gsrc; // that op's operand registers, resolved once per op

  // The leaf store (implicit_mesh.cpp, sparse.js's Store): the sampled plan's grid,
  // its leaves (i0, j0, l0, program per leaf) and their (LEAF+1)^3 float32 samples
  // each, leaf after leaf in plan order. `sampled` is false until ip_sample succeeds.
  bool sampled = false;
  double origin[3] = {0, 0, 0}, edge = 0;
  int n[3] = {0, 0, 0};
  bool clipped = false;
  std::vector<int32_t> leaves;
  std::vector<float> vals;
};

// Checks a program's structure once (op codes, operand counts, register and fn
// indices, primitive parameter counts) so the interpreter can trust it; a
// program the JS would throw on is not ok.
void validate(Program& p);

// runProgram over n <= BATCH lanes. The program must be ok and its texture
// slots present (eval checks both).
void run(Session& s, const Program& p, const double* X, const double* Y, const double* Z, int n, double* out);

// evalBatch: any n, in chunks of BATCH. Returns 0, or nonzero for a malformed
// program / missing texture slot (nothing written then).
int eval(Session& s, const Program& p, const double* X, const double* Y, const double* Z, int n, double* out);

// The scalar building blocks, exposed for the later stages (detail heights).
double eval_prim(int code, const double* P, double x, double y, double z);
double sample_texture(const Texture& t, double u, double v);

// The session table (ids >= 1); null for an unknown or destroyed id.
Session* session(int id);

}  // namespace ipe
