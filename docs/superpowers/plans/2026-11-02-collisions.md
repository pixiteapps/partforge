# Collisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pieces stay solid in Pose mode (a dragged finger slides along the palm instead of passing through it), and the agent can sweep a declared motion and learn whether it stays clear, how close it gets, where it first touches and what was moving.

**Architecture:** One pure collision layer (`src/framework/collide/`) indexes each sub-part's mesh once in its own frame and measures pair distances under placement matrices from the existing place-scope pose probe. Pose mode feeds it the viewer's delivered meshes; per drag frame it picks a few nearby pairs, linearises their contact once per solver iteration as residual rows, then enforces a hard "never move in" guarantee. The oracle feeds it built meshes to step declared motions for `measure`/`verify`.

**Tech Stack:** Plain ESM JavaScript, vitest, Node 24 (`nvm use`; if `source nvm.sh` is blocked, PATH-prefix `~/.nvm/versions/node/v24*/bin`), Playwright Chromium for `check-pose`/`bench:pose`.

**Spec:** `docs/superpowers/specs/2026-11-02-collisions-design.md` (revised after review — read "Pose mode: collision in the solver" in full).

## Global Constraints

- A part with no `collisions` block and no `verify.sweeps` behaves exactly as today: Pose mode, goal drags, `measure`, `verify`.
- `test/verify-golden.test.js` passes unchanged through Task 8; Task 9 re-records it once (`PARTFORGE_RECORD_VERIFY_GOLDEN=1`) and the diff touches only hand, drawer-box and gearbox.
- Default clearance is `CONTACT_EPS` (1e-3 mm). Pair names are `pairKey(a, b)` (`"a×b"`). Both move to an import-free leaf (Task 1) that `oracle/gaps.js` re-exports.
- Everything under `src/framework/collide/` and `src/framework/oracle/sweep.js` is DOM-free, three-free, `node:`-free, and loaded lazily by the worker (`test/worker-layering.test.js`). Lint's closure must not reach `oracle/bvh.js` or `core-wasm.js`.
- The new BVH query is JS-only, reaching a core index through `jsIndex()`. Do not touch `native/` or `core-wasm.js`; `test/core-parity.test.js` and `test/core-wasm.test.js` must pass.
- `solveDLS` with no `onIteration` hook is bit-identical to today (`test/solve-dls.test.js`, `test/pose-param-solve.test.js` untouched).
- Panel sliders are never blocked by collision.
- A pair inside clearance, or wholly inside, when a drag starts may move out, never further in.
- Constants: `COLLIDE_BAND_MM = 2`, `COLLIDE_WEIGHT = 100`, `MAX_ROWS = 8`, `MAX_SUBSTEPS = 32`, `SETTLE_BISECTIONS = 12`.
- Performance gate (Task 6): on the hand, p95 drag frame < 16 ms and ≤ 1.5× the Task 1 baseline p95, same machine, including a drag held against contact.
- Bump `package.json` from `0.180.0` to `0.181.0` in Task 9.

## Review Focus

1. **A drag that starts overlapping or wholly inside** (a preset, a saved pose): moves freely away. Tests in Task 4 (`exempts a pair inside at begin`, `exempts a pair wholly inside at begin`).
2. **A fast flick** across a thin piece: never ends inside; the drag lags instead. Test in Task 4 (`settle caps sub-steps and stops short`).
3. **A real pin joint turning**: a drag in open air solves exactly as without collisions. Test in Task 5 (`hand pin pairs leave an open-air solve unchanged`, on the real hand, through the full knuckle range).
4. **A goal dragged out of reach** on an opted-in arm: still reads "missed by". Test in Task 5 (`open-air goal drag writes the goal directly`).
5. **Sub-parts the viewer cannot pose by matrix**, or not indexed yet: excluded, never a throw. Test in Task 6 (`matricesAt returns null for posed and untrusted names`, `drag before the index is ready runs guard-only`).

---

### Task 1: Collision declaration, lint, the pair leaf, and the pose baseline

**Files:**
- Create: `src/framework/collide/pairs.js` (import-free: `CONTACT_EPS`, `pairKey` moved here from `oracle/gaps.js`)
- Modify: `src/framework/oracle/gaps.js` (re-export both from `../collide/pairs.js`)
- Create: `src/framework/collide/declaration.js`
- Create: `src/framework/lint/rules-collisions.js`; Modify: `src/framework/lint/index.js` (register)
- Modify: `types/part.d.ts` (`collisions?: CollisionsBlock` beside `handles?`, ~line 923)
- Test: `test/collide-declaration.test.js`, `test/lint-collisions.test.js`

**Interfaces:**
- Produces: `normalizeCollisions(part) → { clearance: number, allow: Set<string>, pose: boolean } | null` (null when `part.collisions` is absent; `clearance` defaults to `CONTACT_EPS`, `pose` to `true`); `isAllowed(decl, a, b) → boolean`.
- Declaration type: `{ clearance?: number; allow?: string[]; pose?: boolean }`.

- [ ] **Step 1: Record the Pose baseline.** Run `npm run bench:pose -- --json docs/research/collisions-pose-baseline.json`; commit it with the hand's p95 and the arm's derives/frame in the message.
- [ ] **Step 2: Write failing tests.**
  - `normalizes an absent block to null`; `defaults clearance and pose` (`{ clearance: 1e-3, pose: true }`, empty `allow`); `allow is order-insensitive`.
  - lint `collisions-unknown-part` (error, names the entry), `collisions-bad-pair` (error: no `×`, or the same part twice), `collisions-bad-clearance` (error: `-1`, `"x"`).
  - `lint does not reach the BVH`: add `src/framework/lint/rules-collisions.js` to the lint closure check in `test/worker-layering.test.js` (or the lint layering test that exists) asserting no `oracle/bvh.js` / `core-wasm.js` in its import closure.
- [ ] **Step 3: Run** `npx vitest run test/collide-declaration.test.js test/lint-collisions.test.js` — FAIL.
- [ ] **Step 4: Implement** `pairs.js`, the re-export, `declaration.js` (imports `pairs.js` only), and the rules (`lint/finding.js`'s `error`).
- [ ] **Step 5: Run** them, then `npm test` — PASS.
- [ ] **Step 6: Commit** `feat(collide): the collisions declaration and its lint rules`.

### Task 2: Distance between two indexes under matrices

**Files:**
- Modify: `src/framework/oracle/bvh.js` (beside `distanceTo`, ~line 576; add to the returned object)
- Modify: `types/oracle.d.ts` if `buildBVH`'s result type is declared there
- Test: `test/bvh-posed.test.js`

**Interfaces:**
- Produces: on every `buildBVH` result, `distanceToPosed(other, mSelf, mOther) → { distance, at, pointA, pointB }`. `mSelf`/`mOther` are column-major rigid `mat4`s (`geometry/pose.js`'s convention) placing each mesh in a shared frame; `at`/`pointA`/`pointB` are in that frame. Identity matrices give `distanceTo`'s distance exactly.
- Produces: `insideOf(other, mSelf, mOther) → boolean` — whether `self`'s first vertex, placed by `mSelf`, lies inside `other` placed by `mOther` (odd ray-crossing count along +X through `other.raycast`; for a ray that grazes an edge, retry along a second fixed direction).

- [ ] **Step 1: Write failing tests.**
  - `identity matches distanceTo`; `matches pre-transformed meshes` (20 seeded rigid transforms of a sphere and a box, `|Δ| < 1e-6`, `at` within 1e-6); `touching reads 0`; `core index` (a core-backed index on one side → same result).
  - `insideOf`: a 2 mm cube centred in a 20 mm cube → true; offset 30 mm → false; under a rotation of both → unchanged.
- [ ] **Step 2: Run** `npx vitest run test/bvh-posed.test.js` — FAIL.
- [ ] **Step 3: Implement.** Traverse in `self`'s frame with `R = invertRigid(mSelf) · mOther`: an `other` node's box is the AABB of its 8 corners under `R`; `other`'s leaf triangles are transformed by `R` into a scratch buffer before `triTriDist`. Map result points back by `mSelf`. Same pruning and descent order as `distanceTo`.
- [ ] **Step 4: Run** it plus `npx vitest run test/bvh.test.js test/core-parity.test.js test/core-structures.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(oracle): BVH distance and inside test under placement matrices`.

### Task 3: The collision world

**Files:**
- Create: `src/framework/collide/world.js`
- Modify: `src/framework/preview-animation.js` (import the shared `placePoses` rule from `world.js`)
- Test: `test/collide-world.test.js`

**Interfaces:**
- Consumes: Tasks 1–2; `buildBVH`, `disposeBVHs`.
- Produces:
  - `createCollisionWorld({ meshes, decl }) → world`; `meshes: Map<name, { positions, indices }>` in each sub-part's own frame.
  - `world.distances(mats, { names, within, limit }) → [{ a, b, distance, at, pointA, pointB, normal }]`: `mats: Map<name, mat4 | null>` (null = excluded); only non-allowed pairs with a name in `names` (default all), whose matrix-moved boxes are within `within` mm (default `Infinity`); nearest first, at most `limit` (default all). `normal` is the unit vector `pointA − pointB` (null at distance 0).
  - `world.inside(mats, a, b) → boolean` (via `insideOf`, both directions).
  - `world.travel(matsA, matsB, names) → number`: the largest displacement in mm of any corner of any named sub-part's box between the two pose sets.
  - `world.boundsOf(name)`, `world.dispose()`.
  - `placeMatrix(sp, view, p, d) → mat4 | null`: `probeSubPartPose(sp, { view, purpose: "display", p, d }, { scope: "place" })` composed; null when untrusted, `baseHash !== CANONICAL`, or `!isRigid`. This is the shared rule `preview-animation.js`'s `placePoses` uses.
  - `poseMatrices(part, view, p, d, { deltas }) → Map<name, mat4 | null>`: `placeMatrix` per in-view sub-part on an ALREADY RESOLVED `(p, d)` (never re-derives), times `deltas.get(name)` when given.
  - `relativeMatsAt(part, view, startP, startD) → (p, d) → Map`: for meshes built posed at the start (`buildView`/`buildPosed`): `poseMatrices(p, d) · invertRigid(poseMatrices(startP, startD))`.

- [ ] **Step 1: Write failing tests** on hand-built cube meshes: `distances honours allow`; `within prunes far pairs` (10 mm apart: `within: 2` → `[]`, `within: 20` → distance 10); `limit keeps the nearest`; `null matrix excludes a name`; `normal points from b to a`; `travel of a 90° turn` (corner arc chord); `poseMatrices on the drawer box` (`drawer1Open: 50` moves `drawer1` by `[0, −0.5·(depth−10), 0]`); `poseMatrices does not call derive` (a derive spy counts 0 calls); the existing `test/preview-animation.test.js` still passes.
- [ ] **Step 2: Run** `npx vitest run test/collide-world.test.js` — FAIL.
- [ ] **Step 3: Implement** `world.js` and the `preview-animation.js` import.
- [ ] **Step 4: Run** it plus `test/preview-animation.test.js test/worker-layering.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(collide): the collision world`.

### Task 4: The drag guard

**Files:**
- Create: `src/framework/collide/guard.js`
- Test: `test/collide-guard.test.js`

**Interfaces:**
- Consumes: Task 3.
- Produces: `createDragGuard({ world, matsAt, start, moving, clearance }) → guard`. `matsAt(params) → Map<name, mat4|null>`; `start` the drag's snapshot params; `moving` the names whose placement the handle's DOFs after locks (`dofsOf` in `param-solve.js`, exported) can change.
  - At creation: pairs inside clearance, or `world.inside`, at `start` are exempt until they open past clearance once. Pairs whose start distance is below `COLLIDE_BAND_MM` are guard-only (never rows).
  - `guard.beginFrame(params)`: picks this frame's rows — non-exempt, non-guard-only pairs with a moving name, within `clearance + BAND + lastTravel` at `params`, nearest `MAX_ROWS`. `guard.rowCount` is fixed until the next `beginFrame`.
  - `guard.linearise(params)`: one `world.distances` query for the current rows; stores each row's `pointA`/`pointB` mapped into its own mesh frame (by the inverse of its matrix at `params`) and its normal. Called from `solveDLS`'s `onIteration`.
  - `guard.rows(params) → Float64Array(rowCount)`: per row `COLLIDE_WEIGHT · max(0, margin − n·(M_a·p_a − M_b·p_b))`, `margin = clearance + BAND`, matrices from `matsAt(params)` only (no BVH query).
  - `guard.isClear(params) → boolean`: no non-exempt pair (rows and guard-only alike) inside `clearance`.
  - `guard.settle(from, to, { blend }) → { params, blocked: { a, b } | null }`: `blend(t) → params` (default linear between `from` and `to`); sub-steps so no step's `world.travel` exceeds `BAND / 2`, at most `MAX_SUBSTEPS`; at the first unclear step bisects `SETTLE_BISECTIONS` times and returns the last clear params with the blocking pair; if the cap is hit while still clear, returns the last checked step (the drag lags). Updates exemptions.
  - Exports `COLLIDE_BAND_MM`, `COLLIDE_WEIGHT`, `MAX_ROWS`, `MAX_SUBSTEPS`, `SETTLE_BISECTIONS`, and `COLLIDE_IN_SOLVE = true` (Task 6's fallback switch).

- [ ] **Step 1: Write failing tests** with a fixture part: a `bar` rotating by `p.angle` about a pin over a fixed `palm` slab, contact at 60°.
  - `rows are zero far from contact` (0°); `rows rise inside the band` (58°); `rows match exact distances near the linearisation point` (at 58°, `rows` after `linearise(58)` vs `COLLIDE_WEIGHT·(margin − world distance)` at 58.5°, within 2%).
  - `settle stops at the surface`: `settle(0 → 90).params.angle` in `[59.5, 60]`, `blocked` names the pair.
  - `settle caps sub-steps and stops short`: a thin bar through a thick slab, `settle(0 → 180)` never returns a point past first contact, and with contact removed returns a point short of 180 when 180° needs more than 32 sub-steps.
  - `exempts a pair inside at begin`: start at 70°; `settle(70 → 80)` and `settle(70 → 50)` pass; then `settle(50 → 80)` stops at ~60.
  - `exempts a pair wholly inside at begin`: a small cube starting inside the slab moves out freely.
  - `a pair below the band at start gets no rows` but is still stopped by `settle`.
  - `custom blend is used`: a `blend` spy is called with `t` values in (0, 1].
- [ ] **Step 2: Run** `npx vitest run test/collide-guard.test.js` — FAIL.
- [ ] **Step 3: Implement** `guard.js`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(collide): the drag guard`.

### Task 5: Collision rows in the solvers

**Files:**
- Modify: `src/framework/solve/dls.js` (`solveDLS` takes `onIteration(x)`, called before each iteration's Jacobian)
- Modify: `src/framework/pose/param-solve.js` (`solveAngles` ~185, `solveHandle` ~266, `solveGoalPinned` ~578; export `dofsOf`)
- Modify: `src/framework/pose/pose-session.js` (`defaultSolve` ~74)
- Test: `test/pose-param-solve-collide.test.js`, `test/solve-dls.test.js` (one case)

**Interfaces:**
- Consumes: `guard.beginFrame`, `guard.linearise`, `guard.rows`, `guard.rowCount` (Task 4).
- Produces: `solveAngles`, `solveHandle`, `solveGoalPinned`, `defaultSolve` take optional `collide` (a guard or null). With it: `collide.beginFrame(params)` once; residuals append `collide.rows(paramsAtU)`, where `paramsAtU` is the params object the evaluation already resolves (`solveGoalPinned`: `{ ...params, ...goalFromForward(overrides).values }`); `onIteration` calls `collide.linearise(paramsAtX)`. With `collide` null: bit-identical to today.
- Produces: each solver's result gains `blend(t) → params` for `settle`: linear for angles/generic; for `solveGoalPinned`, `goalFromForward(at01(t)).values` merged over `params` (the joint-space path).
- `defaultSolve` goal mode with `collide`: if `collide.rowCount === 0` after `beginFrame` (open air), today's direct write (`goalValues` + seeds) with linear `blend`; otherwise `solveGoalPinned`, falling back to the direct write if it returns null.

- [ ] **Step 1: Write failing tests.**
  - dls: `onIteration is called once per iteration with x`, and `no hook is bit-identical` (same `x` as before, `Object.is` per entry).
  - `hand pin pairs leave an open-air solve unchanged`: real `src/parts/hand.js` meshes (Manifold `buildView` at defaults, mats from `relativeMatsAt`), index handle; for 10 targets in open air sweeping the knuckle 0→90° and curl 0→0.9, values equal (|Δ| < 1e-9) with and without `collide`.
  - `a tip pushed into the palm slides`: target 5 mm inside the palm below the index tip; after `settle(result.blend)` the pose is clear and the tip is nearer the target than the stop-dead answer (`settle` of the uncollided solve).
  - `goal drags slide on the arm`: `src/parts/robot-arm.js` with `collisions: {}`, a tool target inside the turret → clear after settle, values hold seeds and goal params, and `resolveParams` of the result puts the tool within 0.5 mm of `goalFromForward`'s frame.
  - `open-air goal drag writes the goal directly`: an out-of-reach target → values equal `goalValues(...)` + seeds, and the arm's `tool` probe reads a miss.
- [ ] **Step 2: Run** `npx vitest run test/pose-param-solve-collide.test.js test/solve-dls.test.js` — FAIL.
- [ ] **Step 3: Implement.** No step rejection inside `solveDLS`; rows saturate at `w · margin` inside clearance.
- [ ] **Step 4: Run** the new file plus `test/pose-param-solve.test.js test/pose-session.test.js test/solve-dls.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(pose): collision rows in the parameter solves`.

### Task 6: Pose mode wiring, feedback, and the performance gate

**Files:**
- Modify: `src/framework/pose-fast-path.js` (`matricesAt`)
- Modify: `src/framework/viewer.js` (`getSubMeshLocal(name)` beside `getSubMeshPayload` ~1945; export ~3521)
- Modify: `src/framework/pose/pose-session.js` (`collide` factory; `begin`/`apply`; `end()` reports `blocked`)
- Modify: `src/framework/pose/pose-mode.js` (pass `collide` through ~264; forward `blocked` in `onDragEnd`)
- Modify: `src/framework/pose/readout-chip.js` (the "Stopped at <label>" message)
- Modify: `src/framework/mount.js` (index in idle time after each delivery, including transient ones, when the part has `collisions` and Pose mode is live; tint the blocked pair while held through `selection/feature-highlight.js`; dispose)
- Modify: `scripts/check-pose.mjs` (palm and turret cases), `scripts/bench-pose.mjs` (a drag held against contact)
- Test: `test/pose-collide-wiring.test.js`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `viewer.getSubMeshLocal(name) → { positions, indices } | null` — geometry in its delivery frame, no pose matrix.
  - `fastPath.matricesAt(p, d) → Map<name, mat4|null>` — rung-1 matrices (`placeMatrix · delta`) for current canonical in-view names on a resolved `(p, d)`; null for posed, stale or untrusted names; no viewer side effect.
  - `createPoseSession({ ..., collide })` — `collide: ({ handle, snapshot }) → guard | null`, called at `begin`; `apply` passes the guard (or null when `COLLIDE_IN_SOLVE` is false) into `solve`, then writes `guard.settle(lastClear, values, { blend: result.blend }).params`; `lastClear` starts at the snapshot. `end()` result gains `blocked: { a, b } | null` (the last frame's).
  - `onDragEnd` payload gains `blocked`; the chip shows `Stopped at ${label of b}` for `CHIP_MS` when set.
  - A world exists only when `normalizeCollisions(part)?.pose`; names not yet indexed are excluded (guard-only for indexed ones).

- [ ] **Step 1: Write failing tests** (pose-session with injected fakes, no DOM):
  - `apply settles before write`: a fake guard whose `settle` halves the move; `write` gets the settled values and `blend` was passed.
  - `no collisions block, no guard`: `collide` returns null → `solve` gets `collide: null`, values unchanged.
  - `end reports the blocking pair`.
  - `matricesAt returns null for posed and untrusted names` (fast path with fake viewer/cache).
  - `drag before the index is ready runs guard-only` (mount-level fake: world with no meshes yet → `collide` returns a guard over indexed names only, or null).
  - `chip shows Stopped at` (readout-chip unit test, as `test/pose-readout-chip.test.js` does).
- [ ] **Step 2: Run** `npx vitest run test/pose-collide-wiring.test.js test/pose-readout-chip.test.js` — FAIL.
- [ ] **Step 3: Implement** the modifications.
- [ ] **Step 4: Run** them plus `npm test` — PASS.
- [ ] **Step 5: Opt in** `src/parts/hand.js` and `src/parts/robot-arm.js` (`collisions: {}`) and add check-pose cases: hand — drag the index tip toward a point inside the palm; assert the committed pose has 0 `assemblyOverlaps`, the tip moved, and `onDragEnd.blocked` names `palm`. Arm — drag the tool into the turret, same assertions; and drag it out of reach in open air, assert the goal param equals the dragged target.
- [ ] **Step 6: Run** `node scripts/check-pose.mjs` — PASS.
- [ ] **Step 7: Performance gate.** `npm run bench:pose -- --json docs/research/collisions-pose-after.json`. If the hand's p95 ≥ 16 ms or > 1.5× baseline, set `COLLIDE_IN_SOLVE = false` (stop-at-contact: `settle` only), re-run check-pose (palm/turret cases must still pass, the "slides" assertion is skipped when the flag is off) and the bench, and commit the final JSON. Report which mode shipped, both p95s and the arm's derives/frame in the commit message.
- [ ] **Step 8: Commit** `feat(pose): pieces stay solid while posing`.

### Task 7: The sweep engine

**Files:**
- Create: `src/framework/oracle/sweep.js`
- Test: `test/sweep.test.js`

**Interfaces:**
- Consumes: Task 3 (`createCollisionWorld`, `relativeMatsAt`), `COLLIDE_BAND_MM` (Task 4); `buildPosed`, `resolveParams`, `viewSubParts`; `probePoses` (build scope, to detect rebuilds); `viewAnimations`, `evaluate` (`animation.js`); `part.presets` via the preset control's `presets`.
- Produces:
  - `SWEEP_REBUILD_STEPS = 24`, `SWEEP_MAX_STEPS = 2000`.
  - `normalizeSweeps(part, view, params) → [{ name, kind: "param" | "path" | "animation", ... , clearance, views }]` from `part.verify.sweeps`, entries `{ param, range? } | { handle } | { from, to } | { path: [params…] } | { animation }`, each with optional `clearance`, `views`. A handle expands to one `param` sweep per DOF named `"<name>.<param>"`; a goal handle yields none. A sweep is dropped from a view where its two ends place every in-view sub-part identically (nothing moves).
  - `runSweeps(kernel, part, view, params, { deadline, now = performance.now }) → [SweepRow]`, `SweepRow = { name, clear, clearance, steps, rebuilds, minClearance: { distance, a, b, at, value } | null, contacts: [{ from, to, a, b, at, driver }], freeRange: [lo, hi] | null, skipped?: "timeout" | "unreadable" | "no-motion" }`. `value` is the param value (param sweeps) or path/animation `t` ∈ [0, 1]. `driver` is the param with the largest share of the pair's closing speed at `from` (finite difference of `normal·(M_a p_a − M_b p_b)` per param over the moving params).
  - Rigid path: build each in-view sub-part once posed at the start, matrices from `relativeMatsAt`. Steps run from low to high end; a step is halved and re-tried until its `world.travel` ≤ `(clearance + COLLIDE_BAND_MM) / 2`; at most `SWEEP_MAX_STEPS`.
  - Rebuild path: if any sub-part's build-scope probe `baseHash` differs between the ends (or its place is untrusted), rebuild every changed sub-part per step, at most `SWEEP_REBUILD_STEPS` evenly spaced steps; `rebuilds: true`.
  - A contact's `from` is bisected to 1e-3 of the range. `freeRange` (param sweeps only) is the contact-free interval containing the param's current value, or null if it is in contact. `clear` uses the sweep's `clearance`.
  - `deadline` is an absolute `now()` value; unfinished rows get `skipped: "timeout"`.

- [ ] **Step 1: Write failing tests** (Manifold kernel):
  - `drawer travel is clear`: drawer-box, `{ d1: { handle: "drawer1" } }` → row `"d1.drawer1Open"`, `clear`, `rebuilds: false`, `minClearance.distance` ≈ 1 mm `GAP` (±0.05).
  - `rotation finds first contact`: the Task 4 bar fixture, `{ param: "angle" }` over 0–90 → `contacts[0].from` within 0.1° of 60, `driver: "angle"`, `freeRange` `[0, ≈60]`.
  - `a clearance requirement fails a close pass`: drawer sweep with `clearance: 2` → `clear: false`, contact pair `carcass×drawer1`.
  - `path sweep between presets`: hand, `{ from: "open", to: "fist", clearance: 0.3 }` → a row with `steps > 1`; `value`s in [0, 1].
  - `coupled driver`: a two-param fixture where only `b` closes the pair → `driver: "b"`.
  - `shape-changing sweep rebuilds`: drawer-box `{ param: "width" }` → `rebuilds: true`, `steps ≤ 24`.
  - `animation sweep`: gearbox `spin` with the meshing pairs allowed → `clear`.
  - `no row where nothing moves`: hand curl sweep in the `print` view → no row.
  - `sweep skips an unreadable target`: unknown param → `skipped: "unreadable"`; zero-duration animation → `"no-motion"`.
  - `deadline`: a `now` stub past the deadline → every row `skipped: "timeout"`.
- [ ] **Step 2: Run** `npx vitest run test/sweep.test.js` — FAIL.
- [ ] **Step 3: Implement** `sweep.js`.
- [ ] **Step 4: Run** it plus `test/worker-layering.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(oracle): sweep a declared motion for contact`.

### Task 8: Sweeps and allowed pairs in measure, verify, lint and the CLI

**Files:**
- Modify: `src/framework/assembly.js` (`assemblyOverlaps` takes `allow: Set<string>`)
- Modify: `src/framework/oracle/measure.js` (~577: pass `allow`; `opts.sweeps` (default true) runs `runSweeps` when `normalizeSweeps` is non-empty, `deadline` from the inspect's report deadline (`changes.js`'s `REPORT_SHARE_MS` pattern, counted from the measure's start when no inspect deadline is passed); never memoized)
- Modify: `src/framework/oracle/verify.js` (~552: per-case re-measures pass `sweeps: false`)
- Modify: `src/framework/verify-metrics.js` (`VIEW_METRICS.sweepContacts`)
- Modify: `src/framework/lint/rules-collisions.js` (sweep rules)
- Modify: `bin/cli.js` (~521, a `sweeps:` line after `overlaps:`)
- Modify: `types/part.d.ts` (`VerifyBlock.sweeps`), `types/testing.d.ts` (`SweepRow` on the measure report)
- Test: `test/measure-sweeps.test.js`, `test/lint-collisions.test.js`

**Interfaces:**
- Consumes: Tasks 1, 7.
- Produces:
  - `measure(...).sweeps: SweepRow[]` (key absent when none declared, or `opts.sweeps === false`).
  - `VIEW_METRICS.sweepContacts = { kind: "gate", extract: (r) => r.sweeps ? r.sweeps.filter((s) => !s.clear && !s.skipped).length : null, hint: "a declared motion comes closer than its clearance to another sub-part — the first contact, its pair and the param driving it are reported; add clearance, narrow that param's range (freeRange is the contact-free span), or allow the pair in collisions.allow", locate: (r) => first non-clear row's contacts[0].at ?? minClearance.at }`. Authors write `expect: { _view: { sweepContacts: 0 } }`.
  - Lint: `sweep-unknown-target` (error: unknown param/handle/preset/animation, or a param without finite min/max), `sweep-goal-handle` (warning), `sweep-rebuilds` (warning: build-scope `baseHash` differs between the target's ends — "this sweep rebuilds geometry at every step and runs slower").
  - CLI: `  sweeps: <name> clear (min 1.02mm carcass×drawer1) | CONTACT at <value> <a>×<b> driven by <driver>, free [lo, hi]; ...`.

- [ ] **Step 1: Write failing tests.**
  - `measure without sweeps has no sweeps key`; `verify-golden` unchanged.
  - `measure reports declared sweeps` (drawer box); `verify re-measures cases without sweeps` (a `measureFn` spy: only the seed call has `sweeps !== false`).
  - `sweepContacts gates` — bar fixture → `verify().ok === false`, the check names `sweepContacts` and its hint; with the pair in `collisions.allow` → ok.
  - `allow lifts the overlaps gate for that pair only`.
  - The three lint rules, one failing case each plus a clean case.
- [ ] **Step 2: Run** `npx vitest run test/measure-sweeps.test.js test/lint-collisions.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS, including `test/verify-golden.test.js` with no re-record.
- [ ] **Step 5: Commit** `feat(oracle): sweeps and allowed pairs reach measure, verify and the CLI`.

### Task 9: Reference parts, docs, release

**Files:**
- Modify: `src/parts/hand.js` (`verify.sweeps`: per digit `"<id>Knuckle"`, `"<id>Curl"`, plus `fist: { from: "open", to: "fist", clearance: 0.3 }` — reported, NOT in `expect`)
- Modify: `src/parts/drawer-box.js` (`collisions: {}`, a handle sweep per drawer, `expect._view.sweepContacts: 0`)
- Modify: `src/parts/gearbox.js` (`collisions: { allow: [meshing pairs] }`, `spin` sweep, `sweepContacts: 0`)
- Modify: `test/verify-golden.test.js`'s recording (re-record)
- Modify: `docs/AUTHORING-PARTS.md` ("Collisions and sweeps": the block, allowed pairs, sweep kinds incl. paths, per-sweep clearance, the pieces-thicker-than-the-band assumption, the hinge choice — write a range, or leave it wide and let collision stop it, reading `freeRange`), `docs/domains/kinematics.md` (the hinge choice + link), `docs/domains/mechanisms.md` (path and animation sweeps for gear trains and crank-sliders), `docs/ERROR-PATTERNS.md` (one `##` for `sweepContacts`), `AGENTS.md` (an Architecture bullet for `src/framework/collide/`)
- Modify: `package.json` (`0.181.0`)

- [ ] **Step 1:** Make the part edits; run `npx partforge measure` on drawer-box, gearbox and hand — the first two exit 0 with all sweeps clear; the hand prints its sweeps, including `fist`, and exits 0.
- [ ] **Step 2:** `npx partforge lint` on all three — no errors, no `sweep-rebuilds` on the hand.
- [ ] **Step 3:** Re-record the golden: `PARTFORGE_RECORD_VERIFY_GOLDEN=1 npx vitest run test/verify-golden.test.js`; read the diff — only the three parts' entries change, by added sweep rows and checks.
- [ ] **Step 4:** Write the docs; `npm run docs:domains` if the domain index changed; `npx vitest run test/domain-index.test.js`.
- [ ] **Step 5:** `npm test`, `npm run check`, `node scripts/check-pose.mjs` — all PASS.
- [ ] **Step 6: Commit** `feat: collisions in Pose mode and swept motion checks (0.181.0)`.
