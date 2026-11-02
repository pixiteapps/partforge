# Inverse kinematics: goals in code, handles on screen

Status: design, 2026-10-30. Extends the kinematics domain (`partforge/kinematics`,
spec `2026-10-29-limb-helper-design.md`).

## Intent

partforge is a general tool for building and posing robots, robotic arms and
lifelike hands and figures. Both kinds must work well:

- **Robot arms need precision.**
  - A tool tip lands exactly where asked, and optionally points a given way.
  - Joint limits are hard stops.
  - The arm never flips between elbow-up and elbow-down.
  - A target it cannot reach is reported, with the distance by which it missed.
- **Hands and figures need to look natural.**
  - Several tips are posed at once.
  - Some stay planted while others move.
  - Coupled joints hold.
  - Most posing is by curl and spread, presets, and dragging, not coordinates.

Today `limb.pose` solves only two narrow goals: `reach` (one finger-like chain, curling
evenly) and `grip`. Nothing in the viewer lets you drag a pose.

### What done looks like (the user's demo)

1. Open a robot-arm part and a hand part. Ask an agent to pose each one ("gripper over
   the cup, pointing down"; "loose fist, index pointing"). The agent changes a few pose
   values and never rewrites part code. It reads back a short report. The model
   updates. The token cost is minimal.
2. Click into the same model and drag it.
   - The robot shows what it can and cannot reach.
   - The hand can be sculpted into a pose you would want to print as a decoration or as
     part of a model.
3. The hand prints as a flat kit of segments, the way `robot-finger.js` exports today.
   The pose does not carry into the print; you pose the printed hand yourself. (Your
   answer to the builder check.)

### Goals

- A general goal solver in `partforge/kinematics`:
  - several position goals, each with an optional orientation;
  - pinned joints;
  - limits and couplings respected;
  - deterministic and pure, so it can run in `derive`;
  - a terse report.
- On-screen **Pose mode**: drag a tip or any joint and the chain follows; pin tips; see
  limits; out-of-reach is shown, never hidden.
- A drag is saved exactly like a control change. The values land in the panel and the
  host's commit and undo path, one commit per drag.
- Live dragging that never flickers:
  - rigid links move by matrix every frame;
  - parts built from the pose show a live skeleton over a ghost of the last build, and
    rebuild once on release.
- Two reference parts with demo pages: `robot-arm.js` and `hand.js`.
- Code helpers and the on-screen controls ship together in one release. The code side is
  finished first.

### Non-goals (this release)

- Closed kinematic loops (four-bar linkages, delta robots).
- Collision-aware IK, where links avoid each other or the scene.
- Physics or balance, Cascadeur-style auto-posing, and learned rigs.
- Animation authoring by dragging (keyframing from the viewer).
- FABRIK. The domain stores angles, so the solver works in angles.
  ("Should we adapt to FABRIK?" was asked and answered: no.)
- The smooth, fused implicit hand. That waits on the implicit-parts PR (#297) and is a
  follow-up. This design must not block it: the same limb, pose values and presets must
  drive it, and only the build changes.

### Anti-goals (a failure even if the maths is right)

- **Flashing:** a mesh blinking out and back, or opacity popping, during a drag or on
  release.
- **Jumping:** a chain snapping to a different solution, an elbow flipping, a limb
  teleporting when a target crosses out of reach, or the camera or panel re-framing
  mid-drag.
- **Fiddly handles:**
  - targets too small to hit;
  - handles fighting orbit;
  - unclear what will move before you grab it;
  - too many handles on screen at once.

## Constraints from the codebase

- `build`/`derive` stay pure functions of `(k, p, d)`. A solve inside `derive` uses
  fixed iteration counts and no clock, like `solve.js` today.
- Poses are parameters. Anything a drag changes is a schema parameter, written through
  the same path as a control: `setParams` / `applyAnimationValues`, `panel.syncValues`,
  then `onParamsCommit` on release. partforge has no undo of its own; hosts own undo and
  persistence through `onParamsCommit`.
- Live posing rides the existing pose fast path (`pose-fast-path.js`).
  - A sub-part whose `build` never reads a pose parameter is current, and rung 1 moves it
    by matrix with no worker job.
  - Anything else needs a rebuild. That rule is how the viewer tells "rigid" from "built
    from the pose", per sub-part, without the author declaring it.
- The kinematics domain stays worker-safe, three-free and DOM-free. Viewer code lives
  under `src/framework/`, never in the domain folder. The domain's manifest may add lint
  rules (`lint/finding.js` only).
- A parented limb needs its parent frames passed to `pose` (unchanged).

## Design

### 1. The solver: `goals` and `pins` on `limb.pose`

`pose` gains a third goal form beside `reach` and `grip`. Only one of the three is
allowed per pose.

```js
arm.pose({
  bend: { base: 0, shoulder: 40, elbow: 60 },   // the starting point (warm start); unsolved joints keep these
  goals: [
    { at: "tip", position: [120, 40, 80], aim: [0, 0, -1] },   // tool over the cup, pointing down
  ],
  pins: ["base"],                                // joints the solver may not move
});
```

- **A goal** is `{ at, position?, aim?, up?, weight? }`.
  - `at` is a joint name or `"tip"`.
  - `position` is in part coordinates (or the parent frame's coordinates, as `reach` does
    today).
  - `aim` is the direction that frame's limb axis (`toward`) should point.
  - `up` optionally fixes the roll about it.
  - A goal with only `aim` is legal. A goal at a joint constrains only the joints above
    that joint.
- **Pins** name joints held at their `bend` value.
  - Followers still follow.
  - A pinned leader also holds its followers.
  - "Keep this tip where it is" is a goal at its current position, not a pin. Pins are
    for joints.
- **The method** is damped least squares in joint space.
  - Each solved hinge contributes one DOF.
  - A free ball joint contributes three: bend, spread, twist.
  - The Jacobian is numeric, by finite differences of `forwardLocal`, which `solve.js`
    already shares with `pose`.
  - Clamp to the range, or to the cone, after each step.
  - Followers are expanded through `couple`, so a coupled pair is one DOF.
  - A fixed iteration count, and a fixed damping schedule.
- **Warm start and no flips.** The iteration starts from the `bend` values given, so the
  same call always gives the same answer. For an interactive drag, the caller passes the
  previous frame's values. Continuity comes from that warm start and from damping, never
  from a branch search.
- **Ranking several goals.** Goals are weighted (default 1). Position error is in mm and
  aim error in degrees. The builder chooses how degrees convert to mm and records it in
  the guide.
- **Report.** `report.goals` is one entry per goal: `{ at, residual, aimResidual?, status }`.
  - `status` reuses `reach`'s words where they apply: `reached` or `out-of-range`.
    `too-far` applies when the residual would shrink only by straightening the chain.
  - `conflict` is reported when goals pull against each other and none is met.
  - `report.clamped` is unchanged.
  - Everything is rounded to 0.001, so the whole report stays a line or two of JSON for
    an agent.
- `reach` and `grip` keep working unchanged. `reach` keeps its exact bisection; it is
  not reimplemented on DLS.
- **Across limbs** (thumb on cup while the wrist moves): each limb solves its own goals,
  given its parent's pose, in `derive` order. A child limb's goal in part coordinates
  then holds while the parent moves. Solving several limbs at once in code is not in
  this release. The viewer's parameter-space drag (section 3) covers it on screen.

### 2. Handles: what a part declares

A part opts into on-screen posing with a top-level `handles` list. Lint checks every
name it references.

```js
handles: {
  tool: { limb: "arm", at: "tip", mode: "goal",
          params: { position: ["toolX", "toolY", "toolZ"], aim: ["toolPitch", "toolYaw"] } },
  index: { limb: "index", mode: "angles", params: ["indexCurl", "indexSpread", "wristPitch"] },
},
```

- `limb` is a key of `derive`'s result holding a **posed** limb. The viewer reads its
  frames, joints and ranges from that.
- **`mode: "goal"`**
  - Dragging writes the goal's parameters directly: position, and `aim` if declared,
    clamped to each parameter's schema range.
  - The part solves from those parameters in `derive` (via section 1).
  - The target holds when other parameters change, for example when the upper arm gets
    longer.
  - This is the natural mode for robot tool points and planted tips.
  - **The seed.** A goal-mode handle also lists `seed`: the joint-angle parameters the
    part passes to `pose({ bend })` as its warm start. The handle example below adds
    `seed: ["base", "shoulder", "elbow", "wristPitch", "wristYaw", "wristRoll"]`.
    - During a drag, the viewer writes the goal parameters, reads the solved
      `posed.values`, and writes them back into the seed parameters on the same frame.
      `derive` stays a pure function of `p`: the worker, the CLI and export all pose the
      same way as the viewer. Each frame starts from the last, so the arm cannot flip.
    - An agent sets only the goal parameters. The solve starts from the saved seed,
      which is deterministic and nearest to the last saved pose.
    - The seed parameters are ordinary schema parameters, normally in an advanced
      section. They are committed with the goal on release.
    - *(Builder check, settled as my call. It replaces "the caller passes the previous
      frame's values".)*
  - **Aim parameters.**
    - `aim` lists two parameters, pitch and yaw in degrees.
    - An optional third, roll, becomes the goal's `up`.
    - The domain exports one helper that turns those angles into `aim`/`up` vectors
      (`aimFromAngles`). The part and the viewer's rotate rings share its convention:
      zero pitch and yaw is the rest direction the goal handle declares as `toward` (the tool's rest aim, which need not be the limb's `toward`), yaw is about part +Z, then pitch.
    - *(Builder check, settled as my call.)*
- **`mode: "angles"`**
  - Dragging solves for the listed parameters (section 3) and writes them.
  - Parameters can be anything the pose reads: per-joint angles, a `curl` scalar, a
    spread, a parent limb's wrist angle.
  - This is the natural mode for fingers and figure limbs.
- **Grabbing in angles mode.** Every joint of the handle's limb, and its tip, is
  grabbable. The grabbed point follows the cursor. Joints below it move however the
  listed parameters move them: a `curl` scalar curls the whole finger. Nothing extra
  holds them. *(Builder check, settled as my call.)*
- **Grabbing in goal mode.** Only `at` is grabbable.
- **Which views.** Handles show in every view where that limb's sub-parts are visible.
  The builder decides the exact rule.

### 3. The viewer's drag solve (angles mode)

The viewer cannot invert an arbitrary parameters-to-pose mapping analytically, so it
solves in **parameter space**:

- **DOFs.** The handle's listed parameters, bounded by their schema `min`/`max`, with
  integer and step snapping applied only on release.
- **Forward map.** `resolveParams`, then `derive`, then the limb's `world(at)` for the
  grabbed point. These are the same pure functions the fast path already runs on the
  main thread.
- **Goals.**
  - The grabbed point goes to the cursor's point on a plane through the grab point,
    facing the camera.
  - Every pinned tip is held at the position it had when the drag started.
- **Method.** The same DLS core as section 1, in a shared module: numeric Jacobian, warm
  start from the current values, and an iteration cap per animation frame.
- **Why this is enough.** Couplings, `curl` scalars and multi-limb effects (a wrist
  parameter moving five fingertips) all fall out with no special cases.

One DLS core serves both layers: joint space in the domain, parameter space in the
viewer. It is a pure function over a forward map and bounds.

**Where the code lives.** This follows the domain layering rules, which forbid core
from importing a domain folder:

- **The DLS core** is a core module, `src/framework/solve/dls.js`. It is three-free and
  DOM-free. The kinematics domain imports it, and so does the viewer.
- **`handles`** is a core part-contract key, read by core lint and by the viewer.
- **Finding the limb.** The viewer finds a posed limb by plain data on the derive value:
  `frames`, `values` and the joint ranges, plus a small `ikInfo()` the posed limb
  exposes. It never uses `instanceof`, the `CHAINS` WeakMap or a `Symbol`. This is the
  same rule sheet parts follow, because a host can hold two copies of this code.
- **Lint.** Handle lint rules are core rules.
- `test/domain-layering.test.js` stays unchanged.

*(Builder check, settled as my call.)*

### 4. Pose mode (on screen)

- **Entering.** *(Revised 2026-10-31: there is no toggle.)* Posing is always on in the
  normal click mode of a part that declares `handles`. It stops while measure, sketch or
  cutaway is on, and starts again when they are all off. A host can turn it off with
  `runtime.pose.setEnabled(false)`.
  - At rest only pin badges show. When the pointer is 32 CSS px or less from a limb's
    bones on screen, that limb's dots and skeleton show (the nearest limb wins).
  - A press on a dot or an aim ring is a pose grab. Every other press orbits and picks
    as before. A pin click and a drag never pick. While a dot is hovered, the model's
    hover label is hidden.
  - Touch has no hover: a touch press 24 px or less from any limb's dot grabs it.
  - Orbit stays on, but yields to a handle grab (the `cutaway-gizmo.js` pattern):
    capture-phase `pointerdown`, disable orbit, pointer capture, restore on
    end/cancel/blur.
- **What shows.**
  - Each handle's tip shows as a dot of fixed screen size. Its hit target is generous, at
    least 24 CSS px.
  - Joints are not shown until you hover the limb.
  - Hovering a limb highlights the chain that will move and shows its joints as small
    dots.
  - Only one limb's joints show at a time.
- **Dragging.**
  - Writes values with the animation path's per-frame write (`applyAnimationValues` style).
  - Calls `onParamsCommit` once on release with every parameter changed, so one drag is
    one host undo step.
  - Integer and step snapping are applied at release, then the pose settles once. The
    builder must keep that settle invisible: no visible jump.
- **Pins.**
  - A click (no drag, `drag-tracker.js`) on a tip toggles a pin, drawn as a pin badge.
  - A "Release pins" button appears in the mode's chrome while any pin is set.
  - Pins are viewer state (carried in `viewerState`), not parameters.
- **Limits.**
  - While dragging, each moving hinge shows its allowed arc.
  - A clamped joint turns the warning colour while it stays clamped. It does not flash.
- **Out of reach.**
  - The chain stays at its nearest solution.
  - The cursor's target point shows as a hollow dot.
  - A dashed line runs to it, labelled with the miss in mm.
  - The chain never jumps to a different solution to catch up.
- **Goal-mode handles with `aim`.** A small rotate ring set lets you tilt the aim; it is
  drawn only on the grabbed handle.
- **Live behaviour, per sub-part,** decided by the fast path:
  - **Rigid** (rung 1, matrix only): the sub-part moves every frame.
  - **Built from the pose** (anything that would need a job):
    - When the drag starts, it fades to a ghost of about 0.35 opacity
      (`setSubPartOpacity`), and stays put.
    - A **live skeleton** (bones as lines, joints as dots, rings at the limb's `r` radii
      when declared) is drawn in the parts frame from the posed limb's frames, following
      the drag.
    - No job is sent mid-drag.
    - On release, one regen runs. The ghost stays until the new delivery lands. The new
      mesh and the restored opacity appear in the same frame, so nothing flashes.
    - The skeleton is a scene group in the parts frame (the `measure/dim3-scene.js`
      pattern), hidden from captures.
- **Accessibility.** Pose mode is a pointer tool. Keyboard and screen-reader users keep
  the panel sliders, which drive the same parameters. Visually hidden keyboard handles
  are not in scope.

### 5. Hands and figures

- **A `hand` reference part.**
  - It is made of five limbs. The fingers hang off a palm/wrist frame, and the thumb's
    base can oppose the fingers.
  - Parameters per finger: curl and spread. Plus the wrist, and thumb opposition.
  - Built as rigid printed segments, so every pose drags live.
  - Pose presets (fist, point, peace, open, relaxed, OK) use the panel's existing
    `{ type: "preset" }` node. A preset is a bundle of parameter values.
  - **Finger lock** (Clip Studio's "lock this finger, then apply fist"): a part-authoring
    convenience, not a framework feature. The builder decides whether the reference part
    shows it, for example as a per-finger toggle that presets skip.
- **A printable hand.** The rigid hand exports as a flat kit of print-ready segments.
  The pose never reaches the printed file, so no new export view and no fusing at the
  joints are needed. A smooth, fused figure is the implicit follow-up.
- **No `hand()` helper.** Writing five limbs by hand is the worked example. A `hand()`
  helper waits until a second hand-like part shows what it should hide.
- **Mirroring a whole figure pose left to right** is out of this release. Limb `mirror`
  already covers building a mirrored limb.

### 6. A robot arm reference part

`robot-arm.js` is a 6-axis arm with a gripper:

- Base yaw, shoulder, elbow, and a wrist with pitch, yaw and roll.
- Realistic limits.
- One goal-mode `tool` handle with `aim`.
- A gripper-opening parameter.
- A `probes` entry that returns the tool goal's report, so an agent can read reached or
  missed by how much in one line.
- **What it demonstrates.**
  - The goal holds when link lengths change.
  - An out-of-reach target reports `too-far` or `out-of-range`.
  - Dragging near full stretch never flips the elbow.

### 7. The agent path

Agents pose by **setting parameters**, never by editing code:

- goal parameters for arms;
- curl, spread and presets for hands.

They read back the limb's report through a probe. That keeps a pose to a handful of
values and a one-line report.

The guide (`docs/domains/kinematics.md`) gains:

- `goals` and `pins`;
- `handles`;
- a short "posing a part as an agent" section.

The builder decides whether `partforge measure` needs `--params` (it lacks it today) so
an agent can check a pose's probe without the browser.

### 8. Lint and verify

New domain lint rules:

- a handle names a `derive` key that is not a posed limb, or a parameter that does not
  exist or is not numeric;
- a goal-mode handle with the wrong parameter count;
- an `at` that is not a joint of that limb.

The probe-based check stays the agent's tool. Verify gains nothing new this release.

## Left to the builder

- The DLS details: damping schedule, iteration counts (in `derive` and per drag frame),
  finite-difference step, the mm-to-degree weighting, and the exact `too-far` and
  `conflict` tests.
- Whether a fast analytic path for two-joint chains is worth adding inside `goals`.
  DLS alone must already be stable.
- Pose mode's icon, dot sizes and colours (match the measure and cutaway chrome), how
  goal-mode drag planes behave at grazing camera angles, and the rule for which views
  show handles.
- Exact arm and hand proportions, and the preset list.
- The release version bump (`package.json` on the feature branch, per AGENTS.md), and
  adding the two demo pages to `vite.config.js` and the CI smoke list.

## Testing

- **Solver unit tests.**
  - Reach-equivalence with `reach` on the finger.
  - Orientation goals on the arm.
  - Pins hold.
  - Couplings hold.
  - Out-of-reach gives the nearest pose and the right status.
  - Determinism: the same input gives byte-identical output.
  - Warm-start continuity: a target swept in small steps never changes any joint by more
    than a bound per step, so no flips.
- **Parameter-space solver tests** on the hand: dragging a fingertip writes only the
  listed parameters, and pinned tips stay within tolerance.
- **Lint rule tests** for each handle mistake.
- **Pose mode.**
  - A `scripts/check-app.mjs`-style browser check drags a handle and asserts:
    - no worker job runs mid-drag for rigid parts;
    - exactly one `onParamsCommit` fires on release;
    - the ghost-to-mesh swap happens in one frame.
  - Smoke checks for both demo pages.
