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
- **No other transcendental computed here**: cosines etc. are computed once in
  JS and passed in, so a second libm never decides anything.
- **No fused multiply-add**: the build passes `-ffp-contract=off` (clang on
  arm64 fuses `a*b + c` by default and the output drifts; measured, it buys no
  speed here — this code is bound by memory and branches).
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
fixed traversal stacks, a build sort that skips already-sorted ranges and
radix-sorts large ones, and min-wall rays cast in leaf order with the JS's
first-wins tie-break kept explicitly. The top comment of each `.cpp` says
which of these it does and why each gives the same bits.

Two rules come with that freedom:

- **A structure the JS order cannot be derived from is refused, not
  approximated.** The JS BVH sorts with the engine's own comparison sort,
  which reads a NaN comparison as "equal" — an order no other sort
  reproduces — so the core BVH declines a mesh with a NaN triangle centroid
  and the oracle uses the JS index for it (counted in `coreStatus()`'s
  `refusedMeshes`, like a refused creasedNormals mesh).
- **Every new structure gets a test that fails when it is broken.**
  `test/core-structures.test.js` builds the meshes the reference parts never
  produce (three- and four-way edges, a large fan, centroid ties at -0/+0, NaN
  vertices, a plate where every min-wall ray ties); each of its cases was
  checked by deliberately breaking the structure it covers.

Measure a change with `npm run bench:core` (`BENCH_BASELINE=<an older
core-wasm.js>` runs both builds side by side, alternating, so machine load
hits both alike — absolute timings on a shared machine are not comparable
run to run). It also checks every result against the JS.

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
