// The implicit engine's field evaluator — the C++ twin of
// src/framework/geometry/implicit/{primitives.js, frames.js (xformPoint/xformDir),
// expr-lower.js (the UN/BIN/TER tables), textures.js (sampleTexture),
// contact.js (contactValue/bulgeOffset), program.js (runProgram/evalBatch/evalBatchContact)}. Bit-identical to the JS: the same
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
#include <memory>
#include <vector>

namespace ipe {

constexpr int BATCH = 256;      // program.js's BATCH
constexpr double BIG = 1e6;     // primitives.js's BIG
constexpr int MAX_OWNER_K = 127; // contact.js's MAX_OWNER_K: an exact contact's child indices are below it

struct Texture {
  int width = 0, height = 0;
  std::vector<float> data;      // textures.js stores float32 in 0..1
};

// One op of a validated program, decoded once (validate) so the interpreter
// reads integers instead of re-converting the code's doubles every call: the
// register indices, the primitive / fn / warp kind / axis / component as a
// small int, and `at`, the offset in `code` of the op's inline doubles
// (parameters, matrix, operand list). Arithmetic still reads every constant
// from `code`, as the JS reads it from the Float64Array.
struct Inst {
  int32_t op, sub;      // opcode; PRIM code, UN/BIN/TER fn, WARP kind (0 taper), MIRROR axis / GET comp,
                        // CONTACT 1 when exact (fuse == 2: a child map and tie ranks follow the fills) (-1: none)
  int32_t d, a, b, c;   // destination and source registers, by op
  int32_t at, cnt;      // inline doubles' offset; UNION/INTER/CONTACT operand count, BULGE region count
};                      // (CONTACT: b = attachment count, c = fill-region count, a = point register)

struct Program {
  std::vector<double> code;     // program.js's Float64Array format, verbatim
  bool ok = false;              // passed validate(): every op well-formed
  int nP = 0, nV = 0;
  int maxSlot = -1;             // highest texture slot a TEX op reads
  int maxKid = -1;              // highest child index an exact CONTACT's child map names
  std::vector<Inst> insts;      // the decoded ops, END last (only when ok)
};

struct Session {
  std::vector<Texture> textures;
  std::vector<Program> programs;
  // Register files: nP point registers (x, y, z) and nV value registers, each a
  // block of BATCH lanes; grown on demand, never shrunk, reused across runs.
  std::vector<double> PX, PY, PZ, V;
  std::vector<const double*> gsrc; // a UNION/INTER's operand registers, resolved once per op
  std::vector<double> um, us;   // UNION/INTER per-lane running extreme and sum (BATCH each)
  std::vector<int32_t> uam;     // UNION/INTER per-lane arg-extreme (BATCH)
  std::vector<double> cg, cc, cw;  // CONTACT's per-lane operands, c_i and attachment weights
  std::vector<int32_t> cpair;   // CONTACT's slot pair -> first attachment (-1: none), per op
  std::vector<int32_t> cap32;   // ip_sample's per-lane piece capture (owner plans)

  // The leaf store (implicit_mesh.cpp, sparse.js's Store): the sampled plan's grid,
  // its leaves (i0, j0, l0, program per leaf) and their (LEAF+1)^3 float32 samples
  // each, leaf after leaf in plan order. `sampled` is false until ip_sample succeeds.
  bool sampled = false;
  double origin[3] = {0, 0, 0}, edge = 0;
  int n[3] = {0, 0, 0};
  bool clipped = false;
  std::vector<int32_t> leaves;
  std::unique_ptr<float[]> vals;   // uninitialized: every sample is written before it is read
  size_t valsCap = 0;
  // With an owner plan (ownerK > 0: the root is an exact contact), each sample's owning
  // child, or -1 (AIR) where the stored value is >= 0 — sparse.js's leaf `owner`.
  int ownerK = 0;
  std::vector<int8_t> owners;

  // The mesh (mesher.js's meshStore output): xyz per vertex, three indices per
  // triangle, and the leaf each vertex was created in. `meshed` is false until
  // ip_mesh succeeds on the current store.
  bool meshed = false;
  std::vector<double> positions;
  std::vector<uint32_t> indices;
  std::vector<int32_t> vertLeaf;
  // Per-vertex field normals (project.js's `normals`, double x3), written by
  // ip_project with normals on and by ip_cleanup; empty after a new mesh.
  std::vector<double> normals;

  // The owner path (implicit_owner.cpp; a root exact contact). The contact's context, set once
  // by ip_set_contact: its attachment table (contact.js's ATTACH_STRIDE layout, child indices),
  // its exact clearance (clearanceExact(gap)), its gap, and contact.js's CREASE_SNAP, CREASE_TOL
  // and DETAIL_SEAM_FADE — handed in from JS, so the constants have one home.
  bool contactSet = false;
  std::vector<double> att;
  double cl = 0, gap = 0, creaseSnap = 0, creaseTol = 0, seamFade = 0;
  // An OWNER MESH (ip_mesh_owners, and every stage after it) carries per vertex its owner (a
  // child index), held / pinned marks and, once the crease is cut (hasCrease), crease marks.
  // A plain mesh (ip_mesh, ip_mesh_load) clears them.
  bool ownerMesh = false, hasCrease = false;
  std::vector<int32_t> vertOwner;
  std::vector<uint8_t> ownerHeld, pinned, creaseMark;
  std::vector<int32_t> triOwner;   // ip_tri_owners' answer (result.js's triangleOwners)
};

// Checks a program's structure once (op codes, operand counts, register and fn
// indices, primitive parameter counts) so the interpreter can trust it; a
// program the JS would throw on is not ok.
void validate(Program& p);

// evalBatchContact's capture (program.js): per lane, the exact contact op's merged
// owner and piece (child indices), and per lane x K each child's cut and share. A null
// array is not captured. Lane i of a run writes at lane `off + i`.
struct Capture {
  int K = 0;
  int32_t* owner = nullptr;
  int32_t* piece = nullptr;
  double* cuts = nullptr;
  double* shares = nullptr;
};

// runProgram over n <= BATCH lanes. The program must be ok and its texture
// slots present (eval checks both). `cap` (null on the hot path) captures the
// exact contact op's lanes at offset `off`.
void run(Session& s, const Program& p, const double* X, const double* Y, const double* Z, int n, double* out,
         const Capture* cap = nullptr, int off = 0);

// evalBatch: any n, in chunks of BATCH. Returns 0, or nonzero for a malformed
// program / missing texture slot (nothing written then).
int eval(Session& s, const Program& p, const double* X, const double* Y, const double* Z, int n, double* out);

// evalBatchContact: eval, also capturing into `cap` after filling its arrays' first
// n lanes (n x K for cuts/shares) with -1 / +Infinity. Nonzero (nothing written) as
// eval, or when K is outside 1..MAX_OWNER_K or below a child index the program names.
int eval_contact(Session& s, const Program& p, const double* X, const double* Y, const double* Z, int n, double* out,
                 const Capture& cap);

// The scalar building blocks, exposed for the later stages (detail heights).
double eval_prim(int code, const double* P, double x, double y, double z);
double sample_texture(const Texture& t, double u, double v);

// The session table (ids >= 1); null for an unknown or destroyed id.
Session* session(int id);

}  // namespace ipe
