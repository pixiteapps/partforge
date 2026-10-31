# Inverse Kinematics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship general goal-based IK in `partforge/kinematics` (`goals`/`pins` on `limb.pose`) plus an on-screen Pose mode where you drag declared `handles`. Deliver it with two reference parts, a robot arm and a hand.

**Architecture:**
- **Solver core.** One damped-least-squares (DLS) solver in core (`src/framework/solve/dls.js`), pure and three-free. Two users share it:
  - the kinematics domain, which solves joint angles inside `derive`;
  - the viewer, which solves the handle's listed parameters during a drag.
- **Handles.** `handles` is a core part-contract key. Core lint checks it.
- **Pose mode.** A viewbar mode modelled on measure and the cutaway gizmo.
  - It writes parameters every frame through mount's animation write path.
  - It holds regen jobs while a drag is in progress.
  - Sub-parts that must rebuild are ghosted.
  - It commits once on release.

**Tech Stack:** Plain ESM JavaScript, three.js (viewer only), vitest, Playwright check scripts, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-30-inverse-kinematics-design.md`. Read it before any task. Every section number cited below is a section of the spec.

## Global Constraints

- **Node 24.**
  - Prefix every command with `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`, because sourcing `nvm.sh` is blocked in this sandbox.
  - Tests run with `npx vitest run <file>`.
- **Pure solves.** `build`/`derive` stay pure. Solves inside `derive` use fixed iteration counts and no clock.
- **Layering.**
  - `src/framework/domains/kinematics/` and `src/framework/solve/` import no three.js, no DOM and no `node:` modules.
  - Core never imports a domain folder (`test/domain-layering.test.js` stays unchanged).
- **Finding a posed limb.** The viewer recognises one by plain data (`ikInfo()`), never by `instanceof`, the `CHAINS` WeakMap or a `Symbol`.
- **Report rounding.** Report numbers are rounded to 0.001 with the existing `r3`.
- **Reach tolerance.** `reached` means residual ≤ 0.01 mm (`REACHED_TOL`). Aim counts as reached at ≤ 0.1°. *(Plan's call; record it in the guide.)*
- **Parameter writes.** A drag writes parameters only through mount's per-frame path. On release it calls `onParamsCommit({ changed, params })` exactly once.
- **Timing and hit targets.** No mid-drag worker job for any sub-part. Handle hit targets are at least 24 CSS px. The ghost opacity is 0.35.
- **Unchanged API.** `reach`, `grip` and every existing `limb` behaviour stay byte-identical. The existing `test/kinematics-*.test.js` must pass untouched.
- **Release.** Bump `package.json`'s minor version on the branch. Never publish.

## Review Focus

1. **Grazing camera angle.** When the drag plane is nearly edge-on, the cursor ray barely meets it.
   - Expect the target to clamp to a finite distance (at most 4× the limb's length from the grab point).
   - It must never fly off or produce NaN.
   - Pinned by Task 6's `dragPlanePoint` test.
2. **Cancelled drag.** Escape, `pointercancel`, window blur or lost capture mid-drag.
   - Expect the pre-drag parameters restored and no `onParamsCommit` call.
   - Pinned by Task 7's session test.
3. **Host writes parameters mid-drag.** For example an agent calls `setParams` while the user is dragging.
   - Expect the drag to end as a cancel, with no stale writes.
   - Pinned by Task 7's session test.
4. **Integer or `step` parameters.**
   - Expect snapping only on release, with the snapped pose within the step of the dragged one and no visible jump.
   - Pinned by Task 5's `snapValues` test.
5. **`derive` throws or the handle's limb is missing at some parameter values** (out-of-range lengths, say).
   - Expect that drag frame to be skipped and the last good pose kept, with no exception reaching the page.
   - Pinned by Task 5's param-solve test.

---

## Phase A: the solver

### Task 1: DLS core

**Files:**
- Create: `src/framework/solve/dls.js`
- Test: `test/solve-dls.test.js`

**Interfaces:**
- Produces: `solveDLS({ x0, lo, hi, residuals, iterations, lambda = 1, h = 1e-4 }) → { x: Float64Array, error: number }`.
  - `x0`, `lo`, `hi` are arrays of numbers of length n.
  - `residuals(x) → Float64Array` has length m. It is a pure function, and the solve minimises its squared norm.
  - `error` is ‖residuals(x)‖ at the result.
  - Each iteration:
    - builds a central-difference Jacobian (step `h`);
    - takes the step Δ = Jᵀ(JJᵀ + λ²I)⁻¹(−r) (solve the m×m system by Gaussian elimination with partial pivoting);
    - clamps x to [lo, hi];
    - keeps the step only if the error did not grow. Otherwise it doubles λ and retries the same iteration, at most 4 times. On a kept step it halves λ, with a floor of 0.01.
  - No clock and no randomness.

- [ ] **Step 1: Write the failing tests**
  - `planar two-link reaches an in-range point`: a 2-DOF arm with lengths 100 and 80, target `[120, 60]`, 40 iterations → `error < 1e-6`. The end point matches the analytic forward map.
  - `respects bounds`: with `hi = [10, 10]`, every `x[i] ≤ 10`.
  - `deterministic`: two calls give `Object.is`-equal entries.
  - `unreachable target stays put`: target `[500, 0]`. The results after 40 and after 80 iterations differ by less than 1e-6 per entry, and the arm points within 0.01 rad of the target.
  - `warm start is continuous`: sweep a target along a 100-step arc, each solve warm-started from the last. No entry changes by more than 0.2 rad per step.
- [ ] **Step 2: Run the tests and confirm they fail**
  - Run: `npx vitest run test/solve-dls.test.js`
  - Expected: FAIL with "Cannot find module".
- [ ] **Step 3: Implement `solveDLS` as specified above.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit**
  - Message: `feat(solve): damped least squares core`

### Task 2: `goals`, `pins` and `aimFromAngles` on `limb.pose`

**Files:**
- Create: `src/framework/domains/kinematics/goals.js`
- Modify: `src/framework/domains/kinematics/core.js`
  - add `goals` and `pins` to `POSE_KEYS`;
  - make `reach`, `grip` and `goals` mutually exclusive;
  - add a branch beside the reach and grip ones.
- Modify: `src/framework/domains/kinematics/outputs.js`, so `buildReport` accepts `goals`.
- Modify: `src/framework/domains/kinematics/index.js`, to export `aimFromAngles`.
- Modify: `types/kinematics.d.ts`.
- Test: `test/kinematics-goals.test.js`

**Interfaces:**
- Consumes: `solveDLS` (Task 1); `forwardLocal`, `couple`, `jointSteps` and `buildFrames` (existing).
- Produces:
  - `pose({ bend?, curl?, spread?, twist?, goals: Goal[], pins?: string[] }, parents?)`, where `Goal = { at: string, position?: [x,y,z], aim?: [x,y,z], up?: [x,y,z], weight?: number }`.
  - `report.goals: [{ at, residual, aimResidual?, status }]`, where `status` is one of `"reached" | "too-far" | "out-of-range" | "conflict"`.
  - `aimFromAngles({ toward, pitch = 0, yaw = 0, roll? }) → { aim: [x,y,z], up?: [x,y,z] }`. The convention: zero is `toward`; yaw is applied about part +Z, then pitch about the yawed horizontal axis at right angles to the aim; `roll` (if given) turns `up` about the aim. `up` starts as part +Z, or as +Y when `toward` is vertical.
- **Solve details** (`goals.js`, `solveGoals(tree, parentWorld, goals, raw, pins, { spread, twist })`):
  - **DOFs.** Every driven, unpinned joint:
    - a hinge contributes one DOF;
    - a ball contributes three (bend, spread, twist);
    - followers are expanded through `couple`, so they are not DOFs.
  - **Residuals.**
    - a position goal adds 3 residuals, in mm × weight;
    - an aim goal adds 3: (frame +Y − aim) × 100 × weight, so 1° ≈ 1.75 mm;
    - an up goal adds 3 the same way on the frame's −Z (the side `bendToward` names).
  - **Iterations.** 64, warm-started from the raw values. `lo`/`hi` come from the ranges; a ball's swing is clamped by `couple`.
  - **Statuses.**
    - `reached` when every goal's position residual is ≤ 0.01 and its aim residual is ≤ 0.1°;
    - otherwise `too-far` when the target lies beyond the sum of segment lengths from the first moving joint;
    - otherwise `conflict` when there are two or more goals and each is better met alone;
    - otherwise `out-of-range`.
  - **Pin errors.** A pin naming an unknown joint fails with `limb "x".pins[i]: unknown joint "…"`.
  - **Parented limbs.** These need `parents` exactly as `reach` does.

- [ ] **Step 1: Write the failing tests** (use the finger limb from `test/kinematics-reach.test.js`, and a 6-axis arm fixture defined in the test):
  - `goals reproduce reach on the finger`: for the three targets in the guide's `reach` examples, the goals tip matches `reach`'s tip within 0.01 mm, and the statuses match.
  - `arm meets position + aim`: the target `[120, 40, 80]` with aim `[0, 0, -1]` → `reached`.
  - `pins hold`: with `pins: ["base"]`, `values[0]` equals the given `bend.base`.
  - `couplings hold`: on the finger, dip = 0.75 × pip after the solve.
  - `too-far`: a target at 2× the reach gives `too-far`, and the limb points at the target within 0.5°.
  - `conflict`: two goals 400 mm apart on a short arm give `conflict`.
  - `deterministic`: two identical calls give deep-equal reports.
  - `aimFromAngles`: zero angles with `toward` `[0, 1, 0]` give `[0, 1, 0]`, and `yaw: 90` gives `[-1, 0, 0]`.
  - `reach + goals throws`: the message contains `use one of reach, grip or goals`.
- [ ] **Step 2: Run** `npx vitest run test/kinematics-goals.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `goals.js`, the core.js branch, the report field, the export and the types.
- [ ] **Step 4: Run** the goals file and every `test/kinematics-*.test.js`. Expected: all PASS. The existing files are unchanged.
- [ ] **Step 5: Commit**
  - Message: `feat(kinematics): goals and pins on limb.pose`

### Task 3: `ikInfo()` on a posed limb

**Files:**
- Modify: `src/framework/domains/kinematics/core.js`, adding `ikInfo` to the posed object.
- Test: `test/kinematics-ikinfo.test.js`

**Interfaces:**
- Produces: `posed.ikInfo() → { kind: "partforge.limb", name, joints: [{ name, frame, type, range?, cone?, follower: boolean }], tip, r?, points: { [jointOrTip]: [x,y,z] }, values, axes: { [joint]: [x,y,z] } }`.
  - It is plain JSON in part coordinates, resolved with the parents passed to `pose`.
  - It throws the existing "needs the parent frames" error for a parented limb posed without frames.
  - `axes[joint]` is a hinge's world rotation axis. The limit arcs use it.

- [ ] **Step 1: Write the failing test.** On the finger posed at `curl: 0.5`:
  - `ikInfo().points.tip` deep-equals `report.tip`;
  - `ikInfo()` survives `JSON.parse(JSON.stringify(…))` unchanged;
  - `kind === "partforge.limb"`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it** from `world()` (the origins) and `buildFrames` (the axes).
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit**
  - Message: `feat(kinematics): ikInfo plain-data view of a posed limb`

## Phase B: the handles contract

### Task 4: lint rules for `handles`

**Files:**
- Create: `src/framework/lint/rules-handles.js`
- Modify: `src/framework/lint/index.js`, appending `...HANDLE_RULES` after `SHEET_RULES` in `RULES`.
- Modify: `types/part.d.ts`, adding `handles?: Record<string, Handle>`.
- Test: `test/lint-handles.test.js`

**Interfaces:**
- Produces the handle shape:
  - **goal mode:** `{ limb: string, at?: string = "tip", mode: "goal", params: { position: [string, string, string], aim?: [string, string] | [string, string, string] }, seed?: string[] }`
  - **angles mode:** `{ limb: string, mode: "angles", params: string[], lock?: string }`. `lock` names a parameter; when it is truthy, the handle's own parameters are left out of a drag solve (Clip Studio's finger lock).
- Produces these rule ids, which read `ctx.d` (already resolved by `lintContext`):
  - `handle-unknown-limb`: `d[limb]` is missing or has no `ikInfo` function;
  - `handle-unknown-param`: a listed parameter (including `seed` and `lock`) is not in `part.defaults`, or its default is not a finite number;
  - `handle-param-count`: `position` is not 3 names, or `aim` is not 2 or 3;
  - `handle-unknown-joint`: `at` is not a joint of the limb or `"tip"`;
  - `handle-bad-mode`.
  - Each is an `err(...)` with a hint and a `handles.<name>` path, in `rules-shape.js`'s style.

- [ ] **Step 1: Write the failing tests:** one bad-part fixture per rule asserting its id, plus one valid part asserting zero handle findings.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the rules.**
- [ ] **Step 4: Run them, and run `npx vitest run test/lint` to check for regressions.** Expected: PASS.
- [ ] **Step 5: Commit**
  - Message: `feat(lint): handles rules`

### Task 5: Parameter-space solve and goal writes

**Files:**
- Create: `src/framework/pose/param-solve.js` (pure, three-free)
- Test: `test/pose-param-solve.test.js`, with a fixture part `test/fixtures/ik-hand-fixture.js`: a wrist parameter plus two finger limbs parented on it, with curl and spread parameters and `handles`.

**Interfaces:**
- Consumes: `solveDLS` (Task 1), `resolveParams(part, params)` (`part-model.js`), and `ikInfo` (Task 3).
- Produces:
  - `limbInfo(part, params, handle) → ikInfo | null`. It returns null when `derive` throws or the limb is missing.
  - `solveAngles({ part, params, handle, grab, target, holds, iterations = 8 }) → { values: Record<string, number>, error } | null`.
    - `grab` is a joint name or `"tip"`.
    - `holds` is `[{ limb, at, point }]`, the pinned points held in place.
    - The DOFs are `handle.params`, bounded by `part.schema`'s `min`/`max` for each key, minus the parameters of every handle in `allHandles` whose `lock` parameter is truthy. (The signature takes `allHandles`, defaulting to `[handle]`.)
    - The residuals are the grab point minus the target, plus each hold.
    - A `derive` throw inside a residual evaluation makes that evaluation return a large constant (1e6) residual. A null result means the start pose itself failed.
  - `goalValues({ handle, point, aimAngles? }) → Record<string, number>`: maps a part-space point (and pitch, yaw and roll) onto the handle's goal parameters.
  - `seedValues({ part, params, handle }) → Record<string, number>`: the solved `posed.values` written into `handle.seed`, in order. A ball joint contributes bend, spread and twist, in that order.
  - `snapValues(part, values) → Record<string, number>`: applies each key's schema `step` and integer rules.

- [ ] **Step 1: Write the failing tests:**
  - `drags a fingertip by writing only listed params`: the result's keys are a subset of `handle.params`, and the tip lands within 0.5 mm of the target after 8 × 5 warm-started calls.
  - `pinned tip holds`: dragging finger A with finger B's tip in `holds` keeps B within 0.5 mm.
  - `derive throw is skipped`: with a parameter combination that makes `derive` throw, the call returns a finite `values` object or null and never throws.
  - `goalValues maps point to position params`.
  - `seedValues writes solved angles in seed order`.
  - `snapValues`: `step: 5` on 42.6 gives 45.
  - `locked handle is skipped`: with `B.lock` truthy, dragging the wrist leaves B's curl unchanged.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the module.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit**
  - Message: `feat(pose): parameter-space solve for handles`

## Phase C: Pose mode in the viewer

### Task 6: Pose geometry and scene

**Files:**
- Create: `src/framework/pose/pose-geom.js` (pure). It exports:
  - `dragPlanePoint(rayOrigin, rayDir, planePoint, planeNormal, maxDist) → [x,y,z]`, clamped to `maxDist` from `planePoint`, falling back to the closest point on the ray when |dir·n| < 0.05;
  - `hitHandle(screenPts: {id, x, y}[], px, py, radius = 12) → id | null`, choosing the nearest within the radius;
  - `limitArc(origin, axis, refDir, [lo, hi], radius, segments = 32) → [x,y,z][]`.
- Create: `src/framework/pose/pose-scene.js` (three.js), modelled on `measure/dim3-scene.js`:
  - a group in the parts frame, registered with `registerCanonicalCaptureHidden`;
  - `setLimbs(infos)`, `setHover(limbName|null)`, `setActive({ limb, grab, clamped: boolean[], target?, residual? })`, `setPins(ids)` and `clear()`, each calling `viewer.requestRender()`;
  - what it draws:
    - tip dots of fixed screen size (sized per frame from the camera);
    - the joint dots of the hovered or active limb only;
    - skeleton lines;
    - rings at radius `r`;
    - the limit arcs of moving hinges;
    - the warning colour on clamped joints;
    - a hollow target dot plus a dashed line labelled `"<residual> mm"` when the residual is above 0.01;
    - pin badges;
    - aim rings (`setAimRings({ at, axes } | null)`), shown only on a grabbed goal handle that declares `aim`: three rings about the tool frame's axes, for pitch, yaw and roll. Roll is shown only when `aim` lists 3 parameters.
- Test: `test/pose-geom.test.js`:
  - grazing ray → a finite point within `maxDist`;
  - `hitHandle` picks the nearest within 12 px and returns null outside;
  - the limit arc's end points sit at `lo` and `hi` about the axis.

- [ ] **Step 1: Write the failing `pose-geom` tests.**
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `pose-geom.js` and `pose-scene.js`.**
- [ ] **Step 4: Run them.** Expected: PASS. The scene is covered by Task 8's browser check.
- [ ] **Step 5: Commit**
  - Message: `feat(pose): overlay geometry and scene`

### Task 7: Pose session and mode

**Files:**
- Create: `src/framework/pose/pose-session.js`. It is pure: it holds no DOM and is injected with its effects.
- Create: `src/framework/pose/pose-mode.js`. It handles the pointer and orbit arbitration, copying `cutaway-gizmo.js`:
  - a capture-phase `pointerdown` that disables orbit and calls `setPointerCapture` on a hit;
  - restore on `pointerup`, `pointercancel`, blur and `lostpointercapture`;
  - `drag-tracker.js` to tell a click from a drag.
- Create: `src/framework/pose/pose-controls.js`: the viewbar `#pose` button, in `measure-controls.js`'s shape, with a "Release pins" action shown while any pin is set.
- Test: `test/pose-session.test.js`

**Interfaces:**
- Produces `createPoseSession({ getParams, write(values), commit(changed), restore(values), solve, staleSubParts(), ghost(names), unghost(names), hold(on), onCancel }) → { begin(handleId, grab), frame(rayHit), end(), cancel(), externalWrite(), togglePin(id), releasePins(), pins }`.
  - **`begin`:**
    - snapshots the parameters;
    - calls `hold(true)`;
    - goal handles go straight to `goalValues`, plus `seedValues` when declared.
  - **`ringFrame(axis, deltaDeg)`** (goal handles with `aim`): adds the delta to the matching pitch, yaw or roll parameter, clamped to the schema range, then does what `frame` does. The mode calls it when the grab is a ring rather than the tip dot (the ring angle is measured about the ring's axis between the grab ray hit and the current hit).
  - **`frame`:**
    - solves (angles mode) or computes `goalValues` (goal mode);
    - calls `write`;
    - then ghosts any new names in `staleSubParts()` (once each, never unghosting mid-drag).
  - **`end`:**
    - writes `snapValues`;
    - calls `hold(false)` and `commit(changedKeys)` once;
    - unghosts each ghosted name when mount reports that sub-part's delivery (mount calls `session.delivered(name)`).
  - **`cancel` / `externalWrite`:** `restore(snapshot)`, `hold(false)`, unghost everything, and no commit.
  - **Pins** are ids `"<handle>:<at>"`. A pin's held point is captured at `begin`.

- [ ] **Step 1: Write the failing tests**, with fake effects that record calls:
  - one drag of 5 frames gives exactly 1 `commit` with the changed keys, and `hold(true)`/`hold(false)` come in order;
  - a sub-part that goes stale on frame 2 is ghosted once and unghosted only after `delivered(name)`;
  - `cancel()` restores the snapshot with 0 commits;
  - `externalWrite()` mid-drag does the same as cancel, and later frames are ignored;
  - a click with no drag toggles a pin; `releasePins()` empties `pins`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `pose-session.js`, `pose-mode.js` and `pose-controls.js`. The mode makes the ray from the camera through the pointer, and the plane faces the camera through the grab point (`dragPlanePoint`, with `maxDist` = 4 × the sum of the limb's segment lengths).
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit**
  - Message: `feat(pose): drag session, mode and viewbar toggle`

### Task 8: Mount wiring and a browser check

**Files:**
- Modify: `src/framework/mount.js`
  - **When to create it.** Create the pose mode only when `part.handles` is a non-empty object. Pose mode, measure and annotate are mutually exclusive (follow how measure and annotate already exclude each other).
  - **`write`.** The same body as `applyAnimationValues`, but with no playback stamp. It calls `animCtl?.notifyUserEdit()` on `begin`.
  - **`hold`.** It sets a flag that makes `missingParts` return `[]`. On release it clears the flag, then calls `onParamChange()` and `loop.kick()`.
  - **`staleSubParts`.** It is `viewSubParts(part, view(), params).filter((n) => !isCurrent(n))`.
  - **`ghost` / `unghost`.** They call `viewer.setSubPartOpacity(name, 0.35 | 1)`. Unghosting happens in the same delivery handler that calls `setSubGeometry` for that name, so the mesh and the opacity change in one frame.
  - **`commit`.** It calls `onParamsCommit?.({ changed, params: { ...params } })`.
  - **External writes.** `setParams` called while a session is active calls `session.externalWrite()` first.
  - **State.** Pins persist in `viewerState` under `pose.pins`.
  - **Runtime surface.** `runtime.pose: { isEnabled, setEnabled }`.
- Modify: `demo.html`-style viewbars: add `<button id="pose" title="Pose" aria-label="Pose">` to the new pages only (Task 9/10). Other pages simply have no button.
- Create: a dev-only page `pose-smoke.html` + `src/app-pose-smoke.js` + `src/pose-smoke-worker.js` (not in `rollupOptions.input`). It uses `test/fixtures/ik-hand-fixture.js` (Task 5), plus one sub-part whose `build` reads `p.aCurl`, so it cannot move by matrix. This is the only page that exercises the ghost-and-skeleton path until the implicit hand exists.
- Create: `scripts/check-pose.mjs`, modelled on `scripts/check-app.mjs`. On `pose-smoke.html` it asserts:
  - the rebuilt sub-part's opacity is 0.35 during the drag;
  - exactly one `generate` job is sent after release;
  - its opacity is 1 once that job's mesh is shown.
  It then opens `robot-arm.html` and `hand.html`, enables Pose mode, and drags the tool or fingertip handle over 20 pointer moves. It asserts:
  - no worker `generate` job is posted during the drag (count the worker messages in the page);
  - exactly 1 `onParamsCommit` on release (expose a counter through the demo app's `onParamsCommit`);
  - the changed parameter values differ from the defaults;
  - no console errors.
- Modify: `.github/workflows/ci.yml` and `package.json` scripts, adding `check:pose`.

- [ ] **Step 1: Write `scripts/check-pose.mjs`.** It fails until Tasks 9 and 10 land, so run it at the end of Task 10.
- [ ] **Step 2: Wire mount as above.**
- [ ] **Step 3: Run** `npm test` and `npm run check`. Expected: PASS, with the existing pages unaffected.
- [ ] **Step 4: Commit**
  - Message: `feat(pose): mount wiring, regen hold, ghosting, commit`

## Phase D: reference parts and docs

### Task 9: `robot-arm.js`

**Files:**
- Create: `src/parts/robot-arm.js`, `robot-arm.html`, `src/app-robot-arm.js` and `src/robot-arm-worker.js`. Copy the glue from the demo files. The page includes `#pose`.
- Modify: `vite.config.js` (`rollupOptions.input`), `.github/workflows/ci.yml` (a smoke check of `robot-arm.html`) and AGENTS.md's parts list.
- Test: `test/robot-arm.test.js`

**Part contents:**
- **Limb.** A 6-axis limb: `base` (twist axis), `shoulder`, `elbow`, `wristPitch`, `wristYaw` (a spread axis) and `wristRoll` (a twist axis), with realistic ranges.
- **Links.** Rigid links placed with `d.arm.place` in a views pose, so they move by matrix only.
- **Gripper.** A `gripper` opening parameter.
- **Goal parameters:** `toolX`, `toolY`, `toolZ`, `toolPitch`, `toolYaw` and `toolRoll`.
- **Seed parameters.** The six joint parameters, in an advanced section.
- **Link length parameters:** `upperLen` and `foreLen`.
- **`derive`.** `arm.pose({ bend: seed, goals: [{ at: "tip", position, ...aimFromAngles(...) }] })`.
- **Handle:** `handles: { tool: { limb: "arm", mode: "goal", params: { position: [...], aim: ["toolPitch", "toolYaw", "toolRoll"] }, seed: [...] } }`.
- **Probe:** `probes: { tool: (k, p, d) => d.arm.report.goals[0] }`.

**Tests:**
- the default parameters give `reached`;
- changing `upperLen` by +20 keeps `reached`, and the tip stays within 0.01 mm of the goal;
- a goal 2× out of reach gives `too-far`;
- sweeping `toolX` over 60 steps, re-seeding from each solve, never moves `elbow` by more than 10° per step (no flip);
- `lintPart` reports zero errors;
- `npx partforge measure src/parts/robot-arm.js` exits 0.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Write the part and its glue.**
- [ ] **Step 4: Run them, plus `node scripts/check-app.mjs robot-arm.html`.** Expected: PASS.
- [ ] **Step 5: Commit**
  - Message: `feat(parts): robot-arm IK reference part`

### Task 10: `hand.js`

**Files:**
- Create: `src/parts/hand.js`, `hand.html`, `src/app-hand.js` and `src/hand-worker.js`.
- Modify: `vite.config.js`, `ci.yml` and AGENTS.md's parts list.
- Test: `test/hand.test.js`

**Part contents:**
- **Limbs.**
  - A `palm` limb with `wristPitch` and `wristYaw` joints.
  - Four fingers parented on the palm's frame, each with mcp, pip, and dip following pip × 0.75, plus a spread joint.
  - A thumb with an `oppose` joint plus mcp and ip.
- **Parameters:**
  - per finger: `<f>Curl` (0..1) and `<f>Spread`;
  - `thumbOppose` and `thumbCurl`;
  - `wristPitch` and `wristYaw`;
  - per finger: a `<f>Lock` toggle that the presets do not include.
- **Presets** use the panel's `{ type: "preset" }` node, with these names: `open`, `relaxed`, `fist`, `point`, `peace` and `ok`.
- **Links.** Rigid, placed with `place`. Export is a flat kit: each segment has its own print view laid flat, following `robot-finger.js`.
- **Handles.**
  - `thumb`, `index`, `middle`, `ring` and `pinky` are angles-mode handles listing that digit's curl and spread plus `wristPitch` and `wristYaw`, with `lock: "<f>Lock"`.

**Tests:**
- each preset lints clean and builds;
- `fist` gives every finger curl ≥ 0.8;
- the exported print views for the default pose and for `fist` have identical bounding boxes (the pose never reaches the print);
- `lintPart` reports zero errors.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Write the part and its glue.**
- [ ] **Step 4: Run them, plus `node scripts/check-app.mjs hand.html` and `node scripts/check-pose.mjs`.** Expected: PASS.
- [ ] **Step 5: Commit**
  - Message: `feat(parts): hand IK reference part with presets`

### Task 11: Docs, types and release

**Files:**
- Modify: `docs/domains/kinematics.md`, with new sections:
  - "Posing by goals: `goals` and `pins`", next to `reach`;
  - "`aimFromAngles`";
  - "Handles and Pose mode";
  - "Posing a part as an agent": set the goal or curl parameters and read the probe, with a short robot-arm example and its one-line report.
- Modify: `docs/AUTHORING-PARTS.md`: a `handles` row in the `PartDefinition` contract, and a short "Pose mode" section linking to the domain guide.
- Modify: `types/kinematics.d.ts` and `types/part.d.ts` (Handle, Goal, report.goals), and `types/index.d.ts` (`runtime.pose`).
- Modify: `package.json`, bumping the minor version.
- Test: `test/kinematics-docs.test.js` already checks the guide's examples. Add the new examples to it.

- [ ] **Step 1: Write the docs and examples.**
- [ ] **Step 2: Run** `npx vitest run test/kinematics-docs.test.js test/domain-index.test.js`, then `npm test`. Expected: PASS.
- [ ] **Step 3: Commit**
  - Message: `docs(kinematics): goals, pins, handles, Pose mode; bump version`
