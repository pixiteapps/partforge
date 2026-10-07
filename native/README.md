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
