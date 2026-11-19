# k.implicit PR 2 — the native (C++) engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the implicit engine's hot path — program evaluation, sampling, meshing, projection, cleanup and surface detail — in the native core (C++ → WebAssembly), bit-identical to the PR 1 JavaScript, which stays as the fallback.

**Architecture:** JavaScript keeps compiling: validation, IR lowering, interval culling and program emission (measured at ~70 ms of the hand's ~1.3 s). It hands the native side a *session*: textures, the emitted programs (the `Float64Array` format from `program.js`), the leaf list (block coordinates + program id), grid parameters, cleanup constants and flattened detail entries. The session runs sample → mesh → cleanup → detail in C++ and returns positions, indices, normals. Every stage is also exposed separately so each is held byte-identical to its JS twin by its own parity test. `core-parity.test.js` gains the implicit parts, so turning the core on or off changes no byte.

**Tech Stack:** C++17 compiled with Emscripten (`em++`, on PATH at /opt/homebrew/bin) via `scripts/build-core-wasm.mjs` into the committed `src/framework/core/core-wasm.js`; vitest; Node 24.

**Spec:** `docs/superpowers/specs/2026-10-14-implicit-organic-parts-design.md` — PR 2 = §9 item 2 ("C++ port and parity"); performance targets §3. Native rules: `native/README.md` (read it fully before any C++ task). PR 1 plan (the JS being ported): `docs/superpowers/plans/2026-10-14-implicit-pr1-js-engine.md`. PR 1's review triage (the "Must land in PR 2" list) is folded into Tasks 1–2 below.

## Global Constraints

- **Node 24:** prefix every command with `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"` (`source nvm.sh` is blocked).
- **Branching:** Task 1 commits on `feat/implicit-1-js-engine` (PR #278) and pushes it. Every later task commits on `feat/implicit-2-native`, branched from `feat/implicit-1-js-engine` after Task 1. PR 2 targets `feat/implicit-1-js-engine` until PR 1 merges, then is retargeted to `feat/implicit`. **No `package.json` version bump.** Commits end with the model's own `Co-Authored-By` trailer.
- **Bit-identical, not close (native/README.md "The contract"):** arithmetic in double, storage in float32 exactly where the JS uses a `Float32Array`; `jsmath::hypot3`/`jsmin`/`jsmax` for `hypot3`/`Math.min`/`Math.max`; no `std::sin`/`cos`/`atan2`/`exp`/`pow` — the ported `pfSin`/`pfCos`/`pfAtan2`; `-ffp-contract=off` (already in FLAGS); the JS's iteration order wherever it decides a result (vertex creation order, Map insertion order, first-wins ties). Never loosen a parity test to a tolerance.
- **Every C++ change rebuilds** `src/framework/core/core-wasm.js` with `node scripts/build-core-wasm.mjs` in the same commit (`test/core-wasm.test.js` fails on stale wasm). New exports are added to `EXPORTS` in that script.
- **Editing a ported JS pass means editing its C++ in the same commit** (README rule). From Task 3 on, the JS engine files are frozen except for the seams Task 2 creates.
- **Failure is contained:** a trap or failed allocation poisons the core instance (`poisonCore`), and the JS path answers instead — never a crash (`core.js` conventions; pattern in `src/framework/core/creased-normals-core.js`). WebAssembly stack is 64 KB: no deep recursion in C++.
- **Engine purity:** no DOM/three/`node:` in src/framework; the core wrapper lives in `src/framework/core/implicit-core.js`.

## Review Focus

1. **A part whose implicit sub-part uses a texture** (expr `texture()` or texture detail): the textures must reach the native session in the same float32 values the JS uses (`makeTexture` rounds `v/65535` in double, then stores float32). Test in Task 4 (texture program parity) and Task 9 (vase parity).
2. **A mesh big enough to grow WebAssembly memory past `RECYCLE_BYTES`** (hand at the 0.5 mm print grid, ~1.4 M triangles): results stay identical, memory views are re-read after every call that can grow memory, and the instance recycles when idle. Test in Task 9.
3. **The core faulting mid-build** (simulated trap/out-of-memory): `k.implicit` still returns the JS result, `coreStatus()` reports the fallback once. Test in Task 9 (pattern from `test/core-guards.test.js`).
4. **Core off** (`setCoreEnabled(false)` / `globalThis.PARTFORGE_CORE = false`): the JS path runs and produces identical bytes. Test in Task 9 (parity runs both ways).
5. **An empty or clipped shape on the native path**: the same warnings and the same "implicit: the shape is empty" error as the JS path. Test in Task 9.

---

## Native file structure

| File | Responsibility | JS twin |
|---|---|---|
| `native/implicit_math.h` | `pf_sin`, `pf_cos`, `pf_atan2`, `lattice_hash`, `value_noise`, `to_int32` | `geometry/js-math.js` (pf*), `implicit/noise.js` |
| `native/implicit_eval.h` / `.cpp` | primitives, `union_n`/`intersect_n`, warps, mirror, xform, `sanitize`, `clamp_unit`, UN/BIN/TER tables, `sample_texture`, the program interpreter | `implicit/primitives.js`, `implicit/expr-lower.js` (tables), `implicit/textures.js` (sampling), `implicit/program.js` (`runProgram`) |
| `native/implicit_mesh.h` / `.cpp` | the session: leaf sampling (incl. the zero nudge), marching tetrahedra, vertex projection, cleanup | `implicit/sparse.js` (evaluation half), `implicit/mesher.js`, `implicit/project.js`, `implicit/cleanup.js` |
| `native/implicit_detail.cpp` | detail heights, red-green refinement, displacement | `implicit/detail.js` |
| `src/framework/core/implicit-core.js` | JS wrapper: session lifecycle, copy in/out, poisoning | — |

`native/flat_map.h` (existing) is the hash map for edge keys and midpoint keys.

---

### Task 0: Branch (controller)

Controller-only, no code: after Task 1 is pushed, `git switch -c feat/implicit-2-native` from `feat/implicit-1-js-engine` and commit this plan there.

---

### Task 1: PR 1 fix — intersect growth bound under rotation (on `feat/implicit-1-js-engine`)

**Files:** Modify `src/framework/geometry/implicit/ir.js` (intersect/subtract `G`); Test `test/implicit-ir.test.js` (or the existing bounds regression file from PR 1's final fix — `grep -rn "derived bounds" test/` to find it).

The final review found `G = minG(children)` for `intersect` holds only per axis; under a rotation above it (twist, polar repeat, rotated frame) the box padding can fall short by up to √3, clipping the shape flat.

- [ ] **Step 1: Failing test** — at edge 0.5, with `I = { kind: "intersect", children: [{ kind: "box", size: [10, 10, 40], at: [-2.5, -2.5, 0] }, { kind: "box", size: [10, 10, 40], at: [2.5, 2.5, 0] }] }`, each of these meshes with `clipped === false` (use `sampleField(compileImplicit(spec), 0.5).clipped`):
  - `{ root: { kind: "round", r: 4, child: { kind: "twist", degPerMm: 2.25, child: I } } }`
  - `{ root: { kind: "round", r: 4, child: { kind: "repeat", polar: { count: 8 }, child: I } } }`
  - `{ frames: { f: { rotate: { axis: "z", deg: 45 } } }, root: { kind: "round", r: 4, child: { ...I, frame: "f" } } }`
  Run it; expect the three to report `clipped: true` (RED).
- [ ] **Step 2: Fix** — in `ir.js`, set the intersect (and subtract, which lowers through the same box rule) node's `G` to `minG(ids) / Math.sqrt(3)`, with a comment: the child bounds are per-axis (L∞), and a rotation above the node can turn the box so the straight-line growth is up to √3 slower.
- [ ] **Step 3:** run `npx vitest run test/implicit-` — all pass (including the three new cases).
- [ ] **Step 4:** commit `fix(implicit): intersect growth bound holds under rotation (√3)`; then `git push` (PR #278 updates).

---

### Task 2: JS prep — behaviour fixes the port must mirror, and the seams it plugs into

**Files:** Modify `implicit/sparse.js`, `implicit/program.js`, `implicit/cleanup.js`, `implicit/detail.js`, `implicit/mesher.js`, `scripts/bench-implicit.mjs`; Test `test/implicit-program.test.js`, `test/implicit-sparse.test.js`, `test/implicit-detail.test.js`, `test/implicit-cleanup.test.js`.

**Interfaces produced (later tasks rely on these names):**
- `sparse.js`: split `sampleField` into `planLeaves(compiled, edge, { cull }) → Plan` and `evaluateLeaves(plan) → Store`, with `sampleField(compiled, edge, opts) = evaluateLeaves(planLeaves(...))` unchanged in output. `Plan = { origin, edge, n, snap, leaves: [{ i0, j0, l0, progIndex }], programs: Float64Array[] (index order = first emission), textures, samples, clipped: false }`. `evaluateLeaves` fills each leaf's `vals` and `prog`, sets `clipped`, and keeps every existing Store field.
- `program.js`: `FN_CODES = { UN: [...], BIN: [...], TER: [...] }` exported and pinned (the native tables index these arrays).
- `detail.js`: `flattenDetail(compiled) → { entries: Float64Array, programs: Float64Array[] }` — the per-entry layout below — and `detailHeight` reads entries through the same values (so JS and C++ consume identical numbers).

- [ ] **Step 1: Pin fn codes.** Add to `test/implicit-program.test.js` a snapshot of `UN_NAMES`, `BIN_NAMES`, `TER_NAMES` (literal arrays). Export them as `FN_CODES`. Make `emitProgram` throw `Error("implicit: unknown expr function <name>")` when `indexOf` returns −1. Add `if (n > BATCH) throw new Error(...)` to `runProgram`. Hoist the per-call `gather` buffer to module scope (sized `max(64, cnt)` lazily).
- [ ] **Step 2: Float32 zero test.** In `evaluateLeaves`, the exact-zero test becomes `Math.fround(v) === 0` (the stored value), both for the nudge decision and the `±1e-30` fallback. Test: a sample whose double value is `1e-46` (below float32 subnormal range) is treated as zero (construct with an `expr` that returns `1e-46` on a grid point).
- [ ] **Step 3: Zero-normal robustness** (both change results, so they land before the port):
  - `cleanup.js relax`: a vertex whose normal is `(0,0,0)` does not move.
  - `detail.js`: a new midpoint whose projection left a zero normal takes the normalized average of its two endpoints' normals (zero if that is zero too); such a vertex is not displaced.
  - Tests: inject a zero normal (call `relax` through `cleanupMesh` on a tiny hand-built mesh with a store whose program has zero gradient — e.g. an `expr` returning a constant inside a region — or unit-test the exported helpers; export `relax` and the midpoint-normal helper for testing if needed).
- [ ] **Step 4: Detail flattening.** Implement `flattenDetail` with this layout per entry (28 doubles):
  `[kind(1 creases, 2 noise, 3 texture, 4 expr), hasInv, inv[12], radius (−1 = none), hasSide, side[3], amplitude, wavelength (−1 = none), axis, slot (−1), projection (0 planar, 1 cylindrical, 2 triplanar), size0, size1, target, progIndex (−1)]`.
  For `expr` entries, emit the lowered height expression as a program with `emitExpr`-style emission into a standalone program `[nP, nV, …, OP.END, result]` with **no** `SANITIZE` (the JS keeps `v === v ? v : 0` after running it). Make `detailHeight` read the flattened entry and evaluate expr heights by running that program on a 1-lane batch (`runProgram`), so the JS uses exactly what C++ will get. All detail tests pass unchanged.
- [ ] **Step 5: Mesher hygiene** — remove the dead degenerate-triangle guard in `mesher.js` `tri()`; hoist the per-cell `cornerPos`/`mid` closures to plain locals (no behaviour change; sparse==dense and all mesher tests stay byte-identical).
- [ ] **Step 6: Bench** — `scripts/bench-implicit.mjs`: rename the end-to-end line "after warm-up" (it is warm), and add a true cold line run first in a fresh child process (`node -e` that imports and times one `k.implicit(handSpec())`). Add a `--core on|off|both` flag (default `both`) that runs the table with `setCoreEnabled(false)` and, once Task 9 lands, `true`; until then `on` prints "core path not wired".
- [ ] **Step 7:** run `npx vitest run test/implicit-` and the full suite once; commit `refactor(implicit): seams and behaviour fixes for the native port`.

---

### Task 3: Native math

**Files:** Create `native/implicit_math.h`; Modify `scripts/build-core-wasm.mjs` (EXPORTS: `ip_math_probe`); Create `native/implicit_probe.cpp` (test-only exports); Test `test/implicit-native-math.test.js`.

**Interfaces produced:** `namespace ipm { double pf_sin(double), pf_cos(double), pf_atan2(double, double); double lattice_hash(double i, double j, double l); double value_noise(double x, double y, double z); int32_t to_int32(double); }` and the export `double ip_math_probe(int fn, double a, double b, double c)` (fn 0 sin, 1 cos, 2 atan2(a,b), 3 hash(a,b,c), 4 noise(a,b,c)).

- [ ] **Step 1: Failing test** — for 20,000 inputs per function (seeded: grid over [−1000, 1000] plus specials ±0, ±Infinity, NaN, 1e-300, huge integers like 2^31+5, −2^40), `core().x.ip_math_probe(fn, …)` returns the **same bits** as the JS (`pfSin`, `pfCos`, `pfAtan2`, `latticeHash`, `valueNoise`): compare with `Object.is` (distinguishes −0) and NaN-equality.
- [ ] **Step 2: Implement** — port line by line:
  - `pf_sin`/`pf_cos`: same constants, same `Math.floor(x*INVPIO2 + 0.5)`, same Cody–Waite two-step reduction, same `kSin`/`kCos` polynomials in the same operation order; `quadrant(n) = ((fmod(n, 4) + 4) mod 4)` must equal JS `((n % 4) + 4) % 4` for every double `n` (JS `%` is `fmod`).
  - `pf_atan` (fdlibm s_atan, the JS branch thresholds and arrays) and `pf_atan2` (the JS's zero/NaN rules, `PI - (a - PI_LO)`).
  - `to_int32(double)`: ECMAScript ToInt32 — NaN/±∞ → 0; truncate toward zero; wrap modulo 2^32 to signed (use `fmod(trunc(x), 4294967296.0)`, adjust to [−2^31, 2^31)).
  - `lattice_hash`: `uint32_t` arithmetic reproducing `Math.imul` (multiply as uint32, wrap), `^`, `>>>`; inputs via `to_int32`; the PR 1 chained form `fin((imul(fin((imul(i,A)+j)|0),B)+l)|0)`; result `(h >>> 0) / 4294967296.0`. Note `(x + j) | 0` is int32 wraparound of a double sum — compute the sum in double, then `to_int32`.
  - `value_noise`: the same loop order and arithmetic as `noise.js`.
- [ ] **Step 3:** `node scripts/build-core-wasm.mjs`; run the test GREEN; `npx vitest run test/core-wasm.test.js test/core-parity.test.js` still pass.
- [ ] **Step 4:** commit `feat(core): native implicit math (trig, noise) bit-identical to JS`.

---

### Task 4: Native evaluator — primitives, tables, textures, the program interpreter

**Files:** Create `native/implicit_eval.h`, `native/implicit_eval.cpp`; Create `src/framework/core/implicit-core.js` (session wrapper, first part); Modify `scripts/build-core-wasm.mjs`; Test `test/implicit-native-eval.test.js`.

**Interfaces produced:**
- C ABI (all pointers are wasm offsets; counts are int32):
  - `int ip_session_create()` → session id (≥ 1) or 0; `void ip_session_destroy(int s)`.
  - `int ip_tex_add(int s, int width, int height, const float* data)` → slot index (slots numbered in add order, matching `compiled.textures`).
  - `int ip_prog_add(int s, const double* prog, int len)` → program index (add order).
  - `int ip_eval(int s, int prog, const double* X, const double* Y, const double* Z, int n, double* out)` → 0 ok, nonzero on a malformed program (any length; batches internally in chunks of 256 exactly like `evalBatch`).
- JS (`implicit-core.js`): `class NativeSession { constructor(c) ; addTexture(t) ; addProgram(prog) → index ; eval(progIndex, X, Y, Z) → Float64Array ; destroy() }`, built on `core()`'s `alloc`/`copyIn`/`copyOut`; every call re-reads memory views after the call; a thrown trap calls `poisonCore(c, err)` and rethrows a sentinel the caller catches to fall back.

- [ ] **Step 1: Failing test** — for every tree in `test/fixtures/implicit-small-trees.js`, plus the vase (`vaseSpec()`, with its texture) and every `ADVERSARIAL` spec: compile, take `fullDecision` and 40 random `blockDecision`s, `emitProgram` each, and evaluate 2,000 seeded random points per program with `evalBatch` (JS) and `NativeSession.eval`. Byte-compare the `Float64Array` outputs (`Buffer.compare` of the underlying bytes). Include the NaN/∞ expr union case from PR 1's program test.
- [ ] **Step 2: Implement** — port line by line, keeping JS operation order:
  - `eval_prim` (every PRIM code, the scaled-sphere ellipsoid, round cone with `sgn`), `union_n`, `intersect_n` (first arg-min/arg-max wins; skip `i == am`; `g > 0`), `warp_point` (twist/bend/taper with `ipm::pf_*`), `mirror_point`, `xform_point`/`xform_dir`, `sanitize` (NaN → BIG; clamp ±BIG), `clamp_unit` (NaN → 0).
  - UN/BIN/TER tables indexed by `FN_CODES` order (Task 2 snapshot): `neg abs floor fract sqrt sin cos not` / `add sub mul div min max mod step lt gt le ge eq ne and or` / `clamp mix smoothstep smin smax select` — verify against the snapshot, not this list. `Math.min/max` → `jsmath::jsmin/jsmax`; `Math.abs` → `std::fabs`; `Math.floor` → `std::floor`; `Math.sqrt` → `std::sqrt`; JS `===` on doubles → `==`; `mod` is `a - b*floor(a/b)`.
  - `sample_texture` exactly as `textures.js` (float32 texel reads, double arithmetic, the NaN-to-0 clamp form).
  - The interpreter: registers as `std::vector<double>` blocks of 256 lanes; opcode dispatch identical to `runProgram`, including the `vs`-gather for UNION/INTER into a per-session scratch buffer (no per-call allocation in the hot loop).
- [ ] **Step 3:** rebuild wasm; GREEN; `npx vitest run test/core-` passes.
- [ ] **Step 4:** commit `feat(core): native implicit program interpreter, bit-identical to program.js`.

---

### Task 5: Native leaf sampling

**Files:** Create `native/implicit_mesh.h`, `native/implicit_mesh.cpp` (sampling part); Modify `implicit-core.js`, `scripts/build-core-wasm.mjs`; Test `test/implicit-native-sample.test.js`.

**Interfaces produced:**
- `int ip_sample(int s, const int32_t* leaves /* i0,j0,l0,prog × count */, int count, const double* origin3, double edge, const int32_t* n3)` → 0 ok; fills the session's leaf value store (float32, `(LEAF+1)³` per leaf, same layout as JS `vals`) and its `clipped` flag.
- `const float* ip_leaf_vals(int s)` / `int ip_clipped(int s)`.
- JS: `NativeSession.sample(plan) → { vals: Float32Array[] per leaf, clipped }`.

- [ ] **Step 1: Failing test** — for every small tree, the vase, the hand (`handSpec()` at 1.5 and 0.8), every `ADVERSARIAL` spec and the touching-faces cases from PR 1's final fix (mirror-half box, coincident faces, repeat of touching boxes, flush subtracts) at edges 0.5 and 1.0: `planLeaves` once, then `evaluateLeaves(plan)` (JS) vs `NativeSession.sample(plan)`: every leaf's `vals` byte-identical, and `clipped` equal.
- [ ] **Step 2: Implement** — port `evaluateLeaves`: coordinates `origin[a] + (i0 + i) * edge` (same integer sum before the multiply), the sample order `(l, j, i)` with `i` fastest, the outer-layer rule (`gi == 0 || … || gi >= n-1` → `if (v <= 0) clipped; if (v < 0.5*edge) v = 0.5*edge`), the float32 store, the exact-zero nudge (collect zero samples in sample order, re-evaluate them in one batch at `p + 1e-6*edge*(1, 0.7071067811865476, 0.5773502691896258)` with the leaf's own program, still-zero → `±1e-30` keeping sign) — mirror the JS exactly as it is after Task 2.
- [ ] **Step 3:** rebuild; GREEN; commit `feat(core): native leaf sampling, bit-identical to evaluateLeaves`.

---

### Task 6: Native marching tetrahedra

**Files:** Modify `native/implicit_mesh.{h,cpp}`, `implicit-core.js`, `scripts/build-core-wasm.mjs`; Test `test/implicit-native-mesh.test.js`.

**Interfaces produced:** `int ip_mesh(int s)` → 0 ok; builds the session's mesh from its leaf store: `ip_vertex_count`, `ip_positions` (double ×3), `ip_index_count`, `ip_indices` (uint32), `ip_vert_leaf` (int32). JS: `NativeSession.mesh() → { positions: Float64Array, indices: Uint32Array, vertLeaf: Int32Array }`.

- [ ] **Step 1: Failing test** — same case list as Task 5: `meshStore(evaluateLeaves(plan))` vs native sample+mesh: positions, indices and vertLeaf byte-identical.
- [ ] **Step 2: Implement** — port `mesher.js` as it is after Task 2: leaf order, cell order, KUHN tet order, `vertexOn` edge key `gIndex(low)·8 + dir` in a `FlatMap<uint64,uint32>` (creation order = vertex index), low→high interpolation `t = a/(a−b)`, and the topological orientation rule (edge midpoints vs inside→outside centroid) with the same arithmetic. `gIndex` in 64-bit integer arithmetic (it exceeds 2^31 on large grids); the JS computes it in doubles — exact below 2^53, so integers match.
- [ ] **Step 3:** rebuild; GREEN; commit `feat(core): native marching tetrahedra, bit-identical to meshStore`.

---

### Task 7: Native projection and cleanup

**Files:** Modify `native/implicit_mesh.{h,cpp}`, `implicit-core.js`, `scripts/build-core-wasm.mjs`; Test `test/implicit-native-cleanup.test.js`.

**Interfaces produced:** `int ip_cleanup(int s, double collapseFrac, int relaxPasses, double relaxWeight, double maxMoveCells)` → 0 ok; replaces the session mesh with the cleaned one and fills `ip_normals` (double ×3). Also `int ip_project(int s, const int32_t* which, int whichCount, double maxStep, int wantNormals)` for the detail stage and for a projection-only parity test. JS: `NativeSession.cleanup(CLEANUP)`, `NativeSession.normals()`.

- [ ] **Step 1: Failing test** — same case list: `cleanupMesh(store, meshStore(store))` vs native sample+mesh+cleanup: positions, indices, vertLeaf, normals byte-identical. Plus a projection-only case: `projectVertices` on the raw mesh with a `which` subset and normals, vs `ip_project`.
- [ ] **Step 2: Implement** — port `project.js` (group vertices by leaf **in first-appearance order** — the JS `Map` insertion order — and within a group in vertex order; 7-point stencil in the JS order; `e = 0.1*edge`; the clamp and the gradient-threshold early return) and `cleanup.js` as it is after Task 2 (`collapse`: per-vertex incident triangle lists in triangle order, the `ring` common-neighbour count, the no-flip test with the same save/restore arithmetic, `locked`, the break-after-collapse, first-use compaction; `relax`: the edge-accumulation order `a+=P[b]`, `b+=P[a]` per triangle edge, the zero-normal skip; projection passes in the JS order). Use flat arrays (CSR for incident triangles is fine — README "Data structures: free to differ, as long as no answer does").
- [ ] **Step 3:** rebuild; GREEN; add the collapse's incident-list structure to `test/core-structures.test.js` with one case it would get wrong if broken (e.g. a fan where a vertex's incidence order decides which collapse happens first — check by temporarily breaking it); commit `feat(core): native projection and mesh cleanup, bit-identical`.

---

### Task 8: Native surface detail

**Files:** Create `native/implicit_detail.cpp`; Modify `implicit-core.js`, `scripts/build-core-wasm.mjs`; Test `test/implicit-native-detail.test.js`.

**Interfaces produced:** `int ip_detail(int s, const double* entries, int entryCount, const int32_t* progIndex /* already added via ip_prog_add */, double edge)` → 0 ok; refines + displaces the session mesh (positions, indices, vertLeaf, normals updated). JS: `NativeSession.detail(flattenDetail(compiled))` (adds the detail programs first).

- [ ] **Step 1: Failing test** — the hand with creases (and the hand with `pores`-style noise detail added: `{ kind: "noise", amplitude: 0.08, wavelength: 1.1 }`), the vase (cylindrical texture detail), the PR 1 detail test specs (box with creases; texture emboss; an `expr` detail with a texture): JS `applySurfaceDetail` vs native — all four arrays byte-identical.
- [ ] **Step 2: Implement** — port `detail.js` as it is after Task 2: `weight` (side ramp, compact radius falloff), `planar`/cylindrical/triplanar texture reads with `ipm::pf_atan2` and the `TWO_PI` constant `2*Math.PI` (pass it in as data or reproduce the exact double), creases with `ipm::pf_cos`, noise with `ipm::value_noise`, expr heights by running the detail program on one lane, the per-round target computation, the `midpoint` key `a<b ? a*nv+b : b*nv+a` (64-bit), `splitTri` with all four cases and the canonical rotations, projection of added vertices via the Task 7 projector with `maxStep = edge`, the Task 2 zero-normal fallback, and the final displacement loop.
- [ ] **Step 3:** rebuild; GREEN; commit `feat(core): native surface detail, bit-identical to applySurfaceDetail`.

---

### Task 9: Wire the native path into `meshImplicit`

**Files:** Modify `src/framework/geometry/implicit/index.js`, `src/framework/core/implicit-core.js`; Modify `test/core-parity.test.js`, `test/core-guards.test.js`; Test `test/implicit-native-path.test.js`.

**Interfaces produced:** `meshImplicitCore(compiled, edge, plan) → same object as meshImplicit` or `null` (fall back). `meshImplicit` = `planLeaves` → try `meshImplicitCore` when `core()` is non-null and every array is acceptable → else the JS stages. Warnings are computed identically either way (`thin`, `clipped`, `hasExpr`).

- [ ] **Step 1: Failing tests:**
  - `test/core-parity.test.js`: add implicit cases built through `k.implicit` (Manifold kernel, core off vs on): the hand (preview tier, with nails via `nailSpecs`), the vase (register its image on the kernel first), the bendCut and formula small trees, and the touching-faces cases. Meshes byte-identical, `measure()` deep-equal — the existing harness.
  - `test/implicit-native-path.test.js`: (a) Review Focus 2 — the hand at print tier 0.5 mm builds identically core on/off and `core().x.memory.buffer.byteLength` growth is followed by recycle when idle (`releaseIfIdle`); (b) Review Focus 3 — with a stand-in core whose `ip_mesh` throws (use `setCoreForTesting` as `test/core-guards.test.js` does), `k.implicit` returns the JS result and `coreStatus()` records one fallback; (c) Review Focus 4 — `globalThis.PARTFORGE_CORE = false` runs the JS path, identical bytes; (d) Review Focus 5 — empty shape and clipped shape give the same error/warnings on both paths.
- [ ] **Step 2: Implement** the dispatch and the full session run in `implicit-core.js` (create session → add textures → add programs → `ip_sample` → `ip_mesh` → `ip_cleanup` → `ip_detail` if any → copy out → destroy; `try/finally` destroy; poison on trap; recycle via `releaseIfIdle`).
- [ ] **Step 3:** GREEN; full suite once; commit `feat(implicit): run the engine on the native core when available`.

---

### Task 10: Benchmarks, CI speed gates, docs

**Files:** Modify `scripts/bench-implicit.mjs`, `docs/research/organic-shapes.md` (§9), `native/README.md` (file table rows + the implicit data-structure notes), `AGENTS.md` (the native-core bullet: what it now runs); Create `test/implicit-speed.test.js`.

- [ ] **Step 1:** `npm run bench:implicit -- --core both` → record the table (JS vs native per stage, hand preview/print, vase) in §9 with the spec's targets beside them (hand full detail preview ≤ 150 ms Node; print 0.5 mm ≤ 2 s).
- [ ] **Step 2: CI gates** — `test/implicit-speed.test.js` using `test/helpers/cpu-pace.js`'s `cpuMs` (paced CPU time, as the sheet checks do): hand full detail preview on the native path under 3× the spec target (450 ms paced), print 0.5 mm under 3× (6 s paced). If the native path misses the spec targets themselves on this machine, do not loosen the gates beyond 3× — record the measured numbers and report DONE_WITH_CONCERNS with a profile (`node --cpu-prof`) of where the time goes.
- [ ] **Step 3: Docs** — native/README file table gains the three implicit files with their JS twins; one paragraph on the session ABI and the order-sensitive structures (edge-key map creation order, leaf-group order in projection, collapse incidence order); AGENTS.md's native-core bullet adds "the implicit engine's sample/mesh/cleanup/detail path".
- [ ] **Step 4:** full suite; commit `docs(implicit): native engine numbers, speed gates, native README`.

---

## Self-review notes

- Spec §3 "Single-threaded", §8 "Native parity" rows, §9 PR 2 scope: Tasks 3–9. Performance targets: Task 10. Review Focus 1–5: Tasks 4, 9.
- PR 1 triage "Must land in PR 2": fn-code pin, unknown fn throw, gather hoist, n ≤ BATCH guard (Task 2 Step 1); `Math.fround` zero (Step 2); zero-normal fixes (Step 3); mesher dead guard + allocations (Step 5); bench cold line (Step 6); makeTexture float32 note (Review Focus 1, Task 4); sin/cos/atan2 edge cases (Task 3's special inputs). The weak flip criterion stays as is (behaviour change without evidence of a fold; the port mirrors it).
- Region reuse (block sample cache) is PR 3, not here.
