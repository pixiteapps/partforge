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
| `implicit_eval.{h,cpp}` | `src/framework/geometry/implicit/` `program.js` (runProgram/evalBatch), `primitives.js`, `frames.js` (xformPoint/xformDir), `expr-lower.js` (the UN/BIN/TER tables), `textures.js` (sampleTexture) — the implicit engine's field interpreter, and the session that holds a meshing run |
| `implicit_mesh.{h,cpp}` | `implicit/sparse.js` (evaluateLeaves), `mesher.js` (meshStore), `project.js` (projectVertices), `cleanup.js` (cleanupMesh) — sample, mesh and clean on the session |
| `implicit_detail.cpp` | `implicit/detail.js` (applySurfaceDetail) — refine, project and displace for surface detail |
| `implicit_math.h` | `js-math.js`'s `pfSin`/`pfCos`/`pfAtan2` and `implicit/noise.js` (latticeHash/valueNoise) |
| `implicit_probe.cpp` | (test only) `ip_math_probe`, which `test/implicit-native-math.test.js` calls to compare `implicit_math.h` with its JS |

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
- **SIMD only where it rounds per lane**: the build passes `-msimd128`, so
  independent lane loops (the implicit interpreter's) run two lanes per
  `f64x2` op. Its add/sub/mul/div/sqrt round each lane exactly as the scalar
  op, and without `-ffast-math` the compiler reassociates nothing, so the bits
  do not change. Never `-mrelaxed-simd` (its `madd` fuses) or `-ffast-math`.
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
  which triangles survive and how they are renumbered.

Likewise detail's midpoints are numbered in creation order (triangles in
order, edges v0v1, v1v2, v2v0); its midpoint map is per-vertex chains, only
found and inserted.

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

The output, `src/framework/core/core-wasm.js`, is committed: the WebAssembly
base64-encoded in a plain ES module, plus a hash of these sources and the
build flags. `test/core-wasm.test.js` recomputes that hash, so a C++ edit
without a rebuild fails CI even though CI has no compiler. A JS module rather
than a `.wasm` file because partforge ships as source into a browser worker,
Node (the CLI, tests, a host's server), and `blob:` hosts — an import works in
all of them with no loader or asset-URL rewriting, and instantiates
synchronously.
