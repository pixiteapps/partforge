# Handles for any part: drag points that drive parameters

Status: design, 2026-11-02. Generalises the handles that the inverse-kinematics release
added (spec `2026-10-30-inverse-kinematics-design.md`, guide `docs/domains/kinematics.md`
"Handles and Pose mode").

## Intent

The draggable handles on IK limbs are the most direct way to use a forge: you grab the
thing and move it, and the parameters follow. Today only a posed limb can have them. This
design makes handles a general part feature, so that the agent that writes a part can put
a handle on whatever is most worth grabbing:

- a **motion**: spin a gear and watch the train turn, open a lid, slide a drawer, crank a
  slider-crank, run a belt;
- a **shape**: pull a box corner to change its width, drag a shelf to a new height, drag a
  hole along a slot.

It is one tool with one declaration. The author (usually an agent) picks which handles to
offer, per part, by what helps the user most. IK limbs become one kind of handle among
several, and keep working exactly as they do now.

### What done looks like

1. A gearbox forge: hover any gear and a rotary handle shows on it. Drag it round, and
   every gear in the train turns at its own ratio, live, past 360° with no wrap or stop.
2. A drawer cabinet: drag a drawer front out along its rail. The other drawers stay.
3. A parametric box: hover a top corner, drag it outward, and the width and depth follow,
   with a readout of the values. On release the box rebuilds to the snapped size.
4. The robot arm and the hand behave exactly as today.
5. An agent writing any of these parts adds handles in a few lines, with no solver or
   viewer knowledge, and lint tells it when a handle is wrong or does nothing.

### Goals

- One `handles` declaration for motion and shape handles alike.
- A handle can sit on any point that `derive` can compute: a limb's joint, a point of a
  mechanism helper, or a point the author writes as a function.
- Four ways to move: free point, along a line, about an axis, on a plane.
- Coupled mechanisms (gear trains, belts, racks, cranks) work by coupling parameters in
  `derive`. Grabbing any member solves the shared driving parameter. The viewer has no
  gear-specific code.
- Continuous rotation: a rotary handle can turn a parameter without end.
- Shape handles give live feedback during the drag, even when the part is slow to build.
- Existing `limb` handles, pins, joint rings, aim gizmos and `runtime.pose` are unchanged.

### Non-goals (this release)

- Handles that read built geometry (a face, an edge, a mesh point). Every handle point
  comes from `derive`.
- Constraint solving between sub-parts (mates, assemblies). Coupling is the author's
  `derive` code.
- Physics: collision, gear backlash, belt slip.
- Handles in sketch, measure or cutaway modes, or in a cached preview.
- A keyboard path for handles. The panel sliders drive the same parameters.

### Anti-goals (a failure even if the maths is right)

- An author has to learn two systems, one for motion and one for shape.
- A gear drag that sticks at 0° or 360°, jumps, or spins the wrong way.
- A shape drag on a slow part that freezes the page or shows nothing moving.
- Any change in how the robot arm or the hand feel.
- Handles everywhere: a part with ten handles all visible at once is a failure of the
  reveal rule.

## Constraints from the codebase

- `derive` is pure, and the drag solver calls it about twice per parameter per iteration
  (`param-solve.js`'s `solveAngles`). Handle points must come from `derive` (or from a
  pure function of `p` and `d`), never from the kernel.
- Core never imports a domain (`test/domain-layering.test.js`). A point source is
  recognised by plain data alone, never `instanceof`: the cloud's worker holds two copies
  of this code. The limb is recognised today by `typeof v?.ikInfo === "function"`.
- `pose-session.js` and `param-solve.js` are pure, with effects injected. Keep them so.
- The viewer draws on demand. Overlay code that edits the scene in place calls
  `viewer.requestRender()`.
- Mount already knows, per sub-part, whether new params only re-place it (pose ladder
  rung 1) or need a rebuild (`staleSubParts`). Today a rebuilding sub-part is ghosted at
  0.35 opacity during a drag and rebuilt once on release.
- Release snaps every written parameter to its schema `step`. One drag is one
  `onParamsCommit`.

## Design

### 1. The declaration

A handle says three things: **where it is**, **what it drives**, and **how it moves**.

```js
handles: {
  // a point on something derive returned (a limb, a mechanism helper, a plain object)
  input: { on: "train", at: "gear1.rim", params: ["driveAngle"], drag: "rotary" },

  // a point the author computes
  corner: {
    point: (p, d) => [p.width / 2, p.depth / 2, p.height],
    params: ["width", "depth"],
    drag: "plane", normal: [0, 0, 1],
  },
  drawer2: {
    point: (p, d) => d.drawerFront(2),
    params: ["drawer2Open"],
    drag: "axis", direction: [0, -1, 0],
  },

  // unchanged: today's limb handles
  tool:  { limb: "arm", at: "tip", mode: "goal", params: { position: [...], aim: [...] }, ... },
  index: { limb: "index", mode: "angles", params: [...], lock: "indexLock", joints: { ... } },
}
```

Where it is (exactly one of these):

- `on` + `at`: `on` is a key of `derive`'s result whose value is a **point source**
  (section 2). `at` names one of its points.
- `point: (p, d) => [x, y, z]`: a function, in part coordinates, of the resolved params
  and `derive`'s result. Pure, like `derive`.
- `limb` (+ `at`): today's form. It is the same as `on` for a posed limb, and keeps
  `mode`, `seed`, `aim`, `joints` and `lock` as documented.

What it drives: `params`, the numeric parameters the drag may write, as in angles mode.
`lock` works as today.

How it moves: `drag` (section 3). A `limb` handle keeps `mode` and has no `drag`.

Optional, all handles:

- `label`: a short name for the readout and for agents (default: the handle's key).
- `showOn`: sub-part name(s). Hovering those sub-parts reveals the handle (section 5).
- `readout`: the params to show in the drag readout (default: `params`).

### 2. Point sources

A point source is any value in `derive`'s result with a `handleInfo()` method returning
plain JSON:

```js
{
  kind: "partforge.points",          // a limb answers "partforge.limb" from ikInfo()
  points: { "gear1.rim": [x, y, z], "gear1.center": [x, y, z], ... },
  axes?:  { "gear1": { origin: [...], direction: [...] } },   // rotary and axis defaults
  lines?: [[ "gear1.center", "gear2.center" ], ...],           // a skeleton to draw on hover
}
```

A posed limb is a point source through its existing `ikInfo()`; the viewer adapts it. A
mechanism helper (section 6) returns one. An author can also return a plain object with
`handleInfo` from `derive`. `at` is a key of `points`. A rotary or axis handle on a source
takes its axis from `axes[<prefix of at>]` when it does not give one.

### 3. How a handle moves (`drag`)

Every drag kind turns the pointer into a **target** for the handle point, and then the
existing solver finds parameter values that put the point on it, holding pins. The kinds
differ only in how the pointer becomes a target.

- **`"point"`** (default): free 3D. The pointer moves the target on a plane fixed at drag
  start, as an angles-mode drag does today.
- **`"axis"`**: the target moves on a line through the handle point, along `direction`
  (part coordinates). The pointer is projected onto the line on screen. The overlay shows
  a short double arrow.
- **`"plane"`**: the target moves on the plane through the handle point with `normal`.
- **`"rotary"`**: the target turns about an axis (`axis: { origin, direction }`, or a
  function `(p, d) => …`, or the source's `axes`). The pointer's angle about the axis is
  read on the axis plane (edge-on: screen-space fallback, as `gizmo/gizmo-rotate.js`
  does). The drag **adds up the change in angle** frame by frame instead of reading an
  absolute angle, so it turns past 360° freely. The solve for a rotary handle uses an
  angular residual (the wrapped difference, -180..180°, between the point's angle about
  the axis and the target angle), not a distance, so a full turn never looks like a
  backwards step to the solver.

`axis` and `direction`/`normal`/`axis.origin` may each be a function `(p, d) => …`, read
at drag start. A rotary handle's axis must stay put while its own params change (a
gear's centre); lint warns when it does not (section 8).

**Continuous parameters.** A number control gains `wrap: true` (with `min`/`max`, often
0..360). The stored value of a wrapped parameter is **never reduced**: a drag through two
turns writes 720, and the solver and snapping never clamp it. Only the panel's slider
shows it reduced into `[min, max)`; dragging that slider writes a value in the same turn
as the stored one, so it never jumps a turn back. This is what keeps a rack, a belt or a
gear with a non-integer ratio from jumping when the input passes 360°: the helpers always
see the true accumulated angle. Outside a drag, a wrapped value behaves like any number:
`runtime.setParams` accepts any finite value, animation tracks interpolate the raw values
(350 to 10 turns backwards 340°; author 350 to 370 to go forward), and lint's range checks
skip wrapped controls. A parameter with no `range` at all is also unbounded, as today.

### 4. Motion and shape

The author does not say which a handle is. Mount already knows, from the sub-parts that
the drag's params make stale:

- **Motion**: every sub-part the drag changes is only re-placed. It moves live on every
  frame, as rigid limb parts do today.
- **Shape**: some sub-part must rebuild.

Shape-drag feedback (this is my call; see "Calls made"):

1. The handle, its guide (the line, plane or arc it moves on) and a **readout** move live
   on every frame. The readout is a small label by the handle with the `readout` params'
   current values, rounded to their step, such as "width 84.0 · depth 60.5".
2. The rebuilding sub-parts ghost at 0.35 opacity, as today.
3. **Live rebuild when it is cheap.** If the last build of every stale sub-part took
   under `LIVE_REBUILD_MS` (start at 120 ms), mount lets regen jobs run during the drag:
   at most one job in flight, always for the latest params, and the delivered mesh lifts
   the ghost for that frame. A slower part keeps today's behaviour: no build until
   release. The decision is made at drag start and kept for the whole drag, so the look
   does not change mid-drag.
4. On release, the snapped values build once, as today.

Mid-drag builds are **transient**. They draw, and nothing else sees them: no `onBuild`
or other host callback, no change to export, preview or inspect state, and no commit. The
host sees the drag exactly as it does today, as one commit and one build at release. The
worker may cache them like any build.

Pose-mode's per-sub-part ghost and delivery logic (`pose-session.js` `delivered`) already
supports deliveries mid-drag; the change is in mount's hold on regen jobs.

### 5. Showing handles

The current rule is "hover within 32 px of a limb's bones". The general rule:

- A `limb` handle: unchanged.
- A handle with `showOn`: shows while the pointer is over any of those sub-parts.
- Any other handle: shows while the pointer is within 32 CSS px of its point on screen.
- A point source with `lines` shows its skeleton with its handles, like a limb.
- While a handle shows, hovering its dot shows its **path**: for a one-parameter handle,
  the curve the point travels as that parameter sweeps its range (sampled through
  `derive`, 32 samples, cached per drag start; a wrapped parameter samples one turn). For
  axis, plane and rotary handles, the guide line, square or circle.
- Touch: a press within 24 px of a handle's point drags it, as today.

Dots and gizmos keep the existing look (`gizmo/` and `pose-scene.js` palette). Axis gets a
double arrow at the dot; rotary a ring about its axis through the dot.

**Pins.** A pin means the same thing on every handle: it holds that handle's point still
in space, as a weighted hold in the solve, exactly as on a limb today. A pin id is
`"<handle>:<at>"`, or `"<handle>:point"` for a `point` handle. The hold machinery
(`solveAngles`' `holds`, `pose-session.js`'s locate) becomes generic over point sources,
keyed by handle and point rather than limb and joint. The consequences follow from the
maths and need no special cases: a pinned gear in a train locks the whole train (the shared
drive cannot move without moving it), and a pinned box corner pushes a drag of another
corner onto whatever listed params leave it still, or stops the drag.

**`on` never names a limb in this release.** A posed limb is reached only through `limb`
handles, with their existing modes, rings, aim gizmo and bone-hover reveal; lint refuses
`on` pointing at a value with `ikInfo` (`handle-on-limb`). This keeps the IK path apart.
`label`, `showOn` and `readout` are new-handle fields only.

### 6. Mechanisms domain (`partforge/mechanisms`)

A new domain, following `docs/superpowers/specs/2026-10-29-domain-modules-design.md`:
`src/framework/domains/mechanisms/`, `types/mechanisms.d.ts`,
`docs/domains/mechanisms.md`, and reference parts. Helpers are called in `derive` and
return point sources that also place sub-parts (like a limb's `place`):

- `gearTrain({ gears: [{ name, teeth, module, center, axis, meshesWith? }], drive: { gear, angle } })`
  — each gear's angle from the drive angle and the tooth ratios (sign flips per external
  mesh; `internal: true` for a ring gear). Points: `<gear>.center`, `<gear>.rim`; axes per
  gear. `place(gearName, solid)` turns a sub-part to its gear's angle.
- `beltDrive({ pulleys: [...], drive })` — pulleys by diameter ratio, same direction;
  points include a point on the belt.
- `rack({ pinion, direction })` — the rack's travel from the pinion angle.
- `crankSlider({ crank, rod, axis })` and `fourBar({ ... })` — the linkage's positions from
  the crank angle.

The helpers compute only angles and positions. They build no geometry (a gear tooth
profile is out of scope; parts may keep using their own).

Reference parts: `gearbox.js` (a three-gear train with a rotary handle on every gear and a
crank on the input; demo page `gearbox.html`), and `drawer-box.js` (shape and motion on one
part: a corner `plane` handle for width and depth, and an `axis` handle per drawer).

### 7. Agents

An agent sets parameters; it never drags. Handles help it in two ways:

- **Authoring.** The guide gets a "Handles" section in `docs/AUTHORING-PARTS.md` (the IK
  section in the kinematics guide points to it for the shared parts) with when to add a
  handle and which `drag` to choose.
- **Reading.** `npx partforge measure` prints each handle in the view with its label, its
  point and the params it drives, so an agent can say "the lid handle is at …" and knows
  which params to set.
- **The `inspect` report carries `handles`, and partforge-cloud consumes it.** This is a
  contract with the cloud, so its shape is fixed here:

  ```js
  handles: [
    { id: "input", label: "input", kind: "rotary",       // "point" | "axis" | "plane" | "rotary" | "limb-goal" | "limb-angles"
      point: [x, y, z],                                   // part coordinates, at the inspect's params
      params: ["driveAngle"],                             // flat list; a goal handle lists position, then aim
      direction: [x, y, z],                               // axis: its direction; plane: its normal; rotary: its axis direction
      origin: [x, y, z],                                  // rotary only: a point on the axis
      locked: false },                                    // true while the handle's `lock` param is true
  ]
  ```

  - Points are read at the params the inspect ran with, in part coordinates (the frame
    `measure` reports bounding boxes in), rounded to 0.001 mm.
  - The list follows the view: only handles Pose mode would show in that view (the
    existing relevance filter in mount), in declaration order.
  - A handle whose point throws at those params is listed with `point: null` and
    `error`, a short message; the report never fails because of a handle.
  - `limb` handles are included too, so the cloud sees one list for every part.
  - Absent (not an empty array) on a part with no `handles`, so existing reports are
    byte-identical; `test/verify-golden.test.js` must not move.
  - The cloud's prompt corpus regenerates against the installed package, so the release
    notes and the cloud PR that reads `handles` land together, after the publish.

### 8. Lint

New rules in `src/framework/lint/rules-handles.js`, next to the existing ones:

- `handle-no-source`: none or more than one of `on`, `point`, `limb`.
- `handle-unknown-source`: `on` is not a key of `derive`'s result, or the value has no
  `handleInfo`/`ikInfo`; `at` not in its points.
- `handle-bad-drag`: unknown `drag`; `axis` without a direction; `plane` without a normal;
  `rotary` without an axis it can find.
- `handle-point-throws`: the point (or the axis function) throws at the defaults.
- `handle-inert` (warning): nudging each listed param by one step moves the handle point
  by less than 0.01 mm. The handle does nothing at the defaults.
- `handle-axis-moves` (warning): a rotary handle's axis moves when its own params change.
- `wrap-needs-range`: `wrap: true` on a control with no `min`/`max`.

Lint runs these by calling `derive` at the defaults, as the existing handle rules do.

## Left to the builder

- Module layout: whether point-source and drag-kind code lives in new files under
  `src/framework/pose/` or a renamed folder. Public names (`runtime.pose`, "Pose mode" in
  docs) stay.
- The exact screen-to-target projection for `axis` and `plane` when the line or plane is
  nearly edge-on, following the existing 18° rule.
- Readout styling and placement, inside the existing pose theme.
- The `LIVE_REBUILD_MS` threshold, tuned on the reference parts.
- How the CLI's `measure` prints the handle list (the `inspect` shape is fixed in section 7).
- Whether `fourBar` ships in the first release.

## Calls made (not discussed with the user)

- Shape-drag feedback: live readout and guide always; live rebuild only for parts whose
  last build was under about 120 ms, else ghost and rebuild on release.
- Handles never read built geometry; points come from `derive`.
- Continuous rotation through a new `wrap: true` control flag.
- The mechanisms domain computes motion only, not tooth geometry.
- `showOn` and point-proximity as the reveal rules for non-limb handles.
- Two reference parts, `gearbox.js` and `drawer-box.js`.
- Wrapped values are stored unreduced; only the slider shows them reduced.
- Mid-drag builds are transient: no host callbacks, no export or inspect state.
- Pins hold a point in space on every handle kind, through one generic hold path.
- `on` cannot name a limb in this release.
- The `inspect` `handles` entry's exact shape (the user decided it ships to the cloud;
  the fields, frame, view filter and error handling are my call).

## Testing

- `param-solve` unit tests per drag kind: axis and plane targets, rotary with an angular
  residual, a rotary drag through 720° on a wrapped param (no stick, no reverse), a
  coupled three-gear train solved from each gear.
- `pose-session` tests for live-rebuild deliveries mid-drag and for the threshold chosen
  at drag start.
- Lint tests for every new rule.
- `inspect` tests: the `handles` shape on the gearbox, the drawer box and the robot arm;
  absent on a part without handles; a throwing point listed with `point: null`.
- Mechanisms helper tests: ratios and signs, internal gears, belts, crank-slider
  positions against closed-form values.
- The robot arm and hand: existing pose tests and `scripts/check-pose.mjs` stay green
  unchanged; `npm run bench:pose` shows no regression.
- `scripts/check-pose.mjs` extended to drag the gearbox and the drawer box in Chromium.
