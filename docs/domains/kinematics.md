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
3. **Output.** The posed limb has `place(solid, joint)`, `world(joint)`, `frames`,
   `values` and `report`, and `flesh()` and `attach()` for a `k.implicit` body (see
   "Organic bodies").

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
| `joints` | Required. A non-empty array, base first. An entry is a joint name, or `{ name, axis?, length?, range?, follow?, type? }`. |
| `lengths` | One length per joint, in mm: from that joint to the next joint, and from the last joint to the tip. Alternatively, give each joint its own `length`. If you give both, they must agree. |
| `toward` | The direction the straight limb points. Required unless you use `rotate`. |
| `bendToward` | The side a positive bend curls toward. Required unless you use `rotate`. |
| `at` | The base joint's position, in the parent frame (or part coordinates). Default `[0, 0, 0]`. |
| `parent` | The name of a frame the limb hangs from. Omit it for part coordinates. See "Limbs on a parent frame". |
| `r` | Radii, one per joint and then the tip (`joints.length + 1` entries). Only `grip`, `flesh` and `attach` use them. |
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
- **`type`**: only `"hinge"`.
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
| `bend` | Degrees per driven joint (followers are skipped). Use an array in joint order, or an object keyed by joint name, such as `{ pip: 60 }`. A joint that the object leaves out stays at 0. A positive value bends toward `bendToward` and a negative value bends away (hyperextension), whichever way the limb points. For a joint whose `axis` is not `"bend"`, the value turns about that joint's axis. |
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
    `implicitDistance(node)` from `partforge/geometry` makes one from any `k.implicit`
    node (see "Organic bodies").
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

`posed.frames` is one plain frame per joint (`index.mcp`, …) plus `index.tip`. Each
frame is `{ parent?, at, rotate? }`. The base frame has a `parent` only when the limb
has one. These are the same frames that `place` and `world` use, and they go straight
into a `k.implicit` spec (see "Organic bodies").

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

## Organic bodies

For a body built with `k.implicit` (a hand, a paw, a creature's leg), the limb writes the
spec's frames, flesh and joins for you. It still builds no geometry: `frames`, `flesh()`
and `attach()` are plain data that you put in the spec, and `k.implicit` validates and
meshes it. See `docs/AUTHORING-PARTS.md` for the `k.implicit` grammar.

- **`posed.frames`** are in `k.implicit`'s own frame shape. Put them in the spec's
  `frames` with the parent frame they hang from: `{ ...palmFrames, ...posed.frames }`.
  A node with `frame: "index.pip"` then sits in that joint's frame (its joint at the
  origin, along +Y). `k.implicitFrames(spec).report()` reports each of these frames with
  the same numbers that `posed.world(joint)` gives.
- **`posed.flesh({ r?, blend?, label? })`** is a `union` with `k: blend` of one tapered
  capsule per segment. Each capsule is in its joint's frame, runs from the joint to the
  next joint (or the tip), tapers from that joint's radius to the next one, and is
  labelled with the joint's frame name. A zero-length segment gets no capsule. `r`
  defaults to the limb's own `r`, and `label` to the limb's name. Without an `r`, or on a
  limb whose segments all have zero length, it throws. `blend` is the union's blend
  width in mm; when you leave it out the union is sharp (a hard union, and no `k` key is
  written).
- **`posed.attach(label, { k?, radius?, band?, r?, a? })`** is a contact `attach` entry
  that joins the flesh (labelled `a`, default the limb's name) to the piece labelled
  `label`, near the base joint. `k` is required: the blend width in mm where the limb
  joins `label`, a finite number that is 0 or more. `radius` defaults to a third of the first segment that
  is not zero-length. `band` defaults to 3 mm × `r[0]` / 9.5, from `r` or the limb's own
  `r`. Without either `band` or an `r`, or on a limb whose segments all have zero length,
  it throws.

```js
const palmFrames = { palm: { at: [0, 0, 0] } };
const onPalm = limb("index", {
  parent: "palm", at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: ["mcp", "pip", "dip"], lengths: [42, 25, 22], r: [9.5, 8.5, 7.4, 6.4],
});
const curled = onPalm.pose({ curl: 0.4 }, palmFrames);
curled.flesh({ blend: 3 });
// { kind: "union", k: 3, label: "index", children: [
//   { kind: "capsule", frame: "index.mcp", b: [0, 42, 0], r: [9.5, 8.5], label: "index.mcp" },
//   { kind: "capsule", frame: "index.pip", b: [0, 25, 0], r: [8.5, 7.4], label: "index.pip" },
//   { kind: "capsule", frame: "index.dip", b: [0, 22, 0], r: [7.4, 6.4], label: "index.dip" } ] }
curled.attach("palm", { k: 8 });   // { a: "index", b: "palm", near: "index.mcp", radius: 14, band: 3, k: 8 }

// In build, with the posed limb from derive: a palm and a finger, joined by a contact.
const hand = k.implicit({
  frames: { ...palmFrames, ...curled.frames },
  root: {
    kind: "contact", gap: 0, attach: [curled.attach("palm", { k: 8 })],
    children: [
      { kind: "box", frame: "palm", size: [80, 100, 26], round: 8, label: "palm" },
      curled.flesh({ blend: 3 }),
    ],
  },
});
```

Pose the limb in `derive`, as for solid links. But a `k.implicit` body is one solid, not
a set of placed links, so a pose change rebuilds it: there is no fast path for its pose.

**Gripping an organic shape.** `grip.around` takes the plain shapes listed under "grip".
For any other `k.implicit` node (a blended union, a warp, a `round`), pass
`implicitDistance(node)` from `partforge/geometry`. It is the implicit engine's own
distance function for that node, in part coordinates, so the node must not name a
`frame`:

```js
import { implicitDistance } from "partforge/geometry";

const handle = { kind: "union", k: 4, children: [rod, { kind: "sphere", r: 12, at: [-30, 130, -22] }] };
index.pose({ grip: { around: implicitDistance(handle) } }).report.grip;
// { touching: true, gap: 0, joints: [{ joint: "mcp", bend: 5.506, touched: true },
//                                    { joint: "pip", bend: 35.421, touched: true }] }
```

## The report

`posed.report` is plain JSON, so a probe can return it unchanged:

- `bend`: the final value of every joint (followers included), in degrees, rounded to
  0.001. `posed.values` holds the same values without the rounding.
- `clamped`: one boolean per joint. It is true when the value requested for that joint
  (directly, through `follow`, or by a solver) was outside its range and was clamped.
- `tip`: the tip in part coordinates. It is absent for a parented limb posed without
  frames.
- `reach` / `grip`: these are present only when the pose asked for them (see above).

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
limb "index".grip.around: node kind "twist" needs the implicit engine — pass a distance function (x, y, z) => mm instead; implicitDistance(node) from partforge/geometry makes one
limb "index".grip.around: distance function returned a non-finite value at [-30, 96, 2]
```

Other errors: `attach` without a `k`, `flesh` or `attach` on a limb with no segment
longer than zero, `lengths`, `r` or a `bend` array of the wrong length, a `range` that is not
`[min, max]` with `min ≤ max`, a zero-length `toward` or `bendToward`, a duplicate joint
name, a `follow` that names an unknown or later joint, an `axis` that is not `"bend"`,
`"spread"`, `"twist"` or a non-zero vector, an unknown `parent` when frames are passed,
and an unknown field anywhere. `curl` must be from 0 to 1. A distance function that
throws is reported as a `SpecError` on `grip.around`, with the original error as its
`cause`.

`limb()` usually runs in `derive`, so lint reports a throw there as `derive-throws`, with
the message above.

## What lint and verify check

The domain adds no lint rules and no verify metrics. Use the ordinary ones:

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
