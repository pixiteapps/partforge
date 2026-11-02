# Generic Handles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any part declare draggable handles (free point, axis, plane, rotary) on points `derive` computes, driving motion or shape parameters, plus a `partforge/mechanisms` domain for gear trains, belts, racks and crank-sliders.

**Architecture:** A non-limb handle is adapted into the same plain-JSON "info" record Pose mode already draws and hit-tests for limbs (one point, no joints), so `pose-mode.js` gains a second source of shown entries rather than a second mode. The drag solver in `param-solve.js` is generalised from `d[limb].world(at)` to a `locate` function and gains per-kind targets (rotary uses an angular residual). Mount relaxes its regen hold for cheap shape drags and keeps those builds transient. The oracle's `measure()` gains a `handles` list, which the CLI prints and `inspect` carries to partforge-cloud.

**Tech Stack:** plain ESM JavaScript, three.js (overlay only), vitest, Playwright (check script), Node 24 (`nvm use`; in a sandbox PATH-prefix `~/.nvm/versions/node/v24*/bin`).

**Spec:** `docs/superpowers/specs/2026-11-02-generic-handles-design.md` — read it first; this plan argues from it.

## Global Constraints

- Handle points come from `derive` or a pure `(p, d) => …` function, never from the kernel or built geometry.
- A point source is recognised by plain data only: `typeof v?.handleInfo === "function"` (limbs: `typeof v?.ikInfo === "function"`). Never `instanceof`, Symbols or WeakMaps keyed on sources.
- Core never imports a domain folder (`test/domain-layering.test.js`). `src/framework/pose/` must not import `domains/mechanisms/`.
- `param-solve.js`, `pose-session.js`, the new `handle-source.js` and `drag-kinds.js` stay pure: no DOM, no three.js, no `node:`.
- `src/framework/oracle/` stays DOM-free, three-free, `node:`-free (`test/worker-layering.test.js`).
- Existing `limb` handles (`mode: "goal"` / `"angles"`), joint rings, aim gizmo, pins on limbs and `runtime.pose` behave byte-for-byte as today: every existing `test/pose-*.test.js`, `test/lint-handles.test.js` and `scripts/check-pose.mjs` stay green unmodified.
- Wrapped params are stored unreduced (720 after two turns); only the panel slider shows them reduced into `[min, max)`.
- `LIVE_REBUILD_MS = 120`. Mid-drag builds fire no `onBuild`, do not change export/preview/inspect state, and do not commit.
- `inspect`/`measure` `handles` is absent (not `[]`) for a part with no `handles`; `test/verify-golden.test.js` must not move.
- Pin ids: `"<handle>:<at>"` for an `on` handle, `"<handle>:point"` for a `point` handle.
- Path preview: 32 samples; a wrapped param samples one turn (`min..max`).
- Reveal: 32 CSS px from the point (mouse), 24 px (touch), or hover over a `showOn` sub-part.
- Lint ids exactly: `handle-no-source`, `handle-unknown-source`, `handle-on-limb`, `handle-bad-drag`, `handle-point-throws`, `handle-inert` (warning), `handle-axis-moves` (warning), `wrap-needs-range`.
- Bump `package.json` version (0.178.1 → 0.179.0) in the last task; never `npm publish`.

## Review Focus

1. A rotary drag that crosses the axis line on screen (pointer passes over the axis centre): the accumulated angle must not jump 180°. Test in Task 4.
2. A rotary drag on a gear whose `point` is on its axis (radius 0) or a rotary handle viewed exactly edge-on: falls back to the screen-space turn, never NaN. Test in Task 4.
3. A `point` function that throws for some params mid-drag: that frame scores FAILED and the drag holds the last good values, as limb derives do. Test in Task 3.
4. Two handles sharing one wrapped param (every gear on `driveAngle`) with one gear pinned: the drag writes nothing and shows the miss, it does not spin. Test in Task 3.
5. A shape drag on a part whose last build was 119 ms vs 121 ms: live rebuild on vs off, decided once at drag start even if a mid-drag build is slower. Test in Task 7.

---

### Task 1: `wrap: true` number controls

**Files:**
- Modify: `src/framework/pose/param-solve.js` (`rangesOf`, `clamp`, `snapValues`)
- Modify: `src/framework/panel/widgets/numeric.js` (slider display and write)
- Modify: `src/framework/lint/rules-schema.js:311` (defaults range check), `src/framework/lint/rules-animations.js:218` (`animation-value-out-of-range`), add `wrap-needs-range` in `rules-schema.js`
- Modify: `types/part.d.ts` (number control `wrap?: boolean`)
- Test: `test/pose-param-solve.test.js`, `test/lint-schema-wrap.test.js` (new), panel test beside existing numeric widget tests

**Interfaces:**
- Produces: `rangesOf(part)` entries become `{ min, max, step, wrap: boolean }` (export `rangesOf` — Task 3 uses it). `clamp(v, r)` returns `v` unchanged when `r.wrap`. `snapValues(part, values)` rounds to step but never clamps a wrapped key.
- Produces: `reduceWrapped(v, min, max) -> number` in `numeric.js` (`min + mod(v - min, max - min)`, result in `[min, max)`), and `sameTurn(stored, shown, min, max) -> number` (the unreduced value in `stored`'s turn whose reduction is `shown`, choosing the turn nearest `stored`).

- [ ] **Step 1: Write failing tests**
  - `snapValues` on a `wrap` control `{min:0,max:360,step:0.1}` with `{ a: 720.04 }` → `{ a: 720 }`; a non-wrap control with 400 → 360.
  - `reduceWrapped(720, 0, 360) === 0`, `reduceWrapped(-10, 0, 360) === 350`.
  - `sameTurn(725, 10, 0, 360) === 730`; `sameTurn(725, 350, 0, 360) === 710`.
  - Lint: `wrap: true` without `min`/`max` → error `wrap-needs-range`; `defaults.a = 725` on a wrap control → no range finding; an animation keyframe of 725 on a wrap control → no `animation-value-out-of-range`.
- [ ] **Step 2: Run** `npx vitest run test/pose-param-solve.test.js test/lint-schema-wrap.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** Slider shows `reduceWrapped(value)`; on slider input writes `sameTurn(stored, sliderValue)`. The typed box shows and accepts the raw value. `runtime.setParams` and animation interpolation are unchanged (raw values).
- [ ] **Step 4: Run** the same tests plus `npx vitest run test/lint-handles.test.js test/pose-*.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(params): wrap: true number controls store unreduced turns`

### Task 2: Handle sources and the declaration model

**Files:**
- Create: `src/framework/pose/handle-source.js`
- Modify: `src/framework/mount.js:73` (`handleParamKeys` moves to `handle-source.js` and is imported)
- Modify: `types/part.d.ts` (`Handle = GoalHandle | AnglesHandle | PointHandle`; `PointHandle` with `on?`, `at?`, `point?`, `params: string[]`, `drag?: "point"|"axis"|"plane"|"rotary"`, `direction?`, `normal?`, `axis?`, `lock?`, `label?`, `showOn?: string|string[]`, `readout?: string[]`; each geometric field also accepts `(p, d) => …`)
- Test: `test/handle-source.test.js` (new)

**Interfaces:**
- Produces (all pure, never throw unless noted):
  - `handleKind(h) -> "limb" | "on" | "point" | null` (`limb` present → "limb"; exactly one of `on`/`point` → that; else null).
  - `handleParamKeys(h) -> string[]` (today's behaviour for limb handles; `params` + `lock` for the others).
  - `handleAt(h) -> string` (`h.at` for `on`; `"point"` for `point`).
  - `sourceInfo(d, key) -> object | null` — `d[key].handleInfo()` JSON, or null.
  - `locateHandle(part, p, d, handle) -> [x,y,z]` — **throws** when the point cannot be read (the solver scores a throw as FAILED).
  - `resolveGeom(value, p, d)` — calls it when a function, else returns it.
  - `handleAxis(handle, p, d) -> { origin, direction } | null` — rotary: `handle.axis` resolved, else the source's `axes[at.split(".")[0]]`; axis: `{ origin: point, direction }`; plane: `{ origin: point, direction: normal }`.
  - `handleRecord(part, params, d, handleId) -> { kind: "partforge.handle", name: "handle:<id>", handleId, joints: [], points: { tip: [x,y,z] }, tip: "tip", values: [], axes: {}, lines?: [[a,b]…] (resolved to point pairs from the source's lines), drag, axis }` or null — the pseudo-limb record Pose mode draws.

- [ ] **Step 1: Write failing tests** covering: kind detection for all three forms and the invalid ones; `locateHandle` on an `on` source, a `point` function, and a throwing function (throws); `handleAxis` taking the source's `axes.gear1` for `at: "gear1.rim"`; `handleRecord` shape (exact keys above); `handleParamKeys` unchanged for the robot arm's `tool` and the hand's `index` (compare against the current mount output, copied as literals).
- [ ] **Step 2: Run** `npx vitest run test/handle-source.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `handle-source.js`; switch mount.js to import `handleParamKeys`.
- [ ] **Step 4: Run** `npx vitest run test/handle-source.test.js test/pose-mount-handle.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(pose): handle sources — on/point handles as pseudo-limb records`

### Task 3: Solver — generic locate, drag-kind targets, generic holds

**Files:**
- Modify: `src/framework/pose/param-solve.js`
- Test: `test/pose-param-solve.test.js`, `test/handle-solve.test.js` (new)

**Interfaces:**
- Consumes: Task 1 `rangesOf`/`clamp`; Task 2 `locateHandle`, `handleAxis`.
- Produces:
  - `solveAngles` keeps its signature; internally its points use `locate(d, ref)` where `ref` is `{ limb, at }` (limb, unchanged maths) or `{ handleId, handle }` (generic). A hold becomes `{ ref, point }`; the old `{ limb, at, point }` shape is still accepted.
  - `solveHandle({ part, params, handle, target, holds = [], allHandles, iterations = 8, tol = TOL_MM }) -> { values, error } | null` where `target` is `{ point: [x,y,z] }` for point/axis/plane, `{ angleDeg, axis, radius }` for rotary. Rotary residual (first point): `radius * rad(wrapTo180(angleOf(point, axis) - target.angleDeg))` on one component, plus the point's distance off the axis-perpendicular plane at drag start on a second, so units stay mm and holds weigh the same (`HOLD_WEIGHT`).
  - Starting damping for a generic handle: `max(1, radius)` for rotary (radius in mm), else the distance in mm the point moves when every listed param goes from its min to its max (one derive at each end; 1 when unbounded or unreadable). It plays the role `limbLength` plays for a limb; say so in a comment.

- [ ] **Step 1: Write failing tests** (`test/handle-solve.test.js`, using small in-file fixture parts whose `derive` returns a hand-written `handleInfo` source):
  - axis handle on `drawerOpen` (point = `[0, -p.drawerOpen, 0]`): target `[0,-40,0]` → `drawerOpen ≈ 40` within 1e-3.
  - plane handle on `width`,`depth` (corner `[w/2, d/2, 10]`): target `[50, 30, 10]` → `width ≈ 100`, `depth ≈ 60`.
  - rotary on a 3-gear train (`driveAngle` wrap 0..360; gear angles `a`, `-a*20/30`, `a*20/40`): grabbing gear 3's rim with `angleDeg` = current + 90 → gear 3 turned 90° (driveAngle +180); repeated in 10 steps of 72° to 720° total → `driveAngle` reaches its start + 1440 with no step going backwards.
  - Review Focus 3: `point` throws when `width > 200`; target asks for 300 → result `width ≤ 200` and finite error, no throw.
  - Review Focus 4: same train with gear 2's rim pinned → `driveAngle` changes by < 0.01° and `error` > 1.
  - Existing angles-mode tests unchanged and green.
- [ ] **Step 2: Run** `npx vitest run test/handle-solve.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `solveHandle` and the `locate` refactor.
- [ ] **Step 4: Run** `npx vitest run test/handle-solve.test.js test/pose-param-solve.test.js test/pose-session.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(pose): solveHandle — axis, plane and rotary targets through derive`

### Task 4: Drag kinds — pointer to target

**Files:**
- Create: `src/framework/pose/drag-kinds.js` (pure)
- Test: `test/drag-kinds.test.js` (new)

**Interfaces:**
- Consumes: `pose-geom.js`'s existing ray/plane helpers.
- Produces: `startDrag(kind, { point, axis, ray, screen }) -> state` and `dragTarget(state, { ray, screen }) -> target` where `target` matches Task 3's `solveHandle` target. `point` keeps the existing plane rule (reuse the function `pose-mode.js` uses today for angles drags; move it here if needed). `axis`: closest point on the line to the ray; when the line is within 18° of the view direction, use the screen-projected line. `plane`: ray–plane hit; when the plane is within 18° of edge-on, fall back to the `point` rule. `rotary`: `state.angleDeg` accumulates `wrapTo180(Δ)` per call, read on the axis plane, or by screen-space turn about the projected axis centre (as `gizmo/gizmo-rotate.js`) when edge-on or when the ray–plane hit is within 4 CSS px of the axis on screen.

- [ ] **Step 1: Write failing tests:** axis drag along +Y; axis nearly view-aligned (fallback, finite); plane drag; rotary 4 × 100° calls → `angleDeg` = start + 400; Review Focus 1: pointer path crossing the axis centre → no single step with |Δ| > 30°; Review Focus 2: radius-0 point and exactly edge-on axis → finite target, no NaN.
- [ ] **Step 2: Run** `npx vitest run test/drag-kinds.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(pose): drag kinds — axis, plane, rotary pointer targets`

### Task 5: Session — generic handles, pins and wrap

**Files:**
- Modify: `src/framework/pose/pose-session.js`
- Test: `test/pose-session.test.js`

**Interfaces:**
- Consumes: Task 2 `handleKind`, `locateHandle`, `handleAt`; Task 3 `solveHandle`; Task 4 targets.
- Produces: `defaultSolve` dispatches `handleKind(handle) !== "limb"` to `solveHandle`. `begin(handleId, grab)` for a generic handle takes `grab = handleAt(handle)`. `frame(target)` accepts the Task 3 target shapes. `pinTarget(id, handles)` returns `{ handleId, handle, ref }` for generic pins (`ref = { handleId, handle }`); `defaultLocate` reads them through `locateHandle`. `end()` snaps through Task 1's `snapValues` (wrap keys unclamped).

- [ ] **Step 1: Write failing tests:** a generic axis drag writes, ghosts stale sub-parts and commits once on `end()`; a pin `"gear2:gear2.rim"` holds through a `gear3` drag (no change); a pin `"corner:point"` round-trips through `parsePinId`/`pinTarget`; cancel restores.
- [ ] **Step 2: Run** `npx vitest run test/pose-session.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/pose-*.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(pose): session drives generic handles and holds their pins`

### Task 6: Pose mode on screen — reveal, guides, path, readout

**Files:**
- Modify: `src/framework/pose/pose-mode.js` (`readLimbs`, `nearestLimb`, `startDrag`, `dragStep`)
- Modify: `src/framework/pose/pose-scene.js` (add `setGuides(guides)` and `setReadout(r)`; return them)
- Modify: `src/framework/mount.js` (pass `hoveredSubPart: () => string | null` into `createPoseMode`, from the existing hover pick)
- Test: `test/pose-mode.test.js`

**Interfaces:**
- Consumes: Task 2 `handleRecord`; Task 4 `startDrag`/`dragTarget`; Task 5 session.
- Produces:
  - `readLimbs` appends one `handleRecord` per shown generic handle to `shown` (entry `{ handleId, handle, limbKey: null, info, generic: true }`) and to the infos given to `scene.setLimbs`; a record with `lines` draws them as bones.
  - Reveal: a generic entry is near when its point is within `NEAR_LIMB_PX` (or `TOUCH_HIT_PX` on touch), or when `handle.showOn` includes `hoveredSubPart()`.
  - `scene.setGuides([{ kind: "axis"|"plane"|"rotary"|"path", points: [[x,y,z]…] }])`: axis = double arrow (two segments ± 12 px), plane = 24 px square, rotary = ring of the handle's radius about its axis, path = polyline of 32 samples from sweeping the handle's single param through its range via `resolveParams` (computed once per hover start, cached until params change; only for one-param handles).
  - `scene.setReadout({ at: [x,y,z], text })`, text = `readout` params as `"<key> <value>"` joined by `" · "`, each rounded to its step's decimals; shown during a drag of a generic handle only.
  - `handlePoints()` includes generic handles.
- [ ] **Step 1: Write failing tests** with the fake viewer the existing `pose-mode.test.js` uses: a `point` handle shows within 32 px and hides at 40 px; a `showOn: "lid"` handle shows when `hoveredSubPart()` returns `"lid"`; dragging an axis handle calls `write` with the solved param; guides set on hover and cleared on leave; readout text `"width 84.0 · depth 60.5"` for step 0.1; limb handles' existing assertions untouched.
- [ ] **Step 2: Run** `npx vitest run test/pose-mode.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** Keep limb code paths unchanged; branch on `entry.generic`.
- [ ] **Step 4: Run** `npx vitest run test/pose-*.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(pose): show and drag generic handles with guides and readout`

### Task 7: Mount — live rebuild for cheap shape drags, transient builds

**Files:**
- Modify: `src/framework/mount.js` (`hold` effect ~829, regen loop `missingParts` ~1226, build delivery ~1620)
- Test: `test/pose-mount-handle.test.js`

**Interfaces:**
- Produces: `export const LIVE_REBUILD_MS = 120` from mount.js. At `hold(true)` mount records `liveRebuild = lastSuccessfulBuildMs != null && lastSuccessfulBuildMs < LIVE_REBUILD_MS` (where `lastSuccessfulBuildMs` is the `data.ms` of the last successful generate that rebuilt at least one sub-part). While held and `liveRebuild`, `missingParts` returns the stale parts (at most one job in flight: the existing loop's in-flight guard), deliveries call the session's `delivered(name)`, and the delivery path skips `onBuild`, `dbg` export-state updates and preview/inspect invalidation (flag the job `transient: true` at dispatch and branch on it at delivery). The release build is normal.
- [ ] **Step 1: Write failing tests:** last build 80 ms → a mid-drag param write dispatches a generate; `onBuild` not called until release, then called once; last build 200 ms → no dispatch mid-drag (today's behaviour); Review Focus 5: 119 vs 121 ms boundary, and a 300 ms mid-drag build does not switch live rebuild off for the rest of that drag.
- [ ] **Step 2: Run** `npx vitest run test/pose-mount-handle.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/pose-*.test.js test/mount*.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(mount): live rebuild during cheap shape drags, kept transient`

### Task 8: Lint rules for generic handles

**Files:**
- Modify: `src/framework/lint/rules-handles.js`
- Test: `test/lint-handles.test.js`

**Interfaces:**
- Consumes: Task 2 helpers (lint may import `pose/handle-source.js`; it is pure).
- Produces: the rules listed in Global Constraints. `handle-inert`: at the defaults, nudge each listed param by its `step` (or 0.01 × range, or 0.1) and warn when every nudge moves the point < 0.01 mm. `handle-axis-moves`: rotary only; nudge each listed param and warn when the axis origin moves > 0.01 mm or its direction > 0.1°. `handle-on-limb`: error when `on` names a value with `ikInfo`. Existing limb rules skip non-limb handles; existing messages unchanged.
- [ ] **Step 1: Write failing tests,** one passing and one failing fixture per rule.
- [ ] **Step 2: Run** `npx vitest run test/lint-handles.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS; then `npx partforge lint src/parts/robot-arm.js` and `src/parts/hand.js` report nothing new.
- [ ] **Step 5: Commit** `feat(lint): rules for generic handles`

### Task 9: `handles` in measure, the CLI and `inspect`

**Files:**
- Create: `src/framework/oracle/handles.js`
- Modify: `src/framework/oracle/measure.js` (beside `probes`, ~533), `bin/cli.js` (`printMeasure`, beside probes ~527)
- Modify: `types/` for the measure report (find the `probes` report type and add `handles`)
- Test: `test/oracle-handles.test.js` (new), `test/inspect-job.test.js`

**Interfaces:**
- Consumes: Task 2 `handleKind`, `locateHandle`, `handleAxis`, `handleParamKeys`; `relevantParamKeys` from `param-deps.js`; `resolveParams` from `part-model.js`.
- Produces: `handlesReport(part, view, params) -> Array | undefined` (undefined when the part has no handles). Entries exactly as spec §7: `{ id, label, kind, point, params, direction?, origin?, locked, error? }`; `kind` is `"point"|"axis"|"plane"|"rotary"` for generic, `"limb-goal"|"limb-angles"` for limb handles (limb point = `world(at).origin`); coordinates rounded to 0.001; filtered to handles with a param in `relevantParamKeys` (all when it returns `RELEVANT_ALL`); a throwing point gives `point: null, error: <message, first line, ≤ 120 chars>`. `measure()` sets `report.handles` only when defined. CLI prints `  handles:` then one line per handle: `    <label> (<kind>) at [x, y, z] → <params joined ", ">`.
- [ ] **Step 1: Write failing tests:** robot arm report has `tool` with kind `"limb-goal"`; a fixture with axis/rotary/throwing handles matches exact JSON; a part without handles has no `handles` key; inspect job result carries the same list.
- [ ] **Step 2: Run** `npx vitest run test/oracle-handles.test.js test/inspect-job.test.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those plus `npx vitest run test/verify-golden.test.js test/worker-layering.test.js test/oracle-entry.test.js` — expect PASS with no golden change.
- [ ] **Step 5: Commit** `feat(oracle): handles in measure, inspect and the CLI`

### Task 10: The mechanisms domain

**Files:**
- Create: `src/framework/domains/mechanisms/{manifest.js,index.js,gears.js,belt.js,rack.js,crank.js}`, `types/mechanisms.d.ts`, `docs/domains/mechanisms.md`
- Modify: `src/framework/domains/registry.js:59` (`validateDomains([kinematics, mechanisms])`), `package.json` (`exports["./mechanisms"]`, `typesVersions.mechanisms`)
- Test: `test/mechanisms.test.js` (new); `test/domain-layering.test.js`, `test/domain-index.test.js` must pass

**Interfaces:**
- Produces (from `partforge/mechanisms`), every result has `handleInfo()` (spec §2 shape, `kind: "partforge.points"`) and `place(name, solid)`:
  - `gearTrain({ gears: [{ name, teeth, module, center, axis = [0,0,1], meshesWith?, internal? }], drive: { gear, angle } })` → `{ angleOf(name), handleInfo, place }`. Ratio across a mesh: `-teethA/teethB` (external), `+teethA/teethB` when either is `internal`. Points `<name>.center`, `<name>.rim` (pitch radius `module*teeth/2` along the gear's local +X turned by its angle); `axes[name]`; `lines` center-to-center for meshing pairs. Throws on an unknown `meshesWith` or a gear not connected to the drive.
  - `beltDrive({ pulleys: [{ name, diameter, center, axis }], drive: { pulley, angle } })` → same shape; ratio `dA/dB`, same sign; point `belt` on the first pulley's top.
  - `rack({ pinion: { name, teeth, module, center, axis, angle }, direction })` → `{ travel, handleInfo, place }`; `travel = rad(angle) * module*teeth/2`.
  - `crankSlider({ crank: { center, axis, length, angle }, rod, slideDirection })` → `{ crankPin, slider, handleInfo, place }` from closed form.
  - `fourBar` is not in this release (spec leaves it to the builder; deferred).
- Manifest: `id: "mechanisms"`, `when: "gears, gear trains, pulleys and belts, racks, cranks and sliders; parts that move together"`, `subpath: "partforge/mechanisms"`, `guide: "docs/domains/mechanisms.md"`, `referenceParts: ["src/parts/gearbox.js", "src/parts/drawer-box.js"]` (created in Task 11 — land Tasks 10 and 11 in one PR so the registry test sees them), `workerSafe: true`.
- [ ] **Step 1: Write failing tests:** 20/30/40 train at drive 90° → angles 90, -60, 45; internal ring gear sign; belt 20→40 at 360 → 180; rack 20 teeth module 1 at 360° → travel `20π`; crank-slider at 0°, 90°, 180° against closed form to 1e-9; `handleInfo()` JSON round-trips through `JSON.parse(JSON.stringify(...))` unchanged.
- [ ] **Step 2: Run** `npx vitest run test/mechanisms.test.js` — expect FAIL.
- [ ] **Step 3: Implement;** write `docs/domains/mechanisms.md` (helpers, the "couple in derive, grab any member" pattern, a gearbox example); run `npm run docs:domains` and commit its output.
- [ ] **Step 4: Run** `npx vitest run test/mechanisms.test.js test/domain-*.test.js` — expect PASS (after Task 11's files exist).
- [ ] **Step 5: Commit** `feat(mechanisms): gear trains, belts, racks and crank-sliders as point sources`

### Task 11: Reference parts and demo page

**Files:**
- Create: `src/parts/gearbox.js`, `src/parts/drawer-box.js`, `gearbox.html`, `src/app-gearbox.js`, `src/gearbox-worker.js` (copy the robot-arm glue trio)
- Modify: `vite.config.js` (`rollupOptions.input` adds `gearbox.html`), `.github/workflows/ci.yml` (smoke list adds `gearbox.html`), `AGENTS.md` (parts list: two new entries in the existing style)
- Test: `test/reference-handles.test.js` (new); `scripts/check-pose.mjs`

**Interfaces:**
- Consumes: Task 10 `gearTrain`; all earlier tasks.
- Produces:
  - `gearbox.js`: three spur gears (20, 30, 40 teeth, module 2) on one plate; `driveAngle` (wrap 0..360, step 0.1) in a "Motion" section; a rotary handle per gear (`on: "train"`, `at: "<gear>.rim"`) and an input crank handle; a `spin` animation 0→360. Gears are sub-parts placed by `train.place` (motion only; no rebuild during drags).
  - `drawer-box.js`: a cabinet with `width`, `depth` (shape, `plane` handle on the top front corner, `showOn: "carcass"`) and three drawers, each `drawerNOpen` (0..depth-10) with an `axis` handle on its front, `showOn: "drawerN"`.
- [ ] **Step 1: Write failing tests:** both parts lint clean (`lintPart`); `measure` reports their handles; solving gear 3's handle by +90° moves `driveAngle` by +180; a corner plane drag to `[60, 40, h]` gives width 120 / depth 80.
- [ ] **Step 2: Run** `npx vitest run test/reference-handles.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the parts and glue; `npx partforge render src/parts/gearbox.js` and look at the PNGs.
- [ ] **Step 4: Run** the test, `npx partforge measure src/parts/gearbox.js`, `npx partforge measure src/parts/drawer-box.js`, `node scripts/check-app.mjs gearbox.html` — expect PASS.
- [ ] **Step 5: Commit** `feat(parts): gearbox and drawer-box reference parts for generic handles`

### Task 12: Browser check, docs and version

**Files:**
- Modify: `scripts/check-pose.mjs` (add gearbox: drag gear 3's rim a full turn and assert `driveAngle` grew by ≈ 720 with no backwards frame; add a drawer drag on a dev page or `gearbox.html` — use a dev-only `drawer-box.html` + glue, not in `rollupOptions.input`)
- Modify: `docs/AUTHORING-PARTS.md` (new "Handles" section: the three forms, `drag` kinds, `wrap`, motion vs shape, reveal, pins, lint ids, the `inspect` entry, when to add a handle), `docs/domains/kinematics.md` ("Handles and Pose mode" opens with a pointer to the shared section), `types/index.d.ts` (pose docs mention generic handles), `package.json` version `0.179.0`
- Test: `test/kinematics-docs.test.js` and any docs-parity tests

- [ ] **Step 1:** Extend `check-pose.mjs`; run `node scripts/check-pose.mjs` — expect FAIL before the gearbox wiring is complete, PASS after.
- [ ] **Step 2:** Write the docs.
- [ ] **Step 3: Run** `npm test` (whole suite), `npm run check`, `npm run bench:pose` (no regression on robot-arm.html and hand.html vs main) — expect PASS.
- [ ] **Step 4: Commit** `docs+chore: generic handles guide, browser check, 0.179.0`
