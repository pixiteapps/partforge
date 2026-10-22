# The native core

C++ ports of partforge's hottest per-vertex / per-triangle JavaScript,
compiled to one WebAssembly module that every JS host loads
(`src/framework/core/`), and compilable as plain native code for an app that
binds the same C calls into its own JS engine.

| File | Port of |
| --- | --- |
| `creased_normals.{h,cpp}` | `src/framework/geometry/creased-normals.js` — the shading/feature-edge pass every Manifold mesh goes through |
| `blend_surfaces.{h,cpp}` | `src/framework/geometry/blend-surfaces.js` — the analytic fillet normals that pass evaluates (all seven kinds: line, point, circle, path, spine, planes, and an unknown kind's "no normal") |
| `bvh.{h,cpp}` | `src/framework/oracle/bvh.js` + `min-wall.js` — the oracle's triangle BVH (raycast, closestPoint, distanceTo) and the min-wall pass |
| `js_math.h` | `src/framework/geometry/js-math.js` — partforge's own `hypot3` |
| `flat_map.h` | (no JS twin) the open-addressing hash map the ports use in place of `std::unordered_map` |
| `implicit_eval.{h,cpp}` | `src/framework/geometry/implicit/` `program.js` (runProgram/evalBatch), `primitives.js`, `frames.js` (xformPoint/xformDir), `expr-lower.js` (the UN/BIN/TER tables), `textures.js` (sampleTexture), `contact.js` (contactValue/bulgeOffset: the CONTACT and BULGE ops) — the implicit engine's field interpreter, and the session that holds a meshing run |
| `implicit_mesh.{h,cpp}` | `implicit/sparse.js` (evaluateLeaves), `mesher.js` (meshStore), `project.js` (projectVertices), `cleanup.js` (cleanupMesh) — sample, mesh and clean on the session |
| `implicit_detail.cpp` | `implicit/detail.js` (applySurfaceDetail, with the owner path's seamFade) — refine, project and displace for surface detail |
| `implicit_owner.cpp` | `implicit/mesher-owners.js` (meshStoreOwners), `crease.js` (cutCreases, untangle), `result.js` (triangleOwners) — the owner path of a root exact contact; its cleanup modes (owner guards in collapse, `project_owned`) are in `implicit_mesh.cpp` |
| `implicit_bracket.h` | `implicit/bracket.js` (solveBrackets) — the owner path's safeguarded Illinois edge solve, shared by the mesher and the crease cut |
| `implicit_math.h` | `js-math.js`'s `pfSin`/`pfCos`/`pfAtan2` and `implicit/noise.js` (latticeHash/valueNoise) |
| `implicit_probe.cpp` | (test only) `ip_math_probe`, which `test/implicit-native-math.test.js` calls to compare `implicit_math.h` with its JS, and `ip_bracket_probe`, which `test/implicit-bracket.test.js` calls to compare `solve_brackets` with `solveBrackets` |

## The contract: bit-identical, not close

Each port produces the same bits as its JS. `test/core-parity.test.js` builds
the reference parts (and inline forms reaching every fillet descriptor kind)
with the core off and on and requires byte-identical meshes and deep-equal
`measure()` output. Never loosen it to a tolerance: the core is a speed
switch, and everything downstream — change-tracker hashes, verify verdicts,
eval baselines, thumbnails — relies on it changing nothing else.

What keeping it exact takes, wherever you edit:

- **Arithmetic in double, storage in float32**, exactly where the JS does
  each (a JS `Float32Array` store rounds; JS arithmetic never does).
- **No `Math.hypot`** in a ported pass — engines disagree on it in the last
  bit (JavaScriptCore: libc++'s fused `std::hypot`; V8: Kahan-summed). The JS
  calls `hypot3` from `js-math.js`, the C++ calls `jsmath::hypot3`; both are
  `sqrt(x*x + y*y + z*z)`, rounded per operation.
- **`Math.max`/`Math.min` are `jsmath::jsmax`/`jsmin`**, never `std::fmax`/
  `fmin`: JS propagates NaN (and ranks +0 above -0); `fmax` drops NaN.
- **No libm transcendental**: the creased-normals pass gets its cosines
  computed once in JS and passed in, and the implicit engine's sin/cos/atan2/
  noise are partforge's own (`js-math.js`'s `pfSin` & co., fdlibm kernels
  built from + − × and floor only), ported to `implicit_math.h` — never
  `std::sin`, whose libm differs from every JS engine's.
- **No fused multiply-add**: the build passes `-ffp-contract=off` (clang on
  arm64 fuses `a*b + c` by default and the output drifts; measured, it buys no
  speed here — this code is bound by memory and branches).
- **SIMD only through per-lane exact ops**: the module is built twice from
  the same sources and flags, scalar and with `-msimd128`, and `core.js`
  boots the SIMD build when the engine validates a tiny v128 probe module
  (else the scalar one; `globalThis.PARTFORGE_CORE_SIMD = false` forces it).
  With `-msimd128` the compiler may vectorize ANY loop in any translation
  unit, so the rule is not "where SIMD is used" but "only ops that are exact
  per lane": `f64x2` add/sub/mul/div/sqrt round each lane exactly as the
  scalar op, and without `-ffast-math` nothing is reassociated. Never
  `-mrelaxed-simd` (its `madd` fuses) or `-ffast-math`. The parity suites
  (`test/core-parity.test.js`, `test/implicit-native-path.test.js`) run both
  builds.
- **The JS's order wherever it picks a winner**: Map insertion order, stable
  sorts (JS `TypedArray#sort` is stable — use `std::stable_sort`), first-wins
  ties, the same traversal stack order.

Changing a ported JS pass means changing its C++ in the same PR — the parity
test fails otherwise, which is the point.

## Data structures: free to differ, as long as no answer does

Only the ORDER of anything that decides a result has to be the JS's. How the
data is held is not, and the ports use that: flat hash maps (`flat_map.h`), a
vertex-major normals walk, edge pairing by sorted per-vertex buckets, a BVH
stored as one node struct per node with its triangles copied into leaf order,
fixed traversal stacks, a build that resets and sweeps only the bins a node
uses and takes each child's box from its parent's partition, and min-wall rays cast in
leaf order with the JS's first-wins tie-break kept explicitly. The top
comment of each `.cpp` says which of these it does and why each gives the
same bits.

Two rules come with that freedom:

- **Choose algorithms both sides can follow exactly.** The BVH build (bvh.js's
  binned surface-area heuristic) has no sort in it on purpose: a comparison
  sort's order under NaN keys is the sort algorithm's own, and no other sort
  reproduces V8's. A stable partition and fixed arithmetic leave nothing to the
  engine, NaN included.
- **Every new structure gets a test that fails when it is broken.**
  `test/core-structures.test.js` builds the meshes the reference parts never
  produce (three- and four-way edges, a large fan, centroid ties at -0/+0, NaN
  and infinite coordinates, piles of coincident triangles, a tree past the
  build's depth limit, a plate where every min-wall ray ties) and compares the
  BVH itself through `bvh_fingerprint`, not only its answers; each case was
  checked by deliberately breaking the structure it covers. The core's WASM
  stack is 64 KB, so recursion keeps per-level state small (the build's bin
  scratch lives on the builder, not the stack).

### The implicit engine: a session, and the orders it keeps

The implicit engine is not one call but a run of stages over shared state, so
its ABI is a **session**: `ip_session_create` returns an id (≥ 1; sessions
are independent and several may be live), `ip_tex_add` / `ip_prog_add` copy in
the part's textures and programs (their indices are the add order, which must
be the plan's), then `ip_sample` → `ip_mesh` → `ip_cleanup` → `ip_detail` each
read and write the session's leaf store and mesh in place, and only the final
mesh is copied out (`ip_positions`, `ip_indices`, `ip_normals`, …).
`ip_session_destroy` frees it. `src/framework/core/implicit-core.js`
(`NativeSession`, `meshImplicitCore`) is the one JS caller: it validates
inputs before any call, treats a refusal (a nonzero code) as "let the JS
answer", and poisons the instance only on a trap or failed allocation.

The orders that decide a result, and so must stay the JS's however the data is
held (each `.cpp`'s top comment has the full list):

- **Edge-key creation order in the mesher**: a crossing vertex is numbered when
  its edge is first met — leaves in store order, cells (l, j, i), the Kuhn tets
  in order, a triangle's corners left to right. The weld tables (a per-leaf
  local table, and a `flat_map.h` map for edges on leaf faces) are only found
  and inserted, so they decide nothing; the creation order decides everything.
- **Leaf-group order in projection**: the JS batches vertices by leaf, the core
  by program. That is free only because a vertex's move reads only itself and
  the interpreter is lane-local; anything that lets one vertex's move see
  another's would make the grouping an order that decides.
- **Collapse incidence order**: triangles in order, edges (c, c+1), and b's
  incident triangles walked in the order the JS pushed them (CSR filled in
  triangle, corner order); a collapse's kill/rename follows it, so it decides
  which triangles survive and how they are renumbered. The preview tier's
  decimation passes are the same walk again over each pass's compacted mesh.

The `contact` node's two ops keep `contact.js`'s order per lane (planning stays
in JS; a program carries its clearance `cl` baked in):

- **CONTACT** (`[14, dst, p, cl, fuse, nK, nA, kid × nK, (ia, ib, ax, ay, az,
  r0, band, k) × nA, nF, (ia, ib, cx, cy, cz, rho) × nF]`): the attachment
  weights in attachment order; then for each slot i in order, c_i = v_i maxed
  with every other slot j's `cut + w·(v_i − cut)` (`cut = (v_i − v_j + cl) ·
  0.5`; w is the pair's FIRST attachment's weight, either order, else the bare
  cut; a bare cut with `v_i + v_j > cl + 1e-9·(|v_i| + |v_j| + cl)` lies below
  v_i and is skipped, on both sides, changing no bit), and value = min over the c_i in slot order; then, if `fuse` is truthy
  (JS truthiness: not 0, −0 or NaN), the pad fill per region in region order,
  `min(value, f + (1 − g)·(cl + PAD_BLEND / 4))` with f = `unionN([c'_a, c'_b], 2, PAD_BLEND)` (PAD_BLEND
  = 1.5) maxed, in slot order, with `(min(v_a, v_b) − v_j + cl) · 0.5` for every slot j
  other than a and b where its gate weight g > 0 (no term
  where g is 0 or NaN), c'_a being c_a's max over every slot but b (and c'_b
  likewise), in slot order; then each attachment with `k·w > 0`,
  in order, `min(value, unionN([c_a, c_b], 2, k·w))`. Distances are
  `sqrt(dx·dx + dy·dy + dz·dz)`. The pair → first attachment lookup reads only
  the program, so the core tables it once per op; it decides nothing the JS's
  per-lane search does not. The decoder refuses a slot index (ia, ib) that does
  not name an operand.
  An EXACT node (the root contact under `exactContact`) has `fuse = 2`: after
  the fills come `child × nK` (each slot's original child index, below
  `MAX_OWNER_K` = 127, which the decoder checks) and `rank × nK` (each slot's
  tie rank), read only when `fuse == 2`, as program.js reads them. `fuse` is
  otherwise read by truthiness, as above. The value is the same op; what
  `fuse = 2` adds is the CAPTURE (`ip_eval_contact`, `NativeSession.evalContact`
  — program.js's `evalBatchContact`/`captureOwner`), per lane after its value,
  from the lane's own c_i and attachment weights: cuts and shares (each slot's
  c_i at its child's column; then each attachment with `w > 0` and `k·w > 0`, in
  order, lowers both of its children's shares to `unionN([c_a, c_b], 2, k·w)`
  when below), the piece (slots in order, each slot's least share over the
  attachments touching it; strictly less wins, a tie to a slot whose own c_i is
  its share, then the lesser rank, then the lesser child) and the owner (the
  first least c_i in slot order, merged to the lesser child of any attachment
  with `w > 0` holding it, until stable). `ip_sample` with `ownerK > 0` (an
  owner plan) captures the piece alongside each sample's value, the zero
  nudge's own for a nudged sample, and stores −1 (AIR) where the stored float32
  is ≥ 0 (`ip_leaf_owners`, int8 per sample) — sparse.js's leaf `owner`.
- **BULGE** (`[15, dst, src, p, nR, (cx, cy, cz, A, rho) × nR]`): `src −` the
  regions' `A·(1 − t²)²` (t = distance / rho, 0 for t ≥ 1) summed in order from
  +0.

Likewise detail's midpoints are numbered in creation order (triangles in
order, edges v0v1, v1v2, v2v0); its midpoint map is per-vertex chains, only
found and inserted.

**The owner path** (a root exact contact; `meshImplicitCore` runs it whenever
`compiled.ownerRoot ≥ 0`): `ip_set_contact` hands in the contact's attachment
table, exact clearance and gap with `contact.js`'s CREASE_SNAP, CREASE_TOL and
DETAIL_SEAM_FADE (one home for the constants), then `ip_mesh_owners` →
`ip_cleanup` → `ip_crease` → `ip_untangle` → `ip_detail`, and `ip_tri_owners`.
An owner mesh carries `vertOwner`, `ownerHeld`, `pinned` and (once cut)
`crease` per vertex through every stage (`ip_vert_owner`, …); a plain mesh
clears them, and the existing stages switch to their owner modes on an owner
mesh. Evaluations of mesh or grid points with a leaf's program go through
`eval_points` (bucketed by program, which decides nothing since the
interpreter is lane-local); the exceptions are `project_owned`, which calls
`ipe::eval` / `eval_contact` directly (a vertex's share and cuts, point by
point). The orders that decide a result:

- **The mesher**: owner-owner edge records numbered when first met (leaves,
  cells, Kuhn tets, corner pairs a < b); emission is meshStore's order with
  each refined tet's split edges taken in ascending key order and its
  sub-tets in (s1, s2) order; a crossing toward an air node is numbered when
  its unordered node pair is first met.
- **The crease cut**: the crossing edges in triangle, corner order (first
  seen wins), snaps and then splits in that order.
- **untangle**: JS Sets keep insertion order and here it decides results — a
  ring's centroid is summed in ring order, a fan's order is the order a
  collapse rewrites and relinks its triangles, and the round's `touched` set
  orders the next flipped list (which orders the swaps). So fans are vectors
  with Set semantics (append when absent, erase in place), rings are read off
  them in order, and `touched` is an insertion-ordered list. The edge →
  triangle lists are only counted or read at length two, so only their
  contents must be the JS's.

A vertex owner that is not a child index below ownerK (the JS would index
its shares past the point's own) makes `ip_mesh_owners` refuse, and the JS
answers.

Measure a change with `npm run bench:core` (`BENCH_BASELINE=<an older
core-wasm.js>` runs both builds side by side, alternating, so machine load
hits both alike — absolute timings on a shared machine are not comparable
run to run). It also checks every result against the JS. The implicit engine
has its own: `npm run bench:implicit -- --core both` (JS and native per
stage, CPU time), with CI's gates in `test/implicit-speed.test.js`.

## Building

```bash
node scripts/build-core-wasm.mjs          # needs Emscripten's em++ (brew install emscripten)
node scripts/build-core-wasm.mjs --check  # no compiler: is core-wasm.js current?
```

The output, `src/framework/core/core-wasm.js`, is committed: both builds of
the WebAssembly (scalar and SIMD) base64-encoded in a plain ES module, plus a
hash of these sources and the build flags. `test/core-wasm.test.js` recomputes that hash, so a C++ edit
without a rebuild fails CI even though CI has no compiler. A JS module rather
than a `.wasm` file because partforge ships as source into a browser worker,
Node (the CLI, tests, a host's server), and `blob:` hosts — an import works in
all of them with no loader or asset-URL rewriting, and instantiates
synchronously.
