# Dragging the pose of an organic part — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a slider that changes only a `k.implicit` spec's `frames` is dragged, the viewer shows the last exact mesh skinned to the new frames at display rate with no worker job; on release (or a 150 ms pause) an exact rebuild — faster than today through a world-anchored sample cache in both engines and a two-stage union delivery — replaces it.

**Architecture:** Three independent lanes meet in `mount.js`. (1) *Engine:* the preview grid is anchored to a world lattice (`planLeaves` `anchor`) so a bounded per-kernel sample cache (`sample-cache.js`) can hand a leaf's float32 samples (and owners) to the next pose — in JS `evaluateLeaves` and in the native core through a new `ip_sample_cached` entry; a leaf is reusable when its emitted program bytes, texture digests, world cell and grid edge are unchanged, so cold and warm builds are byte-identical. (2) *Bindings:* a preview `k.implicit` build binds every output vertex to ≤2 frames by nearest rigid "unit" of the IR (`bindings.js`), rides them through Manifold booleans as vertex properties (`numProp` 7: xyz + codeA + codeB + weight + check) and decodes them in `toMesh` into `{ frameA, frameB, weight, frames }` keyed `"<call id>:<frame>"`, so a union of several implicit bodies (the hand) keeps every body's bindings. (3) *Main thread:* the pose probe records each sub-part's `k.implicit` specs and whether its final solid is still in spec space; `skin/frames-only.js` decides a change is frames-only; `skin/deform.js` (pure, three-free) blends rigid frame motions into the delivered positions/normals and `viewer.setSubVertices` writes them in place; `skin/skin-drag.js` holds the exact base per sub-part and drives it from interactive slider input only; the regen loop gains `delayKick`/`flush` so release dispatches at once and a pause dispatches after 150 ms. Separately, a preview union with an implicit operand is left lazy (Manifold CSG nodes are) with its boolean-gate judgment deferred to first read, so `jobs.js` can post the pieces' meshes concatenated (`meshes-provisional`) before paying for the union; mount shows that stage without recording it current, so every exact reader keeps waiting for the union.

**Tech Stack:** plain ESM, vitest, Node 24; Manifold 3.5 (`vertProperties`, lazy booleans); C++17 via Emscripten (`em++` at `/opt/homebrew/bin`) through `scripts/build-core-wasm.mjs` into the committed `src/framework/core/core-wasm.js`.

**Spec:** `docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md` (binding). Read `AGENTS.md` (the map), `native/README.md` ("The contract", "The implicit engine: a session", "The owner path") before any native task, and `docs/superpowers/plans/2026-10-15-implicit-pr2-native-core.md` for how the session was built.

## Global Constraints

- **Node 24:** every command uses `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node`; tests run as `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run <files>`. Plain single commands, no `$(...)`, no `cd x && y`.
- **Branch:** `feat/implicit-pose-drag` off the current head of `feat/implicit-release`; PR into `feat/implicit` before #297 merges (spec header). **No `package.json` version bump.** Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Bit-identical core on/off** (`native/README.md` "The contract"; `test/core-parity.test.js` is the contract and is never loosened). Arithmetic in double, storage in float32 exactly where the JS uses a `Float32Array`; `jsmath::hypot3`/`jsmin`/`jsmax`; the JS's iteration order wherever it decides a result. **Every C++ change rebuilds `src/framework/core/core-wasm.js` in the same commit** (`test/core-wasm.test.js` fails on stale wasm); new exports go in `EXPORTS` of `scripts/build-core-wasm.mjs`.
- **No change to any exact build's output: same mesh bytes, same hashes** (spec anti-goal). The export/print tier (`quality === "print"`, `tier !== "preview"`) never anchors, never caches samples, never computes bindings, keeps `numProp` 3 and its cache keys, and never defers a union judgment. Every pinned digest (`test/implicit-cleanup.test.js`, `implicit-detail`, `implicit-contact`, `implicit-engine`, `implicit-native-*`, `test/verify-golden.test.js`) stays as it is — a task that moves one is wrong, not a re-record.
- **Preview bytes (the spec §5 decision, recorded in Task 1):** anchoring the grid to the world lattice moves organic PREVIEW-tier meshes. This applies only to builds that carry a sample cache: the Manifold preview kernel's `k.implicit`. Such a mesh is the same shape sampled on a grid shifted by less than `TOP` cells, so its bytes differ from before. The print/export tiers never anchor, `meshImplicit` without a cache is unchanged, and every pinned digest stays as it is. Property tests on preview meshes may need tolerance for the new triangulation (Task 1 fix round 1: `implicit-shading`'s crease check allows at most 1% of crease edges to stay unsplit).
- **Cold == warm:** a build with a warm sample cache produces the SAME bytes as a cold build at that pose, core on and off (spec "Tests").
- **The deformed mesh and the provisional stage never reach an export, `measure`, `verify`, a capture (`captureViews`, `captureView`, `exportPreview`, thumbnails), the change tracker or the geometry cache as if they were exact** (spec anti-goal). Nothing approximate is ever recorded by `cache.record` or `fastPath.recordDelivered`.
- **Deformed previews are for interactive slider drags only** — never `runtime.setParams`, never animation playback (spec "Calls I made"). Non-organic sub-parts keep the pose fast path untouched.
- **Skinning: linear blend, ≤2 frames per vertex, one weight; 150 ms pause or pointer up (`change`) triggers the exact build; a sub-part whose bindings are lost does not skin.** (spec, owner-approved.)
- **OCCT and Manifold never boot in one test process** — every new test file boots Manifold only (`bootManifoldKernel`).
- **Worker layering** (`test/worker-layering.test.js`): everything under `src/framework/geometry/` and `src/framework/core/` stays DOM-, three- and `node:`-free; the eager worker closure loads no oracle/kit module. `src/framework/skin/` is MAIN-THREAD code (it may import `geometry/xform.js`, `geometry/solid-hash.js`, `geometry/implicit/call-id.js`) and is never imported from `worker.js`/`jobs.js`.
- **The viewer draws on demand:** every in-place edit of a drawn geometry goes through a viewer API call that requests a render (`setSubVertices`, Task 6) — never by poking a BufferAttribute from outside.
- **No new per-part authoring; no new dependencies.** `build` stays a pure function of `(k, p, d)`.

## Review Focus

1. **A delivery whose `place()` was baked in the worker (`frame: "posed"`), or a build that moves an implicit result before unioning it (`k.implicit(a).translate(v)`, a `.cut()`, a `mirror`)** — the mesh is no longer in the spec's frame space, so frame motions would deform it wrongly; a reasonable person expects such a sub-part to simply rebuild as today. Pinned by Task 5 ("a moved or cut implicit is not skinnable") and Task 7 ("a posed delivery never becomes a skin base").
2. **Several `k.implicit` calls in one sub-part that share frame names** (the hand: body and five nails each carry the whole frame table) — a nail's vertices must follow the nail's own call, not the body's. Pinned by Task 4 ("two calls sharing a frame name decode to their own call ids") and Task 6 (`frameMotions` resolves by call id).
3. **A drag that leaves frames-only mid-way** (a slider that also drives a radius, a preset switch, the hand's `handLength`) — the deformed mesh must give way to the exact base and the ordinary rebuild, never stay skinned to a shape that changed. Pinned by Task 7 ("a change that is not frames-only restores the base and rebuilds").
4. **A host undo (`runtime.setParams`) while a slider is mid-drag** — the exact base must come back and the ordinary 180 ms rebuild run; no skinned frame may survive a programmatic edit. Pinned by Task 7 ("setParams during a drag restores the base").
5. **A long drag through hundreds of poses** — the sample cache must stay inside its byte bound in the worker (WebAssembly memory never shrinks), evicting the oldest leaves first. Pinned by Task 1 ("the cache evicts by age within its byte bound") and Task 2 (the native path puts/gets through the same bounded cache).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/framework/geometry/implicit/sparse.js` | `planLeaves` `anchor` → `plan.base`; sample positions by the base formula; `evaluateLeaves` cache hook | 1 |
| `src/framework/geometry/implicit/sample-cache.js` (new) | bounded LRU of leaf samples; leaf keys; program digests | 1 |
| `src/framework/geometry/implicit/index.js` | `meshImplicit(..., { cache })` → anchor + cache on both engines | 1, 2 |
| `native/implicit_mesh.cpp`, `scripts/build-core-wasm.mjs`, `src/framework/core/{implicit-core,core-wasm}.js` | `ip_sample_cached`: base formula, skipped leaves, preloaded values/owners | 2 |
| `src/framework/geometry/implicit/ir.js` | per node: effective `frame`, `world`, `worldBox`, `unit`; `compiled.frameNames` | 3 |
| `src/framework/geometry/implicit/bindings.js` (new) | `bindVertices`: nearest-unit binding with a blend band | 3 |
| `src/framework/geometry/implicit/call-id.js` (new) | `stripFrames`, `implicitCallId` — shared by worker and main thread | 4 |
| `src/framework/geometry/mesh-bindings.js` (new) | encode codes into props; `decodeBindings` from MeshGL; `mergeBindings` | 4, 8 |
| `src/framework/geometry/mesh-build.js`, `manifold-backend.js`, `src/framework/jobs.js` | props through `ofMesh`; call slots; `toMesh().bindings`; the `meshes` message | 4 |
| `src/framework/pose-probe-core.js` | records `implicitSpecs` and `skinnable` per sub-part | 5 |
| `src/framework/skin/frames-only.js` (new) | `framesOnlyChange(oldSpecs, newSpecs)` | 5 |
| `src/framework/skin/deform.js` (new) | `frameMotions`, `skinVertices` (pure, three-free) | 6 |
| `src/framework/viewer.js` | `setSubVertices(name, { positions, normals })` | 6 |
| `src/framework/regen-loop.js`, `src/framework/skin/skin-drag.js` (new), `src/framework/mount.js` | drag vs release; stale-exact rebase; captures restore the base | 7 |
| `src/framework/geometry/mesh-concat.js` (new), `manifold-backend.js`, `jobs.js`, `worker.js`, `mount.js` | the two-stage union delivery (`meshes-provisional`) | 8 |
| `scripts/bench-pose-drag.mjs` (new), `docs/domains/organic.md`, `AGENTS.md`, `docs/KERNEL-CONTRACT.md` | numbers and docs | 9 |

Shared test fixture (Task 3 creates it): `test/fixtures/skin-fixtures.js` exporting `TWO_BONE(bend = 0)` — `{ frames: { root: { at: [0, 0, 0] }, child: { parent: "root", at: [0, 20, 0], rotate: { axis: "x", deg: bend } } }, root: { kind: "union", k: 2, children: [{ kind: "capsule", frame: "root", b: [0, 20, 0], r: 4 }, { kind: "capsule", frame: "child", b: [0, 20, 0], r: 4 }] }, preview: 1, resolution: 1 }` — and `BALL(frame = "child", at = [0, 24, 6])` — `{ frames: TWO_BONE(0).frames, root: { kind: "sphere", frame, at, r: 3 }, preview: 1 }`.

---

### Task 1: World-anchored preview grid + the JS sample cache

**Files:**
- Modify: `src/framework/geometry/implicit/sparse.js` (`planLeaves`, `evaluateLeaves`)
- Create: `src/framework/geometry/implicit/sample-cache.js`
- Modify: `src/framework/geometry/implicit/index.js` (`meshImplicit`)
- Modify: `src/framework/geometry/manifold-backend.js:974-1010` (the `implicit` op) and the kernel table (`_sampleCache`)
- Test: `test/implicit-sample-cache.test.js`

**Interfaces:**
- Produces: `planLeaves(compiled, edge, { cull = true, inherit = true, anchor = false })` — with `anchor`, `plan.base = [bi, bj, bl]` (integers, each a multiple of `TOP`) and `plan.origin[a] === base[a] * edge`; without, `plan.base === null` and origin/n/leaves exactly as before. A sample's world position is `base ? (base[a] + i0 + i) * edge : origin[a] + (i0 + i) * edge` (one multiplication of an integer by `edge` when anchored, so two grids agree bit for bit on a shared cell).
- Produces: `createSampleCache({ maxBytes = SAMPLE_CACHE_BYTES } = {})` → `{ get(key) → { vals: Float32Array(125), owner: Int8Array(125) | null } | undefined, put(key, entry), has(key), bytes, size, clear(), stats() → { hits, misses }, resetStats() }`; `SAMPLE_CACHE_BYTES = 64 * 2 ** 20`; an entry costs `500 + (owner ? 125 : 0)` bytes; LRU by `Map` re-insertion on `get`; `put` evicts oldest until `bytes <= maxBytes`.
- Produces: `leafKeys(plan)` → `Array<string | null>` in plan-leaf order — `null` when `plan.base === null` or the leaf touches the grid's outer layer (`i0 < 1 || j0 < 1 || l0 < 1 || i0 + LEAF > n[0] - 2 || j0 + LEAF > n[1] - 2 || l0 + LEAF > n[2] - 2`, the samples `evaluateLeaves` clamps); else `h("leaf", programDigest(plan, progIndex), base[0] + i0, base[1] + j0, base[2] + l0, edge, plan.ownerK)`. `programDigest(plan, i) = JSON.stringify({ prog: plan.programs[i], tex: plan.textures.map((t) => t.digest) }, byteAwareReplacer)` (solid-hash.js; the typed array is fingerprinted by bytes, memoized per program object).
- Produces: `evaluateLeaves(plan, { evalBatch, evalBatchContact, cache })` — a leaf whose key is in `cache` takes the entry's `vals`/`owner` and runs nothing (it never sets `clipped`: boundary leaves have no key); every other keyed leaf is `put` after evaluation. The store gains `cacheHits: number`.
- Produces: `meshImplicit(compiled, edge, { tier, owners, cache })` — anchors (`planLeaves(..., { anchor: !!cache })`) and passes `cache` to `evaluateLeaves` and (Task 2) to the core; `result.stats.cacheHits`.
- Produces: `createManifoldKernel` holds one `createSampleCache()` as `kernel._sampleCache` and passes it as `cache` when `quality !== "print"`.
- Consumed by Task 2 (native), Task 9 (bench).

- [ ] **Step 1: Write the failing tests** in `test/implicit-sample-cache.test.js` (core OFF for this task: `setCoreEnabled(false)` in `beforeAll`, `true` in `afterAll`; `digest(mesh)` = sha256 of positions+indices+normals bytes as `test/implicit-cleanup.test.js` does; specs from `test/fixtures/skin-fixtures.js` — create the fixture file now with the two exports named above if Task 3 has not):

```js
test("an anchored plan sits on the world lattice; an unanchored plan is unchanged", () => {
  const c = compileImplicit(TWO_BONE(0)), a = planLeaves(c, 1, { anchor: true }), u = planLeaves(c, 1);
  expect(a.base.every((b) => Number.isInteger(b) && b % TOP === 0)).toBe(true);
  expect(a.origin).toEqual(a.base.map((b) => b * 1));
  expect(u.base).toBeNull();
  expect(u.origin).toEqual(c.bounds.min.map((v) => v - 2));   // the pre-change formula, pad = 2·edge
});
test("leaf keys: outer-layer leaves have none; a shared interior cell keys the same under two poses", () => {
  const kA = leafKeys(planLeaves(compileImplicit(TWO_BONE(0)), 1, { anchor: true }));
  // a leaf at the grid's first cell layer is null; some key is shared with the bent pose's plan
});
test("warm == cold: a frames-only pose change reuses samples and meshes the same bytes", () => {
  const cold = meshImplicit(compileImplicit(TWO_BONE(40)), 1, { tier: "preview", cache: createSampleCache() });
  const cache = createSampleCache();
  meshImplicit(compileImplicit(TWO_BONE(0)), 1, { tier: "preview", cache });
  const warm = meshImplicit(compileImplicit(TWO_BONE(40)), 1, { tier: "preview", cache });
  expect(warm.stats.cacheHits).toBeGreaterThan(0);
  expect(digest(warm)).toBe(digest(cold));
});
test("the hand reuses samples across a one-finger flex, byte for byte", () => { /* handSpec() vs { flex: { index: 62 } }, edge 1.5, same shape as above */ }, 120_000);
test("no cache: no anchor, and the result is byte-identical to before", () => {
  expect(planLeaves(compileImplicit(TWO_BONE(0)), 1).base).toBeNull();
  expect(meshImplicit(compileImplicit(TWO_BONE(0)), 1, { tier: "preview" }).stats.cacheHits).toBe(0);
});
test("the cache evicts by age within its byte bound", () => {
  const c = createSampleCache({ maxBytes: 1500 });
  for (const k of ["a", "b", "c", "d"]) c.put(k, { vals: new Float32Array(125), owner: null });
  expect(c.has("a")).toBe(false); expect(c.has("d")).toBe(true); expect(c.bytes).toBeLessThanOrEqual(1500);
});
test("the Manifold preview kernel reuses samples across a frames-only rebuild; the print kernel never caches", async () => {
  const k = await bootManifoldKernel(); k.beginSubPart("t");
  k.implicit(TWO_BONE(0)); k.implicit(TWO_BONE(40));
  expect(k._sampleCache.stats().hits).toBeGreaterThan(0);
  const kp = await bootManifoldKernel({ quality: "print" }); kp.beginSubPart("t"); kp.implicit(TWO_BONE(0)); kp.implicit(TWO_BONE(40));
  expect(kp._sampleCache.size).toBe(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-sample-cache.test.js`
Expected: FAIL — `createSampleCache`/`leafKeys` not exported; `base` undefined.

- [ ] **Step 3: Implement `sample-cache.js`, the `anchor` option and position formula in `sparse.js`, the `cache` hook in `evaluateLeaves`, and `meshImplicit`'s `cache` option.** `planLeaves` with `anchor`: `base[a] = Math.floor((bounds.min[a] - pad) / (TOP * edge)) * TOP`, `origin[a] = base[a] * edge`, `n` from that origin as today. In `evaluateLeaves` compute `X[q]` by the base formula when `plan.base` is set; look the key up before building `X/Y/Z`. The kernel's `implicit` op passes `{ tier: quality, cache: quality === "print" ? undefined : sampleCache }`.

- [ ] **Step 4: Run the new file and the pinned-digest files**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-sample-cache.test.js test/implicit-cleanup.test.js test/implicit-engine.test.js test/implicit-sparse.test.js test/implicit-plan-inherit.test.js test/implicit-manifold.test.js`
Expected: all PASS (the vase's preview digest in implicit-cleanup still equals its pinned print digest — `meshImplicit` without a cache does not anchor).

- [ ] **Step 5: Commit** — `git add src/framework/geometry/implicit/sparse.js src/framework/geometry/implicit/sample-cache.js src/framework/geometry/implicit/index.js src/framework/geometry/manifold-backend.js test/implicit-sample-cache.test.js test/fixtures/skin-fixtures.js` ; `git commit -m "feat(implicit): world-anchored preview grid with a bounded sample cache"`

---

### Task 2: The sample cache in the native core

**Files:**
- Modify: `native/implicit_mesh.cpp` (`sample()` at ~line 61; `ip_sample` at ~1098), `native/implicit_mesh.h` if `sample` is declared there
- Modify: `scripts/build-core-wasm.mjs:36` (`EXPORTS` gains `"ip_sample_cached"`), rebuild `src/framework/core/core-wasm.js`
- Modify: `src/framework/core/implicit-core.js` (`NativeSession.sample`, `meshImplicitCore`), `src/framework/geometry/implicit/index.js` (pass `cache` to the core)
- Modify: `native/README.md` ("The implicit engine: a session" — one paragraph on the cached sample)
- Test: `test/implicit-native-sample.test.js` (new cases), `test/implicit-sample-cache.test.js` (core-on twin), `test/core-parity.test.js`, `test/core-wasm.test.js`

**Interfaces:**
- Consumes: `leafKeys`, `createSampleCache` (Task 1); `plan.base`.
- Produces (C++): `int ip_sample_cached(int id, const int32_t* leaves, int count, const double* origin3, double edge, const int32_t* n3, int ownerK, const int32_t* base3, const uint8_t* skip, const float* preVals, const int8_t* preOwners)` — `base3` null means the old position formula, else `(double)(base3[a] + i0 + i) * edge`; a leaf with `skip[L] != 0` copies `preVals + L*125` (and `preOwners + L*125` when `ownerK > 0`) into the store, runs no interpreter, no outer-layer clamp, no zero pass and never sets `clipped`; a `RUN` batch holds unskipped leaves only. `ip_sample` becomes `ip_sample_cached(..., nullptr, nullptr, nullptr, nullptr)`. Return codes as `ip_sample`'s.
- Produces (JS): `NativeSession.sample(plan, { readBack = true, cache = null })` → `{ vals, clipped, cacheHits }` — with `cache`, builds `skip`/`preVals`/`preOwners` from `leafKeys(plan)` and `cache.get`, calls `ip_sample_cached`, then reads `ip_leaf_vals` (and `ip_leaf_owners`) back once to `put` every keyed, unskipped leaf. `meshImplicitCore(compiled, edge, plan, opts, { owners, cache })` passes it; `result.stats.cacheHits` as the JS path.

- [ ] **Step 1: Write the failing tests.** In `test/implicit-native-sample.test.js` (its existing harness: a session per plan, `addTexture`/`addProgram` in plan order):

```js
test("an anchored plan samples the base formula's bytes: the core equals evaluateLeaves", () => {
  const plan = planLeaves(compileImplicit(TWO_BONE(0)), 1, { anchor: true });
  // session.sample(plan).vals[k] Buffer-equal to evaluateLeaves(plan).leaves[k].vals for every k
});
test("skipped leaves take the preloaded values and the rest are evaluated: equal to an unskipped sample", () => {
  // sample once with cache = createSampleCache() (fills it), then a fresh session with the warm cache:
  // cacheHits > 0 and every leaf's vals Buffer-equal; an owner plan (BALL_BOARD) also matches leafOwners()
});
test("a warm cache never changes clipped", () => { /* SUB_CELL_PLATE-style clipped plan: clipped true cold and warm */ });
```
In `test/implicit-sample-cache.test.js` wrap the warm == cold tests in `describe.each([["core on", true], ["core off", false]])` with `setCoreEnabled(on)` and, when on, `expect(core()).not.toBeNull()` and `coreStatus().refusedMeshes` unchanged across the warm build.

- [ ] **Step 2: Run to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-native-sample.test.js test/implicit-sample-cache.test.js`
Expected: FAIL — `ip_sample_cached` is not a function / core-on warm build has `cacheHits` 0.

- [ ] **Step 3: Implement the C++** (`sample()` gains the four parameters; the batching loop advances `R` over unskipped leaves with the same program; skipped leaves `memcpy` into `s.vals`/`s.owners`), add the export, and rebuild:

Run: `PATH="/opt/homebrew/bin:$PATH" /Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node scripts/build-core-wasm.mjs`
Expected: both builds (scalar, SIMD) written; `src/framework/core/core-wasm.js` changed.

- [ ] **Step 4: Implement the JS** (`NativeSession.sample` cache path; `meshImplicitCore` passes `cache`; `meshImplicit` passes `cache` into `meshImplicitCore`) and the README paragraph.

- [ ] **Step 5: Run the native, cache, wasm-hash and parity suites**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-native-sample.test.js test/implicit-sample-cache.test.js test/core-wasm.test.js test/core-parity.test.js test/implicit-native-path.test.js test/implicit-native-mesh.test.js`
Expected: all PASS, both SIMD and scalar parity cases.

- [ ] **Step 6: Commit** — `git add native/implicit_mesh.cpp native/implicit_mesh.h native/README.md scripts/build-core-wasm.mjs src/framework/core/core-wasm.js src/framework/core/implicit-core.js src/framework/geometry/implicit/index.js test/implicit-native-sample.test.js test/implicit-sample-cache.test.js` ; `git commit -m "feat(core): ip_sample_cached — the sample cache on the native path, bit-identical"`

---

### Task 3: Bindings — which frames move each vertex

**Files:**
- Modify: `src/framework/geometry/implicit/ir.js` (`lowerSpec`/`lower`/`finish`)
- Create: `src/framework/geometry/implicit/bindings.js`
- Create/extend: `test/fixtures/skin-fixtures.js`
- Test: `test/implicit-bindings.test.js`, `test/implicit-ir.test.js` (one case)

**Interfaces:**
- Produces (IR): every node gains `frame: string | null` (the effective frame: `node.frame ?? the parent's effective frame`; the root's parent has `null`), `world: Float64Array(12)` (its `W`), `worldBox: { min, max }` (`boxXform(n.box, Wparent)`), and `unit: boolean` (`frame !== parentFrame && frame !== null && rigid`, where `rigid` is false for every node below a `warp`, `mirror` or `ref` node). `lowerSpec` returns `frameNames: string[]` (`Object.keys(spec.frames ?? {})`). No existing field, hash or digest changes.
- Produces: `bindVertices(compiled, positions, edge, { band = BIND_BAND_CELLS * edge } = {})` → `{ frameA: Uint16Array, frameB: Uint16Array, weight: Float32Array }`, one entry per vertex (`positions.length / 3`); a value is `1 + compiled.frameNames.indexOf(name)`, `0` = unbound; `BIND_BAND_CELLS = 3`; `MAX_BIND_FRAMES = 1023` (a spec with more frames binds nothing).
- Consumed by Task 4 (props), Task 6 (deform reads the same layout per corner).

The rule (not determined by the tests — the builder's call per spec §1): for each unit `u` emit `prog_u = emitProgram(compiled, unitDecision(u))` where `unitDecision(id) = { id, kids: nodes[id].children.map(unitDecision) }` (a `mirror` node's kids are `[child, child]`, as `interval.js`'s `full` does); a vertex `v` is a candidate of `u` when it lies inside `u.worldBox` padded by `band + 2·edge` (if no unit contains `v`, every unit is a candidate); evaluate each unit once over its candidates with `evalBatch(prog_u, compiled.textures, X, Y, Z, out)` on the points moved into `u`'s parent space by `invert(Wparent_u)` with `Wparent_u = u.inv ? compose(u.world, u.inv) : u.world`; per vertex sort candidates by value, `A` = nearest, `B` = the nearest whose `frame` differs from `A`'s; if `B` exists and `d_B − d_A < band`: `frameB = B`, `weight = clamp(0.5 + (d_B − d_A) / (2·band), 0.5, 1)`, else `frameB = 0, weight = 1`.

- [ ] **Step 1: Write the failing tests** (`test/implicit-bindings.test.js`; mesh with `meshImplicit(compileImplicit(TWO_BONE(0)), 1, { tier: "preview" })`, core off or on — the rule is JS):

```js
test("vertices far from the joint bind wholly to their own bone", () => {
  // every vertex with y < 12: frameA === 1 ("root"), frameB === 0, weight === 1; y > 28: frameA === 2
});
test("vertices near the joint blend both bones with a weight in [0.5, 1]", () => {
  // some vertex with |y - 20| < 3 has frameB !== 0; every blended vertex has frameA !== frameB and 0.5 <= weight <= 1
});
test("a spec with no frames binds nothing", () => { /* { root: { kind: "sphere", r: 5 }, preview: 1 } → all zeros */ });
test("bindings are sized to the mesh and deterministic", () => { /* lengths === positions.length / 3; two calls Buffer-equal */ });
test("a frame root below a warp or repeat does not start a unit: the subtree binds to the warp's frame", () => {
  // { frames: { a: {at:[0,0,0]}, b: {parent:"a", at:[0,10,0]} }, root: { kind: "twist", frame: "a", degPerMm: 1, child: { kind: "capsule", frame: "b", b: [0,10,0], r: 3 } } }
  // → every bound vertex has frameA === 1 (a)
});
```
And in `test/implicit-ir.test.js`: `lowerSpec(TWO_BONE(0)).ir.nodes` — the second capsule has `frame === "child"`, `unit === true`, `xformPoint(p, node.world, 0, 0, 0)` → `[0, 20, 0]`, and `frameNames` equals `["root", "child"]`.

- [ ] **Step 2: Run to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-bindings.test.js test/implicit-ir.test.js`
Expected: FAIL — `bindVertices` not exported; `frame` undefined on nodes.

- [ ] **Step 3: Implement the IR fields** (thread `parentFrame` and `rigid` through `lower(node, Wparent, path, parentFrame, rigid)`; the `cylinder`/`torus` inner node and `tube` segments share their node's frame; `repeat`'s refs and `warp`/`mirror` children pass `rigid = false`) **and `bindings.js`.**

- [ ] **Step 4: Run the implicit suite that reads the IR**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-bindings.test.js test/implicit-ir.test.js test/implicit-interval.test.js test/implicit-program.test.js test/implicit-engine.test.js test/implicit-frame-report.test.js test/implicit-contact.test.js`
Expected: all PASS; no pinned digest moved.

- [ ] **Step 5: Commit** — `git add src/framework/geometry/implicit/ir.js src/framework/geometry/implicit/bindings.js test/fixtures/skin-fixtures.js test/implicit-bindings.test.js test/implicit-ir.test.js` ; `git commit -m "feat(implicit): per-vertex frame bindings for preview builds"`

---

### Task 4: Bindings through Manifold and into the `meshes` message

**Files:**
- Create: `src/framework/geometry/implicit/call-id.js`, `src/framework/geometry/mesh-bindings.js`
- Modify: `src/framework/geometry/mesh-build.js:87-109` (`manifoldFromWeldedMesh`), `src/framework/geometry/manifold-backend.js` (the `implicit` op, `meshOut`, `beginSubPart`/`endSubPart`), `src/framework/jobs.js:187-188,498` (`transferOf`, the mesh entry)
- Modify: `test/core-parity.test.js` (compare bindings)
- Test: `test/implicit-bindings-manifold.test.js`

**Interfaces:**
- Produces: `stripFrames(spec)` → the spec without `frames`; `implicitCallId(spec, priorSpecs)` → `` `${h("implicit-shape", stripFrames(spec))}#${n}` `` where `n` counts entries of `priorSpecs` with the same shape hash (so two calls of one shape at different frames are `…#0`, `…#1`). Used identically by the worker (Task 4) and the main thread (Tasks 5–7).
- Produces: `BIND_CALL_STRIDE = 1024`; `encodeBindingProps(bind, slot)` → `Float32Array(nVert * 4)` of `[codeA, codeB, weight, check]` with `code = frame ? slot * 1024 + frame : 0` and `check = (codeA * 31 + codeB) % 97`; `decodeBindings(g, calls)` → `{ frameA: Uint16Array, frameB: Uint16Array, weight: Float32Array, frames: (string | null)[] } | null` over the MeshGL's corners (`triVerts` order — the order `creasedNormals` emits its non-indexed output in): `null` when `g.numProp < 7` or `calls.length === 0`; a corner is unbound unless `codeA` is an integer with `local = codeA % 1024 ≥ 1`, `slot = floor(codeA / 1024) < calls.length`, `local ≤ calls[slot].frames.length`, `0 ≤ weight ≤ 1` and `check` matches; `frameB` likewise else `0` with `weight = 1`; `frames[0] = null`, then `"<calls[slot].id>:<frameName>"` in order of first sight. `mergeBindings(list, counts)` (Task 8 uses it) → one binding set over concatenated corner counts with one merged `frames` table keyed by string; an entry without bindings contributes zeros.
- Produces: `manifoldFromWeldedMesh(wasm, V, Tr, originalID, triOwner = null, ids = null, extra = null)` — `extra = { per, data }` interleaves `per` extra floats after xyz (`numProp = 3 + per`).
- Produces (backend): per sub-part bracket `implicitCalls: { id, frames: string[] }[]` (reset in `beginSubPart` and `endSubPart`); the preview `implicit` op pushes its call (`slot = index`), keys the solid `h("implicit", implicitHashable(keySpec, compiled), quality, slot)`, and builds the welded mesh with `extra = { per: 4, data: encodeBindingProps(bindVertices(compiled, out.positions, edge), slot) }`; the print op is unchanged (no slot, `numProp` 3). `toMesh()` (`meshOut`) adds `bindings` when `decodeBindings(g, implicitCalls)` is non-null.
- Produces (jobs): each `meshes`/`meshes-partial` entry carries `bindings` (undefined when the backend gave none) and `transferOf` transfers its three buffers.
- Consumed by Tasks 5–8.

- [ ] **Step 1: Write the failing tests** (`test/implicit-bindings-manifold.test.js`; `bootManifoldKernel()` preview quality; every build inside `k.beginSubPart("t")` … `k.endSubPart()`):

```js
test("an implicit solid's mesh carries bindings keyed by call id and frame name", () => {
  const spec = TWO_BONE(0), m = k.implicit(spec).toMesh(), id = implicitCallId(spec, []);
  expect(m.bindings.frames[0]).toBeNull();
  expect(m.bindings.frames).toEqual(expect.arrayContaining([`${id}:root`, `${id}:child`]));
  expect(m.bindings.frameA.length).toBe(m.triangles * 3);
});
test("bindings survive a union with another k.implicit and with a plain box", () => {
  const u = k.union([k.implicit(TWO_BONE(0)), k.implicit(BALL("child")), k.box([6, 6, 6]).translate([30, 0, 0])]).toMesh();
  // corners with x > 25: frameA === 0; corners with y < 10: frames[frameA] endsWith ":root" of call 0's id;
  // some corner's frames[frameA] starts with implicitCallId(BALL("child"), [TWO_BONE(0)])
});
test("two calls sharing a frame name decode to their own call ids", () => {
  // k.union([k.implicit(TWO_BONE(0)), k.implicit({ ...BALL("child"), frames: TWO_BONE(0).frames })]):
  // the table holds both "<id0>:child" and "<id1>:child"
});
test("two calls of one shape at different frames get ordinals #0 and #1", () => { /* BALL at bend 0 and BALL with child deg 30 */ });
test("the print tier carries no bindings and its solid hash is unchanged", async () => {
  // print kernel: k.implicit(TWO_BONE(0)).toMesh().bindings === undefined, and ._hash === h("implicit", implicitHashable({ ...stripped, resolution: 1 }, compiled), "print") — no slot in the key
});
test("a toMesh outside a sub-part bracket carries no bindings", () => { /* endSubPart first → undefined */ });
test("decodeBindings: an interpolated or check-failing code is unbound", () => {
  // hand-made { numProp: 7, vertProperties: Float32Array, triVerts } with one corner (1025.5, 0, 1, 0) and one (1025, 1026, 0.5, wrongCheck) → both unbound; a valid corner decodes
});
test("the generate job posts bindings and transfers their buffers", async () => {
  // handle(kernel, part, { type: "generate", subparts: ["body"], view: "assembly", params: {} }, post) with build (k) => k.implicit(TWO_BONE(0)):
  // post's meshes[0].bindings defined; post's transfer list includes bindings.frameA.buffer
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-bindings-manifold.test.js`
Expected: FAIL — `bindings` undefined.

- [ ] **Step 3: Implement** `call-id.js`, `mesh-bindings.js`, the `extra` argument, the backend's slot/key/props/decode, and the jobs.js fields. In `test/core-parity.test.js`'s mesh comparison add `bindings`: when either side has it both must, with `frames` `toEqual` and `frameA`/`frameB`/`weight` Buffer-equal.

- [ ] **Step 4: Run the Manifold, parity, jobs and layering suites**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-bindings-manifold.test.js test/implicit-manifold.test.js test/core-parity.test.js test/framework/jobs.test.js test/cache-jobs.test.js test/worker-layering.test.js test/oracle-entry.test.js test/implicit-shading.test.js`
Expected: all PASS (numProp 7 flows through `creasedNormals` on both paths by stride).

- [ ] **Step 5: Commit** — `git add src/framework/geometry/implicit/call-id.js src/framework/geometry/mesh-bindings.js src/framework/geometry/mesh-build.js src/framework/geometry/manifold-backend.js src/framework/jobs.js test/core-parity.test.js test/implicit-bindings-manifold.test.js` ; `git commit -m "feat(implicit): bindings ride through Manifold booleans into the meshes message"`

---

### Task 5: Detecting a frames-only drag

**Files:**
- Modify: `src/framework/pose-probe-core.js` (`makeProbeSession`, `probeSubPartPose`)
- Create: `src/framework/skin/frames-only.js`
- Test: `test/skin-frames-only.test.js`, `test/pose-probe-skin.test.js`, `test/framework/pose-fast-path.test.js` (unchanged, must pass)

**Interfaces:**
- Consumes: `stripFrames`, `implicitCallId` (Task 4).
- Produces: `probeSubPartPose(sp, ctx, { scope })` in `"build"`/`"full"` scope returns, trusted or not, `implicitSpecs: object[]` (the first argument of every `k.implicit` call, in call order; `[]` when the build threw) and `skinnable: boolean` — true when the build's final token is in spec space: probe tokens carry `_implicit` (derived from any implicit result; propagated to every op's result when any operand token has it) and `_specSpace` (true on a `k.implicit` result; true on a `union` — the kernel's `k.union([...])` or a solid's `.union(t)` — whose every operand token is either (`_specSpace` with `_pose.length === 0`) or `!_implicit`; false on every other op); `skinnable = token._specSpace && token._pose.length === 0` measured on the BUILD token (before `place()`). `probePoses` passes both fields through unchanged.
- Produces: `framesOnlyChange(oldSpecs, newSpecs)` → boolean: `oldSpecs.length === newSpecs.length > 0` and, pairwise by position, `implicitCallId(old, oldPrior) === implicitCallId(new, newPrior)` and `Object.keys(old.frames ?? {})` `===` `Object.keys(new.frames ?? {})` in order.
- Consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

```js
// test/skin-frames-only.test.js
test("a change inside frames alone is frames-only", () => expect(framesOnlyChange([TWO_BONE(0)], [TWO_BONE(30)])).toBe(true));
test.each([["a radius", { r: 5 }], ["a blend k", { k: 3 }], ["a node added", ...], ["a frame added", ...], ["a frame removed", ...]])("%s is not frames-only", ...);
test("a different number of k.implicit calls, or none, is not frames-only", () => { /* [a] vs [a, b] false; [] vs [] false */ });
// test/pose-probe-skin.test.js — sub-parts as { build }, probed with probeSubPartPose(sp, { view: "v", p: {}, d: {} }, { scope: "build" })
test("a union of k.implicit results is skinnable and records the specs in call order", () => { /* k.union([k.implicit(a), k.implicit(b)]) → skinnable true, implicitSpecs [a, b] */ });
test("a lone k.implicit is skinnable; a union with a plain box too", ...);
test.each(["k.implicit(a).translate([1,0,0])", "k.union([k.implicit(a).translate([1,0,0]), k.implicit(b)])", "k.implicit(a).cut(k.box([1,1,1]))", "k.implicit(a).mirror(\"yz\")", "k.union([k.implicit(a), k.implicit(b)]).translate([0,0,1])"])("a moved or cut implicit is not skinnable: %s", ...);
test("a build with no implicit has skinnable false and no specs", ...);
test("place() steps in full scope do not change skinnable", () => { /* build union + place translate: skinnable true in \"full\" */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/skin-frames-only.test.js test/pose-probe-skin.test.js`
Expected: FAIL — module missing; `skinnable` undefined.

- [ ] **Step 3: Implement** the token flags and recording in `makeProbeSession` (the Proxy's catch-all records `key === "implicit"`; `foldOp`/the Proxy compute the flags from `args` flattened one array level) and `frames-only.js`.

- [ ] **Step 4: Run the probe suites**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/skin-frames-only.test.js test/pose-probe-skin.test.js test/framework/pose-fast-path.test.js test/lint-purity.test.js`
Expected: all PASS (hashes and trust unchanged).

- [ ] **Step 5: Commit** — `git add src/framework/pose-probe-core.js src/framework/skin/frames-only.js test/skin-frames-only.test.js test/pose-probe-skin.test.js` ; `git commit -m "feat(skin): the probe records k.implicit specs; frames-only change detection"`

---

### Task 6: The deformer and the viewer's in-place update

**Files:**
- Create: `src/framework/skin/deform.js`
- Modify: `src/framework/viewer.js` (~line 1861, beside `setSubGeometry`; the returned API near line 3479)
- Test: `test/skin-deform.test.js`, `test/framework/viewer-vertices.test.js`

**Interfaces:**
- Consumes: `resolveFrames`, `compose`, `invert`, `xformPoint`, `xformDir` (`geometry/xform.js`); `implicitCallId` (Task 4); the `bindings` layout (Task 4).
- Produces: `frameMotions(baseSpecs, liveSpecs, frames)` → `Array<Float64Array(12) | null>` indexed like `frames` (`[0]` null): for `"<id>:<name>"`, the spec with that call id in each list (ids computed positionally with `implicitCallId`), `motion = compose(liveWorld, invert(baseWorld))` from `resolveFrames(spec.frames).get(name).world`; returns `null` (the whole array) when any id or frame name is missing on either side.
- Produces: `skinVertices(base, motions, out)` — `base = { positions, normals, bindings }`, `out = { positions, normals }` of equal lengths, written in place and returned; per corner `c`: `a = frameA[c]`; unbound or `motions[a] == null` → copied; else `p' = w·(M_a p) + (1 − w)·(M_b p)` when `frameB[c]` names a motion, else `M_a p`; normals through `xformDir` of each motion, blended the same way, renormalised.
- Produces (viewer): `setSubVertices(name, { positions, normals })` → `boolean` — false when no mesh is drawn under `name`; throws `RangeError` on a length mismatch; copies into the existing `position`/`normal` attributes (`array.set`, `needsUpdate = true`), recomputes `boundingBox`/`boundingSphere`, calls `cutaway.updateGeometry(name, geo)`; a render is requested by `withRenderRequests` (the name matches no `NO_RENDER_REQUEST` pattern). Edge lines are left as delivered.
- Consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

```js
// test/skin-deform.test.js — hand-made base: 6 corners (2 triangles), corners 0-2 bound to frame 1 ("root"), 3-5 to frame 2 ("child"), frames [null, `${id}:root`, `${id}:child`]
test("a pure rotation of one frame moves exactly that bone's corners by that rotation", () => {
  const motions = frameMotions([TWO_BONE(0)], [TWO_BONE(90)], frames);
  // corners 0-2 toEqual base; corners 3-5 within 1e-9 of xformPoint(motions[2], p); normals rotated by the same motion's rotation
});
test("deforming twice from one base gives identical results and leaves the base untouched", () => { /* two outs Buffer-equal; base bytes unchanged */ });
test("a blended corner is the weighted mix of both motions", () => { /* weight 0.25 */ });
test("unbound corners and corners naming a missing motion stay put", ...);
test("frameMotions is null when a frame or call is missing from the live specs", ...);
// test/framework/viewer-vertices.test.js — @vitest-environment happy-dom, the three mock and makeViewer of test/framework/viewer-pose.test.js
test("setSubVertices rewrites positions and normals in place, updates bounds and the payload", () => {
  // setSubGeometry("body", tri) then setSubVertices("body", { positions: p2, normals: n2 }) → true;
  // getSubMeshPayload("body").positions equals p2; the geometry's boundingBox.max matches p2
});
test("setSubVertices refuses a length mismatch and an unknown name", () => { /* RangeError; false */ });
test("setSubVertices requests a render", () => { /* the pattern of test/framework/viewer-render-on-demand.test.js */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/skin-deform.test.js test/framework/viewer-vertices.test.js`
Expected: FAIL — module missing; `setSubVertices` is not a function.

- [ ] **Step 3: Implement `deform.js` and `setSubVertices`.**

- [ ] **Step 4: Run them with the viewer suites that touch sub-geometry**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/skin-deform.test.js test/framework/viewer-vertices.test.js test/framework/viewer-pose.test.js test/framework/viewer-render-on-demand.test.js test/framework/viewer-cutaway.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit** — `git add src/framework/skin/deform.js src/framework/viewer.js test/skin-deform.test.js test/framework/viewer-vertices.test.js` ; `git commit -m "feat(skin): linear-blend deformer and viewer.setSubVertices"`

---

### Task 7: Drag vs release — the regen loop, the skin controller and mount

**Files:**
- Modify: `src/framework/regen-loop.js`
- Create: `src/framework/skin/skin-drag.js`
- Modify: `src/framework/mount.js` (`makeHandle` ~77-100: a `beforeCapture` hook; the `meshes` case ~1391-1460; `applyFreshMeshes` ~1306; `buildControls` wiring ~1563; `onParamChange` ~1594; `exportPreview` unchanged)
- Test: `test/framework/regen-loop.test.js`, `test/skin-drag.test.js`, `test/framework/mount-pose-drag.test.js`

**Interfaces:**
- Consumes: `probePoses(part, view, params, { scope: "build" })` entries with `implicitSpecs`/`skinnable` (Task 5); `framesOnlyChange` (Task 5); `frameMotions`, `skinVertices` (Task 6); `viewer.setSubVertices` (Task 6); mesh payloads with `bindings` and `frame` (Task 4); mount's `dispatched: Map<name, { view, params }>`, `cache.forget/record/frameOf`, `fastPath.forget/apply/recordDelivered`.
- Produces (regen loop): `markDirty({ debounce = true, delayMs = debounceMs } = {})`; `delayKick(ms)` — clears the armed timer and arms `kick` in `ms` without bumping the version; `flush()` — clears the timer and calls `kick()` now. Existing behaviour untouched.
- Produces: `SKIN_PAUSE_MS = 150`; `createSkinDrag(part, viewer, { params, getView, getParamsVersion, probe = probePoses })` →
  - `recordDelivered(name, mesh, at)` — becomes the skin base only when `mesh.bindings`, `mesh.frame === "canonical"`, `at?.params` and the build-scope probe at `at.params` is `skinnable` with specs; stores copies of `positions`/`normals`, the `bindings`, the specs; otherwise `forget(name)`.
  - `forget(name)`; `hasBase(name)`.
  - `canSkin(name)` → the live probe (memoized per `getParamsVersion()`) is `skinnable` and `framesOnlyChange(base.specs, live.implicitSpecs)`.
  - `canRebase(name, at)` → same test between the probe at `at.params` and the live probe (the stale-delivery question, asked before the delivery is recorded).
  - `deform()` → `string[]` — for every in-view name with a base: `canSkin` → `skinVertices(base, motions, scratch)` (motions memoized per version) and `viewer.setSubVertices(name, scratch)`, marked deformed, sets `dragging = true`; else, if deformed, `restore(name)`. Always from the base, never from a previous deformation.
  - `restore(name)`, `restoreAll()` → names restored (`viewer.setSubVertices(name, base)`); `isDeformed(name)`, `anyDeformed()`, `isDragging()`, `endDrag()`.
- Produces (mount): `onParamChange({ debounce = true, interactive = false })` — after `fastPath.repair()`: interactive → `const skinned = skin.deform(); if (skinned.length) loop.delayKick(SKIN_PAUSE_MS)`; not interactive → `if (skin.anyDeformed()) skin.restoreAll(); skin.endDrag()`. The panel's `onDirty` calls `onParamChange({ interactive: true })`; the panel's `onCommit` (now always passed) does `if (skin.isDragging()) { skin.endDrag(); loop.flush(); }` then the host's `onParamsCommit`. `applyFreshMeshes` calls `skin.recordDelivered(m.name, m, dispatched.get(m.name))` after `setSubGeometry`, and `skin.endDrag()` once `missingParts().length === 0`. The `meshes` handler gains a branch after the animation one: the stale meshes with `m.bindings && m.frame === "canonical" && skin.canRebase(m.name, dispatched.get(m.name))` are shown (`setSubGeometry`, `fastPath.forget`, `cache.forget`, `skin.recordDelivered`, `fastPath.apply(names, framesFromReply)`, `skin.deform()`, `recordFrames`) and every other stale mesh is discarded as before; the handler's trailing `loop.kick()` becomes `skin.isDragging() ? loop.delayKick(SKIN_PAUSE_MS) : loop.kick()`. `makeHandle` takes `beforeCapture` and calls it first in `captureViews` and `captureViewsAs`; mount passes `() => { skin.restoreAll(); }` (Task 8 extends it). `setParams` is unchanged (it reaches `onParamChange()` non-interactive).
- Consumed by Task 8 (the handler shape), Task 9 (bench/docs).

- [ ] **Step 1: Write the failing regen-loop tests** (append to `test/framework/regen-loop.test.js`, its fake-timer style):

```js
test("markDirty({ delayMs }) arms the kick at that delay", ...);       // 150 → not sent at 149, sent at 150
test("delayKick re-arms the kick without bumping the version", ...);   // version() unchanged; sent after ms
test("flush() sends now and cancels the armed timer", ...);            // one send immediately, none later
test("flush() with nothing missing sends nothing", ...);
```

- [ ] **Step 2: Write the failing skin-drag tests** (`test/skin-drag.test.js`; a fake viewer `{ setSubVertices: vi.fn(), hasSubMesh: () => true }`, a fake `probe` returning a Map of `{ skinnable, implicitSpecs }` per params, `params` mutated in place, a part `{ parts: { body: {} }, views: {} }` with `viewSubParts` answering `["body"]`):

```js
test("a delivery without bindings, or posed, never becomes a base", ...);          // hasBase false
test("deform skins from the base twice identically and marks the drag", ...);     // two calls → equal arrays; isDragging true
test("a change that is not frames-only restores the base", ...);                 // probe flips skinnable/specs → setSubVertices called with the base; isDeformed false
test("canRebase answers for the params a stale build was dispatched with", ...);
test("restoreAll returns the names it restored and endDrag clears the drag", ...);
```

- [ ] **Step 3: Write the failing mount tests** (`test/framework/mount-pose-drag.test.js`; copy `makeElements`/`makeWorkers`/the fake-viewer `vi.mock` of `test/framework/mount.test.js`, adding `setSubVertices: vi.fn()`, `captureCanonicalViews: vi.fn(() => [])`, `cutawayEnabled: () => false`; `vi.useFakeTimers()`; the part: `parameters: [{ key: "bend", min: 0, max: 90, step: 1 }, { key: "r", min: 2, max: 6, step: 1 }]`, `parts: { body: { build: (k, p) => k.implicit({ ...TWO_BONE(p.bend), root: withRadius(p.r) }), views: ["v"] } }`; a reply builder `delivery(bend)` making `{ name: "body", frame: "canonical", triangles: 2, positions, normals, edges: new Float32Array(0), reads: ["bend", "r"], bindings: { frameA, frameB, weight, frames: [null, `${id}:root`, `${id}:child`] } }` with `id = implicitCallId(TWO_BONE(0), [])`; a slider drag = set the `input[type=range]` for `bend` and `dispatchEvent(new Event("input"))`, release = `new Event("change")`):

```js
test("a frames-only slider input deforms in place with no job; the exact build goes out after 150 ms", () => {
  // after ready + meshes(delivery(0)): postMessage count N; input bend=30 → setSubVertices called once, count still N;
  // advanceTimersByTime(149) → N; advanceTimersByTime(1) → N+1 with params.bend 30
});
test("release dispatches the exact build at once", ...);                          // input then change → N+1 before any timer
test("the exact delivery replaces the deformed mesh and becomes the new base", ...); // meshes(delivery(30)) → setSubGeometry called; next input skins from delivery(30)'s positions
test("a stale-but-exact delivery during a drag becomes the skin base; a sub-part without bindings is discarded", () => {
  // two sub-parts: body (bindings) and lid (a plain box, no bindings); dispatch, then input mid-flight, then the reply with both:
  // setSubGeometry("body", …) called and immediately setSubVertices("body", …); setSubGeometry("lid", …) NOT called;
  // advanceTimersByTime(150) → a new generate posted
});
test("setParams during a drag restores the exact base and takes the ordinary rebuild", () => {
  // input (deformed) → runtime.setParams({ bend: 50 }) → last setSubVertices call carries the base positions; generate after 180 ms, not 150
});
test("a change that is not frames-only restores the base and rebuilds", ...);    // drag r → base restored; generate after 180 ms
test("captureViews during a drag captures the exact base", ...);                 // setSubVertices(base) happens before captureCanonicalViews
test("a posed delivery never becomes a skin base", ...);                          // frame: "posed" → input dispatches as today, setSubVertices never called
test("exportPreview during a drag rejects as not fully built", ...);
```

- [ ] **Step 4: Run all three to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/framework/regen-loop.test.js test/skin-drag.test.js test/framework/mount-pose-drag.test.js`
Expected: FAIL — `delayKick`/`flush` undefined; module missing; `setSubVertices` never called.

- [ ] **Step 5: Implement** the regen-loop additions, `skin-drag.js`, and the mount wiring listed under Interfaces.

- [ ] **Step 6: Run the mount, regen, fast-path and animation suites**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/framework/regen-loop.test.js test/skin-drag.test.js test/framework/mount-pose-drag.test.js test/framework/mount.test.js test/framework/pose-fast-path.test.js test/framework/animation.test.js test/mount-capture.test.js test/framework/mount-capture-view.test.js test/framework/panel`
Expected: all PASS.

- [ ] **Step 7: Smoke the hand in Chromium** (needs Playwright; optional if absent — say so in the commit body): `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node scripts/check-app.mjs hand.html` — Expected: the app boots and builds with no console error.

- [ ] **Step 8: Commit** — `git add src/framework/regen-loop.js src/framework/skin/skin-drag.js src/framework/mount.js test/framework/regen-loop.test.js test/skin-drag.test.js test/framework/mount-pose-drag.test.js` ; `git commit -m "feat(skin): drag a pose at display rate; exact rebuild on release or a 150 ms pause"`

---

### Task 8: Two-stage delivery for unions of implicit bodies

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (`union` ~1054, `judged`/`volumeOf` ~103-133, `meshOut`/`indexedMeshOut` ~270-290, the wrap's `boundingBox/volume/genus/isEmpty` ~770, `endSubPart`)
- Create: `src/framework/geometry/mesh-concat.js`
- Modify: `src/framework/jobs.js` (the generate loop ~477-528), `src/framework/worker.js:144` (the post gate), `src/framework/mount.js` (a `meshes-provisional` case beside `meshes-partial`; the `provisional` set; `beforeCapture`)
- Test: `test/implicit-two-stage.test.js`, `test/framework/mount-pose-drag.test.js` (provisional cases), `test/kit-layering.test.js`/`test/worker-layering.test.js` (unchanged, must pass)

**Interfaces:**
- Consumes: `mergeBindings` (Task 4); `replay`, `wrap`, `_canon` (backend internals); `loop.isFresh()`, `showPartial()`, `fastPath.forget/apply`, `cache.forget` (mount); `skin` (Task 7).
- Produces (backend): `kernel.setProvisionalUnions(on: boolean)`; `kernel.takeProvisionalPieces(solid)` → `Solid[] | null`. While armed and `quality === "preview"`, a `union` of ≥2 solids with at least one operand whose `_canon.m` is an implicit result (or an earlier deferred union) is built as the lazy `Manifold.union` node with its boolean-gate `judged(...)` DEFERRED: `pendingJudge.set(node, () => judged("union", ms, node))`, run by `settle(m)` at the top of `meshOut`, `indexedMeshOut`, `volumeOf` and the wrap's `boundingBox`/`volume`/`genus`/`isEmpty` (deleted from the map only after it returns without throwing). The last deferred union of the bracket is remembered as `{ m: node, pieces: operand solids }`; `takeProvisionalPieces(solid)` returns `pieces.map((p) => replay(p, solid._canon.chain))` when `solid._canon.m === node` (the union is the sub-part's final solid up to rigid steps), else `null`; it and `endSubPart` clear the memory. Unarmed, print, hoisted-or-not: every other path is unchanged.
- Produces: `concatMeshPayloads(list)` → `{ positions, normals, triangles, edges, bindings? }` — concatenates non-indexed payloads (throws on an indexed one), drops `featureIds`/`features`, merges bindings with `mergeBindings`.
- Produces (jobs/worker): the generate job arms `setProvisionalUnions(true)` for its duration (false in `finally`); after `displayWithReads(name)` and before `solid.toMesh`, `const pieces = kernel.takeProvisionalPieces?.(solid)`; when non-null and `!isStale()`, posts `{ type: "meshes-provisional", meshes: [{ name, ...concatMeshPayloads(pieces.map((p) => p.toMesh({ quality: "preview" }))), reads, frame, provisional: true }] }` with the buffers transferred. `worker.js`'s gate drops a `meshes-provisional` from a stale epoch exactly as `meshes-partial`. `capture-generate`, `inspect` and exports never arm it.
- Produces (mount): `case "meshes-provisional"`: ignored unless `loop.isFresh()` and `!viewer.cutawayEnabled?.()`; shown with `setSubGeometry`, `fastPath.forget`, `cache.forget` (the sub-part stays missing, so `exportPreview` keeps throwing "not fully built" and the loop keeps waiting), `fastPath.apply(names, framesFromReply)`, `showPartial()`, and `provisional.add(name)`; `applyFreshMeshes` and the stale branches `provisional.delete(name)`; `beforeCapture` throws `Error("captureViews: the view on screen is not fully built")` while `provisional.size > 0`. `skin.recordDelivered` is never called for a provisional stage.

- [ ] **Step 1: Write the failing backend/jobs tests** (`test/implicit-two-stage.test.js`, Manifold preview kernel):

```js
test("an armed preview union of implicit results hands out its pieces once, then the real union", () => {
  k.setProvisionalUnions(true); k.beginSubPart("t");
  const s = k.union([k.implicit(TWO_BONE(0)), k.implicit(BALL("child"))]);
  const pieces = k.takeProvisionalPieces(s);
  expect(pieces).toHaveLength(2); expect(k.takeProvisionalPieces(s)).toBeNull();
  const m = s.toMesh();                                   // forces the union and its judgment
  // m byte-equal (positions/normals/edges) to the same union built on a kernel with setProvisionalUnions(false)
});
test("a trailing rigid step is replayed onto the pieces", () => { /* .translate([5,0,0]) → each piece's mesh bounds shifted by 5 */ });
test.each(["a cut after the union", "a mirror after the union", "a union of two plain boxes", "unarmed", "print quality"])("no pieces: %s", ...);
test("the deferred judgment still refuses an impossible union, at first read", () => {
  // an operand in an error state (an extrude of an empty profile, as judged()'s comment describes) → s.toMesh() throws the invalidOperand message; a second toMesh throws again
});
test("the generate job posts the provisional stage, then the union; inspect's buildView never sees it", async () => {
  // handle(kernel, part, { type: "generate", subparts: ["body"], view, params }, post): post types in order ["meshes-provisional", "meshes"];
  // provisional meshes[0].provisional === true, triangles === pieces' sum, bindings.frames names both call ids; final meshes[0].provisional undefined;
  // buildView(kernel, part, view)[0].mesh.triangles === final triangles
});
test("the provisional stage of a stale build is not posted", ...);   // opts.isStale → () => true after the build starts
```

- [ ] **Step 2: Write the failing mount tests** (append to `test/framework/mount-pose-drag.test.js`):

```js
test("the provisional stage shows first and leaves the sub-part missing; the union replaces it", () => {
  // reply meshes-provisional → setSubGeometry called with provisional: true; runtime.exportPreview() rejects /not fully built/;
  // reply meshes → setSubGeometry with the final; exportPreview resolves
});
test("captureViews during the provisional stage throws", ...);
test("with the cutaway on, the provisional stage is not shown", ...);  // cutawayEnabled: () => true → setSubGeometry not called for it
test("a provisional stage of a stale build is dropped", ...);         // input between dispatch and the provisional reply → not shown
```

- [ ] **Step 3: Run to verify they fail**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-two-stage.test.js test/framework/mount-pose-drag.test.js`
Expected: FAIL — `setProvisionalUnions` is not a function; no `meshes-provisional` posted.

- [ ] **Step 4: Implement** the deferred union and `settle`, `mesh-concat.js`, the jobs/worker/mount wiring.

- [ ] **Step 5: Run the backend, jobs, worker-layering, kit-layering and mount suites**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/implicit-two-stage.test.js test/framework/mount-pose-drag.test.js test/framework/jobs.test.js test/cache-jobs.test.js test/worker-layering.test.js test/kit-layering.test.js test/boolean-gate.test.js test/implicit-manifold.test.js test/core-parity.test.js`
Expected: all PASS (`core-parity` builds through `buildView`, which never arms the deferral).

- [ ] **Step 6: Commit** — `git add src/framework/geometry/manifold-backend.js src/framework/geometry/mesh-concat.js src/framework/jobs.js src/framework/worker.js src/framework/mount.js test/implicit-two-stage.test.js test/framework/mount-pose-drag.test.js` ; `git commit -m "feat(implicit): two-stage preview delivery for unions of implicit bodies"`

---

### Task 9: Bench and docs

**Files:**
- Create: `scripts/bench-pose-drag.mjs`; Modify: `package.json` (`"bench:pose-drag"` script only — no version bump)
- Modify: `docs/domains/organic.md` ("Resolution, preview and cost": a `### Dragging a pose` subsection), `AGENTS.md` (one architecture bullet after the `src/framework/core/` entry), `docs/KERNEL-CONTRACT.md:329` (the `implicit` row's cache sentence)
- Test: `test/framework/docs-coherence.test.js`, `test/domain-index.test.js`, `test/kernel-contract.test.js` (unchanged, must pass)

**Interfaces:**
- Consumes: everything above; `handSpec`/`nailSpecs` and `hand.js`'s part (`src/parts/hand.js`).
- Produces: `bench-pose-drag.mjs` (pattern of `scripts/bench-implicit.mjs`: CPU ms, `--core on|off|both`) printing, on the hand: (a) the deform time per update — `skinVertices` over the delivered payload of `hand.parts.hand.build(k, defaults)` at `curl 30 → 31`; (b) `bindVertices` cost on the body at 1.5 mm; (c) the exact rebuild — one-finger (`flexIndex 60 → 62`) and all-finger (`curl 30 → 32`) — cold (fresh kernel) and warm (second build), plus `k._sampleCache.stats()`; (d) the provisional stage's time to post versus the full union (`takeProvisionalPieces` + pieces' `toMesh` versus `toMesh` of the union).
- Produces (docs): `organic.md`'s subsection states what skins (a slider changing only `frames` of a canonical, unmoved `k.implicit` or `k.union` of them), what does not (`setParams`, animations, posed or moved results, shape changes), the 150 ms pause, the two-stage union, and the measured numbers from (a)–(d) with the machine noted; `AGENTS.md` names `src/framework/skin/` (main-thread only), the sample cache (`sample-cache.js`, `ip_sample_cached`, preview only, cold == warm) and the `meshes-provisional` stage; the KERNEL-CONTRACT row says the preview tier's cache key also carries the call's ordinal within its sub-part build (bindings are per call), print unchanged, no contract bump.

- [ ] **Step 1: Write the bench and run it** — `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node scripts/bench-pose-drag.mjs --core on` — Expected: a table with the four groups; the deform line under 16 ms (if not, say so in the docs and the PR rather than tune blindly); the warm one-finger rebuild below the cold one.

- [ ] **Step 2: Write the docs** (the numbers from Step 1) and add the `Measured` block below this plan's file structure table with the same numbers, the sample-cache hit share per case, and the date/machine.

- [ ] **Step 3: Run the docs and contract tests**

Run: `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run test/framework/docs-coherence.test.js test/domain-index.test.js test/kernel-contract.test.js test/framework/markdown.test.js`
Expected: all PASS (`npm run docs:domains` output unchanged — the manifest did not change).

- [ ] **Step 4: Run the whole suite once** — `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run` — Expected: PASS; in particular `test/verify-golden.test.js`, `test/implicit-cleanup.test.js`, `test/core-parity.test.js`, `test/core-wasm.test.js`, `test/worker-layering.test.js`.

- [ ] **Step 5: Commit** — `git add scripts/bench-pose-drag.mjs package.json docs/domains/organic.md AGENTS.md docs/KERNEL-CONTRACT.md docs/superpowers/plans/2026-10-31-implicit-pose-drag.md` ; `git commit -m "docs(organic): dragging a pose — bench, guide, architecture note"`

---

## Rulings made while reading the code (deviations from the brief, one line each)

- **Anchoring is tied to the cache, not the tier.** `test/implicit-cleanup.test.js:175` pins the vase's PREVIEW digest equal to its print digest (the probe skips decimation there), so `meshImplicit(…, { tier: "preview" })` without a cache must not move; only the kernel's preview path (which supplies a cache) anchors. Export bytes are untouched either way.
- **Leaf identity is the emitted program's bytes** (plus textures, world cell, edge, ownerK) — correct by construction, more conservative than the value-equality the scratch measurement counted: a contact root bakes the palm slot's bulge regions into every palm block's program, so a finger flex misses the palm's leaves. The bench reports the real hit share; pruning far regions per block is a later engine change (it would move pinned hashes).
- **Sample positions are `(base + gi) · edge` when anchored** — `origin + gi · edge` with two different origins is not bit-stable at a shared world point for a non-dyadic edge (the nails' 0.35), and cold == warm requires it. Unanchored plans keep the old formula, so nothing pinned moves.
- **Bindings are 1-based local frame indices encoded per CALL SLOT** (`slot · 1024 + local`, plus a check channel) and decoded to `"<call id>:<name>"` strings: a frame-name table cannot ride a Manifold object through transforms/hoisting, and the hand's six calls share every frame name. The preview solid's cache key therefore carries the slot; the oracle's one-bracket-per-view numbering may miss the display cache for a view's later implicit sub-parts (a perf cost only).
- **Skinnable structure is decided by the probe**, not by the worker: only a build whose final solid is a `k.implicit` or a `union` of unmoved implicit results (plus implicit-free operands), with no trailing rigid step and a canonical delivery, skins — a posed delivery or a moved/cut/mirrored implicit would deform in the wrong space.
- **The provisional stage uses Manifold's own laziness**: a synchronous observer inside `union()` cannot know whether the union is the sub-part's final solid or what rigid chain follows it, so the boolean-gate judgment is deferred to the first read and `jobs.js` asks for the pieces after the build returns. Only `generate` arms it.
- **On-screen captures mid-drag restore the exact base first (deformed) or throw (provisional)**; `captureView`, `inspect`, `exportPreview` and the change tracker already build exactly or wait for the whole view.

## Self-review notes

- Spec coverage: §1 bindings → Tasks 3–4; §2 detection → Task 5; §3 deforming → Task 6; §4 release/rebuild/stale-base/setParams → Task 7; §5 sample cache (JS + native + parity) → Tasks 1–2, two-stage → Task 8; Measuring → Task 9; every spec test has a named test above; anti-goals are Global Constraints with owning tests in Tasks 1, 2, 7, 8.
- Names used across tasks: `plan.base`, `leafKeys`, `createSampleCache`, `ip_sample_cached`, `compiled.frameNames`, `bindVertices`, `implicitCallId`, `stripFrames`, `encodeBindingProps`/`decodeBindings`/`mergeBindings`, `bindings = { frameA, frameB, weight, frames }`, `implicitSpecs`/`skinnable`, `framesOnlyChange`, `frameMotions`/`skinVertices`, `setSubVertices`, `markDirty({ delayMs })`/`delayKick`/`flush`, `createSkinDrag`, `SKIN_PAUSE_MS`, `setProvisionalUnions`/`takeProvisionalPieces`, `concatMeshPayloads`, `meshes-provisional`, `beforeCapture`.
