# Cage Pose Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A handle drag or a panel slider drag on a `k.cage` + `k.subdiv` body follows the pointer, by reusing the smoothing structure while only cage points move.

**Architecture:** The worker keeps, per cage topology, the level, the per-level structure and the quad diagonals of the last full preview build (a "subdiv plan"). A build the viewer flags as a drag build re-applies that plan to the new cage points and skips the level search and the self-intersection check. The viewer flags handle holds and interactive slider edits, draws the result as a drag shape, and always ends in a full build.

**Tech Stack:** JavaScript (ES modules), vitest, Manifold WASM, Node 24.

**Spec:** `docs/superpowers/specs/2026-11-22-cage-pose-drag-design.md`. This plan covers the spec's PR 1 and PR 2, and the spike that opens PR 3 (Task 10). Part 3 and Part 4 (viewer-side weights and public pages) get their own plan once the spike has shown how weights ride through booleans.

## Global Constraints

- No new agent-facing API: nothing is added to `k`, to a cage, to `limb`, or to `handles`.
- The fast path is preview tier only. Print builds are unchanged.
- Release always ends in a full build: level search, diagonals, self-intersection check.
- A drag stops at the last valid pose. A pose that fails the drag validity check is never drawn.
- A drag shape is never reported to the host, exported, captured or measured.
- A drag solid must never be stored under the ordinary `h("subdiv", snapshot, tier)` key.
- `SKIN_PAUSE_MS` (150) and `LIVE_REBUILD_MS` (120) keep their values.
- Gate for PR 2: on the cage hand with its flat cut, 33 ms or less from one drawn drag shape to the next, in a browser on the bench machine. Between 33 and 120 ms it still ships.
- PR 1 bumps the version to 0.198.2, PR 2 to 0.199.0, each with a CHANGELOG entry. The bump is in the same PR as the change.
- Docs follow the repo's plain-English rules (see `AGENTS.md`). The guide's code blocks with `// value` comments are executed by `test/organic-docs.test.js`; keep them true.
- Commit after each task. Run `npm test` for the files a task names, and `npm run lint` before each PR.

## Review Focus

1. **A release at the last drag pose.** The release build must not be answered by a cached drag solid or by a `cut`/`union` built from one. Test in Task 5.
2. **A topology change mid-drag** (a slider that drives an extrude `steps` or a face count). The flagged build must fall back to a full build, not apply a stale plan. Tests in Tasks 4 and 5.
3. **A slider edit must not report a drag shape.** `onBuild`, export enablement and preview hand-over fire only for the pause build. Test in Task 8.
4. **A pose that is invalid mid-drag** (the body cuts through itself, `rotate` or `scale` refuses a short edge, or zero volume). It is not drawn, the handle's parameters return to the last valid values, and the next move still builds. Tests in Tasks 5, 7 and 8.
5. **Two cages in one sub-part, or one cage smoothed twice.** Plans are kept per topology key and tier, so both get the fast path and neither reads the other's plan. Test in Task 5.

---

## PR 1: the recipe

### Task 1: the reference part `src/parts/cage-hand.js`

**Files:**
- Create: `src/parts/cage-hand.js`, `cage-hand.html` (copy the shape of `hand.html`), `test/cage-hand.test.js`
- Modify: `src/framework/domains/organic/manifest.js` (list it beside `organic-whale` as a reference part), `vite.config.js` only if demo pages are listed there

**Interfaces:**
- Produces: default-exported part with sub-part `hand`, views `{ assembly, print }`; parameters `<f>Knuckle` (range −10 to 90) and `<f>Curl` (0 to 110) for `f` in `index, middle, ring, pinky`, plus `thumbCurl` (0 to 60); `derive` returns one posed limb per digit under the keys `index, middle, ring, pinky, thumb`; `handles` has one `{ on: "<digit>", drag: "angles", params: [...] }` per digit. Named export `cageHand(make, p, bends)` where `bends` maps digit to its `posed.values`.

- [ ] **Step 1: Write the failing tests** in `test/cage-hand.test.js`:
  - lint is clean (`lintPart` as `test/hand-part.test.js` does);
  - the part builds at defaults, at every parameter's min, and at every parameter's max, watertight, on the preview tier;
  - for each finger at defaults, the limb's `report.tip` and `cageHand(cage, …).centroid("<f>Tip")` are within 6 mm (the tip cap sits past the last joint by the tip extrude);
  - `handCage`-style face count is stable across poses: `cageHand(cage, defaults, …).faces().length` equals the count at every parameter's max.
- [ ] **Step 2: Run** `npx vitest run test/cage-hand.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Write the part.** Start from the guide's `handCage` (`docs/domains/organic.md`, "Worked example: a hand that curls"). Per finger, declare `limb("<f>", { at, toward: [0, 0, 1], bendToward: [0, -1, 0], joints: [mcp, pip, dip follows pip × 0.75], lengths })` with `at` at the centre of the palm's top face for that finger plus the neck length, and `lengths` equal to the cage's segment lengths. Each knuckle is three 6 mm rings centred on the joint, each turning a third of the joint's value from `posed.values`, about `x`, pivoting on the centroid of the face it grew from. The thumb is one limb with one joint. Keep the flat `cut` under the wrist. No `mirror`.
- [ ] **Step 4: Run** the test. Expected: PASS. Also run `node bin/cli.js measure src/parts/cage-hand.js --drag index --to <a point within reach>` and confirm it reports changed `indexKnuckle` and `indexCurl`.
- [ ] **Step 5: Commit.**

### Task 2: the guide

**Files:**
- Modify: `docs/domains/organic.md` ("Drag handles on a cage", "Worked example: a hand that curls"), `docs/domains/kinematics.md` ("Organic bodies": one paragraph pointing at the cage recipe), `test/organic-docs.test.js` if a block's expected value changes, `CHANGELOG.md`, `package.json` (0.198.2)

- [ ] **Step 1:** In "Drag handles on a cage", add the limb-driven pattern after the `eel` example: a `limb` in `derive`, `posed.values` into `rotate`, one `angles` handle per chain. State the two rules that put the handle on the body: knuckle rings are centred on the limb's joint, and segment lengths equal the limb's `lengths`. Include one runnable block (a one-finger cage with a `// value` check of the tip centroid).
- [ ] **Step 2:** Rewrite the worked hand to describe `src/parts/cage-hand.js`: per-finger limbs and handles. Keep the three knuckle-ring bullets. Leave the lines "No pose drag" and "Every such drag is a shape drag" as they are; Task 9 rewrites them.
- [ ] **Step 3: Run** `npx vitest run test/organic-docs.test.js test/kinematics-docs.test.js test/domain-index.test.js`. Expected: PASS.
- [ ] **Step 4:** CHANGELOG entry and version 0.198.2. Run `npm run lint`. Commit. Open PR 1.

---

## PR 2: the fast drag build

### Task 3: `scripts/bench-cage-drag.mjs`

**Files:**
- Create: `scripts/bench-cage-drag.mjs`
- Modify: `package.json` (`"bench:cage-drag": "node scripts/bench-cage-drag.mjs"`)

**Interfaces:**
- Produces: also `dragValidity`'s cost at levels 1 and 2 once Task 5 exists (add the row then). A table, for `cage-hand` and `organic-whale`, of CPU ms (median of 12, `process.cpuUsage`, as `bench-pose-drag.mjs` does) for: cage code (`cageHand(cage, …)` + `snapshot()`), `levelFor`, `subdivide` with the built mesh, `selfIntersections`, Manifold import (`manifoldFromWeldedMesh`), the part's `cut`, `toMesh({ quality: "preview" })`, and the whole `build` + `toMesh`.

- [ ] **Step 1:** Write the script. Import the stages from `src/framework/geometry/subdiv/` directly; get a kernel from `src/testing/manifold.js`.
- [ ] **Step 2: Run** `npm run bench:cage-drag`. Paste the table into the spec under "Measure first".
- [ ] **Step 3: Checkpoint.** Add up the stages a drag build still runs: cage code, Manifold import, `cut`, `toMesh`. If that sum is over 120 ms on the hand, the plan as written cannot reach live rebuild: stop, record the numbers in the ledger, and report, because Part 3 is then needed first. Otherwise commit and go on.

### Task 4: the subdiv plan in `surface.js`

**Files:**
- Modify: `src/framework/geometry/subdiv/surface.js`
- Test: `test/subdiv-plan.test.js`

**Interfaces:**
- Produces:
  - `topologyKey(snapshot): string` — a hash of `faces`, `ids` and `creases`; `points` are not read.
  - `subdivPlan(snapshot, level): Plan` — `Plan` is `{ key, level, pointCount, levels, indices, triFace, triRegion?, regions?, creasePairs? }`. `levels` holds each level's structure with no positions. `indices` are the diagonals `subdivide(snapshot, level)` picks at this snapshot's positions.
  - `applySubdivPlan(plan, points): { positions, indices, triFace, triRegion?, regions?, creasePairs? }` — `indices` and the rest are the plan's own arrays (not copied). Throws `subdiv: plan does not match the cage` when `points.length !== plan.pointCount`.

- [ ] **Step 1: Write the failing tests:**
  - `topologyKey` is equal for a cage before and after `move`, `scale` and `rotate`; different after an extra `extrude`, a different `steps`, an added `crease`, and for two cages whose extrudes ran in a different order.
  - For a box cage, an extruded and rotated cage, a mirrored cage and a creased cage: `applySubdivPlan(subdivPlan(s, L), s.points).positions` equals `subdivide(s, L).positions` exactly (`toEqual` on the typed array), and `indices`, `triFace`, `triRegion` are equal too, for L = 1, 2, 3.
  - Moved points: build the plan at pose A, apply it to pose B's points; positions equal `subdivide(snapshotB, L).positions` exactly.
  - A point-count mismatch throws the message above.
- [ ] **Step 2: Run** `npx vitest run test/subdiv-plan.test.js`. Expected: FAIL, `subdivPlan` is not exported.
- [ ] **Step 3: Implement.** Split the position arithmetic out of `step` and `limit` so one function computes a level's positions from the level's structure and the level below's positions; `step` and `limit` call it, so the ordinary path and the plan share one copy of the arithmetic. `subdivPlan` runs the steps once and keeps each level's structure. Use the repo's existing hash helper for `topologyKey`.
- [ ] **Step 4: Run** the new test and `npx vitest run test/subdiv` (the existing subdiv tests). Expected: PASS, and the existing tests unchanged.
- [ ] **Step 5: Commit.**

### Task 5: drag builds in the Manifold backend

**Files:**
- Modify: `src/framework/geometry/subdiv/index.js`, `src/framework/geometry/manifold-backend.js` (the `subdiv` op near line 1189, and the `_set…` hooks near line 1264)
- Test: `test/subdiv-drag-build.test.js`

**Interfaces:**
- Consumes: Task 4's three functions.
- Produces:
  - `dragValidity(plan, points): null | { message, faces }` in `subdiv/index.js`: runs `selfIntersections` on the plan's surface at level `min(plan.level, DRAG_CHECK_LEVEL)` and the zero-volume test. `DRAG_CHECK_LEVEL` starts at 2; lower it if Task 3's bench shows the check over 5 ms on the cage hand. `message` uses `throughMessage`'s wording.
  - `meshSubdivDrag(snapshot, plan)` in `subdiv/index.js`: the same return shape as `meshSubdiv`, `warnings: []`, no level search. It calls `dragValidity` first and throws an error with `code: "subdiv-drag-invalid"` and the message when the pose fails.
  - Kernel hooks: `kernel._setDragBuild(on: boolean)` and `kernel._takeDragCapable(): boolean` (true when a `subdiv` call since the last take stored or used a plan; reading it resets it).
  - Behaviour of `k.subdiv` at the preview tier: a full build stores `subdivPlan(snapshot, level)` in a plan map keyed `topologyKey + tier`. With drag mode on and a plan for the key present, it builds through `meshSubdivDrag` and caches the solid under `h("subdiv", snapshot, tier, "drag")`. With drag mode on and no plan, it is an ordinary full build.

- [ ] **Step 1: Write the failing tests** (kernel from `src/testing/manifold.js`):
  - Full build at pose A, `_setDragBuild(true)`, build at pose B: the solid's volume is within 0.5% of a fresh kernel's full build at B, and `levelFor` was not called (spy on the module).
  - Drag mode on, pose B curls a finger through the palm: the build throws with `code: "subdiv-drag-invalid"` and names the faces; a pose where `rotate` refuses a short edge throws the same code.
  - Review Focus 1: after that, `_setDragBuild(false)` and build at pose B again, with a `cut` applied in both builds: the level search runs (spy on `levelFor`), and the result is not the drag solid (different cache key; assert via the kernel's cache stats or object identity).
  - Review Focus 2: drag mode on, pose B has one more extrude than A: `levelFor` runs (a full build).
  - Review Focus 5: a sub-part that smooths two different cages: both drag builds use their own plan (positions match each cage's own full build within tolerance).
  - Drag mode on at the print tier: a full build.
  - `_takeDragCapable()` is true after a preview `subdiv`, false on the next call with no `subdiv` between.
  - A drag build that throws (zero volume) leaves the plan map intact: the next drag build at a valid pose succeeds.
- [ ] **Step 2: Run** the test. Expected: FAIL, hooks undefined.
- [ ] **Step 3: Implement.** Keep the plan map beside `subdivSources`; bound it at 8 entries, dropping the oldest. Drag solids go through `cache.lookup` under the drag key, so the cache's own budget frees them; register their IDs and policies exactly as the full path does, and delete them in `dispose`. Do not write `subdivSources` or `subdivWarnings` for a drag solid.
- [ ] **Step 4: Run** the new test and `npx vitest run test/subdiv test/organic-whale.test.js test/domain-kernel-ops.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: the job flag and the reply field

**Files:**
- Modify: `src/framework/jobs.js` (the `generate` case near lines 498–545, and the message list comment near line 79)
- Test: `test/subdiv-drag-jobs.test.js` (shape it on `test/cache-jobs.test.js`)

**Interfaces:**
- Consumes: Task 5's hooks.
- Produces: a sub-part whose drag build throws `subdiv-drag-invalid` is reported in the `meshes` reply's `invalid: [{ name, message }]` list, not as an `error` message, and no mesh is sent for it. `generate` accepts `drag: true` and calls `kernel._setDragBuild?.(msg.drag === true)` before building (and sets it false after, in the `finally`). Each mesh in a `meshes` reply carries `dragBuild: true` when `kernel._takeDragCapable?.()` was true for that sub-part's build.

- [ ] **Step 1: Write the failing tests:** a `generate` for the cage hand replies with `dragBuild: true` on `hand`; for a plain box part the field is absent; a `generate` with `drag: true` after a full one returns a mesh whose bounding box matches a full build at the same params within 0.5 mm; a `generate` with no `drag` after a `drag: true` one is a full build (spy `levelFor`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Take `_takeDragCapable` per sub-part, inside the per-sub-part bracket.
- [ ] **Step 4: Run** the new test and `npx vitest run test/cache-jobs.test.js test/jobs-extension.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 7: handle holds in `mount.js`

**Files:**
- Modify: `src/framework/mount.js` (the `hold` handler near line 915, the loop's `send` near line 1431, the `meshes` case near line 1941)
- Test: `test/mount-cage-drag.test.js` (shape it on an existing `test/mount-*.test.js` that drives a fake service)

**Interfaces:**
- Consumes: `dragBuild` on meshes, `drag: true` on `generate`.
- Produces: a set `dragCapable` of sub-part names, updated from every non-transient `meshes` reply. In `hold(true)`: `liveRebuild` is true when `lastBuildMs < LIVE_REBUILD_MS` as today, or when every sub-part of the view that the handle's parameters can make stale is in `dragCapable`. A dispatch with `cycleTransient` true sends `drag: true`. A transient reply's `data.ms` does not overwrite `lastBuildMs`; it is compared with `LIVE_REBUILD_MS` for the existing `liveSlow` fade.

- [ ] **Step 1: Write the failing tests:**
  - A slow full build (ms 400) with `dragBuild: true`, then `hold(true)` and a param move: one `generate` is sent, with `drag: true`.
  - The same with no `dragBuild`: no `generate` during the hold (today's behaviour).
  - A transient reply of 200 ms fades the part (`liveSlow`); one of 20 ms does not.
  - Release sends a `generate` with no `drag`.
  - Review Focus 4: a transient reply listing the sub-part in `invalid` leaves the last mesh shown, writes the handle's parameters back to the values of the last transient build that drew (or the hold's start values), and the next move sends another `generate` with `drag: true`.
  - After such a stop, release at the restored values sends one full `generate` and reports those values to the host.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** as the interface block says. Do not change what `owed`, `cycleTransient` or the release path do.
- [ ] **Step 4: Run** the new test and `npx vitest run test/mount` (all mount tests) and `test/handle-*.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 8: panel sliders in `mount.js`

**Files:**
- Modify: `src/framework/mount.js` (`applyParamChange` near line 2223, the loop's `missingParts` and `send`), `src/framework/regen-loop.js` only if a transient cycle cannot be sent through the existing loop
- Test: `test/mount-cage-drag.test.js`

**Interfaces:**
- Produces: in `applyParamChange`, when `interactive` is true, no pose hold is active, nothing was skinned, and every stale sub-part of the view is in `dragCapable`: the viewer sends a transient drag cycle at once (`cycleTransient` true, `drag: true`) and calls `loop.delayKick(SKIN_PAUSE_MS)` for the ordinary build. A further interactive change while that cycle is in flight re-arms the delay; the next drag cycle goes out when the reply lands and the params have moved again. A non-interactive change takes the ordinary path.

- [ ] **Step 1: Write the failing tests:**
  - An interactive change on a drag-capable part sends `generate` with `drag: true` immediately (no 180 ms debounce).
  - Review Focus 3: its reply draws the mesh and does not call the host's `onBuild`, does not enable export, and `capture` still returns the last exact mesh.
  - 150 ms after the last change, a `generate` with no `drag` is sent; its reply calls `onBuild`.
  - A slider moved into an invalid pose: nothing new is drawn; the pause build is not sent for the invalid values; the parameter is set back to the last valid value, the panel shows it, and the full build runs at that value.
  - A full release build refused by the full self-intersection check at the preview tier puts the parameter back to the last value whose full build passed. (At the preview tier `meshSubdiv` only warns today; the viewer treats that warning on a build that follows a drag as a refusal.)
  - `setParams` and an animation frame send no `drag: true`.
  - A part that is not drag-capable behaves exactly as before (snapshot the sent messages against the current behaviour first).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse the transient reply handling the handle path already has (`owed`, no status line). If a sub-part has both skinned implicit pieces and a cage, the skin path wins and this path stays out.
- [ ] **Step 4: Run** all mount tests and `test/hand-part.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 9: measure in a browser, then docs and release

**Files:**
- Modify: `docs/domains/organic.md`, the spec (record the measured numbers), `CHANGELOG.md`, `package.json` (0.199.0), `types/` if a `.d.ts` lists kernel hooks or message shapes

- [ ] **Step 1:** Run `npm run dev`, open `cage-hand.html`, and measure the time between drawn drag shapes for a fingertip handle drag and for an `indexCurl` slider drag (use the viewer's `?debug` overlay, or `performance.now()` around the `meshes` handler; median of at least 30 moves). Record both in the spec beside the Node bench table.
- [ ] **Step 2: Gate.** 33 ms or less: done. Between 33 and 120 ms: ship, and add a line to the spec that Part 3 is next. Over 120 ms: stop and report.
- [ ] **Step 3:** In the guide's cage section, replace "No pose drag" and "Every such drag is a shape drag" with: a drag on a cage follows the pointer; what the drag shape may differ in (level, diagonals, a self-cutting pose shown until release); what does not take the fast path (a change to the faces, `setParams`, animations, the print tier). Keep it under 15 lines.
- [ ] **Step 4: Run** `npm test` and `npm run lint` in full. Expected: PASS.
- [ ] **Step 5:** CHANGELOG, version 0.199.0, commit, open PR 2.

### Task 10: spike, weights through booleans (opens PR 3; no production code)

**Files:**
- Create: `scripts/spike-cage-weights.mjs` (not shipped; delete or keep under `scripts/` per the repo's habit)

- [ ] **Step 1:** On the cage hand, give each corner of the smooth surface's triangles a limit triangle index and three weights, carried as Manifold vertex properties (see how `geometry/mesh-bindings.js` carries the implicit bindings). Apply the part's flat `cut`. Read the properties back per output corner.
- [ ] **Step 2:** Move the cage to another pose, apply the plan, place every output corner from its triangle and weights, and compare with a full build at that pose: report the largest distance on the smooth skin and on the cut face.
- [ ] **Step 3:** Write the result into the spec under "Part 3": the property layout that worked, the errors measured, and the cost per move in the main thread. If no layout survives the cut, say so and stop: Part 3 and Part 4 then need a different idea, and the owner must be told.

---

## After these PRs (partforge-cloud, not planned here)

Bump to 0.199.0, regenerate prompts, change the organic rule's "or a limb the user drags in Pose mode", add the floor note, and rerun the four organic eval cases. The cache floor moves to encoder 7, with a backfill, only when PR 4 ships.
