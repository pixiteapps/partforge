# Implicit Sharpen Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `k.implicit` mesh keeps the field's sharp edges and corners: a vertex sits on each one, in JS and in the native core with the same bytes.

**Architecture:** A new mesher stage, `sharpenMesh`, runs after cleanup (and after the crease cut on the owner path) and before detail. It splits each mesh edge whose two ends' field normals disagree at the point where their tangent planes meet, then splits edges that see three planes at the corner point. It is built and tuned in JS first, unwired. Then it is ported to the native core and wired into both paths in one task, so core parity never breaks between tasks.

**Tech Stack:** JavaScript (ES modules, vitest), C++ compiled to wasm (`native/`, `scripts/build-core-wasm.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-25-implicit-solid-node-design.md`, goal 3 and section "4. Sharp edges and corners (goal 3)". The prototype is `spike/exact-faces/sharpen.mjs`.

## Global Constraints

- The pass runs on every tree and both tiers. It has no option and no switch.
- JS and the native core give the same bytes (`test/core-parity.test.js`). Ported code uses `js-math.js` helpers (`hypot3`, `pfAtan2`), never `Math.hypot`, `Math.cos`, `Math.acos` or `Math.atan2` at run time. Constants are literals.
- Iteration order is fixed: edges in the order the triangle list first names them, new vertices appended in that order.
- It never moves or re-owns a held, pinned or crease vertex.
- The mesh stays closed and oriented: every directed edge has its reverse exactly once.
- No triangle may face against the field (a flip), and no triangle may be thinner than 0.001 mm, after the pass.
- Constants, in `sharpen.js`, named exactly: `SHARP_ANGLE_COS = 0.9063077870366499` (25°), `SHARP_TOL = 0.05` (cells), `SHARP_MAX_MOVE = 1.5` (cells), `SHARP_SNAP = 0.15` (edge fraction, the value of `CREASE_SNAP`), `SHARP_CORNER_DET = 0.05`. Task 3 may change a value; it then records the new value and its reason in the design's section 4.
- Docs and comments use short plain sentences. No dashes as punctuation.
- The package version becomes `0.206.0` in this branch (Task 6).
- Every task runs the whole suite (`npm test`) before it reports, and lists every failing test by name. A task may report failures that a later task owns only if this plan names them.
- Commits end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. No push.

## Review Focus

1. **The fade zone.** Where a sharp edge of a solid leaf runs into a blend, the true edge is a round that grows from zero radius. Expect a clean hand-over from sharp to rounded, with no spikes or stray triangles. Test in Task 3.
2. **A thin wall.** An `onion` shell 0.8 mm thick at a 1.0 mm grid. A crease point may move up to 1.5 cells, which is more than the wall. Expect no point placed on the wall's other face. Test in Task 1.
3. **A textured surface.** A knurl (`displace`) at a coarse grid has many edges past 25°. Expect a closed mesh, no flips, and triangle growth under 40%. Test in Task 3.
4. **A crease between two curved surfaces.** A sphere `intersect` a cylinder with `k: 0`. One tangent-plane step is not on the crease. Expect the kept points within `SHARP_TOL` cells of the field's zero set. Test in Task 1.
5. **A posed tree.** A contact root with frames, built for pose drag. Expect every per-vertex array of the result to have the new length, and the bindings and frame report to build. Test in Task 2.

---

### Task 1: `sharpenMesh`, edges only (JS, unwired)

**Files:**
- Create: `src/framework/geometry/implicit/sharpen.js`
- Create: `test/implicit-sharpen.test.js`
- Create: `test/helpers/implicit-stages.js`

**Interfaces:**
- Consumes: `cleanupMesh(store, raw, opts)` returns `{ positions: Float64Array, indices, normals: Float64Array, vertLeaf, ... }`. `normals` are the field's unit normals from the last projection. `store.leaves[L].prog` with `evalBatch(prog, store.textures, X, Y, Z, out)` (program.js) gives the field at points, as `crease.js`'s `evalPoints` does. `store.edge` is the grid edge.
- Produces: `export function sharpenMesh(store, mesh, { corners = true } = {})` returns a mesh of the same shape, every per-vertex array grown, plus `sharp: Uint8Array` (0 a mesher vertex, 1 an edge point, 2 a corner point) and `sharpPlanes` (for an edge point, the two vertex ids whose planes it joins; Task 2 uses it). A mesh with no candidate edge is returned as the same object.
- Produces: `test/helpers/implicit-stages.js` exports `jsStages(spec, edge, { tier, kernel })` returning `{ store, cleaned, compiled }`: `compileImplicit`, `planLeaves`, `evaluateLeaves`, `meshStore` or `meshStoreOwners`, `cleanupMesh`, and on the owner path `cutCreases`, exactly as `meshImplicit`'s JS branch does, stopping before `untangle` and detail. And `meshChecks(mesh, field)` returning `{ open, flips, slivers }`: unbalanced directed edges, triangles whose normal has a negative dot with the field gradient at their centre, triangles with shortest altitude under 0.001.

- [ ] **Step 1: Write the failing tests** in `test/implicit-sharpen.test.js`. Grid 0.6 and 1.0, preview tier, for each case below build `jsStages`, run `sharpenMesh(store, cleaned, { corners: false })`, and assert with `meshChecks` that `open === 0`, `flips === 0`, `slivers === 0`. Cases and extra assertions:
  - `box`: root `{ kind: "box", size: [40, 30, 6] }` (use the grammar's box fields). Triangle centres more than 1 cell from any corner lie within 0.005 mm of the exact box surface.
  - `plate-edge` and `bracket-corner` and `cylinder-side`: the trees and solids of `spike/exact-faces/sharpen.mjs`. Away from the blend's reach box (grown by 1.5) and more than 1 cell from a corner, the 99th percentile of centre distance to the exact union is at most 0.015 mm.
  - `cylinder-side` also: no vertex with `sharp === 1` lies more than 0.05 mm from a rim circle (`z = 0` or `z = 40`, `r = 12`) unless it is inside the reach box grown by 1.5. The cylinder's own facets are not sharpened.
  - `smooth`: two spheres `r: 10`, 12 apart, `union` with `k: 6`. `sharpenMesh` returns the same object.
  - `thin-wall`: `onion` of thickness 0.8 over a box 30 × 30 × 30, cut by a half-space so both faces show, grid 1.0. Every `sharp` vertex has the field within `SHARP_TOL` cells of zero, and its two plane vertices lie on the same wall face (their normals' dot with the sharp point's side is consistent: neither plane vertex is farther than 1.5 cells from the point).
  - `curved-crease`: sphere `r: 12` `intersect` cylinder `r: 8` along z, `k: 0`. Every `sharp` vertex has `|field| <= SHARP_TOL * edge`, and its distance to the circle `r = 8, |z| = sqrt(80)` is at most 0.02 mm.

- [ ] **Step 2: Run** `npx vitest run test/implicit-sharpen.test.js`. Expected: FAIL, `sharpenMesh` is not exported.

- [ ] **Step 3: Implement `sharpenMesh`.** For each edge (fixed order) with both ends free to cut (not `pinned`; arrays absent on the plain path mean free) and `dot(nA, nB) < SHARP_ANGLE_COS`:
  1. Start at the point nearest the edge's middle on both tangent planes (the prototype's 2 × 2 solve).
  2. Move it onto the field's zero set and both planes' crease: up to 10 Newton steps within the plane that holds the edge and the sum of the two normals, as `crease.js` step 3 does, re-reading the field and its gradient on each side. Evaluate with the first end's leaf program, or the other end's when the first gives a non-finite value.
  3. Keep it only if `|field| <= SHARP_TOL * edge`, it moved at most `SHARP_MAX_MOVE * edge` from the edge's middle, and the gradients just to each side of it (probe 0.02 cells along each plane, away from the other) still differ by more than the angle. The last test is what refuses a point on a thin wall's other face and a round the grid can resolve.
  4. If its parameter along the edge is under `SHARP_SNAP` or over `1 - SHARP_SNAP`, move that end there (each vertex at most once, never a held, pinned or crease vertex), else split the edge.
  5. Before committing a split or a move, form the triangles it makes. If any would be a flip (against the mean of its corners' normals) or thinner than 0.001 mm, drop that candidate.
  Subdivide as the prototype's `subdivide` does. A new vertex's `normals` entry is the unit sum of its two planes' normals; `vertLeaf` is its evaluating leaf.

- [ ] **Step 4: Run** `npx vitest run test/implicit-sharpen.test.js`, then `npm test`. Expected: the new file passes; the suite has no new failure (nothing is wired).

- [ ] **Step 5: Commit** `implicit: a sharpen stage for edges (JS, not wired)`.

### Task 2: Corners, and the owner path's arrays

**Files:**
- Modify: `src/framework/geometry/implicit/sharpen.js`
- Modify: `test/implicit-sharpen.test.js`

**Interfaces:**
- Consumes: Task 1's `sharpenMesh`, `sharp`, `sharpPlanes`. On the owner path the mesh also has `vertOwner`, `ownerHeld`, `pinned`, `crease` (crease.js).
- Produces: with `corners: true` (the default), corner points with `sharp === 2`. On an owner mesh, every one of `vertOwner`, `ownerHeld`, `pinned`, `crease` grown to the new length: a new vertex takes the owner of its evaluating end, and 0 for held, pinned and crease. `untangle(store, sharpenMesh(store, cutCreases(...)))` must run without error.

- [ ] **Step 1: Write the failing tests.**
  - `plate-edge` and `box` at 0.6 and 1.0: exactly 8 vertices with `sharp === 2`, each within 0.005 mm of a true box corner, and every true corner has one. `bracket-corner`: exactly 12, same rule. The worst centre distance away from the blend, corners included, is at most 0.02 mm.
  - All Task 1 mesh checks still hold with corners on.
  - `posed`: a contact root (two capsules with frames and a `gap`, copied from `test/implicit-crease.test.js`'s first fixture) plus a box child. After `cutCreases`, `sharpenMesh`, `untangle`: every per-vertex array has `positions.length / 3` entries, no vertex with `crease`, `pinned` or `ownerHeld` set has moved (compare positions before and after by index), and `meshChecks` is clean.
  - A mesh with detail: `applySurfaceDetail` on a sharpened box with a noise detail runs and returns a closed mesh.

- [ ] **Step 2: Run** the file. Expected: FAIL on the corner counts and the owner arrays.

- [ ] **Step 3: Implement the corner pass** as the design's step 3: an edge whose ends carry three distinct planes between them (distinct means `dot < SHARP_ANGLE_COS`; at least one end is a sharp vertex) is split where the three planes meet, if `|det| >= SHARP_CORNER_DET`, the two limits of Task 1 hold, and the split makes no flip or sliver. Corner points equal to 1e-5 mm are one vertex. Drop a triangle left with a repeated vertex. Then grow the owner arrays.

- [ ] **Step 4: Run** the file, then `npm test`. Expected: PASS, no new failure.

- [ ] **Step 5: Commit** `implicit: sharpen corners; carry the owner arrays`.

### Task 3: Hard cases, tuning and cost (JS)

**Files:**
- Modify: `src/framework/geometry/implicit/sharpen.js`
- Modify: `test/implicit-sharpen.test.js`
- Modify: `spike/exact-faces/sharpen.mjs` (call `sharpenMesh` in place of the prototype, keep the STL and measure code)
- Modify: `docs/superpowers/specs/2026-11-25-implicit-solid-node-design.md` (section 4: a "Stage numbers" table, and any changed constant)

**Interfaces:**
- Consumes: `sharpenMesh` with corners.
- Produces: final constant values. A measured cost.

- [ ] **Step 1: Write the failing or pinning tests.**
  - `fade`: `plate-edge` at 0.6. Inside the reach box, along the plate's top edge at `x = 30`: every `sharp` vertex has `|field| <= SHARP_TOL * edge`; no triangle with a `sharp` corner has an edge longer than 3 cells; `meshChecks` clean.
  - `knurl`: the `d-knurl` tree of `spike/solid-field/run.mjs` over a `solid` leaf cylinder, grid 0.6: closed, no flips, no slivers, triangles after at most 1.4 times before.
  - `cage`: the `cage-post` case of `spike/exact-faces/border.mjs` at 0.6: `sharp` vertices only within 2 cells of the post's bottom rim; mesh checks clean.
  - `offset`: `offset` `d: -2` over a `solid` leaf box 40 × 30 × 20, grid 0.6: 8 corner points within 0.01 mm of the shrunk box's corners. `offset` `d: 2` over the same: zero `sharp` vertices (a grown box has round edges of radius 2).
  - `print`: `plate-edge` at the print tier (`tier` unset), grid 0.3: mesh checks clean, 99th percentile at most 0.01 mm.

- [ ] **Step 2: Run, then fix or tune** until they pass. Change a constant only with a measured reason.

- [ ] **Step 3: Measure cost.** Time `sharpenMesh` alone and the JS stages before it (CPU ms, median of 3) for `plate-edge`, `bracket-corner`, `cylinder-side`, `knurl` at 0.6 preview. The target is under 10% of the stages before it. If it is over, reduce field calls (reuse `mesh.normals`; evaluate only candidate edges) and measure again. Write the table into the design's section 4 as "Stage numbers".

- [ ] **Step 4: Run** `node spike/exact-faces/sharpen.mjs <dir>` and `node spike/exact-faces/render-stl.mjs <dir>`; read the three pictures; say in the report what each shows at the fade zone.

- [ ] **Step 5: Run** `npm test`. Expected: no new failure. **Commit** `implicit: sharpen stage tuned on the fade, knurl, cage, offset and print cases`.

### Task 4: Native port and wiring

**Files:**
- Modify: `native/implicit_mesh.cpp`, `native/implicit_mesh.h`, `native/implicit_owner.cpp` (or a new `native/implicit_sharpen.cpp` listed in `scripts/build-core-wasm.mjs`), `native/README.md`
- Regenerate: `src/framework/core/core-full-wasm.js` (`node scripts/build-core-wasm.mjs`)
- Modify: `src/framework/geometry/implicit/index.js`, `src/framework/core/implicit-core.js`, `src/framework/geometry/implicit/result.js`
- Modify: `test/core-parity.test.js`

**Interfaces:**
- Consumes: `sharpenMesh(store, mesh)`.
- Produces: `meshImplicit`'s JS branch becomes cleanup, then on the owner path `cutCreases`, then `sharpenMesh`, then on the owner path `untangle`, then detail. The core runs the same stage at the same place. The result's `stats` gain `sharpEdges` and `sharpCorners` (counts). `sharp` and `sharpPlanes` do not leave the engine.

- [ ] **Step 1: Write the failing parity tests**: for `box`, `plate-edge`, `bracket-corner`, `curved-crease`, `posed` and `knurl`, at preview 0.6 and print 0.3, `meshImplicit` with the core on and off gives equal `positions`, `indices` and `normals` bytes, and `stats.sharpEdges > 0` except where Task 1 to 3 expect none.
- [ ] **Step 2: Run.** Expected: FAIL (`stats.sharpEdges` undefined).
- [ ] **Step 3: Wire the JS branch and port the stage to C++**, operation for operation, in the style of the crease stage in `native/implicit_owner.cpp`. Rebuild the wasm. Report the full core's size change in gzipped bytes.
- [ ] **Step 4: Run** `npx vitest run test/core-parity.test.js test/implicit-sharpen.test.js`, then `npm test`. Expected: the two files pass. The suite's remaining failures are only tests that pin an implicit mesh's bytes, counts, volumes or pictures (Task 5 owns them). List each by name. Any other failure is this task's to fix.
- [ ] **Step 5: Commit** `implicit: the sharpen stage in the native core, wired into both paths`.

### Task 5: Re-record what the new meshes change

**Files:**
- Modify: the failing tests and fixtures Task 4 listed (for example `test/fixtures/verify-golden.json`, via `PARTFORGE_RECORD_VERIFY_GOLDEN=1 npx vitest run test/verify-golden.test.js`)

**Interfaces:**
- Consumes: the wired stage.
- Produces: a green suite.

- [ ] **Step 1:** For each failing test, decide which it is: (a) a pin of bytes, a count or a volume that moved because edges are now sharp; (b) a real defect the stage causes. For (a), re-record or update the value, and check the direction makes sense: a volume moves toward the exact shape's volume, a triangle count grows by under 15% (40% for a textured part). For (b), stop and report it as BLOCKED with the case.
- [ ] **Step 2:** Run `npm test`, `npm run lint`, `npx knip` (or the repo's dead-code script). Expected: all pass, lint 0 errors.
- [ ] **Step 3:** In the report, give a table: test, what was pinned, old value, new value.
- [ ] **Step 4: Commit** `tests: re-record implicit meshes with sharp edges`.

### Task 6: Docs, bench and version

**Files:**
- Modify: `docs/domains/organic.md`, `docs/KERNEL-CONTRACT.md`, `AGENTS.md` (only where they say sharp edges soften to the grid), `package.json` and its lock file (`0.206.0`), `scripts/bench-implicit.mjs` (print the sharpen stage's ms), the design's section "5. Cost" (one new table from `node scripts/bench-implicit.mjs --core both`)

- [ ] **Step 1:** Find every sentence that says an implicit result's sharp edges soften, round or go rough at the grid (`grep -n -i "soften\|softens\|sharp edge" docs AGENTS.md`). Replace each with what is true now: sharp edges and corners of the field are kept; a flat face is still meshed at the grid; an edge rounder than the grid can show is drawn sharp below about 0.1 cell. Add no new name to the agent's surface.
- [ ] **Step 2:** Add the 0.206.0 paragraph to `docs/KERNEL-CONTRACT.md` in the form of the 0.205 one: what changed, that meshes of existing implicit parts change, that it has no option.
- [ ] **Step 3:** Bump the version. Run the docs parity tests and `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `organic: implicit meshes keep sharp edges and corners (0.206.0)`.
