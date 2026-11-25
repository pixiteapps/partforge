# Cage authoring tools

Date: 2026-11-24. Status: approved to build ("build all these", 2026-11-24).

## Why

The cage hand took three passes to get right. Most of the time went on things the tools
made hard, not on the hand:

- About 70 of its 330 lines place limbs on the cage: a digit's line read back off its tip,
  one joint stepped sideways, and for the thumb three joints that never move plus a solved
  roll. A 64 mm thumb bone (a real one is 46) hid in that code for two passes.
- Side faces are numbered round a region, so "the back of column 4" was `s(15 - col)`,
  found by listing all 370 faces.
- "Does it build at every pose?" was a throwaway script, written three times.
- The hand was 94 mm across the knuckles and nothing reported it. A cage's width is not the
  smooth body's.

## Goals

- An author places a limb by its joint positions.
- An author picks cage faces by where they face, and shapes a cage with fewer calls.
- One command says which poses of a part do not build.
- The measure report gives the bone lengths and the body's size at each joint.
- The cage hand uses each tool as it lands, and its shape does not change.

## Not goals

- Any change to how a skinned cage moves. `cage.skin` is untouched.
- Mirrored-cage skinning, weight painting, corrective shapes.
- The cloud app. It picks these up with its next partforge bump.

## Never

- A point index in the API.
- A new name where an existing one fits: a joint's own aim is `toward` and `bendToward`,
  the limb's words; a number for `move` means what a number means for `extrude`'s `by`.
- A silent change of the hand's shape. Every hand edit is checked against the cage it
  built before the edit.

## The tools

### 1. A limb from joint points (`partforge/kinematics`)

```js
limb("thumb", {
  points: [pivot, pivot, mcp, ip, tip],        // each joint, then the tip, in part coordinates
  bendToward: THUMB_CURL,
  joints: [
    { name: "abduct", toward: [0, 0, 1], bendToward: [0, -1, 0], range: [0, 70] },
    { name: "oppose", axis: "twist", toward: [0, 0, 1], range: [-98, 22] },
    { name: "mcp", range: [0, 50] },
    { name: "ip", follow: { joint: "mcp", ratio: 0.8 } },
  ],
  r: [26, 26, 19, 18, 18],
});
```

- `points` has one entry per joint, then the tip. It replaces `at`, `lengths` and joint
  `offset`: giving any of them with `points` is an error.
- Each joint's frame has its own aim. Its +Y is, in this order: the joint's own `toward`;
  the limb's `toward`; the direction to the next point; the previous joint's aim. Its bend
  direction is the joint's own `bendToward`, else the limb's.
- So a limb with a `toward` aims every joint the same way, as a limb with offsets does
  today. A limb with no `toward` aims each joint down its own bone.
- A bone with no length and no aim to take is an error that says to give `toward`.
- The last bone must lie along its joint's aim (the tip has no offset). If it does not, the
  error says so and gives the angle.
- A joint's `toward` or `bendToward` without `points` is an error: use them with `points`.
- `mirror` reflects the points and every joint's `toward` and `bendToward`.
- `reach` needs a straight chain. On a limb whose joints do not all share one aim it
  throws, and says to use `goals`.
- Everything else (`pose`, `bones`, `goals`, `grip`, `place`, `flesh`, handles) works as on
  any limb.

### 2. A follower may follow a later joint

`follow: { joint }` may name any other hinge of the limb, not only an earlier one. A joint
that follows a follower takes that follower's value. A loop is an error naming the joints.

### 3. Cage shaping (`k.cage`)

- **Uneven box segments.** An entry of `box.segs` may be a list of widths (mm) that add up
  to `size` on that axis: `segs: [[15, 3, 18.5, 3, 19, 3, 19.5], 1, 3]`. Face ids are
  unchanged (`+z:4,0`). With a mirror, the widths must read the same from both ends.
- **A scale per step.** `extrude`'s `steps` may be a list with one scale per step
  (`steps: [1.1, 1, 0.92]`), each a number or `[sx, sy, sz]`. Each ring is the one before
  it, moved one step and scaled about its own middle. `scale` and a `steps` list together
  are an error. Ids are those of `steps: 3`.
- **Move along the normal.** `move(faces, 1.5)`: a number moves the faces' points along
  the faces' normal, by the rule `extrude`'s `by` uses for a number.
- **Faces by direction.** `faces(prefix, { facing, near })`. `facing` is `"+x"` … `"-z"` or
  `[x, y, z]`: it keeps faces whose normal is within 45° of it. `near` is `[x, y, z]`: it
  orders the result nearest first, by face middle. Either may be used alone.

### 4. Which poses do not build (`partforge measure --ranges`)

`partforge measure <part> [view] --ranges [--random <n>] [--seed <n>] [--json] [--out <file>]`

- It builds the view at a list of poses and reports each one that throws, with the error.
- The poses, in order: the defaults; every ranged control at its `min` and at its `max`
  with the others at their defaults; every ranged control at `min` at once, and at `max` at
  once; then `n` random poses (default 24, seed default 1; the same seed gives the same
  poses).
- A ranged control is one with a finite `min` and `max`. Other controls keep their
  defaults.
- The summary counts failures and, when errors name cage faces, the faces named most often.
- It runs no lint, verify or measure. Exit code 1 only if the part cannot be loaded.

### 5. Bone lengths and body sizes in the measure report

When `derive` returns posed limbs, `measure` adds `limbs`:

```js
limbs: {
  index: {
    joints: [
      { name: "index.mcp", at: [30.8, -8.0, 91.0], length: 42.1, part: "hand", width: 86.2, depth: 24.0 },
      …
    ],
    tip: [43.1, -30.1, 171.8],
  },
}
```

- `at` is the joint's posed position, `length` the distance to the next joint or the tip.
- `width` and `depth` are the size of the body's cross-section at the joint: the plane
  through the joint, square to its bone, cuts the sub-part, and the outline that goes round
  the joint is measured along the joint's bend axis (`width`) and across it (`depth`).
  `part` names the sub-part. A joint no outline goes round has none of the three.
- Numbers are rounded to 0.1 mm.
- A posed limb is any value of `derive`'s result (one level deep, or in an array there)
  that carries `bones`. A limb with a parent is skipped.

## How it fits what exists

- **Skin.** A posed limb's `bones` are read from resolved frames, so a limb from points
  needs no change there.
- **The hand.** Each tool replaces code in `src/parts/cage-hand.js`. The guide's worked
  example is that file, held equal by `test/organic-docs.test.js`.
- **Guides.** `docs/domains/organic.md` and `docs/domains/kinematics.md` describe each new
  option where the old ones are described.

## Dropped

- An offset in a handle's joint map. The hand's one use for it goes away when the cupping
  joint becomes a follower, and nothing else asks for it.
