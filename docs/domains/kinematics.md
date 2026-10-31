# Kinematics: jointed limbs

Use this domain for any part with links that turn about joints: a robot finger, an arm,
a gripper jaw, a leg. You describe the chain of joints once, pose it with words that
cannot have the wrong sign, and place each solid link with one call. The domain is plain
maths. It builds no geometry, so you can use it in `derive`, in `views` poses and in
probes.

```js
import { limb } from "partforge/kinematics";
```

Import it from `partforge/kinematics`, never from `partforge/geometry` or `partforge`.
It is worker-safe, like `partforge/geometry`.

The worked example is **`src/parts/robot-finger.js`**: three printed links posed by one
limb, with an animation that never rebuilds a link. It is at the end of this guide.

## Why use it

When you chain link rotations by hand, these are the usual faults:

- the sign or order of the rotation steps is wrong, so a joint bends the wrong way;
- a child link turns about its rest pivot, not about the pivot where the parent put it,
  so the links come apart (the error pattern `limb-links-hand-chained` in
  `docs/ERROR-PATTERNS.md`);
- you calculate joint angles by hand for a target, and the fingers miss it.

`limb` removes these faults. Each joint has a range, a closing direction and an
optional coupling. A pose is a few numbers or a goal. The posed limb tells you what
it actually did, which includes clamps and misses.

## The three steps

1. **Structure.** `limb(name, def)` validates the joints once and returns a limb.
2. **Pose.** `limb.pose(opts, frames?)` returns a posed limb. You can call it as many
   times as necessary.
3. **Output.** The posed limb has `place(solid, joint, { from? })`, `world(joint)`,
   `frames`, `values` and `report`.

```js
const index = limb("index", {
  at: [-30, 96, 2],          // the base joint, in part coordinates (mm)
  toward: [0, 1, 0],         // the straight limb points along +Y
  bendToward: [0, 0, -1],    // a positive bend curls toward -Z
  joints: [                  // base first
    { name: "mcp", range: [-10, 90] },
    { name: "pip", range: [0, 110] },
    { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } },
  ],
  lengths: [42, 25, 22],     // each joint to the next joint, then the last joint to the tip
  r: [9.5, 8.5, 7.4, 6.4],   // radius per joint, then the tip (needed only by grip)
});

index.joints;                 // ["index.mcp", "index.pip", "index.dip"]
index.tip;                    // "index.tip"

const posed = index.pose({ bend: { mcp: 50, pip: 60 } });
posed.values;                 // [50, 60, 45]  (dip follows pip: 0.75 × 60)
posed.report;                 // { bend: [50, 60, 45], clamped: [false, false, false], tip: [-30, 94.508, -62.964] }
posed.world("pip");           // { origin: [-30, 122.997, -30.174], x: [1, 0, 0], y: [0, -0.342, -0.94], z: [0, 0.94, -0.342] }
```

## Declaring a limb

`limb(name, def)`. `name` is a non-empty string. Each frame name starts with it:
`<name>.<joint>`, plus `<name>.tip`. Fields of `def`:

| field | meaning |
| --- | --- |
| `joints` | Required. A non-empty array, base first. An entry is a joint name, or `{ name, type?, axis?, length?, offset?, range?, cone?, follow? }`. |
| `lengths` | One length per joint, in mm: from that joint to the next joint, and from the last joint to the tip. Alternatively, give each joint its own `length`. If you give both, they must agree. |
| `toward` | The direction the straight limb points. Required unless you use `rotate`. |
| `bendToward` | The side a positive bend curls toward. Required unless you use `rotate`. |
| `at` | The base joint's position, in the parent frame (or part coordinates). Default `[0, 0, 0]`. |
| `parent` | The name of a frame the limb hangs from. Omit it for part coordinates. See "Limbs on a parent frame". |
| `r` | Radii, one per joint and then the tip (`joints.length + 1` entries). Only `grip` uses them. |
| `mirror` | `"XY"`, `"XZ"` or `"YZ"`: reflects the limb. See "Mirroring". |
| `rotate` | The escape hatch: raw rotate steps for the base frame, in place of `toward`/`bendToward`. |

An unknown field is an error. This prevents a typo from being ignored.

## Joints

- **`axis`**: the joint's hinge axis in its own frame. `"bend"` is the default (local
  X, the limb's bend axis). `"spread"` is local Z, `"twist"` is local Y, or you can
  give a non-zero `[x, y, z]` vector. A vector axis turns by the right-hand rule.
- **`range`**: `[min, max]` in degrees, with `min ≤ max`. The default is `[-10, 100]`.
  A value outside the range is clamped to it, and `report.clamped` shows the clamp.
- **`length`**: the segment from this joint to the next one, in mm, `≥ 0`. A length of
  0 puts two joints at one point.
- **`follow: { joint, ratio = 1, offset = 0 }`**: makes this joint a follower (a
  tendon coupling, URDF's mimic). Its value is `ratio × leader + offset`, where the
  leader's value has already been clamped. The follower then clamps to its own range.
  `joint` must name an EARLIER joint of the same limb. A follower takes no pose value
  of its own.
- **`offset: [x, y, z]`**: moves this joint off the straight line, in mm. The joint
  sits at the end of the previous segment (`[0, length, 0]` in the previous joint's
  frame) plus `offset`, in that same frame, so the offset turns with the previous
  joint. The base joint takes no offset: place it with the limb's `at`. See "Joints
  off the line".
- **`type`**: `"hinge"` (the default) or `"ball"`. See "Ball joints".
- The joint name `"tip"` is reserved for the end frame.

**A two-axis base** (a robot knuckle that swings sideways and also bends) is two joints
at one point. Make the first joint a zero-length `"spread"` joint:

```js
const arm = limb("arm", {
  toward: [0, 0, 1],
  bendToward: [1, 0, 0],
  joints: [
    { name: "yaw", axis: "spread", length: 0, range: [-45, 45] },
    { name: "shoulder", range: [-90, 90] },
    { name: "elbow", range: [0, 150] },
  ],
  lengths: [0, 80, 60],
});
arm.pose({ bend: { yaw: 30, shoulder: 20, elbow: 40 } }).report.tip;   // [79.323, 52.588, 91.085]
arm.pose({ curl: 0.5, bend: { yaw: 30 } }).report.bend;                // [30, 45, 75]
```

### Joints off the line: `offset`

Use `offset` when the hinges of one limb are not on one straight line. A printed
finger is the usual case: each pin sits at the height of its own link's radius, so each
hinge is a little lower than the one before it. Give each joint after the base the step
from where the previous segment ends:

```js
const knuckle = limb("knuckle", {
  at: [0, 0, 4.6], toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: ["mcp", { name: "pip", offset: [0, 0, -0.5] }, { name: "dip", offset: [0, 0, -0.5] }],
  lengths: [40, 25, 20],
});
knuckle.pose({}).frames["knuckle.pip"];          // { parent: "knuckle.mcp", at: [0, 40, -0.5] }
knuckle.pose({}).report.tip;                      // [0, 85, 3.6]
knuckle.pose({ bend: [90, 0, 0] }).world("pip").origin;   // [0, -0.5, -35.4]  the step turned with mcp
```

`reach` and `grip` solve through offsets. `reach` still needs its aiming joint at the
base, so the joints up to and including it take no offset.

### Ball joints

`type: "ball"` makes a joint that turns about any axis through its centre: a ball in a
socket. It has no `axis` and no `range`. It takes **`cone`**, the largest swing from
rest in degrees (`0 < cone ≤ 180`, default 180). It cannot follow a joint, and no joint
can follow it.

Pose a ball joint with an object in `bend`: `{ bend?, spread?, twist? }`, in degrees,
with absent keys 0. The segment swings ONCE, by `√(bend² + spread²)` degrees: `bend`
alone swings it as a hinge bend does (toward `bendToward`), and `spread` alone as a
`"spread"` joint does. Then `twist` rolls it about its own swung length. Thus the
order of the words cannot change the pose, and the swing is what the cone limits. A
swing past the cone scales `bend` and `spread` down together, and `report.clamped` is
true for the joint.

```js
const thumb = limb("thumb", {
  toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [{ name: "ball", type: "ball", cone: 45 }, { name: "ip", range: [0, 90] }],
  lengths: [30, 20],
});
thumb.pose({ bend: { ball: { bend: 30 } } }).report.tip;     // [0, 43.301, -25]
thumb.pose({ bend: { ball: { spread: 30 } } }).report.tip;   // [-25, 43.301, 0]
thumb.pose({ bend: { ball: { bend: 40, spread: 30 } } }).report;
// { bend: [{ bend: 36, spread: 27, twist: 0 }, 0], clamped: [true, false], tip: [-21.213, 35.355, -28.284] }
thumb.pose({ curl: 1 }).report.bend;                          // [{ bend: 0, spread: 0, twist: 0 }, 90]
```

`curl` leaves a ball at rest unless you name it in an object `bend`. In an array
`bend`, a ball's entry is its object. `reach` and `grip` hold a ball at the value you
give and solve the hinges. The cone is round: for a limit on one side only, use hinge
joints.

## Words for orientation

- **`toward`**: a direction vector. The straight limb points along it.
- **`bendToward`**: a direction vector for the side a positive bend curls toward, like
  an IK pole vector. Only its component at right angles to `toward` is used. It must
  not be parallel to `toward`.
- **Frame convention.** Each segment lies along its joint frame's local **+Y**.
  Local **Z** is the component of **−bendToward** at right angles to `toward`, made
  unit length. Local **X** = Y × Z. A bend of θ is a rotation of −θ about local X.
  Thus a solid link is built with its joint at the origin, along +Y, with its bending
  side toward −Z.

The pose words:

| word | meaning and sign |
| --- | --- |
| `bend` | Degrees per driven joint (followers are skipped). Use an array in joint order, or an object keyed by joint name, such as `{ pip: 60 }`. A ball joint's value is an object (see "Ball joints"). A joint that the object leaves out stays at 0. A positive value bends toward `bendToward` and a negative value bends away (hyperextension), whichever way the limb points. For a joint whose `axis` is not `"bend"`, the value turns about that joint's axis. |
| `curl` | From 0 to 1. Each driven `"bend"`-axis joint moves from its straightest in-range value (the value nearest 0) toward its closing end (`range[1]`, or `range[0]` if the whole range is negative) by `curl`. For a range that contains 0, this is `curl × range[1]`. Followers follow. Joints on other axes stay at 0 unless you name them in an object `bend`. That is the only way to use `curl` and `bend` together. |
| `spread` | Swings the whole limb sideways at its base, in degrees. It is a rotation about the base frame's local Z, positive by the right-hand rule. |
| `twist` | Rolls the whole limb about its own length (local Y), in degrees, positive by the right-hand rule. |

A sign check, for a limb that points up and bends toward +X:

```js
const stalk = limb("s", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: ["a"], lengths: [10] });
stalk.pose({ bend: [30] }).report.tip;    // [5, 0, 8.66]       toward +X
stalk.pose({ bend: [-10] }).report.tip;   // [-1.736, 0, 9.848]  away from +X
stalk.pose({ spread: 30 }).report.tip;    // [0, 5, 8.66]       local Z is -X, so +spread swings toward +Y
```

**`rotate`** is an escape hatch for porting existing frame data: rotate steps for the
base frame, given as `{ axis, deg }` or an array of them, in the frame-step form. It
replaces `toward`/`bendToward`. With it, a pose cannot use `spread` or `twist`, and the
limb cannot be mirrored. Use `toward`/`bendToward` in new work.

## Posing by goal: `reach` and `grip`

Both goals solve joint values and then pose the limb exactly as `bend` does. Use one or
the other: a pose cannot have both.

### `reach: [x, y, z]`

`reach` puts the tip on a point in part coordinates.

- The first driven bend joint (the pitch) and the pose `spread` aim the limb at the
  point. The solved spread REPLACES any `spread` you gave the pose. If a driven
  `"spread"` joint comes before the pitch, that joint aims the limb instead, and the
  pose `spread` is kept as given. A limb declared with `rotate` cannot spread, so it
  cannot aim sideways: a target off its bend plane reports `out-of-range`.
- The other driven bend joints bend together until the distance from the pitch joint
  to the tip is correct. Each goes the same fraction of the way from its straightest
  in-range value to its closing end. The pitch-to-tip distance need not shrink steadily
  as the joints bend: a long chain can curl past its nearest point and open out again.
  So the solver first samples the distance at 48 even steps of that fraction. Then it
  uses a fixed 60-step bisection in the first step, from straight toward curled, whose
  ends bracket the target's distance. Couplings always hold.
- Joints on other axes keep the values you give in `bend`.
- Rules: the limb needs a driven bend joint, every segment before the pitch joint must
  have length 0, and no joint may follow the pitch joint or the aiming spread joint.
  The `robot-finger` limb (mcp, pip, dip following pip) meets all three rules.

`report.reach` is `{ target, residual, status }`. `residual` is the distance from the
tip to the target, in mm. `status` is one of:

| status | meaning |
| --- | --- |
| `reached` | The tip is within 0.01 mm of the target. |
| `too-far` | The target is beyond the straight limb. The limb is straight and aimed at the target. |
| `too-close` | The target is nearer to the pitch joint than any of the 48 sampled bends puts the tip, or it is at the pitch joint. The limb takes the sampled bend that comes nearest and aims at the target. |
| `out-of-range` | The aim needs a joint outside its range (that joint is clamped: see `report.clamped`), or the tip is otherwise more than 0.01 mm off the target. |

`too-far` and `too-close` take priority over `out-of-range`. Every status other than
`reached` gives the nearest pose the limb can make, and the residual says by how much
it missed. Always read the status. A miss is never silent, but it is also never an
error.

```js
index.pose({ reach: [-30, 137, -64] }).report.reach;    // { target: [-30, 137, -64], residual: 0, status: "reached" }
index.pose({ reach: [-30, 300, 2] }).report.reach;      // { target: [-30, 300, 2], residual: 115, status: "too-far" }
index.pose({ reach: [-30, 160, -20] }).report;
// { bend: [-10, 56.287, 42.216], clamped: [true, false, false], tip: [-30, 155.213, -30.77],
//   reach: { target: [-30, 160, -20], residual: 11.786, status: "out-of-range" } }   (mcp stops at -10)
```

### `grip: { around, clearance = 0, r? }`

`grip` closes the limb on a shape until the limb touches it.

- **`around`** is the shape in part coordinates. It can be a plain shape node or a
  distance function.
  - **A shape node** is plain data, `{ kind, …fields }`: `sphere { r }`,
    `ellipsoid { r: [rx, ry, rz] }` (a scaled field, not an exact distance, so a
    `clearance` against an ellipsoid is approximate), `capsule { a?, b, r }` (`a` defaults to the origin;
    `r` is one radius or a taper `[r0, r1]`), `box { size, round? }`,
    `cylinder { r, h, round?, axis? }` (centred on `at`, along `axis`, default `"z"`),
    `torus { R, r, axis? }`, `tube { points, r }`, `halfspace { normal, offset? }`, and
    `union { children }` of these with no `k` (or `k: 0`). Each node can also have `at`
    (a translation) and `label`. The shapes are already in part coordinates, so a
    `frame` field is an error.
  - **A distance function** is `(x, y, z) => mm`: the signed distance to the surface,
    negative inside. It must be pure and return a finite number at every point. Use one
    for any shape beyond that list (a blended union, a warp, your own formula).
- **`r`** is the limb's radius per joint and then the tip. The default is the limb's
  own `r`. Without either, `grip` throws.
- **`clearance`** is the gap to leave between the limb and the surface, in mm. A
  negative value presses into the surface by that amount.
- **Contact.** The test samples each segment's axis. A point is in contact when the
  shape's distance there, minus the segment's radius (interpolated linearly from joint
  to joint), minus `clearance`, is ≤ 0.
- **Closing.** Grip starts from the pose's own `bend`/`curl` values, clamped into range.
  Then each driven bend joint closes in turn, **base joint first**, toward its closing
  end. Its followers move with it. A joint stops at the first contact (a scan, then a
  40-step bisection, so it stops on the clear side). A joint that reaches its closing
  end with no contact stays there, with `touched: false`. Joints on other axes are not
  moved, and keep their `bend` values.
- **Scan steps.** Each joint's scan has from 48 to 1024 even steps. The count is set so
  that, from one step to the next, no point of the limb beyond the joint moves more than
  the smallest radius beyond the joint plus `clearance`, and never less than 0.25 mm. A
  shape thinner than about the limb's radius can be stepped over only when a joint hits
  the 1024-step cap (a long limb, a wide range, or a thin limb).
- **Stop.** The closing stops early when the first contact that a joint finds is on
  the tip segment, or when a joint is already in contact at its start value. Closing more would only push past that
  contact. The joints after the stop are skipped: they keep their start values.

`report.grip` is `{ touching, gap, joints }`:

- `gap` is the minimum, over the whole final pose, of distance − radius − clearance, in
  mm. It is 0 at contact, positive when the limb is clear of the shape, and negative
  when the limb is in the shape.
- `touching` is true when `gap` is 0 or less (to within 1e-6 mm).
- `joints` has one entry `{ joint, bend, touched, skipped }` for each driven bend
  joint, in order.
  - `skipped` is true for a joint that the stop skipped. Grip did not close it, because
    the contact of an earlier joint already holds the limb. Its `bend` is still its
    start value, and its `touched` is always false.
  - For a joint that closed (`skipped: false`), `touched` is read from the final pose,
    because a later joint can swing an earlier contact away. The joint is `touched` if
    it made contact while it closed, and the limb from that joint to the tip is still
    in contact.

```js
const rod = { kind: "cylinder", r: 8, h: 40, axis: "x", at: [-30, 130, -22] };
index.pose({ grip: { around: rod, clearance: 0.5 } }).report;
// { bend: [10.984, 30.317, 22.738], clamped: [false, false, false], tip: [-30, 165.643, -42.283],
//   grip: { touching: true, gap: 0, joints: [{ joint: "mcp", bend: 10.984, touched: true, skipped: false },
//                                            { joint: "pip", bend: 30.317, touched: true, skipped: false }] } }

// The same rod as a distance function gives the same pose:
const rodDistance = (x, y, z) => Math.sqrt((y - 130) ** 2 + (z + 22) ** 2) - 8;
index.pose({ grip: { around: rodDistance, clearance: 0.5 } }).report.grip.joints[1].bend;   // 30.317

// A rod out of reach: every joint closes fully and nothing touches.
index.pose({ grip: { around: { ...rod, at: [-30, 130, -200] } } }).report.grip;
// { touching: false, gap: 147.073, joints: [{ joint: "mcp", bend: 90, touched: false, skipped: false },
//                                          { joint: "pip", bend: 110, touched: false, skipped: false }] }
```

A `grip` in `derive` runs once each time a param changes, in a few milliseconds. A
`reach` takes less than a millisecond.

## Limbs on a parent frame

Give `parent: "<frame>"` when the limb hangs from another frame, for example a palm.
`at`, `toward` and `bendToward` are then in that frame. Pass the frames declared so far
as `pose`'s second argument: `{ name: { parent?, at, rotate? } }`. A solid part with no
other frames can pass plain ones, such as `{ palm: { at: [0, 0, 10] } }`. A limb on
another limb uses that limb's `posed.frames`.

Without the frames, a parented limb can still be posed with `bend`, `curl`, `spread` and
`twist`. But `report.tip` is then absent, and `reach`, `grip`, `place` and `world` throw
an error that tells you to pass the frames:

```js
const finger = limb("index", {
  parent: "palm", at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: ["mcp", "pip"], lengths: [42, 25],
});
finger.pose({ curl: 0.5 }).report;                                    // { bend: [50, 50], clamped: [false, false] }  (no tip)
finger.pose({ curl: 0.5 }, { palm: { at: [0, 0, 10] } }).report.tip;  // [-30, 118.656, -44.794]
```

**A posed limb can stand in for its frames.** Pass the parent's posed limb itself, not
its `frames`: it brings every frame of its chain, its own parent's included. Pass an
array to combine fixed frames and posed limbs (later entries win). A limb on a
fingertip on a finger on a palm:

```js
const palmFrames = { palm: { at: [0, 0, 10] } };
const pointer = limb("pointer", { parent: "palm", at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["mcp", "pip"], lengths: [42, 25] });
const nail = limb("nail", { parent: "pointer.tip", at: [0, 0, -2], toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["tilt"], lengths: [6] });
const pointerPosed = pointer.pose({ curl: 0.5 }, palmFrames);
nail.pose({ bend: [20] }, pointerPosed).report.tip;                         // [-30, 113.686, -49.643]
nail.pose({ bend: [20] }, { ...palmFrames, ...pointerPosed.frames }).report.tip;   // [-30, 113.686, -49.643]
```

Passing the posed limb also lets `place(…, { from: "rest" })` see the whole chain at
rest. Merged `frames` objects are fixed frames, so they have no rest pose of their own.

`posed.frames` is one plain frame per joint (`index.mcp`, …) plus `index.tip`. Each
frame is `{ parent?, at, rotate? }`. The base frame has a `parent` only when the limb
has one. These are the same frames that `place` and `world` use.

## Mirroring

`mirror: "YZ"` (or `"XZ"`, `"XY"`) reflects the limb's inputs (`at`, `toward` and
`bendToward`) across that plane of the parent frame. The frames are built right-handed
from the reflected inputs. Thus every frame is still a rigid transform, and `place`
never mirrors a solid. `spread` and `twist` are flipped internally, so the same pose
numbers pose both sides symmetrically. A left arm is the right arm's definition plus
`mirror: "YZ"`:

```js
const right = { at: [30, 0, 0], toward: [1, 0, 0], bendToward: [0, 0, -1], joints: ["shoulder", "elbow"], lengths: [100, 80] };
limb("armR", right).pose({ bend: [20, 40], spread: 10 }).report.tip;                     // [161.934, 23.264, -103.484]
limb("armL", { ...right, mirror: "YZ" }).pose({ bend: [20, 40], spread: 10 }).report.tip; // [-161.934, 23.264, -103.484]
```

**Targets are never reflected.** A `reach` point or a `grip` shape is a position in
part coordinates. For a mirrored target, pass the mirrored point or shape yourself.
`mirror` needs `toward`/`bendToward`, and cannot be used with `rotate`. If a link is not
symmetric, build the left-hand version mirrored in `build`. The limb only places the
links.

## Solid parts: placing links

Build each link the way its joint frame expects it: **its own joint at the origin,
running along +Y, with its bending side toward −Z**. Then
`posed.place(solid, joint)` moves the link into that joint's place in part
coordinates, through every joint above it.

- `joint` is a joint name (`"pip"`), a frame name (`"finger.pip"`) or `"tip"`. The
  default is the base joint.
- `place` makes at most one `rotate(deg, [0, 0, 0], axis)` call (none when the frame
  is not turned) and then one `translate` call. These are calls that a `views` pose may make, so the probe can read
  the pose. `place` also works on any object with those two methods.
- `world(joint)` gives that frame in part coordinates as `{ origin, x, y, z }`
  (the unit axes), with values rounded to 0.001. Use it to anchor other features to a
  joint, or to check a placement in a probe or a test.

**Links built where they print: `from: "rest"`.** A print-in-place part builds every
link in part coordinates, where it prints, which is the limb at rest (every joint at
0). Do not move such a link into its joint frame by hand. Pass `{ from: "rest" }`:
`posed.place(solid, joint, { from: "rest" })` moves the link by that joint's motion
from rest to the pose. The links then need no second statement of where each joint is,
and the limb's `at`, `toward`, lengths and offsets must describe the joints where the
links print. For a limb on a parent limb, pass the parent's posed limb to `pose` (not its
`frames`), so that rest is the whole chain at rest. Rest is every joint at 0 even when a
range excludes 0, and a parent given as plain frames is the same at rest as posed.

```js
derive: (p) => ({
  finger: limb("finger", {
    at: [x, y, r1], toward: heading, bendToward: [0, 0, -1],    // the base pin, where it prints
    joints: ["mcp", { name: "pip", offset: [0, 0, r2 - r1] }, { name: "dip", offset: [0, 0, r3 - r2] }],
    lengths: [l1, l2, l3],
  }).pose({ curl: p.curl }),
}),
parts: {
  middle: {
    build: (k, p, d) => middleLink(k, d),                        // built in part coordinates, where it prints
    views: { print: true, assembly: (s, p, d) => d.finger.place(s, "pip", { from: "rest" }) },
  },
},
```

**The fast-path rule.** Pose the limb in `derive`, and read the limb's pose params
(`curl`, `bend` values, a grip toggle) ONLY in `derive` and in `views` poses. Never read
them in `build`. The links then do not change shape when the pose changes. An animation
that drives one param (`p.curl` from 0 to 1) then moves every link at frame rate and
rebuilds nothing. Lint's `animation-track-rebuilds` note stays silent. Params that
change the structure (link lengths) can be read anywhere, because a change to them
rebuilds the links anyway.

```js
derive: (p) => ({
  finger: limb("finger", { /* … */ lengths: [p.proximal, p.middle, p.distal] }).pose({ curl: p.curl }),
}),
parts: {
  middle: {
    build: (k, p) => link(k, p.middle, true),                 // at the origin, along +Y; never reads curl
    views: { assembly: (s, p, d) => d.finger.place(s, "pip") },
  },
},
```

## Posing by goals: `goals` and `pins`

`reach` and `grip` fit a finger. For an arm, a leg or a hand with a held tool, use
`goals`. A goal says where a point on the limb must be, and optionally which way it
must point. The solver finds the joint values. It uses damped least squares on all the
free joints at once, so it can move a whole chain, not only the pitch joint.

`goals`, `reach` and `grip` are mutually exclusive: a pose takes only one of them.
`bend`, `curl`, `spread` and `twist` still give the joint values the solver starts from.

```js
index.pose({ goals: [{ at: "tip", position: [-30, 137, -64] }] }).report.goals;
// [{ at: "tip", residual: 0, status: "reached" }]
```

A goal is `{ at, position?, aim?, up?, weight? }`:

| field | meaning |
| --- | --- |
| `at` | A joint name, the name of its frame, or `"tip"`. |
| `position` | `[x, y, z]` in part coordinates, in mm. |
| `aim` | A direction. The frame's +Y axis (the way the link points) must turn toward it. |
| `up` | A second direction that fixes the roll about `aim`. With an `aim`, it is made square to `aim`, and it must not be parallel to it. It is matched to the frame's +Z side, the back of the bend (opposite the side a positive bend closes toward). |
| `weight` | How much the goal counts against other goals. The default is 1. |

- A goal needs at least one of `position`, `aim` and `up`.
- A goal at a joint moves only the joints above that joint.
- The solve starts from the joint values you give with `bend` or `curl`, so the same
  parameters always give the same pose. It never starts from the last result.
- Every joint stays inside its range. A ball joint stays inside its cone.
- `couple`ings hold. A follower moves with its leader.
- `goals: []` is legal and poses like `bend` does.
- A limb with a `parent` needs the parent frames, as `reach` does.

### Pins

`pins` is a list of joint names. A pinned joint keeps the value the pose gives it
(from `bend`) and the solver does not move it. Use it to hold the shoulder while the
rest of the arm reaches. A pin on a follower does nothing. A pinned leader holds its
followers.

```js
index.pose({ goals: [{ at: "tip", position: [-30, 137, -64] }], pins: ["mcp"], bend: { mcp: 20 } }).report.bend;
// [20, 50.034, 37.526]
```

`pins` needs `goals`. In the example the pinned mcp stays at 20, and the other joints
do what they can.

### The status of each goal

`report.goals` has one entry per goal: `{ at, residual, aimResidual?, status }`.
`residual` is the position miss in mm. `aimResidual` is the larger of the aim miss and
the up miss, in degrees. It is there only when the goal has an `aim` or an `up`. An
aim-only goal has `residual: 0`. Numbers are rounded to 0.001.

| status | meaning |
| --- | --- |
| `reached` | The position is within 0.01 mm, and the aim and the up are within 0.1 degrees. |
| `too-far` | The position is farther from the first moving joint than the segments can reach. The limb stretches toward it. |
| `conflict` | There are two or more goals, and this goal would be met better if it were the only one. |
| `out-of-range` | None of the above. A joint limit or a cone stops the goal, or the aim cannot be met. |

The order of the tests is `reached`, `too-far`, `conflict`, `out-of-range`.

- **`conflict` is judged for each goal.** The solver solves the goal alone, from the
  same start. If that gives a smaller error than the combined solve, by more than
  0.01, this goal reads `conflict`. Two goals 400 mm apart on a 230 mm arm both read
  `conflict`. One goal can read `conflict` while the other reads `reached`.
- **A miss is never an error.** The limb takes the nearest pose it can reach, and the
  residual says by how much it missed. Always read the status.
- **`report.clamped` means something different under goals.** `reach` clamps a joint to
  its range and says so. The goal solver keeps every joint inside its range by itself.
  So a solved joint that rests on its limit reads `false`. `clamped` is `true` only for
  a value the solver was not free to choose: a pinned value outside its range, a
  follower pushed past its own range, or a ball joint whose swing is past its cone.
  To see that a goal was limited by a joint, read `status`, not `clamped`.
- **Re-targeting from read-back values.** `world()` and `tip` are rounded to 0.001. If
  you feed a rounded pose back in as `position` and `aim` and `up` together, the goal
  can read `out-of-range`. The aim error is weighted 100 times, against a position
  tolerance of only 0.01 mm, so the rounding in the aim is enough to miss. Give `position`
  only, or `aim` only, when you set a new goal from values you read back.

## `aimFromAngles`

A goal with an `aim` needs a direction vector. People think in pitch and yaw.
`aimFromAngles` converts them, and a part and the viewer's rotate rings use the same
function, so they always agree.

```js
import { aimFromAngles } from "partforge/kinematics";
```

`aimFromAngles({ toward, pitch = 0, yaw = 0, roll })` returns `{ aim }`, or `{ aim, up }`
when you give `roll`.

- **Zero is `toward`.** With `pitch` 0, `yaw` 0 and no roll, `aim` is `toward`.
- **Yaw first, then pitch.** Yaw turns the aim about part +Z. Pitch then lifts it toward
  the up side. A positive pitch raises the aim. Angles are in degrees.
- **`roll` turns `up` about `aim`.** The `up` before the roll is part +Z, made square to
  `aim`. When `toward` is vertical, it is +Y.
- A vertical `toward` makes yaw and roll the same turn at zero pitch. Use a horizontal
  `toward`, as the arm does.

```js
aimFromAngles({ toward: [0, 1, 0] }).aim;                              // [0, 1, 0]
aimFromAngles({ toward: [0, 1, 0], yaw: 90 }).aim.map(Math.round);     // [-1, 0, 0]
aimFromAngles({ toward: [0, 1, 0], pitch: 90, roll: 0 }).up.map(Math.round);   // [0, -1, 0]
```

Spread the result into a goal: `{ at: "tip", position, ...aimFromAngles({ … }) }`.

**Roll 0 is the natural roll.** A goal's `up` is matched to the frame's +Z side, the
back of the bend. That is the `up` that `aimFromAngles` gives at roll 0, so
`src/parts/robot-arm.js` passes `roll: p.toolRoll` unchanged, and a `toolRoll` of 0 is
the natural gripper roll with the wrist near 0.

## Handles and Pose mode

Handles let a person pose the part with the mouse. A handle is a draggable point on a
posed limb. A part declares them in a top-level `handles` object. Lint checks every
name (`handle-unknown-limb`, `handle-unknown-param`, `handle-param-count`,
`handle-unknown-joint`, `handle-bad-mode`).

```js
handles: {
  tool:  { limb: "arm", at: "tip", mode: "goal",
           params: { position: ["toolX", "toolY", "toolZ"], aim: ["toolPitch", "toolYaw", "toolRoll"] },
           seed: ["base", "shoulder", "elbow", "wristPitch", "wristYaw", "wristRoll"] },
  index: { limb: "index", mode: "angles", params: ["indexCurl", "indexSpread", "wristPitch"],
           lock: "indexLock" },
},
```

`limb` is a key of the object `derive` returns, and its value is a posed limb. Every
parameter a handle names must be a numeric key of `defaults`.

### `mode: "goal"`

Dragging the handle writes the goal parameters: `position` (three parameters) and,
if declared, `aim` (two parameters for pitch and yaw, three for pitch, yaw and roll).
The part solves in `derive` with `goals`. The goal holds when other parameters change,
for example when the upper arm gets longer.

- **`seed`** lists the joint-angle parameters that `derive` passes to `pose({ bend })`.
  During a drag, the viewer writes the goal, reads the solved joint values, and writes
  them into the seed parameters on the same frame. So `derive` stays a pure function of
  the parameters, and each frame starts where the last frame ended. This is what stops
  the arm from flipping between two solutions. An agent sets only the goal parameters.
  The solve then starts from the saved seed, which gives the same pose every time.
  Keep the seed parameters in a collapsed section. They are saved with the goal.
- Only the `at` point can be grabbed. With `aim`, a set of rotate rings shows on the
  grabbed handle, to tilt the aim.

### `mode: "angles"`

Dragging solves for the listed parameters directly and writes them. The parameters can
be anything the pose reads: a joint angle, a `curl`, a `spread`, a parent limb's wrist
angle. Use it for fingers and legs. Every joint of the limb, and its tip, can be
grabbed, and the grabbed point follows the cursor. A joint below the grabbed point moves
however the listed parameters move it: a `curl` curls the whole finger.

- **`lock`** names a parameter. While it is true, the handle's parameters are frozen in a
  drag of any handle. This includes a parameter that two handles share, such as the
  wrist: a locked finger holds the wrist still.
- Presets still write a locked value. Set presets in the panel. A lock only stops a drag.

### Pose mode

A part that declares `handles` gets a Pose button in the viewbar, beside measure and
sketch. Only one of the three can be on. Pose mode turns picking and measure off.

- **Drag a tip or a joint.** Orbit still works on empty space and gives way to a grab.
- **Click a tip (no drag)** to pin it. A pin is view state, not a parameter. A "Release
  pins" button shows while a pin is set.
- **Rigid parts move live.** A sub-part that the pose only places by matrix moves on every
  frame.
- **A part that must rebuild** fades to a ghost (0.35 opacity) and stays still. A
  skeleton (bones and joints) follows the drag. Nothing is built during the drag. One
  rebuild runs on release, and the new mesh and the full opacity appear in the same frame.
- **One drag is one `onParamsCommit`.** It lists every parameter that changed. A drag that
  changed nothing commits nothing.
- **Escape or a cancel** restores the values from before the drag. A `setParams` from
  the host in the middle of a drag cancels the drag.
- **Out of reach.** The chain stops at the nearest pose it can make. A dashed line runs
  from the tip to the cursor's point and shows the miss in mm. The chain does not jump
  to another solution to catch up.
- **Straight limbs can jump.** A limb whose elbow can go fully straight has no bend to
  push on there. When the goal comes back into reach, the solver may jump to the bent
  pose in one step. `src/parts/robot-arm.js` stops its elbow 10 degrees short of
  straight (`range: [10, 150]`). Do the same for a goal-mode arm.

Pose mode is a pointer tool. The panel sliders drive the same parameters, so keyboard
users lose nothing.

`runtime.pose` is the host's view of the mode: `isEnabled()`, `setEnabled(on)`,
`pinCount()`, `releasePins()` and `handlePoints()` (each shown handle's grab point on the
canvas, in CSS px).

## Posing a part as an agent

Do not edit code to pose a part. Set parameters, and read the probe:

- for an arm, the goal parameters (`toolX`, `toolY`, `toolZ`, `toolPitch`, `toolYaw`,
  `toolRoll`);
- for a hand, `curl` and `spread` per digit, or a preset.

`partforge measure` has no `--params` flag, so it reads `defaults`. To check another pose,
write a small module that changes the defaults:

```text
// far-tool.js
import arm from "./src/parts/robot-arm.js";
export default { ...arm, defaults: { ...arm.defaults, toolX: 380 } };
```

`npx partforge measure far-tool.js` then prints the probe line of the part. The
robot-arm's `tool` probe returns the goal's report, so its one line is:

```text
tool  {"at":"tip","residual":39.916,"aimResidual":6.141,"status":"out-of-range"}
```

At the default goal the same line reads `{"at":"tip","residual":0,"aimResidual":0,"status":"reached"}`.
Read `status` first. If it is not `reached`, `residual` (mm) and `aimResidual` (degrees)
say how far the arm is from the goal. Then change the parameters and measure again. Leave
the seed parameters alone: the solve starts from them, and they are not an input.

## The report

`posed.report` is plain JSON, so a probe can return it unchanged:

- `bend`: the final value of every joint (followers included), in degrees, rounded to
  0.001. A ball joint's value is `{ bend, spread, twist }`. `posed.values` holds the
  same values without the rounding.
- `clamped`: one boolean per joint. It is true when the value requested for that joint
  (directly, through `follow`, or by a solver) was outside its range and was clamped,
  or, for a ball joint, when its swing was past the cone.
- `tip`: the tip in part coordinates. It is absent for a parented limb posed without
  frames.
- `reach` / `grip` / `goals`: these are present only when the pose asked for them (see
  above). Under `goals`, `clamped` has a narrower meaning: see "The status of each goal".

Numbers are rounded to 0.001.

## Edge cases

- **A joint whose range excludes 0 is clamped even when you do not set it.** A joint
  that the pose leaves out starts at 0. If its range does not include 0, for example
  `[10, 40]`, it is clamped to the nearest end, and `report.clamped` is true for it.
  `limb(…, { joints: [{ name: "a", range: [10, 40] }], … }).pose({})` reports
  `bend: [10], clamped: [true]`. Give the joint a value in its range if the clamp is not
  what you want.
- **A joint whose range ends at 0 (`hi = 0`) has nothing to close toward.** Its closing
  end is `range[1]` = 0, which is also its straightest value. Thus `curl` and `grip`
  never move it, and `reach` moves it only when it is the aiming (pitch) joint. To make a joint that closes toward the
  other side, flip `bendToward` and give the joint a positive range. For example, use
  `bendToward: [0, 0, 1]` with `range: [0, 60]`, not `bendToward: [0, 0, -1]` with
  `range: [-60, 0]`. An all-negative range, such as `[-60, -5]`, closes toward
  `range[0]`.
- **A joint that grip skipped reports `skipped: true` and `touched: false`.** Its
  `bend` is its start value, because an earlier joint's contact already holds the limb.
  To find the contact, read `touching` and the closed joints (`skipped: false`). A
  closed joint with `touched: true` at its start value means that the limb was already
  on the shape at the start pose.
- **A requested `bend` outside a joint's range stays `clamped` under grip.** Grip
  starts from that value clamped into range, so `report.clamped` is true for that
  joint whether or not grip then moves it.
- **Grip closes base-first.** The base joint closes until the limb touches the shape,
  and then the next joint closes, and so on. A shape near the base can thus stop the
  base joint early, with the outer joints doing the rest of the wrap. A shape near the
  tip lets the base joint close far, and the closing can stop before the outer joints
  move. If you want a different start, give `bend` or `curl` with the `grip`, because
  grip starts closing from those values.

## Errors

`limb()` and `pose()` throw a `SpecError` (`name: "SpecError"`, `code: "SPEC"`). The
message names the limb, the field and the fix, as `limb "<name>".<field>: <problem>`:

```text
limb "index": use bend or curl, not both
limb "index": use reach or grip, not both
limb "index".bend.dip: dip follows pip and takes no value
limb "x".bendToward: must not be parallel to toward
limb "x".lengths: expected 2 entries, got 1
limb "index": reach needs the frames declared so far — pass them as pose(…, frames)
limb "index": place: unknown joint "pipp"
limb "index".grip.around: node kind "twist" needs the implicit engine — pass a distance function (x, y, z) => mm instead
limb "index".grip.around: distance function returned a non-finite value at [-30, 96, 2]
limb "x".joints[0].offset: the base joint has no previous joint — place it with the limb's at
limb "thumb".bend.ball: a ball joint takes { bend?, spread?, twist? }
limb "thumb".joints[0].range: a ball joint takes cone (its largest swing, in degrees), not range
limb "index": place: from must be "joint" or "rest"
```

Other errors: `lengths`, `r` or a `bend` array of the wrong length, a `range` that is not
`[min, max]` with `min ≤ max`, a zero-length `toward` or `bendToward`, a duplicate joint
name, a `follow` that names an unknown or later joint, an `axis` that is not `"bend"`,
`"spread"`, `"twist"` or a non-zero vector, an unknown `parent` when frames are passed,
a `cone` on a hinge, a `follow` on or of a ball joint, an unknown key in a ball value,
`pose` frames that are not an object, a posed limb or an array of them, and an unknown
field anywhere. `curl` must be from 0 to 1. A distance function that
throws is reported as a `SpecError` on `grip.around`, with the original error as its
`cause`.

`limb()` usually runs in `derive`, so lint reports a throw there as `derive-throws`, with
the message above.

## What lint and verify check

The domain adds no lint rules and no verify metrics. A part's `handles` are checked by
the core `handle-*` lint rules (see "Handles and Pose mode"). Use the ordinary ones:

- lint's view-pose rules and the `animation-track-rebuilds` note confirm that each
  `place` pose is rigid and that a pose param does not rebuild a link;
- `verify.expect._view.overlaps: 0` confirms that the links do not interpenetrate in
  the assembly view, and a `clearance` pair states the running gap at a joint that you
  intend. Without the pair, the gap is a near-miss warning.
- To check other poses, run verify with other params. The `robot-finger` test verifies
  at `curl` 0 and 0.9.

## Worked example: `src/parts/robot-finger.js`

A printed robot finger: three links on pin joints. Each link has a narrow tongue
around its own pin, and a fork whose two cheeks hold the next link's tongue. Read the
whole file. These are the parts that apply to this domain:

```js
import { limb } from "partforge/kinematics";

const RANGE = { mcp: [0, 90], pip: [0, 90], dip: [0, 80] };

derive: (p) => ({
  finger: limb("finger", {
    at: [0, 0, R],                                  // the base pin, one link-radius up
    toward: [0, 0, 1],                              // the straight finger stands up
    bendToward: [0, -1, 0],                         // and curls toward -Y
    joints: [
      { name: "mcp", range: RANGE.mcp },
      { name: "pip", range: RANGE.pip },
      { name: "dip", range: RANGE.dip, follow: { joint: "pip", ratio: 0.75 } },
    ],
    lengths: [p.proximal, p.middle, p.distal],
  }).pose({ curl: p.curl }),
}),
parts: {
  proximal: {
    build: (k, p) => link(k, p.proximal, true),
    views: { assembly: (s, p, d) => d.finger.place(s, "mcp"), print: print(0) },
  },
  // middle → place(s, "pip"), distal → place(s, "dip")
},
views: {
  assembly: {
    label: "Assembly",
    animations: {
      close: { label: "Close", duration: 1.5, tracks: { curl: [[0, 0], [1, 1]] } },
    },
  },
  print: { label: "Print" },
},
verify: {
  process: "fdm-pla",
  expect: { _view: { overlaps: 0, clearance: { "proximal×middle": ">=0.3", "middle×distal": ">=0.3" } } },
},
```

The points to copy:

- **One sub-part per link**, built in its link frame. `print` lays the links flat and
  spaced. `assembly` places each one at its own joint. The proximal link goes at `mcp`,
  the middle at `pip` and the distal at `dip`. A link sits at the joint at its own
  proximal end.
- **`curl` is read only in `derive`**, and `d.finger` is read only in `views`. The
  `close` animation is thus pose-only. `test/robot-finger.test.js` holds this: every
  link's pose probe is trusted, with one `baseHash` across `curl` 0.1 and 0.9.
- **The ranges stop at 90°** because the geometry needs this. Past 90°, a link's square
  end would swing into the fork behind it. Set the ranges from your links' clearances,
  and check them with `verify` at the extreme pose.
- **Check the placement** with `world`. Each link's placed origin is
  `d.finger.world("<joint>").origin`, and the test confirms this for every link.
