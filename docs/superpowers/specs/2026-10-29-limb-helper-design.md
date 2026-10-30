# Limb helper — design

Status: approved 2026-10-29, revised the same day so that it covers solid parts and
leaves room for IK and animation.
Branch: `feat/implicit-limb` (off `feat/implicit`, after the frame report).

## Problem

Agents write partforge parts, and jointed limbs are where they fail. This happens in
both kinds of part:

- **Organic (`k.implicit`) parts.** A limb is hand-written frame data: a base frame with
  Euler-style `rotate` steps, a child frame per joint, a capsule per segment, and a
  contact `attach` entry with hand-tuned numbers. One finger in the hand fixture
  (`test/fixtures/implicit-trees.js`) takes about 30 lines.
- **Solid parts, such as a printed robotic hand.** Each link is its own sub-part. Its
  assembly pose is a `views` function that rotates the link about its joint and then
  about every joint above it. The author must chain those rotations by hand, about
  hinge points that move as the joints above them turn.

The failures recorded so far all come from that hand work:

- **Sign and order of rotations.** Whether a joint bends toward the palm or away from
  it depends on a sign on an axis and the order of the steps. The spike's thumb bent
  toward the wrist until its frames were printed (research notes §7c).
- **Handedness.** The first hand was a left hand. Turning it over kept it a left hand.
- **Reaching a target.** In the October review, a trial grip's fingers missed the rod
  entirely. The author had worked out joint angles by hand and had no way to say
  "close the fingers on the rod".
- **Coordinate spaces.** A target is known in part coordinates, but a joint is written
  in its parent's frame. The author has to carry every point through the chain.

LLMs are measurably weak at this. Studies of LLM-written CAD report that models
struggle most with the origins and orientations of sketch planes. The fix that works
is to give them better words for position and rotation.

The frame report (2026-10-28) lets an author *check* where a chain landed. This design
lets the author *say what they want* so that the chain lands there, in either engine.

## Goal

An agent describes a jointed limb once and poses it in terms that cannot have the
wrong sign. It can ask for the tip to reach a point, or for the limb to close on a
shape until it touches. It uses the same limb in two ways:
- to write an organic `k.implicit` body;
- to place the solid links of a mechanical one.

It then reads back what it actually got, including any case where it did not get
what it asked for.

## Shape of the design: a kinematic core and two adapters

The core is forward kinematics. A rest pose plus one value per joint gives every
joint's place, by chaining each joint's fixed offset and its own rotation down from
the parent. `reach` and `grip` are small inverse-kinematics solvers layered on top:
they find joint values, then hand them to the same forward step.

The model follows the robotics standard URDF rather than Denavit–Hartenberg
parameters, which are compact but easy to get wrong:
- joints are described separately from the segments between them;
- each joint has its own origin, axis and limits;
- a joint may follow another one (URDF's "mimic").

Two things depart from URDF on purpose:
- Angles are in degrees, to match partforge.
- The base is oriented by direction vectors, never roll-pitch-yaw. Roll-pitch-yaw is
  the sign-and-order trap behind the spike's backwards thumb.

Internally the joints form a **tree**. `limb` is sugar for one serial chain in that
tree, so a later `skeleton()` holding a palm, a wrist and five fingers is the same
data with branches, not a new system. Rotations are matrices throughout; Euler steps
appear only in the `rotate` escape hatch.

The design separates three things that today's hand-written frames mix together.
That separation is what keeps it open to future IK and animation:

1. **Structure.** The joint tree: each joint's parent, origin, axis, limits and
   coupling, and the segment lengths. This never changes with the pose.
2. **Pose.** One angle per joint, plus the base's spread and twist. Every way of
   posing a limb produces this same plain array:
   - explicit `bend` values or a single `curl`;
   - a `reach` or `grip` solve;
   - an animation track driving a param;
   - a future multi-limb IK.
3. **Output.** Frames, world transforms, and placements, computed from the structure
   and the pose. This is where the engines differ:
   - the implicit adapter writes frames, flesh nodes and `attach` entries;
   - the solid adapter rotates and translates a solid into a joint's frame.

The core is plain maths with no geometry. It has no dependency on either engine. It
lives in the kinematics domain (`src/framework/domains/kinematics/`) and is exported
from `partforge/kinematics`, not `partforge/geometry` (see the amendment under
"Constraints").

## Non-goals

- A new node kind, or changes to the k.implicit grammar, the native core, the mesher
  or the animation engine. Both adapters write things that already exist.
- **Multi-limb IK in this version.** The design leaves room for it: a solver writes
  the same pose array.
- **New animation features.** Animation already works through params and `tracks`.
  This design only makes sure a limb pose can be driven that way at frame rate.
- **Joints that are not hinges in v1:** ball joints and sliders. Each joint keeps a
  `type` field (`"hinge"` only in v1) so that they can be added. A hinge may turn
  about any axis.
- **URDF export.** The joint tree maps onto URDF almost one to one, and v1 must not
  make choices that block it, such as joints without explicit origins or axes. The
  export itself waits until a robotic part needs ROS or a simulator.
- Skinning, muscles and bulge. Bulge stays parked.
- Drawing skeletons in the viewer, and `verify` assertions on limbs.

## Anti-goals

- **A second skeleton format.** The implicit output must be plain
  `{ parent, at, rotate }` frames. The solid output must be ordinary
  `rotate`/`translate` calls.
- **A silent miss.** A target out of reach, a clamped joint, or a grip that closed on
  nothing is reported, never quietly approximated.
- **Non-determinism.** Solvers use fixed iteration counts and no clock. `build` and
  view poses stay pure functions.
- **Breaking the pose fast path.** A solid link placed by the limb must still animate
  at frame rate.

## API

```js
import { limb } from "partforge/geometry";

// 1. Structure: once, from params that change the shape.
const index = limb("index", {
  parent: "palm", at: [-30, 96, 2],     // base, in the parent frame
  toward: [0, 1, 0],                    // where the straight limb points (parent frame)
  bendToward: [0, 0, -1],               // which way a positive bend curls (the palm side)
  joints: [                             // base first; a plain name takes every default
    { name: "mcp", range: [-10, 90] },
    { name: "pip", range: [0, 110] },
    { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } },
  ],
  lengths: [42, 25, 22],                // mm, one per segment (or `length` on each joint)
});

// 2. Pose: as often as needed; every form returns a posed limb.
const posed = index.pose({ bend: { mcp: 50, pip: 60 }, spread: 8 });   // dip follows: 45
// or index.pose({ curl: 0.6 }), index.pose({ reach: [x, y, z] }, frames), index.pose({ grip: { around: rod } }, frames)

// 3a. Organic output
spec.frames = { palm: {}, ...posed.frames };
contact.children.push(posed.flesh({ r: [9.5, 8.5, 7.4, 6.4], blend: 3 }));
contact.attach.push(posed.attach("palm", { k: 8 }));

// 3b. Solid output: a link built along +Y from its joint, placed into the assembly
views: { assembly: (s, p, d) => d.index.place(s, "pip") }
```

### Joints

`joints` is one entry per joint, base first. An entry is a name, or an object for
anything beyond the defaults:

```js
joints: [
  { name: "mcp.spread", axis: "spread", length: 0, range: [-20, 20] },  // a 2-DOF base: two joints at one point
  { name: "mcp", range: [-10, 90] },
  "pip",
  { name: "dip", follow: { joint: "pip", ratio: 0.75 } },               // tendon-coupled
],
lengths: [0, 42, 25, 22],
```

- **`axis`** is the joint's hinge axis in its own frame. It is `"bend"` (the default,
  the limb's bend axis defined below), `"spread"` (local Z), `"twist"` (local Y), or
  a vector. A vector axis follows the same sign rule as any other rotation: positive
  by the right-hand rule.
- **`length`**, or the matching `lengths` entry, is the segment from this joint to the
  next one. A length of 0 stacks two joints at one point. That is how a robot
  finger's two-axis base joint is described, as in URDF, and such a segment has no
  flesh.
- **`range`** is `[min, max]` in degrees. The default is `[-10, 100]`. A value outside
  it is clamped, and the clamp is reported.
- **`follow: { joint, ratio = 1, offset = 0 }`** makes this joint a follower: its
  value is `ratio × value(joint) + offset`, which is URDF's mimic.
  - A follower takes no pose value of its own. Setting one is an error.
  - It still clamps to its own range, and a clamp is reported.
  - `joint` must name an earlier joint in the same limb; v1 has no coupling across
    limbs, so the coupling can never loop.

### Words for orientation

- **`toward`** is a direction vector, not a rotation. The base points along it.
- **`bendToward`** is a direction vector: the side a positive `bend` curls toward. It
  works like an IK pole vector, which is what keeps a solved bend plane from flipping.
  - Only its part at right angles to `toward` is used.
  - It is an error for it to be parallel to `toward`.
- **`bend`** is in degrees. It is positive toward `bendToward` and negative away
  (hyperextension). The sign means the same thing for every limb, whichever way the
  limb points.
  - It is an array with one value per driven joint, followers skipped, or an object
    keyed by joint name, such as `{ pip: 60 }`.
  - A joint the object leaves out stays at 0.
  - For a joint whose `axis` is not `"bend"`, the value turns about that axis instead.
- **`spread`** swings the whole limb sideways, in degrees. It is a rotation about the
  base frame's local Z (defined below), positive by the right-hand rule, and it is the
  hand fixture's abduction.
- **`twist`** turns the limb about its own length.
- **`curl`**, from 0 to 1, is the alternative to `bend`. Every driven `"bend"`-axis
  joint goes from its straightest in-range value `a0` (the value nearest 0) toward its
  closing end (`range[1]`, or `range[0]` for an all-negative range) by `curl`:
  `a0 + curl × (end − a0)`. For a range containing 0 this equals `curl × range[1]`.
  Followers follow. One number poses a whole finger.
  Joints with other axes stay at 0 unless they are named in `bend`, since `curl` and
  `bend` can be combined only that way: `curl` sets the bend joints, and an object
  `bend` sets the rest.
- **`rotate`** is an escape hatch for porting existing specs. It replaces
  `toward`/`bendToward`/`spread`/`twist` with raw `rotate` steps for the base frame,
  exactly as frames take them today.

Frame convention, which the builder must hold to because the fixture and the frame
report both assume it:
- Each segment lies along its frame's local +Y.
- Local Z is the part of `−bendToward` at right angles to `toward`, made unit length.
- Local X is Y × Z.
- A bend of θ is a rotation of −θ about local X.

This matches the hand fixture: a palm faces −Z, and flexion is a negative rotation
about X. A solid link is therefore built with its joint at the origin, running along
+Y, with its bending side toward −Z.

### Posing by goal: `reach` and `grip`

Both need the parent's position in part coordinates, so `pose` takes the frames
declared so far as its second argument. A `reach` or `grip` without them throws an
error that says to pass them. A solid part with no implicit frames passes its own
parents as plain frames: `{ palm: { at: [0, 0, 0] } }`. The same applies to a parent
that is itself a limb, through that limb's `posed.frames`.

**`reach: [x, y, z]`** places the tip on a point in part coordinates (the space of
`frames` with no parent).
- `spread` and the first joint aim the limb at the point.
- The other driven bend joints bend together, sharing the bend in proportion to their
  ranges, and followers follow, until the base-to-tip distance matches. That distance
  shrinks steadily as they bend, so a fixed 60-step bisection finds it.
- Couplings always hold. A target that only an uncoupled finger could reach is
  reported as out of reach, not met by breaking the coupling.
- Joints whose axis is not `"bend"` keep the values given in `bend`, and the solve
  works around them.
- This is the two-bone IK construction, with `bendToward` as the pole, extended to
  more joints. With one segment, only the aim is solved.
- A target that is too far, too close, or needs a first joint outside its range is
  placed as close as the limb allows, and the result is reported.

**`grip: { around, clearance = 0 }`** closes the limb on a shape.
- **`around`** is a shape description in part coordinates. It uses the k.implicit
  primitive vocabulary, such as `{ kind: "cylinder", r: 12, h: 120, at, axis }`, or
  a small tree of them. It is maths, not geometry, so both engines can use it: a solid
  rod is described by the same primitive at the same place.
- **`r`** (radius per joint and tip) can be passed to `grip` when `flesh` has not been
  called yet, so that the contact test knows the limb's thickness.
- **Closing.** Starting from the given pose, each driven bend joint closes, base joint
  first, carrying its followers with it,
  until the limb beyond it comes within `clearance` of the shape's surface. A sample
  on a segment's axis that is closer than that segment's radius plus `clearance`
  counts as contact. A negative `clearance` presses in by that much.
- **Search.** Each joint is found by a fixed 40-step bisection on the shape's distance
  field, evaluated with the k.implicit JS engine and never meshed.
- **No contact.** A joint that reaches the end of its range without touching is
  reported with `touched: false`. That is the October failure, stated outright.

`reach` and `grip` replace `bend`/`curl` for the joints they solve, and they cannot
both be used on one pose.

### Mirroring

`mirror: "YZ" | "XZ" | "XY"` on the structure reflects the limb's inputs across that
plane of the parent frame: `at`, `toward`, and `bendToward`. A `reach` point or `grip`
shape is a scene position in part coordinates and is never reflected; to mirror a
target, pass the mirrored target.
- The helper then builds right-handed frames from the reflected inputs, so the output
  is a true mirror image, and every frame is still a rigid transform. That matters for
  solids: a placement must never mirror (`place-not-rigid`).
- A left arm is the right arm's numbers with `mirror: "YZ"` on a midline parent.
- `spread` and `twist` keep their meaning relative to the reflected axes, so the same
  numbers pose both sides symmetrically.
- For a solid part, the left links themselves must be built mirrored in `build`, as
  the existing rule says. The limb only places them.

### Outputs

All outputs are plain data or plain functions of a posed limb.

- **`frames`**: one frame per joint (`index.mcp`, `index.pip`, `index.dip`) plus
  `index.tip`, each as `{ parent, at, rotate }`. The base frame's orientation is one
  `rotate` step with a vector axis (`axisVector` already accepts one).
- **`flesh({ r, blend, label? })`**: a k.implicit `union` with `k: blend`, labelled
  `index`, of one tapered capsule per segment. Each capsule is labelled `index.mcp`,
  and so on.
- **`attach(label, { k, radius?, band? })`**: the contact `attach` entry joining the
  base to the piece `label`. The defaults come from the hand fixture:
  - `radius` is a third of the first segment;
  - `band` is 3 mm, scaled by the base radius over 9.5 mm.
- **`place(solid, joint = base)`**: moves a solid from its link frame (joint at the
  origin, running along +Y) into that joint's place in part coordinates.
  - It uses only `rotate` and `translate` calls, which are the calls a `views` pose is
    allowed, so a link animates at frame rate when the pose comes from params.
  - It also works on anything else with those methods, such as a frame set from
    `k.implicitFrames` or a `Shape2D`.
- **`world(joint)`**: that joint's `{ origin, x, y, z }` in part coordinates, the
  frame report's shape. This is for probes, and for anchoring other features to a
  joint.
- **`tip`, `joints`**: the frame names.
- **`report`**: plain JSON that a probe can return unchanged.
  ```json
  { "bend": [50, 60, 45], "clamped": [false, false, false],
    "tip": [x, y, z],
    "reach": { "target": [...], "residual": 0, "status": "reached" },
    "grip":  { "joints": [{ "bend": 72.4, "touched": true }, ...] } }
  ```
  - `tip` is in part coordinates when frames were passed to `pose`, and absent
    otherwise.
  - `reach` and `grip` appear only when they were asked for.
  - `status` is one of `reached`, `too-far`, `too-close` or `out-of-range`.
  - Numbers are rounded to 0.001, as in the frame report.

### Using it in a solid part, with animation

Limbs are computed in `derive(p)`, so `build`, `views` and probes share them.
- The limb's pose params (curl, bend, a grip on/off) are read only in `derive` and in
  `views` poses, never in `build`.
- An animation then drives one master param, such as `p.grip` from 0 to 1. `derive`
  turns it into a pose, and every link follows at frame rate. This is the existing
  "couple motions through derive" rule.
- A `reach` or `grip` solved in `derive` runs once per param change: under a
  millisecond for `reach`, a few milliseconds for `grip`.
- The pose fast path never sees the solver, only the resulting `rotate`/`translate`
  calls.

This is the hand in the robotic case: each link a printed sub-part, `print` laying
them flat, and `assembly` placing each one with `d.<finger>.place(s, "<joint>")`.

### Room for later

- **IK.** A multi-limb solver, such as "touch the thumb tip to the index tip" or a
  whole-hand grasp, writes the same pose arrays through `limb.pose({ bend })`. The
  per-limb `reach` and `grip` become building blocks inside it.
- **Joint types.** `type: "ball"` (three angles) or `"slide"` (a distance) are added
  per joint. A pose entry then becomes the joint type's own values. Hinges keep their
  plain number.
- **URDF export.** Each joint becomes a URDF joint with its origin, axis, limits and
  mimic, and each segment becomes a link. Angles convert to radians.
- **Animation.** Keyframes stay on params. A future "pose track", which animates the
  whole pose array or interpolates between two named poses, would set those params
  and need no change here.
- **A shared rig.** Several limbs on one parent can later be gathered into a
  `skeleton()`, which is the same joint tree with branches. It would resolve them in
  order, solve across them, and allow couplings between limbs, without changing what
  a single limb produces.

### Radians and Euler angles: converters, not overloads

Degrees and direction vectors stay the one canonical form. No limb or Solid method
takes a `units` flag or a second angle format: an API that accepts two forms invites
an author to mix them in one call, and a wrong-unit angle fails silently (a radian
read as degrees is a barely visible turn).

Input that arrives in other forms is converted at the edge by small pure helpers in
`partforge/geometry`. They are general rotation helpers that any part may use, not
part of the limb:

- **`deg(radians)`** and **`rad(degrees)`**: plain conversions.
- **`euler({ order, angles, frame, units = "deg" })`**: a rotation given as Euler
  angles, returned as canonical `rotate` steps. Those steps can be fed to a frame's or
  a limb's `rotate`, or to Solid `rotate` calls through `applyRotation`.
  - `order` is required, for example `"XYZ"`.
  - `frame` is required: `"intrinsic"` (each turn about the already-rotated axes) or
    `"extrinsic"` (about fixed axes).
  - There are no defaults for `order` or `frame`, because the conventions disagree.
    URDF's `rpy` is extrinsic XYZ, which equals intrinsic ZYX; Blender's default is
    `XYZ` Euler. A silent default would be the same trap as the spike's thumb.
  - `units` is the only place radians are accepted, and it is named on every call.
- **`applyRotation(x, steps, center?)`**: applies `rotate` steps to anything with a
  `rotate(deg, center, axis)` method (a Solid, a frame set). It uses only `rotate`, so
  it is legal in a `views` pose.
- **`toEuler(steps, { order, frame, units })`**: the reverse, for reporting a rotation
  in the convention another tool expects. The future URDF export uses it.

The converters are tested against each other:
- `euler` → `toEuler` is a round trip, away from gimbal lock;
- intrinsic XYZ equals extrinsic ZYX;
- a URDF `rpy` triple places a frame where ROS's own convention would.

### Errors

Errors are `ImplicitSpecError`s whose messages name the field and the fix, in the
style of the grammar's own messages. These are errors:
- `lengths`, `r`, `joints` or a `bend` array of the wrong length;
- a `range` that is not `[min, max]` with `min ≤ max`;
- `toward` or `bendToward` of zero length, or parallel to each other;
- both `bend` and `curl`, or both `reach` and `grip`;
- `reach` or `grip` without frames;
- an unknown `parent` when frames are passed;
- a duplicate joint name;
- a `follow` that names an unknown or later joint;
- a pose value for a follower;
- an `axis` that is not `"bend"`, `"spread"`, `"twist"` or a non-zero vector;
- `place` given a joint name the limb does not have.

## Constraints

- Pure, deterministic, DOM-free and `three`-free, so it is safe in the worker graph
  and in derive. `test/worker-layering.test.js` must still pass.
- Uses `hypot3`, never `Math.hypot`.
- Cost:
  - without `grip`, well under 1 ms per limb;
  - with `grip`, at most about 5 ms per limb (field evaluation only, no mesh).
- **Amended 2026-10-29 (domain layout).** The limb helper is the first domain; the
  layout and entry follow `2026-10-29-domain-modules-design.md` ("Kinematics: the first
  domain"). It lives in `src/framework/domains/kinematics/` and is exported as `limb`
  from `partforge/kinematics`, never from `partforge/geometry`. The domain imports only
  core: `geometry/xform.js` (rigid transforms and frames), `geometry/rotations.js` and
  `geometry/errors.js` (`SpecError`). Only the rotation converters (`deg`, `rad`,
  `euler`, `toEuler`, `applyRotation`) stay on `partforge/geometry`, with types in
  `types/geometry.d.ts`. The implicit adapter (`flesh`, `attach`) stays with the
  implicit engine and is not part of the first release.

## Testing

- **Port of the fixture.** The hand fixture's `finger()` rewritten with `limb`, using
  the `rotate` escape hatch, resolves to the same frame transforms as today's, bit for
  bit, and meshes to the same hash.
- **One pose, two engines.** For the same posed limb, `place(k.box(...), joint)`
  lands each link where `frames` says that joint is. For every joint, a solid's placed
  bounds agree with the implicit frame within 0.001 mm.
- **Sign.** For many random `toward`/`bendToward` pairs, a positive `bend` moves the
  tip toward `bendToward`, and a negative one away.
- **Joints.**
  - A two-axis base, a zero-length `"spread"` joint followed by a bend joint, matches
    the single-joint limb with `spread` set, frame for frame.
  - A vector-axis joint turns by the right-hand rule.
- **Coupling.**
  - A follower takes `ratio × leader + offset` and clamps to its own range.
  - `curl`, `reach` and `grip` all keep couplings exact. A `reach` that would need
    the coupling broken reports `out-of-range`.
- **Reach.**
  - The tip lands within 0.01 mm of reachable targets, including targets behind the
    pole side.
  - `too-far`, `too-close` and `out-of-range` each report the nearest placement.
- **Grip.**
  - Four fingers closing on a rod across the palm all report `touched: true`, each tip
    at `clearance` ± 0.05 mm from the rod surface.
  - The rod moved out of reach reports `touched: false`.
  - The frame report agrees with `report.tip`.
- **Mirror.**
  - Mirrored frames reflect the originals' origins, and their axes stay right-handed.
  - A mirrored grip touches at mirrored points.
  - `place` on a mirrored limb is still rigid.
- **Fast path.** A small solid test part with three links posed by
  `d.finger.place(...)` from a `curl` param animates through the pose fast path with
  no rebuild. The pose-fast-path tests already have the harness for this.
- **Determinism.** Two calls give identical JSON.
- **Errors.** One test for each error above.
- **Lint.** A part using `limb` with `grip` in `derive` raises no `build-throws` or
  `probe-throws`, and no note that a view pose is unreadable.

## Docs

- **Amended 2026-10-29:** the `partforge/geometry` export and file-layout statements in
  this spec now mean the domain layout above (`partforge/kinematics`,
  `src/framework/domains/kinematics/`). The converters are documented in
  `docs/KERNEL-CONTRACT.md`; `limb` is not a kernel surface.
- `docs/ERROR-PATTERNS.md`:
  - extend `implicit-limbs-miss-target` to point first at `grip`/`reach` and their
    report;
  - add a solid-side twin for links posed by hand-chained rotations.
- The authoring guide gets its limb section in the later docs PR. That section has
  two worked examples: the implicit hand and a three-link solid finger. The second
  may become the reference part for robotic hands.

## Left to the builder

- The order the base rotation is composed in (aim, then spread, then twist), as long
  as the sign rules above hold.
- How many samples to take along a segment for the grip test, as long as the grip
  tests pass.
- The exact rounding in `attach`'s band scaling.
- Whether `place` folds the chain into one `rotate` with a vector axis plus one
  `translate`, or emits the steps per joint. Either is allowed if the fast-path test
  passes. One rotate plus one translate is cheaper and is preferred.
