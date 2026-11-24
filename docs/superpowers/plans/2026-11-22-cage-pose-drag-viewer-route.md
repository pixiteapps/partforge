# Cage Pose Drag Implementation Plan, part 2: the viewer-side route

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A handle drag or a panel slider drag on a `k.cage` + `k.subdiv` body follows the pointer at display rate, in the editor and on a cached preview, and stops at the last valid pose.

**Architecture:** The worker ties every vertex of a cage body's delivered mesh to the smooth surface (a limit triangle and two weights). The viewer's existing skin drag controller gains a second kind of base: on each move it reads the moved cage points from the build probe, re-applies the cached subdiv plan, places every vertex from its tie, and draws. The exact build runs after a pause or on release, as it does for implicit bodies.

**Tech Stack:** JavaScript (ES modules), vitest, Manifold WASM, Node 24.

**Spec:** `docs/superpowers/specs/2026-11-22-cage-pose-drag-design.md`, read with its "Revision, 2026-11-22" section, which overrides Part 2. This plan replaces Tasks 5 to 9 of `2026-11-22-cage-pose-drag.md`. Tasks 1 to 4 and 10 of that plan are done.

## Global Constraints

- No new agent-facing API: nothing is added to `k`, to a cage, to `limb`, or to `handles`.
- Preview tier only. Print builds are unchanged.
- A drag shape is display only. Captures, exports, measure and the geometry cache read exact meshes. A release or a 150 ms pause (`SKIN_PAUSE_MS`) always ends in a full build.
- A pose that fails the drag validity check is never drawn.
- A sub-part takes the fast path only when its build smooths exactly ONE cage, with no creases, in its canonical place, and every delivered vertex is tied. Otherwise it behaves exactly as today.
- The implicit pose drag must not change: every existing skin, mount and hand test passes unmodified.
- The fast-path arithmetic is `applySubdivPlan` / `applySubdivPlanAt` (`src/framework/geometry/subdiv/surface.js`); do not write a second copy of the smoothing.
- A cached plan is reused only after an exact compare of the cage's faces, not on the key alone.
- Gate for PR 2: on the cage hand with its flat cut, 33 ms or less from one drawn drag shape to the next, in a browser on the bench machine. Between 33 and 120 ms it still ships.
- The repo has no CHANGELOG file: the version goes in the commit subject and the notes in the body. PR 2 is 0.201.0, PR 3 is 0.202.0 (main took 0.199.0 and 0.200.0 meanwhile; the cage hand PR is 0.200.1).
- Docs follow the repo's plain-English rules (`AGENTS.md`). Commit after each task. Do not push.

## Review Focus

1. **A stale tie.** A delivered mesh's ties belong to that mesh. A base must be dropped whenever the skin controller drops an implicit base (a new delivery, a stale reply, a view change), and never applied to another mesh's arrays. Tests in Task 14.
2. **A topology change mid-drag** (a slider driving a face count or `steps`). The move must fall back to an ordinary rebuild, not apply the old plan. Tests in Tasks 12 and 14.
3. **A pose the cage refuses** (`rotate` or `scale` throwing on a short edge) or that cuts through itself. Nothing is drawn, a handle's parameters go back to the last valid values, and the next move still works. Tests in Task 15.
4. **Vertices that are not skin.** A cut cap's seam vertices are tied; a unioned piece's are not. A mesh with any untied vertex must send no ties at all. Test in Task 13.
5. **A solid that was moved, labelled or re-stamped after `k.subdiv`.** The tie must still be found (run transform undone, original id mapped), or the sub-part must fall back; never a wrong tie. Tests in Task 13.

---

### Task 11: the topology key ignores face ids

**Files:**
- Modify: `src/framework/geometry/subdiv/surface.js` (`topologyKey`), `test/subdiv-plan.test.js`

**Interfaces:**
- Produces: `topologyKey(snapshot)` hashes `faces` and `creases` only. Also `sameTopology(a, b): boolean`, an exact compare of two snapshots' `faces` (same length, same four indices each, same order) and `creases`.

- [ ] **Step 1: Write the failing tests:** the cage hand (`cageHand` from `src/parts/cage-hand.js`) has the same key at `thumbCurl` 10 and 45 with every other parameter at its default; two snapshots with equal faces and different `ids` have the same key; the existing key tests still hold (an extra extrude, a `steps` change and a crease change the key); `sameTopology` is true for a moved cage and false after an extra extrude.
- [ ] **Step 2: Run** `npx vitest run test/subdiv-plan.test.js`. Expected: FAIL on the thumb case.
- [ ] **Step 3: Implement.** If the thumb case still fails with ids removed, the face ORDER moves too: stop and report, do not sort the faces (the plan's indices depend on the order).
- [ ] **Step 4: Run** the test and `npx vitest run test/subdiv`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 12: the build probe reports a cage

**Files:**
- Modify: `src/framework/pose-probe-core.js` (the `subdiv` branch near line 143 and `probeSubPartPose`), `src/framework/skin/skin-drag.js` only if `skinnableEntry` must change here (prefer Task 14)
- Test: the existing pose-probe test file (find it under `test/`), new cases

**Interfaces:**
- Produces: a build-scope probe entry gains `cages: Snapshot[]` (each `k.subdiv` call's cage snapshot, in call order). For a `k.subdiv(cage)` token, `shapeHash` is built from `topologyKey(snapshot)` and not from the positions, and the token carries the same "spec space" flag an implicit token does, so a later `cut` or `union` with an unchanged operand keeps the result deformable by the existing flag rules. `baseHash` stays the full hash (positions included), so the geometry cache and the preview rule are unchanged. `skinnable` stays the implicit-only flag; add `cagePosable: boolean`: the build result is in spec space, unposed, has exactly one entry in `cages`, no implicit specs, and that cage has no creases.

- [ ] **Step 1: Write the failing tests** on small parts built in the test: a part `k.subdiv(cage)` at two rotate angles has equal `shapeHash`, different `baseHash`, `cagePosable: true`, and `cages[0].points` equal to the real cage's snapshot at each angle; the same with a `.cut(k.box(...))` after it; an extra extrude between the two params changes `shapeHash`; a part with two `k.subdiv` calls, a creased cage, a `k.subdiv(...).translate(...)` result, and a part mixing `k.implicit` and `k.subdiv` are all `cagePosable: false`; a part with no cage has `cages: []`; every existing probe test passes unmodified.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `lint` purity: `pose-probe-core.js` must not import `jobs.js` (see `test/lint-purity.test.js`); importing `topologyKey` from the subdiv module is fine if that test still passes.
- [ ] **Step 4: Run** the probe tests, `test/lint-purity.test.js`, every `test/*preview*` test and `test/hand-part.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 13: the worker ties the delivered mesh to the smooth surface

**Files:**
- Modify: `src/framework/geometry/mesh-build.js` (`manifoldFromWeldedMesh`: an optional per-triangle `faceID`), `src/framework/geometry/manifold-backend.js` (the `subdiv` op near line 1189, `meshOut` near line 405), `src/framework/jobs.js` (the mesh payload near line 537)
- Create: `src/framework/geometry/subdiv/ties.js`
- Test: `test/subdiv-ties.test.js`

**Interfaces:**
- Consumes: the spike's layout A (`scripts/spike-cage-weights.mjs`, and "Spike result" in the spec): `MeshGL.faceID` set to the limit triangle's index at import; skin triangles found by `runOriginalID`; a vertex's weights are its rest position in barycentric coordinates of its source limit triangle.
- Produces:
  - `tiesFor(...)` in `ties.js`, pure (no kernel): from the delivered arrays and the rest limit mesh, `{ tri: Uint32Array(n), w: Float32Array(2 * n), untied: number }`, `n` = delivered vertex count (`positions.length / 3`, the same per-vertex layout `bindings` uses). A vertex on a skin triangle is tied to it; a vertex of a non-skin triangle that coincides with a skin vertex (a seam vertex) takes that vertex's tie; any other vertex counts in `untied`.
  - A preview mesh payload gains `ties: { key, level, tri, w }` (`key` = `topologyKey`, `level` = the level the build chose) only when the sub-part's solid derives from exactly one `k.subdiv`, with no creases, the mesh is in its canonical frame, and `untied === 0`. The typed arrays are transferred like the others. Absent in every other case.

- [ ] **Step 1: Write the failing tests** (kernel from `src/testing/manifold.js`; drive `meshOut` the way an existing backend test does):
  - The cage hand with its cut: `ties` is present, every `tri` is below the plan's triangle count, and placing every vertex from its tie on the REST limit mesh (`subdivide(snapshot, level).positions`) reproduces the delivered positions within 1e-3 mm.
  - Review Focus 4: the hand with a sphere unioned on: no `ties`.
  - Review Focus 5: `k.subdiv(cage).label("x")` and a part whose `place()` moves the solid rigidly both still give correct ties (same reproduce check), or give none; never a tie that fails the reproduce check.
  - A creased cage, two cages in one sub-part, and a print-tier mesh: no `ties`.
  - A part with no cage: the payload is unchanged (snapshot one existing payload's keys before the change).
  - The existing provenance and per-face pick tests for cages pass unmodified (`faceID` must not disturb `triFace` or origins).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Follow how `bindings` are repaired and decoded (`geometry/mesh-bindings.js`, `bindingRepair`) for the run transform and re-stamped ids. If `faceID` changes how Manifold merges triangles for a cage body's exact output (triangle count, normals, edges), measure and report it in the task report.
- [ ] **Step 4: Run** the new test and `npx vitest run test/subdiv test/organic-whale.test.js test/cage-hand.test.js test/domain-kernel-ops.test.js test/cache-jobs.test.js`. Expected: PASS.
- [ ] **Step 5:** Add a row to `scripts/bench-cage-drag.mjs` for the cost of computing ties on the hand, run it, and put the number in the task report. Commit.

### Task 14: the skin controller deforms a cage base

**Files:**
- Create: `src/framework/skin/cage-deform.js`
- Modify: `src/framework/skin/skin-drag.js`, `src/framework/mount.js` only where a call site must pass something new
- Test: `test/cage-deform.test.js`, the existing skin-drag test file (new cases)

**Interfaces:**
- Consumes: Task 12's probe entry (`cagePosable`, `cages`, `shapeHash`), Task 13's `ties`, `subdivPlan` / `applySubdivPlan` / `sameTopology`.
- Produces:
  - `cage-deform.js`: `makeCageBase(snapshot, ties): Base | null` (builds the plan at `ties.level`; null when `topologyKey(snapshot) !== ties.key`), and `deformCage(base, snapshot, outPositions, outNormals): boolean` (false when `!sameTopology(base.snapshot, snapshot)`; else writes every vertex from its tie, with normals interpolated from area-weighted limit vertex normals).
  - `skin-drag.js`: `recordDelivered` also records a cage base for a delivery carrying `ties` whose probe entry is `cagePosable`; `deform()` deforms cage bases too, using the live probe entry's `cages[0]`, under the same trust rule as implicit (both entries trusted, equal `shapeHash`). Every other method (`restore`, `restoreAll`, `forget`, `hold`, `isDeformed`, `anyDeformed`, `isDragging`, `endDrag`) treats a cage base exactly as an implicit one. `deform()`'s return value is unchanged in shape.

- [ ] **Step 1: Write the failing tests:**
  - `deformCage` on the cage hand from pose A to pose B gives positions within 1e-3 mm of the exact build's delivered positions at B, and normals within 2 degrees.
  - Review Focus 2: a snapshot with an extra extrude makes `deformCage` return false and write nothing; the controller then restores the base and reports nothing deformed for that sub-part.
  - Review Focus 1: after a new delivery for the sub-part, or `forget(name)`, a `deform()` does not write into the old arrays (assert on array identity and contents).
  - A slider-style sequence on a fake viewer: deliver, change a curl param, `deform()` returns the sub-part and calls `setSubVertices` once with `{ deformed: true }`; `restoreAll()` puts the exact arrays back.
  - A part with an implicit body and a part with a cage body in one view both deform in one `deform()` call.
  - Every existing skin-drag test passes unmodified.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse scratch arrays per base; one deform of the hand must allocate no per-vertex arrays (assert with a spy on the typed-array constructors, or state the allocations in the report).
- [ ] **Step 4: Run** the new tests, the skin tests, `npx vitest run test/mount` and `test/hand-part.test.js`. Expected: PASS.
- [ ] **Step 5:** Add a bench row for one `deformCage` of the hand (median of 20) and report it. Commit.

### Task 15: stop at the last valid pose

**Files:**
- Modify: `src/framework/geometry/subdiv/index.js` (or `ties.js`'s neighbour; keep it kernel-free), `src/framework/skin/cage-deform.js`, `src/framework/skin/skin-drag.js`, `src/framework/mount.js` (the pose `hold` handler near line 915, `applyParamChange` near line 2223, the `meshes` case)
- Test: `test/cage-drag-validity.test.js`, `test/mount-cage-drag.test.js`

**Interfaces:**
- Produces:
  - `dragValidity(plan, points): null | { message }`: `selfIntersections` on the plan's surface at level `min(plan.level, DRAG_CHECK_LEVEL)` (`applySubdivPlanAt` and that level's indices) plus the zero-volume test. `DRAG_CHECK_LEVEL` starts at 2; lower it to 1 if the bench shows the check over 5 ms on the hand, and say so in the report.
  - `deform()` does not draw a cage pose that fails `dragValidity`, or whose cage code threw in the probe (an untrusted entry while a cage drag is live). The controller exposes `lastValidParams(): object | null`, the parameters of the last pose it drew (or the base's).
  - `mount.js`: during a handle hold, an invalid pose writes the handle's parameters back to `lastValidParams()` without recording a commit. For a slider, the body holds; when the pause or release build would be dispatched at invalid values, the parameters are first set back to `lastValidParams()` and the panel is refreshed. After a drag, a full build whose warnings include a message starting `subdiv: the body passes through itself` is treated as refused: parameters go back to the values of the last exact build that had no such warning, and one more build runs there.

- [ ] **Step 1: Write the failing tests:**
  - `dragValidity` is null across the cage hand's whole slider range, and reports a message for a finger curled through the palm (drive the cage code past the part's range) and for a zero-volume cage.
  - Review Focus 3: handle hold, a move into an invalid pose: `setSubVertices` is not called for it, the params equal the last valid ones, no `onParamsCommit` fires for the invalid values, and a following valid move draws.
  - A slider moved into an invalid pose and released: the dispatched build's params are the last valid ones.
  - A full build after a drag that warns `passes through itself`: params return to the last clean build's and one build is sent there.
  - A part with no cage: none of this code runs (spy).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new tests, all mount and skin tests, `test/handle-*.test.js`. Expected: PASS.
- [ ] **Step 5:** Add a bench row for `dragValidity` on the hand at levels 1 and 2. Commit.

### Task 16: measure in a browser, docs, release (PR 2)

**Files:**
- Modify: `docs/domains/organic.md`, `docs/domains/kinematics.md` if it repeats the "rebuilds on each move" claim, the spec (measured numbers), `AGENTS.md` if it states the old behaviour, `package.json` + lockfile (0.201.0), `types/` if a `.d.ts` lists mesh payload fields
- Delete: `scripts/spike-cage-weights.mjs` (its result is in the spec)

- [ ] **Step 1:** `npm run dev`, open `cage-hand.html`, and measure the time between drawn drag shapes for a fingertip handle drag and for an `indexCurl` slider drag (median of at least 30 moves; instrument temporarily, do not commit the instrumentation). Use a headless browser (Playwright is in the repo's dev dependencies) if no interactive browser is available, and say which was used. Record both numbers in the spec.
- [ ] **Step 2: Gate.** 33 ms or less: done. Between 33 and 120: ship and note it. Over 120: stop and report.
- [ ] **Step 3:** Rewrite the guide's two "rebuilds on each move" passages (Task 2 and its follow-up wrote them): a drag on a cage body follows the pointer; the body is not drawn in a pose that cuts through itself, and the handle stops there; what does not take the fast path (a change to the cage's faces, a creased cage, two cages in one sub-part, a piece unioned onto the body, `setParams`, animations, the print tier) rebuilds on each move. Under 15 lines.
- [ ] **Step 4: Run** `npm test` and `npm run lint` in full. Expected: PASS.
- [ ] **Step 5:** Version 0.201.0, commit. The controller pushes and opens PR 2.

---

## PR 3: dragging on a cached preview

### Task 17: the preview file carries the ties

**Files:**
- Modify: the preview encoder and decoder under `src/` (find `PREVIEW_ENCODER_VERSION`), the worker's `exportPreview` path, their tests

**Interfaces:**
- Produces: `PREVIEW_ENCODER_VERSION` 7. For each sub-part whose delivered mesh has `ties`, the file stores `key`, `level`, `tri`, `w` and the cage snapshot it was built from, in the file's own vertex order (the encoder reorders and quantizes vertices; the ties must follow that order and survive it). A version 6 file still decodes and plays as today. The size caps in force are unchanged; if the cage hand's file exceeds the cap with ties, report the sizes and stop.

- [ ] **Step 1: Write the failing tests:** encode then decode the cage hand's preview: the ties reproduce the decoded positions on the rest limit mesh within the quantization step; a part with no cage encodes byte-identical to version 6 apart from the version field; a version 6 fixture still decodes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** every preview and gltf test. Expected: PASS. Report the cage hand's file size with and without ties.
- [ ] **Step 5: Commit.**

### Task 18: the preview drags a cage body

**Files:**
- Modify: `src/framework/mount-preview.js`, `src/framework/preview-pose.js` (`previewHandlesStepper`), `src/framework/oracle/measure.js` if the "preview handles" line needs it
- Test: the existing mount-preview and preview-pose tests, new cases

**Interfaces:**
- Consumes: Task 17's decoded ties and snapshot, `cage-deform.js`, `dragValidity`.
- Produces: `mountPreview({ part })` deforms a sub-part with ties when a shown handle moves a parameter that changes only its cage points, and stops at the last valid pose. `previewHandlesStepper` accepts a handle when, at every sample, each sub-part is rigidly placed (today's rule) or is `cagePosable` with the file's `key`. There is no exact build afterwards.

- [ ] **Step 1: Write the failing tests:** with a version 7 file of the cage hand, `partforge measure`'s report lists the five handles under "preview handles"; a drag in the preview changes the sub-part's positions to within 1e-2 mm of an exact build at the reached pose; an invalid pose is not drawn; with a version 6 file the handles stay hidden with today's reason; a rigid-only part behaves as before.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** every preview, measure and handle test, then `npm test` in full. Expected: PASS.
- [ ] **Step 5:** Guide: one paragraph saying a cage body can be dragged on a cached preview. Version 0.202.0. Commit. The controller pushes and opens PR 3.

---

## After PR 3 (partforge-cloud, its own plan)

Bump to 0.202.0, regenerate prompts, change the organic rule's "or a limb the user drags in Pose mode", add the floor notes, raise `MIN_PART_MESH_ENCODER_VERSION` to 7 and run the preview backfill, rerun the four organic eval cases.
