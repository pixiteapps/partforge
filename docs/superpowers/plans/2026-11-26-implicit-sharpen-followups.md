# Implicit Sharpen Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sharpen stage cheap on parts with few sharp edges, remove the inward-facing triangles the cleanup stage leaves on rims, and place and reach the corners the stage gets wrong or misses today.

**Architecture:** Four independent changes to the implicit mesher, each in JS and in the native core with the same bytes. Task 1 changes no output and is proved by the existing parity tests and digests. Tasks 2 to 4 change meshes; each ends with a green suite, with every moved pin re-recorded and explained in the same task.

**Tech Stack:** JavaScript (ES modules, vitest), C++ compiled to wasm (`native/`, `scripts/build-core-wasm.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-25-implicit-solid-node-design.md`, section "4. Sharp edges and corners (goal 3)", and its new subsection "Follow-ups (0.207)" added by Task 1. The final review of the sharpen pass is the source of every finding here: `.superpowers/sdd/2026-11-26-implicit-sharpen-followups/evidence/final-review.md`, with its scripts under `evidence/final/`.

## Global Constraints

- JS and the native core give the same bytes (`test/core-parity.test.js`). Ported code uses `js-math.js` helpers, never `Math.hypot`, `Math.cos`, `Math.acos` or `Math.atan2` at run time. Constants are literals, mirrored in the constants probe (`ip_sharpen_constants`, `test/implicit-sharpen-native.test.js`).
- Iteration order is fixed. No dependence on container iteration order other than insertion order. The native build must not contract to fused multiply-add (it does not today; keep the flags).
- The sharpen stage has no option and no switch. No new name in the agent-facing API.
- The stage never moves or re-owns a held, pinned or crease vertex. The mesh stays closed and oriented, with no pinched vertex and no two vertices within 1e-6 mm. The stage makes no flipped triangle and no sliver, and leaves no more of either than it was given.
- Every task runs the whole suite (`npm test`), `npm run lint`, `npx knip` and `node scripts/build-core-wasm.mjs --check` before its last commit, and lists every failing test by name. A task that changes meshes re-records the pins it moves in the same task, with old and new values in its report, and checks each moves in the right direction.
- `node scripts/build-core-wasm.mjs` takes no flag other than `--check`. Any other flag rebuilds.
- Docs and comments use short plain sentences. No dashes as punctuation. The agent-facing guide (`docs/domains/organic.md`) says what an author gets and what it costs, not how a stage works inside.
- The package version becomes `0.207.0` (Task 5).
- Commits end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. No push.

## Review Focus

1. **A part with no sharp edge at all.** Two blended spheres. Task 1 must leave the stage's cost near zero there, and Tasks 2 to 4 must not touch its bytes beyond what cleanup's fix changes.
2. **A posed contact root.** The owner path has held, pinned and crease vertices. Every task's tests include the `posed` fixtures of `test/implicit-sharpen.test.js` at gap 0 and 0.05.
3. **A rim that is meant to be sharp.** Task 2 removes inward-facing triangles on a cylinder's rim. It must not round the rim or move it: the rim's sharp points stay within the limits `test/implicit-sharpen.test.js` already sets for `cylinder-side`.
4. **A corner that is not there.** Task 3 must stop placing corner points beside a curved crease where no three faces meet (a box minus a cylinder, a cut torus), without losing a real corner on the box sweep.
5. **A flip next to a sharp corner.** Task 4 re-pairs triangles around a new corner vertex. A re-pair must never make a triangle that faces into the solid, on a thin shell above all (`onion` of a box with a cut).

---

### Task 1: Make the sharpen stage's bookkeeping local

**Files:**
- Modify: `src/framework/geometry/implicit/sharpen.js`, `sharpen-corners.js`, `sharpen-mesh.js`
- Modify: `native/implicit_sharpen.cpp`; regenerate `src/framework/core/core-full-wasm.js`
- Modify: `scripts/bench-implicit.mjs` (only if a row is missing), `docs/superpowers/specs/2026-11-25-implicit-solid-node-design.md`
- Test: `test/implicit-sharpen.test.js`, `test/core-parity.test.js` (no assertion may change)

**Interfaces:**
- Consumes: `sharpenMesh(store, mesh, opts)` and its `stats` sink.
- Produces: the same function with the same output bytes on every input. No new export.

Background, measured by the final review on the hand at a 0.8 mm print grid (347 candidates in 264,580 vertices, stage 218 ms, 30% of the stages before it, core on): field reads are about 1% of the stage. The time is whole-mesh work that runs up to four times (two edge rounds, two corner passes): the edge scan and array copies about 30%, filing every vertex in the apart grid 17%, re-triangulating every triangle 13%, garbage collection 10%, corner scans 9%.

- [ ] **Step 1: Pin the bytes before changing anything.** Add a test (or extend the parity file) that records a digest of positions, indices and normals of the JS stage's output for: `box`, `plate-edge`, `bracket-corner`, `cylinder-side`, `curved-crease`, `cage`, both `offset` cases, `knurl` at 0.6 and at print 0.3, the mixed knurl plus box part, the two `posed` gaps, the hand at preview and at 0.8 mm print, the vase, and two blended spheres. These digests are the proof for this task. Record them at HEAD and commit that test first.
- [ ] **Step 2: Measure.** With `scripts/bench-implicit.mjs --core both` and a JS profile, write the stage's time per case and where it goes, for the hand at 0.8 mm, the hand at preview, `plate-edge`, the vase and two blended spheres.
- [ ] **Step 3: Make each whole-mesh step proportional to the candidates.** In this order, measuring after each: (a) a round with no candidate past the angle test returns before any copy; (b) the apart grid files only the cells a lookup asks about, or only vertices within reach of a candidate, with the same answers; (c) subdivision rewrites only the triangles a split or move touched and copies the rest in one block; (d) the second edge round and both corner passes scan only the fans of vertices the first round changed or marked; (e) arrays grow in place, not by copy per round. Each change keeps Step 1's digests. Mirror each in C++ in the same commit and keep `test/core-parity.test.js` green.
- [ ] **Step 4: Targets.** With the core on, stage time as a share of the stages before it: hand at 0.8 mm print under 8% (from 30%); hand at preview under 4% (from 6%); two blended spheres under 1%; `plate-edge` and `bracket-corner` no worse than today (18.2% and 16.9% wall). The vase and the knurl are not expected to move; report them. If a target is missed, report the breakdown; do not change output to reach it.
- [ ] **Step 5:** Add a subsection "Follow-ups (0.207)" to the design's section 4 with one paragraph for this task and the before and after table. Run the Global Constraints checks. **Commit** `implicit: the sharpen stage's bookkeeping follows its candidates (no change in output)`.

### Task 2: Cleanup leaves no inward-facing rim triangles

**Files:**
- Modify: `src/framework/geometry/implicit/cleanup.js` (and `project.js` only if the cause is there)
- Modify: `native/implicit_mesh.cpp`, `native/implicit_owner.cpp` (the cleanup stages); regenerate the wasm
- Modify: `test/implicit-cleanup.test.js`, `test/implicit-solid-messy.test.js`, and every test whose pin moves
- Modify: `docs/ERROR-PATTERNS.md` and `docs/domains/organic.md` only where they describe folded `k.implicit` solids

**Interfaces:**
- Consumes: `cleanupMesh(store, raw, opts)`.
- Produces: the same function. A cleaned mesh has no pair of triangles sharing an edge whose normals have dot below −0.5 ("fold edge") that the raw mesher output did not have.

Background: for `offset` 0.5 over a `solid` leaf of a box unioned with a cylinder, at grid 0.5, fold edges count 0 in the raw mesher output, 13 after cleanup, and 8 after sharpen. They sit on the cylinder's top rim. A tapered cylinder has 34 folded triangles at print 0.8. They make a `k.implicit` result's own signed distance wrong along rays out of those triangles, so 16 of 82 such results carried folds when used as a `solid` leaf. Evidence scripts: `evidence/final/fold*.mjs`, `evidence/rr7/`.

- [ ] **Step 1: Find the cause.** Using `jsStages`, count fold edges after each sub-step of cleanup (the first projection, each relax and re-projection, decimation on the preview tier, the final projections) on the box-and-cylinder offset at 0.5 and the tapered cylinder at print 0.8. Name the sub-step that makes them and why (for example a relax that drags a rim vertex across its neighbour, or a projection that lands two vertices on the same side of a crease). Write it in the report before changing code.
- [ ] **Step 2: Failing tests.** A helper `foldEdges(mesh)` in `test/helpers/implicit-stages.js`. Assert zero fold edges after `cleanupMesh`, on both tiers, for: the box-and-cylinder offset at 0.5 and 0.3; a tapered cylinder at 0.5, 0.8 and 1.2; a twisted box at 0.5 and 1.2; wedges of 25°, 30° and 40°; `cylinder-side`; the two `posed` gaps. Run them: they fail on the cases above.
- [ ] **Step 3: Fix the cause** in JS and in C++, same bytes. The fix belongs in the sub-step that makes the folds (for example refusing a relax or projection move that flips a triangle of the vertex's fan), not in a repair pass afterwards. It must not move a held or pinned vertex and must not add a field read per vertex on the common path.
- [ ] **Step 4: Check what else moved.** Every implicit mesh may change. Run the suite; for each failing pin decide moved-for-a-good-reason or defect, as the sharpen pass's Task 5 did, and re-record. Then: the sharpen tests keep their limits and corner counts (the box sweep's parked list may shrink; update it only with the measured result); `test/implicit-solid-messy.test.js`'s pins for the wedge, fin and blade are re-measured; re-run `evidence/final/fold.mjs`'s 82-leaf census and report how many `k.implicit` results still carry folds (target: none from cleanup).
- [ ] **Step 5:** Cost: cleanup's time must not grow by more than 5% on the bench cases. Update the two docs sentences if `k.implicit` results no longer carry folds. Global Constraints checks. **Commit** `implicit: cleanup makes no inward-facing rim triangles`.

### Task 3: Place a corner on its three faces

**Files:**
- Modify: `src/framework/geometry/implicit/sharpen-corners.js`, `sharpen.js` (constants only if needed)
- Modify: `native/implicit_sharpen.cpp`; regenerate the wasm; extend the constants probe
- Modify: `test/implicit-sharpen.test.js`, `test/implicit-near-miss-sweep.test.js`

**Interfaces:**
- Consumes: the corner passes of `sharpenMesh`.
- Produces: the same passes. A corner point is solved on the field: the point where the three faces' tangent planes meet, each plane read from the field's gradient on its own side close to the point, repeated until the move is small, as the edge round's Newton move does for two faces.

Background: the first corner pass takes one of its three planes from a rough mesher normal up to half a millimetre away. On the organic hand (near-miss sweep case `fingerBlend 2, spread −3.4718`) three palm creases meet at (5.8486, −31.3302, 13.1309) and the stage's corner vertex is 0.255 mm along a crease from there, 0.0504 mm off the field. On the vase four corner points sit 0.017 to 0.139 mm beside a curved crease where no three faces meet. The final review saw a box minus a cylinder get 9 corner points and a cut torus 2.

- [ ] **Step 1: Failing tests.** (a) The near-miss hand case: the corner vertex is within 0.02 mm of (5.8486, −31.3302, 13.1309). (b) A box minus a through cylinder (`subtract`, `k: 0`), grids 0.6 and 1.0: exactly 8 corner points, each within 0.005 mm of a box corner. (c) A torus cut by a half-space: 0 corner points. (d) The vase spec of `test/implicit-cleanup.test.js`: every corner point has three distinct face normals within 0.05 cells of it, read from the field (write the check as a helper: sample the gradient on a small sphere around the point and cluster). (e) The box sweep and every existing corner test keep passing.
- [ ] **Step 2: Implement the solve.** A candidate keeps its three seed planes only as a start. Each step reads the gradient on each of the three sides near the current point (offset along the other two planes' intersection directions, as the edge round offsets along its crease's side), solves the three planes, and moves, with the same cap and tolerance style as the edge round. Keep it only if the three side gradients, read at the final point, are pairwise more than the angle apart and the field is within tolerance. That last test is what refuses a point beside a curved crease. Order and tie rules of grouping and merging do not change.
- [ ] **Step 3:** If (a) passes, put `test/implicit-near-miss-sweep.test.js`'s limit back to 0.05 mm if the measured worst vertex allows it; say what it measured.
- [ ] **Step 4:** Cost: the corner passes' time on `plate-edge`, `bracket-corner` and the vase, before and after. Global Constraints checks; re-record moved pins with reasons. **Commit** `implicit: a sharpen corner is solved on its three faces`.

### Task 4: Reach a corner the triangle layout blocks

**Files:**
- Modify: `src/framework/geometry/implicit/sharpen-corners.js`, `sharpen-mesh.js`
- Modify: `native/implicit_sharpen.cpp`; regenerate the wasm
- Modify: `test/implicit-sharpen.test.js`

**Interfaces:**
- Consumes: the corner passes after Task 3.
- Produces: one more try at the end of a corner's try list: re-pair the two triangles across an edge (an edge flip) when that removes the triangle that blocks the corner vertex.

Background: on the box sweep 4 of 114 boxes miss one corner (grid 0.6 at 8 and 9 cells, grid 1.0 at 3 and 4 cells, offset 0.37/0.11/0.73). The corner point is found exactly, but the mesher's bevel joins a vertex on one face straight to a point on the crease above it, so any split or move that puts a vertex on the corner leaves a triangle cutting through the solid. The final review also saw a cut `onion` box and a bent box find 7 of 8.

- [ ] **Step 1: Failing tests.** The sweep's `ONE_CORNER_CUT` list becomes empty: all 114 boxes have exactly 8 corners. A cut `onion` box (the `thin-wall` fixture's shape with all 8 outer corners in view) and a bent box (`bend` warp over a 40 × 10 × 10 box, grids 0.6 and 1.0) find 8 of 8. All pass `expectSound`.
- [ ] **Step 2: Implement the flip try.** When every existing try for a corner fails the flip or sliver check, find the failing triangle, and for each of its edges not on a crease try re-pairing the two triangles on that edge, then the try list again, at most two flips per corner. A flip is allowed only when: neither triangle has a held, pinned or crease vertex on the flipped edge; the new edge does not already exist; both new triangles pass the flip and sliver checks and the field flip check; no vertex becomes pinched. Fixed order: triangles and edges in index order, first success wins.
- [ ] **Step 3:** If some case still cannot reach 8, report it with the reason and pin it by name, as the sweep does today. Do not loosen `expectSound`.
- [ ] **Step 4:** Global Constraints checks; re-record moved pins with reasons. **Commit** `implicit: a sharpen corner can re-pair the triangles that block it`.

### Task 5: Docs, bench and version

**Files:**
- Modify: `docs/domains/organic.md`, `docs/KERNEL-CONTRACT.md`, `docs/ERROR-PATTERNS.md`, `package.json`, `package-lock.json`, the design's sections 4 and 5

- [ ] **Step 1:** Re-run `node scripts/bench-implicit.mjs --core both` and add one dated table to the design's section 5 as the current one.
- [ ] **Step 2:** In the guide, correct every sentence the four tasks made untrue: the cost figures (measured, with their cases named), the corner limits, the folded `k.implicit` leaf sentences. State what is still a limit.
- [ ] **Step 3:** A 0.207.0 paragraph in `docs/KERNEL-CONTRACT.md` in the form of the 0.206 one: what changed, that implicit meshes change again, that nothing is optional. Bump the version.
- [ ] **Step 4:** Global Constraints checks. **Commit** `organic: cheaper sharpening, clean rims, better corners (0.207.0)`.
