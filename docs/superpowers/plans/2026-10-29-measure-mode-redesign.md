# Measure Mode Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace partforge's hover-draws-everything measure mode with cadgang's snapping two-click model: one click, one reading; two clicks, one distance; every dimension square to the part.

**Architecture:** Two new pure modules do the thinking. `snaps.js` builds a per-geometry snap index once and answers "what would a click here grab". `readings.js` turns one or two snap targets into one spec. `measure-mode.js` becomes a small state machine (idle → first → distance) that feeds those specs to the existing `dim3-place` → `dim3-scene` pipeline. A new `snap-marker.js` draws the hover feedback. Hover never places a dimension.

**Tech Stack:** partforge (plain ES modules, three.js, vitest + happy-dom). Tasks 1–9 are in the **partforge** repo. Task 10 is in **partforge-cloud**.

**Spec:** `docs/superpowers/specs/2026-10-28-measure-mode-redesign-design.md` in partforge-cloud. Read it before each task. Everything below argues from it.

**Where to work:** create a partforge worktree from `origin/main` (0.170.0 when this was written). The local `~/…/code/partforge` checkout is on a stale branch at 0.163.1, so do not build there. The measure files on main are the same as the ones read for this plan (`src/framework/measure/*`, 2014 lines).

## Global Constraints

- Ship as a partforge **minor** version, with the `package.json` bump in the same PR (partforge AGENTS.md "Releasing"). Use the next minor after whatever `main` holds at merge time.
- `MeasureRuntime` stays `{ isEnabled, setEnabled, clearPins, pinCount }` (`types/index.d.ts:473`). `pinCount()` returns 0, 1 or 2. `clearPins()` is the Clear button. The internal `onPinsChange` fires on each change, including a clear on rebuild.
- Below the new floor, cloud keeps the old mode and nothing errors. Do not change anything mount.js exposes to hosts, apart from what `pinCount` counts.
- Hover must not scan the whole mesh on each pointer move. Per-geometry work is computed once and cached by geometry identity, as `specCache` does (WeakMap).
- Dimensions stay parented under the meshes' shared group, so the pivot, the pose fast path and animations still carry them.
- The mm/in toggle and Clear in `measure-controls.js` keep working.
- Values stay mm internally. Labels go through `UNITS` in `dim3-place.js`.
- Target: hover and click each respond within one frame (≈16 ms) on a typical part, measured in Task 1 and Task 8.
- Non-goals (do not build): sending measurements to the agent, saved or named measurements, more than one distance, angles, exports, readings that survive a rebuild, readings on unnamed geometry, recovering faces from the mesh, sketch-mode or selection-popover changes.

## Review Focus

Each line below has a test in the task named in brackets.

1. **Second click on the same snap as the first** (a double-click, or a shaky hand). The user expects nothing new. A zero-length distance (< 0.005 mm) is not drawn, and the state stays at the first reading. [Task 6]
2. **Click on empty background** while a reading shows. The user expects the reading to stay. Only Clear, a third click on the part, leaving the mode, or a rebuild removes it. [Task 6]
3. **Animation or pose-only motion** (no geometry change) while a reading shows. The reading must ride the sub-part, not clear. Only a geometry change, a view change or the sub-part hiding clears it. [Task 6]
4. **A coarse polygon** (for example an 8-segment circle drawn as edges). Its vertices turn by 45°, so they pass the curve test and become corner snaps. That is accepted, but a fine circle's vertices (64 segments, 5.6° turns) must never be corners. [Task 2]
5. **Two points on different sub-parts where one is rotated.** The distance must use the shared parts frame, so the dim line is parallel to a parts axis even though one sub-part's own axes are tilted. [Task 3]

---

### Task 1: Reproduce the skewed drawing and time today's mode

The spec says find the broken drawing before changing anything, and profile hover and click before choosing a speed fix.

**Files:**
- Create: `test/framework/measure/drawing-rules.js` (shared test helper)
- Create: `test/framework/measure/drawing-regression.test.js`
- Create: `docs/research/measure-mode-timing.md`

**Interfaces:**
- Produces: `expectSquareDim(dim, { frameAxes })` in `drawing-rules.js`. `dim` is one `drawings[i].dims[j]` record from `placeDims`. `frameAxes` is an array of three unit `number[3]` (default the parts axes). Later tasks use it for every drawing.

- [ ] **Step 1: Write the drawing-rule helper.** It asserts, with tolerance 1e-3 on normalized vectors:

```js
// extension lines run along ext, so they are parallel to each other
expect(len(cross(sub(dim.pA, dim.baseA), dim.ext))).toBeLessThan(1e-3 * Math.max(1, len(sub(dim.pA, dim.baseA))));
expect(len(cross(sub(dim.pB, dim.baseB), dim.ext))).toBeLessThan(1e-3 * Math.max(1, len(sub(dim.pB, dim.baseB))));
// ext is perpendicular to the dim line
expect(Math.abs(dot(norm(dim.dir), norm(dim.ext)))).toBeLessThan(1e-3);
// the dim plane contains a frame axis: dir or ext is parallel to one of them
expect(frameAxes.some((a) => Math.abs(Math.abs(dot(norm(dim.dir), a)) - 1) < 1e-3
  || Math.abs(Math.abs(dot(norm(dim.ext), a)) - 1) < 1e-3)).toBe(true);
```

Why the first check matters: `dim3-scene.js:350-359` draws each extension line from `pA` toward `baseA + ext·offset`, not along `ext`. Any offset between `pA` and `baseA` that is not along `ext` tilts that line, and the two lines then converge. `linearDim` (`dim3-place.js:331-341`) moves the anchor 0.05 mm along `dir` before its surface raycast, which is one known source of that offset.

- [ ] **Step 2: Write regression cases in `drawing-regression.test.js` that run `classifyFeature` → `transformSpec`-equivalent posing → `evaluateChoices` → `placeDims`, then `expectSquareDim` on every dim.** Cases:
  - a bbox overall dim with `surfaceHit` set (a box mesh and a real three Raycaster, as `measure-mode.test.js` builds them);
  - a sub-part rotated 30° about Z by a pose matrix, bbox and plane feature;
  - a plane feature whose normal is not on an axis (a 30°-tilted face), checked against that face's own `u`/`v`/`n` as `frameAxes`;
  - a cylinder feature with an axis at 45°, depth dim checked against `[axis, du, dv]`.
- [ ] **Step 3: Run it.** `npx vitest run test/framework/measure/drawing-regression.test.js`. Expected: at least one case FAILs. Keep each failing case, and note in the test file's header comment which case reproduces Scott's report. If none fail, add more shapes (a mesh whose extreme vertex differs from the extension anchor, a lane-staggered pair) until one does. If nothing reproduces after that, record what was tried in the header, mark the cases `test.todo`, and go on. Task 4's invariant still applies.
- [ ] **Step 4: Time hover and click on a large real part.** Run `npm run dev` and open the largest demo page you can find (check `hinged-box.html`, `propeller.html`, `relief.html`, and use the one with the most triangles). Record in `docs/research/measure-mode-timing.md`: the triangle count, and the median and p95 ms of one hover (`onMove` scheduled callback) and one click (`onClick`). Use `performance.now()` around each, or the Performance panel. Also record the split across `raycastViewer`, `featureSpec`/`classifyFeature`, and `placeDims` + `scene.update`. This number decides Task 8.
- [ ] **Step 5: Commit.** `git add test/framework/measure docs/research/measure-mode-timing.md && git commit -m "Reproduce the measure drawing skew and time today's mode"`

### Task 2: Snap index (pure)

**Files:**
- Create: `src/framework/measure/snaps.js`
- Test: `test/framework/measure/snaps.test.js`

**Interfaces:**
- Consumes: `classifyFeature(mesh, featureId)` from `feature-dims.js` (unchanged).
- Produces:
  - `buildSnapIndex({ positions, indices, featureIds, features, edgePositions })` → `SnapIndex`. All geometry-frame. Pure, called once per geometry by Task 6 and cached in a WeakMap keyed on the geometry.
  - `SnapIndex` = `{ corners: Float32Array /*xyz…*/, cornerGrid, chains: Chain[], cellSize }`.
  - `Chain` = `{ points: number[3][], straight: boolean, length: number, mid: number[3]|null, owners: number[] /*named feature ids*/ }`.
  - `findSnap(index, query)` → `SnapTarget|null`, where `query` = `{ hitPoint: number[3], hitFeatureId: number|0, featureSpec: Spec|null, project: (p:number[3]) => [px,py], pointerPx: [px,py], radiusWorld: number, snapPx: number }`. Points are geometry-frame. `project` maps a geometry-frame point to client px.
  - `SnapTarget` = `{ kind: "corner"|"midpoint"|"circle"|"edge"|"face"|"point", point: number[3], featureId: number /*0 when unnamed*/, chain?: Chain }`.
  - Constants: `SNAP_PX = 12`, `CURVE_TURN_DEG = 20`, `COLLINEAR_TURN_DEG = 0.5`.

Rules the code must follow (these are the spec's, settled here):
- A **corner** is a drawn-edge endpoint (deduped at 1e-4) where the number of incident segments is not 2, or where the two incident segments turn by more than `CURVE_TURN_DEG`. Curve tessellation vertices are never corners.
- **Chains** join segments that meet at non-corner vertices. A chain is `straight` when every turn is under `COLLINEAR_TURN_DEG`. Only straight chains have a `mid`.
- A chain's `owners` are the named feature ids (id > 0) whose triangles contain both chain endpoints (vertex key match at 1e-4).
- Candidates for one query:
  - corners within `radiusWorld` of `hitPoint`, from a spatial hash with `cellSize = max(bboxDiagonal / 128, 1e-3)`;
  - only if `hitFeatureId > 0`: the chains owned by that feature, as `midpoint` (straight chains only) and as `edge` (nearest point on the chain);
  - only if `featureSpec?.kind === "cylinder"`: one `circle` target whose point is the rim centre (`anchors.top` or `anchors.bottom`) nearer the hit;
  - finally `face`, at `hitPoint` on a named feature, or `point` on unnamed geometry.
- Ranking: keep candidates whose projected distance to `pointerPx` is ≤ `snapPx` (a circle counts by its nearest projected rim sample, using 32 samples). The best kind wins in the order corner, midpoint, circle, edge. Ties go to the smaller pixel distance. With no candidate in range, return the `face`/`point` target.
- On unnamed geometry (`hitFeatureId === 0`) only `corner` or `point` can come back.

- [ ] **Step 1: Write the failing tests** in `snaps.test.js` on hand-built payloads (a 20×10×2 box as soup with `edgePositions` for its 12 edges, top face labelled feature 1; and a box with a 64-segment hole, feature 2 = the hole wall):

```js
test("box corners are corners and a long edge is one straight chain", () => {
  const idx = buildSnapIndex(boxPayload());
  expect(idx.corners.length / 3).toBe(8);
  const top = idx.chains.filter((c) => c.owners.includes(1));
  expect(top).toHaveLength(4);
  expect(top.every((c) => c.straight)).toBe(true);
  expect(top.map((c) => c.length).sort((a, b) => a - b)).toEqual([10, 10, 20, 20]);
});
test("hole rim vertices are never corners", () => {
  const idx = buildSnapIndex(holedBoxPayload({ segments: 64 }));
  expect(idx.corners.length / 3).toBe(8); // box corners only
});
test("an 8-segment polygon's vertices are corners (accepted)", () => {
  expect(buildSnapIndex(holedBoxPayload({ segments: 8 })).corners.length / 3).toBe(16);
});
test("ranking: corner beats midpoint beats edge within the snap radius", () => { /* pointer 5px from a corner and 3px from an edge -> corner */ });
test("near the hole rim the target is the circle, at the rim centre", () => {
  const t = findSnap(idx, q({ nearRim: true, featureId: 2, spec: holeSpec }));
  expect(t.kind).toBe("circle");
  expect(t.point).toEqual(holeSpec.anchors.top);
});
test("unnamed geometry only offers corner or point", () => { /* hitFeatureId 0 near an edge mid -> "point"; near a corner -> "corner" */ });
test("nothing in range gives face on a named feature", () => { /* -> kind "face", point === hitPoint */ });
```

- [ ] **Step 2: Run** `npx vitest run test/framework/measure/snaps.test.js`. Expected: FAIL, "buildSnapIndex is not a function".
- [ ] **Step 3: Implement `buildSnapIndex` and `findSnap` in `snaps.js`.** No three.js import (same rule as `feature-dims.js`: plain typed arrays). The spatial hash is a `Map` from a `"ix,iy,iz"` key to an array of corner indices.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "measure: snap index and snap ranking"`

### Task 3: Readings (pure)

**Files:**
- Create: `src/framework/measure/readings.js`
- Test: `test/framework/measure/readings.test.js`

**Interfaces:**
- Consumes: `SnapTarget` (Task 2), the `Spec` shapes in `feature-dims.js` (`plane`, `cylinder`, `bbox`).
- Produces:
  - `firstReading(target, spec)` → `Spec|null`.
  - `spanSpec(a, b, { axes, straight, faceNormals })` → a new spec kind, or `null` when the distance is under 0.005 mm. `a`/`b` are parts-frame points. `axes` is three unit vectors (the frame). `faceNormals` is `[nA|null, nB|null]`, the parts-frame normals when a target is a face on a named plane feature.
  - New spec kinds, consumed by Task 4:
    - `edge` `{ kind: "edge", values: { length }, anchors: { a, b } }`
    - `span` `{ kind: "span", values: { distance }, anchors: { a, b, axis, axes, straight } }`. `axis` is the measuring direction (a frame axis, the face normal for a gap, or the unit `b−a` when `straight`).
  - `frameAxesFor(subPartA, subPartB, matrixOf)` → three unit `number[3]`. When both are the same sub-part, these are the columns of that mesh's rotation (`matrixOf(name)`). Otherwise they are the parts axes.

Rules:
- `firstReading`:
  - `circle` target, or `face`/`edge` on a cylinder feature → the cylinder spec (⌀, or R when `partial`; the depth dim stays with it);
  - `face` on a plane feature → the plane spec (W × H);
  - `edge` with `chain.straight` → an `edge` spec (its length);
  - `corner`, `midpoint`, `point`, a curved edge, or a feature classified `bbox` → `null` (the point is only a start point).
- `spanSpec`:
  - when both `faceNormals` are set and parallel (`|dot| ≥ 0.99863`, the `COS_3DEG` already in `feature-dims.js`), the reading is the gap `|dot(b − a, n)|` along `n`, whatever `straight` says;
  - otherwise, `straight` gives `|b − a|`;
  - otherwise the dominant axis: the one of `axes` with the largest `|dot(b − a, axis)|`, giving that component. **Plan decision** (the spec left one dim or one per axis to the builder): one dimension along the dominant axis. The spec's anti-goal is a cluster of dimensions, and Shift gives the true distance. Flip it in Task 6 Step 6 if real parts read badly.
- The face target's point on a cylinder is the rim centre (Task 2). Distances from a hole therefore start at its axis. **My call:** say so in the release notes.

- [ ] **Step 1: Write the failing tests:**

```js
test("circle target reads the cylinder's diameter", () => expect(firstReading(circle, holeSpec)).toBe(holeSpec));
test("straight edge reads its length", () => expect(firstReading(edgeT(20), planeSpec).values.length).toBe(20));
test("corner reads nothing", () => expect(firstReading(corner, planeSpec)).toBeNull());
test("axis-aligned span takes the dominant axis", () => {
  const s = spanSpec([0, 0, 0], [30, 4, 1], { axes: PARTS, straight: false, faceNormals: [null, null] });
  expect(s.values.distance).toBe(30); expect(s.anchors.axis).toEqual([1, 0, 0]);
});
test("straight span is the true distance", () => {
  expect(spanSpec([0, 0, 0], [3, 4, 0], { axes: PARTS, straight: true, faceNormals: [null, null] }).values.distance).toBe(5);
});
test("parallel faces give the gap along the normal", () => {
  expect(spanSpec([0, 0, 0], [7, 2, 5], { axes: PARTS, straight: true, faceNormals: [[0, 0, 1], [0, 0, -1]] }).values.distance).toBe(5);
});
test("same point is no span", () => expect(spanSpec([1, 1, 1], [1, 1, 1.004], { axes: PARTS, straight: false, faceNormals: [null, null] })).toBeNull());
test("different sub-parts use the parts frame even if one is rotated", () => {
  expect(frameAxesFor("a", "b", rotated30)).toEqual(PARTS);
  const x = frameAxesFor("a", "a", rotated30)[0];
  expect(x[0]).toBeCloseTo(Math.cos(Math.PI / 6)); expect(x[1]).toBeCloseTo(Math.sin(Math.PI / 6));
});
```

Values go through the same `q2` rounding as `feature-dims.js` (export `q2` from there, do not copy it).
- [ ] **Step 2: Run** `npx vitest run test/framework/measure/readings.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `firstReading`, `spanSpec` and `frameAxesFor` in `readings.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "measure: first-click readings and two-click spans"`

### Task 4: Placement for the new kinds, and square drawing everywhere

**Files:**
- Modify: `src/framework/measure/dim3-place.js` (`evaluateChoices` :140, `linearDim` :325, `placeDims` :481; add `placeEdge`, `placeSpan`)
- Modify: `src/framework/measure/dim3-scene.js:350-359` (extension direction)
- Test: `test/framework/measure/dim3-place.test.js`, `test/framework/measure/dim3-scene.test.js`, `test/framework/measure/drawing-regression.test.js`

**Interfaces:**
- Consumes: the `edge` and `span` specs (Task 3) and `expectSquareDim` (Task 1).
- Produces: `placeDims` draws `edge` and `span`, and every `dims[]` record it emits satisfies `expectSquareDim`. Drawing records keep today's contract (`dim3-place.js:21-26`), so `dim3-scene` needs no new record type.

Decisions:
- **The invariant fix:** `linearDim` projects each final anchor onto the line through its base point along `ext`: `p ← base + ext·dot(p − base, ext)`. A surface hit only moves the anchor along `ext`, so the nudge can no longer tilt it. `dim3-scene` then draws each extension line along `R.ext` from `pA`/`pB` (gap, then to the dim line), not toward `dA`. Both changes go in: one keeps the records square, the other keeps an old or hand-built record square on screen.
- `evaluateChoices` for `span`, not straight: reuse `boxCandidates` in the span's own `axes`. The measured axis is `anchors.axis`; the candidates are ± the other two; the score is `scoreCandidate`. Choice key `${id}|span`.
- `evaluateChoices` for `span`, straight: candidates are `±normalize(k − d·(k·d))` for each frame axis `k` with `|k·d| < 0.99`, where `d` is the unit `b − a`. The dim plane then contains `d` and a frame axis.
- `placeSpan`: base points sit in the first point's plane. Project `b` along the plane normal `n = cross(axis, ext)`, so `b′ = b − n·dot(b − a, n)`, as `placeBox` does with its plane snap (`dim3-place.js:386-392`). `baseA = a`, `baseB = a + axis·dot(b′ − a, axis)`, and the ext offset puts the line beyond the farther of the two points along `ext`. `standoffScale: 0.55`.
- `placeEdge`: a linear dim from `a` to `b`, `ext` chosen the way `placePlane` does it (± the in-plane perpendicular), with the plane taken from the edge's owning face normal when there is one, else the frame axis least aligned with the edge.
- `specSig` already covers the new kinds (it stringifies `kind`/`values`/`anchors`).

- [ ] **Step 1: Write the failing tests.** In `dim3-place.test.js`:
  - `"span: axis-aligned dim lies on a parts axis"`: place a span with `a=[0,0,0]`, `b=[30,4,1]`, then `expectSquareDim` and `expect(dims[0].label.value).toBe(30)`;
  - `"span: straight dim reads the true distance and stays square to a frame axis"`;
  - `"edge: one dim, its length"`.
  
  In `dim3-scene.test.js`, `"extension lines are drawn along ext"`: hand the scene a record whose `pA − baseA` is not along `ext`, read the line segment positions, and assert that the extension segment direction equals `ext` within 1e-6.
- [ ] **Step 2: Run** `npx vitest run test/framework/measure`. Expected: the new tests FAIL, and so do the Task 1 regression cases.
- [ ] **Step 3: Implement** the invariant fix, the scene change, `evaluateChoices` for `span`, `placeSpan` and `placeEdge`.
- [ ] **Step 4: Run** `npx vitest run test/framework/measure`. Expected: all pass, including the Task 1 cases (un-`todo` any that now pass). Existing `dim3-place` tests that pinned exact anchor coordinates may move by the 0.05 mm nudge. Update those numbers only, and say so in the commit body.
- [ ] **Step 5: Commit.** `git commit -m "measure: square extension lines; place edge and span dims"`

### Task 5: Snap marker

**Files:**
- Create: `src/framework/measure/snap-marker.js`
- Test: `test/framework/measure/snap-marker.test.js`

**Interfaces:**
- Consumes: `SnapTarget` (Task 2), `createFeatureHighlight` (`selection/feature-highlight.js`, unchanged).
- Produces: `createSnapMarker(viewer, { stage })` → `{ show(target, mesh, label), clear(), setStart(pointGeom|null, mesh), dispose() }`. `setStart` draws a persistent dot for a first click that set a start point, independent of `show`/`clear`.

Rules:
- `show` draws exactly what a click would grab, and nothing more:
  - `face` → the feature highlight;
  - `edge`/`midpoint` → the chain as a `LineSegments2` in the strong dim colour;
  - `circle` → the rim as a 48-point loop;
  - `corner`/`midpoint`/`circle`/`point` → a dot at `target.point`.
- Everything is parented under `mesh` (geometry frame), so the pose carries it, and registered with `registerCaptureHidden`, like the highlight.
- The label is a DOM element in `stage`, class `pf-measure-snap`, positioned at the projected point and offset 12 px up-right. Its text is the `label` argument. Task 6 builds the text: on a named feature, `"<feature label> · <kind word>"` with kind words `corner`, `midpoint`, `centre`, `edge`, `face`; on unnamed geometry only `"corner"` or `"point"` (spec, my call). Exact wording and the dot style are the builder's, matched to the existing highlight colour `0x4da3ff`.
- `show` called with the same target (same kind, same point within 1e-6, same mesh) does nothing, so a resting pointer costs nothing.

- [ ] **Step 1: Write the failing tests** (happy-dom plus the fake viewer pattern from `measure-mode.test.js:61-90`):
  - `"face shows the highlight and no dot"`;
  - `"corner shows a dot and the label text"`;
  - `"same target twice does not rebuild"` (spy on the dot's geometry creation);
  - `"clear hides everything"`;
  - `"marker is capture-hidden"`.
- [ ] **Step 2: Run** `npx vitest run test/framework/measure/snap-marker.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `createSnapMarker`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "measure: snap marker"`

### Task 6: The two-click state machine in measure-mode.js

**Files:**
- Modify: `src/framework/measure/measure-mode.js` (rewrite `buildItems`, `hitToHover`, `onMove`, `onClick`, `togglePin`, the frame sig handling and the returned handle; keep `transformSpec`, `featureSpec`, `buildEnv`, the caches, theme and units)
- Delete: `src/framework/measure/pins.js`, `test/framework/measure/pins.test.js`
- Test: `test/framework/measure/measure-mode.test.js`

**Interfaces:**
- Consumes: `buildSnapIndex`/`findSnap` (Task 2); `firstReading`/`spanSpec`/`frameAxesFor` (Task 3); `placeDims` with `edge`/`span` (Task 4); `createSnapMarker` (Task 5); `paramMatches` (unchanged).
- Produces: `createMeasureMode(viewer, opts)` with the same options and the same returned methods. `pinCount()` now means 0 (nothing), 1 (a first click: a reading or a start point) or 2 (a distance). `setStraight(on)` and `isStraight()` are added for Task 7's touch toggle. They are internal: mount.js does not expose them.

State:

```js
// state.first / state.second: { subPart, geometry, pointGeom: number[3], target, spec /* geometry frame */ }
// idle: first = second = null
```

Points and specs are stored in the **geometry frame**, with their `subPart`, and posed by `mesh.matrix` in `buildItems` (as `transformSpec` does today). This is how a reading rides a pose without clearing.

Rules:
- **Hover:** raycast, then `findSnap` (the index is cached per geometry in a WeakMap), then `marker.show`. No `rebuild()` on hover. Delete the hover item and the `paintCache` hover half. The dirty frame check still handles camera side flips for drawn items.
- **Click** (`drag.consumeClick()` false, and a hit):
  - idle → `first` = the target, with `firstReading` as the spec. If there is a reading, call `revealRelevant(subParts, values)`, passing the spec's whole `values` to `paramMatches` (W × H flashes on either).
  - first → `spanSpec(...)`. If it returns `null`, do nothing (Review Focus 1). Otherwise `second` = the target, and the span is drawn. Distances never flash.
  - distance → clear, then treat as an idle click.
  - Shift: `ev.shiftKey || straight` decides `straight` for the span.
- **Click on nothing:** no change (Review Focus 2).
- **Drawing:** `buildItems` emits the overall item (unchanged), plus either the first reading (`id: "first"`) or the span (`id: "span"`), plus a start-point dot whenever `first` exists with no reading (`marker.setStart`; cleared with the state). The first reading is not drawn once a span replaces it. **My call:** a distance replaces the reading on screen, so one click's number never sits next to the distance as a second dimension.
- **Clears:** Clear (`clearPins`), `setEnabled(false)`, and the frame check finding that any referenced sub-part's `geometry` changed, that it is no longer `visible`, or that `getContext().view` changed. Each clear calls `notifyPins()`. A pose-only `meshSig` change re-places and does not clear (Review Focus 3).
- **Label picks:** clicking a drawn label flashes params for that item (keep `revealRelevant`), and does nothing else. Delete label-click pinning.
- Delete `pins.js`, `resolvePin`, `occurrenceOf` and the per-view pin store.
- Keep `mount.js:111`'s `pinCount() > 0` check, which keeps a dimensioned capture's framing. It still means "dims beyond the overall are on screen".

- [ ] **Step 1: Rewrite the failing tests in `measure-mode.test.js`.** Keep its fake viewer, plate mesh and paint log. Add `edgePositions` to `plateMesh`. Replace the pin tests with:
  - `"hover draws no dimension"`: after a move, `placeDims` call count is unchanged and the snap label exists;
  - `"first click on the labelled face reads W × H and flashes a matching param"`;
  - `"first click on a corner reads nothing but counts 1"`;
  - `"second click draws one span; pinCount is 2"`;
  - `"Shift click gives the straight-line distance"`;
  - `"third click starts over"`;
  - `"second click on the first point does nothing"`;
  - `"click on background keeps the reading"`;
  - `"Clear keeps the overall dims"`;
  - `"leaving the mode clears; re-entering shows only the overall"`;
  - `"a regenerate clears and fires onPinsChange"`;
  - `"a pose-only change keeps the reading and moves it"` (set a rotation on `mesh.matrix`, run `frame()`, assert that the reading's label position moved and `pinCount()` is still 1);
  - `"a view change clears"`.
- [ ] **Step 2: Run** `npx vitest run test/framework/measure/measure-mode.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the state machine above, and delete `pins.js` and its test.
- [ ] **Step 4: Run** `npx vitest run test/framework/measure test/framework/mount.test.js`. Expected: PASS.
- [ ] **Step 5: Run the whole suite and lint.** `npm test && npx eslint src test && npx knip`. Expected: no failures. knip must not flag a now-unused export, for example `linkParam`: delete it if nothing imports it.
- [ ] **Step 6: Try it on real parts.** `npm run dev`, then on `demo.html`, `hinged-box.html` and `propeller.html` walk the spec's story: enter, hover a hole, click (⌀), click a corner (distance), third click, Clear, move a slider (clears). Check whether one dominant-axis dim reads cleanly. If it reads badly, switch `spanSpec` to one dim per separating axis and add that to the commit message. Screenshot each step into the PR.
- [ ] **Step 7: Commit.** `git commit -m "measure: two-click snapping model replaces hover pins"`

### Task 7: Touch, and the straight-line toggle

**Files:**
- Modify: `src/framework/measure/measure-mode.js` (`onMove`, `onClick`, add touch handling)
- Modify: `src/framework/measure/measure-controls.js` (a straight-line toggle beside Clear and the unit button)
- Test: `test/framework/measure/measure-mode.test.js`, `test/framework/measure/measure-controls.test.js`

**Interfaces:**
- Consumes: `setStraight`/`isStraight` (Task 6).
- Produces: the control button `button.pf-measure-straight`, `aria-pressed` reflecting `isStraight()`, labels `"Straight-line distance"` and `"Distance along an axis"`.

Rules (spec, "Touch"):
- A touch tap shows the snap (marker plus label) and commits nothing.
- A second tap within `SNAP_PX` of the shown snap's screen point commits it.
- A touch drag after the first tap moves the shown snap, and lifting commits it. The drag-tracker's threshold separates this from an orbit: a drag that starts away from the shown snap orbits as today.
- Shift does not exist on touch. The toggle is the only way to get straight-line there, and it works on desktop too.

- [ ] **Step 1: Write the failing tests:**
  - `"touch tap previews, second tap commits"`;
  - `"touch drag from the shown snap adjusts then commits on lift"`;
  - `"touch drag elsewhere does not commit"`;
  - in `measure-controls.test.js`, `"straight toggle flips mode and aria-pressed; hidden when the mode is off"`.
- [ ] **Step 2: Run** `npx vitest run test/framework/measure`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run `npm run check` (Playwright smoke). Expected: green.
- [ ] **Step 5: Commit.** `git commit -m "measure: touch preview-then-commit and a straight-line toggle"`

### Task 8: Make hover and click land within a frame

This depends on Task 1's numbers. Re-time with the new mode first: hover is now a raycast plus a snap lookup, and a click places one item.

**Files:**
- Modify: `docs/research/measure-mode-timing.md`
- Modify (only if the raycast dominates): `src/framework/selection/raycast.js` or `src/framework/measure/measure-mode.js`
- Test: `test/framework/measure/measure-mode.test.js`

Decisions:
- If the brute-force `raycaster.intersectObjects` in `raycastViewer` (`raycast.js:131`) is over 8 ms on the large part, build a triangle BVH per geometry with `src/framework/oracle/bvh.js` (already in the package; ~75 bytes per triangle, built for phones), cache it in a WeakMap on the geometry, and use its `raycast` for measure-mode hover and click only. Do not add a dependency. Leave the selection picker on its current path unless it shares the fix for free.
- If `buildSnapIndex` on first hover over a big part is over one frame, build it on `setEnabled(true)` for visible meshes, inside `requestIdleCallback` where available.
- Anything else the profile shows goes in the timing doc with its fix.

- [ ] **Step 1: Re-time** the same part and the same steps as Task 1 Step 4. Record the numbers next to the old ones.
- [ ] **Step 2: If over target, write a failing test** that pins the cache: `"the measure BVH is built once per geometry"` (spy on the BVH constructor across 5 hovers: 1 call; across a regenerate: 2).
- [ ] **Step 3: Implement** the fix the numbers call for.
- [ ] **Step 4: Re-time, then run** `npx vitest run test/framework/measure test/framework/selection`. Expected: PASS, and the timing doc shows hover and click p95 ≤ 16 ms on the typical part. If they are not, write down why.
- [ ] **Step 5: Commit.** `git commit -m "measure: hover and click within a frame"`

### Task 9: Docs, types, version

**Files:**
- Modify: `docs/AUTHORING-PARTS.md:865-868`
- Modify: `types/index.d.ts:466-480` (`MeasureRuntime` doc comment)
- Modify: `src/framework/mount.js:218-221` (comment)
- Modify: `AGENTS.md`, if it describes measure mode (search for "measure")
- Modify: `package.json` version (next minor)

- [ ] **Step 1: Replace** "a click pins that dimension so it tracks parameter changes live. Label the features a user would want to measure; unlabeled geometry still measures as its bounding box." with:

> a click on a labeled feature reads its one number (⌀ for a hole, R for an arc, the length of a straight edge, W × H for a flat face), and a second click measures the distance from there. Unlabeled geometry snaps only to corners and points, for distances, so label the features a user would want to measure.

- [ ] **Step 2: Rewrite the `MeasureRuntime` comment.** `pinCount()` is the number of user measurements on screen: 0, 1 (a reading or a start point) or 2 (a distance). Readings clear when the part rebuilds, the view changes or the mode is turned off.
- [ ] **Step 3: Bump `package.json`** to the next minor. Run `npm test` and `npm run build`. Expected: green.
- [ ] **Step 4: Commit,** then open the partforge PR. The body follows Scott's PR style (plain-language summary, a "what this means in practice" list, the screenshots from Task 6 Step 6), with a closing note listing the two behaviour changes: readings clear on rebuild, and distances from a hole start at its axis.

### Task 10 (partforge-cloud, after the partforge release is on npm): the floor

Wait until `npm view partforge version` shows the release (partforge AGENTS.md "Releasing").

**Files:**
- Modify: `package.json`, `package-lock.json` (partforge `^<new version>`)
- Modify: `AGENTS.md` (the version-floor list in "Viewer + sandbox")
- Regenerate: `prompts/` (`npm run docs:generate && npm run prompt:generate`)

- [ ] **Step 1: Bump and install.** `npm install partforge@^<new version>`. Expected: `npm ls partforge` prints one copy.
- [ ] **Step 2: Regenerate the corpus.** `npm run docs:generate && npm run prompt:generate`. Read the prompt diff: the measure-mode paragraph should be the only authoring change from this release, plus whatever else shipped in between.
- [ ] **Step 3: Add the floor entry** to the AGENTS.md list, in its house form: "≥<version> (**the two-click measure mode** — snaps, one reading per click, a distance on the second, readings clear on rebuild; below it the old hover-and-pin mode works as before, and nothing errors)". Increase the count in "Thirty-N partforge version floors". Mirror it into `docs/agents/viewer-and-sandbox.md` if that doc lists floors.
- [ ] **Step 4: Run** `npm test`. Expected: green (`doc-corpus` and `authoring-prompt` pass after the regenerate).
- [ ] **Step 5: Check it in a real browser.** Use the app preview (`preview_start`) on an owned forge: enter measure, hover, click a hole, click a corner, Clear, move a slider. Check that `src/sandbox/mountManager.js:1137`'s `measure.isEnabled()` check still behaves.
- [ ] **Step 6: Commit and open the cloud PR.**
