# k.implicit frame report — design

Status: approved 2026-10-29.
Branch: `feat/implicit-frame-report` (off `feat/implicit`, after #300 and #302 merged).

## Problem

Frame placement is the dominant way LLM authors fail with `k.implicit`. Joints are
declared as a chain of named frames (`{ parent, at, rotate }`, resolved by
`resolveFrames` in `src/framework/geometry/implicit/frames.js`), and an author has to
work out by hand where a chain of rotations lands. In the October review a trial
grip's fingers missed the rod entirely, and nothing in the report could have shown
it. `docs/research/organic-shapes.md` §7c asked for exactly this: "a probe that
reports each frame's axes in world space".

## Goal

An author — usually an LLM in its check loop — can read, in `partforge measure`
output, where every named frame of a `k.implicit` spec ended up in the finished
part (origin and axes) and roughly where each labelled node sits, and compare those
numbers against targets (a rod's axis, a mating feature) instead of guessing.

## Non-goals

- The limb/chain helper (its own design, next).
- Drawing frames in the viewer.
- Assertions on frames in `verify` (probes are report-only; revisit once we see
  how authors use the numbers).
- Exact label bounds (see "Labels").

## API

```js
const f = k.implicitFrames(spec);   // the same spec k.implicit takes; nothing is meshed
```

`k.implicitFrames(spec)` returns a **frame set**: an immutable value with the same
transform methods as a `Solid` —

- primitives: `translate(v)`, `rotate(deg, center, axis)`, `mirror(plane)`,
  `scale(factor, center?)`, with exactly the Solid signatures and defaults;
- sugar: `rotateX/Y/Z`, `rotateAbout`, `along`, `at`, taken from the same shared
  definitions solids use (`solid-sugar.js`'s `SUGAR`), so the two cannot drift.

Each method returns a new frame set. The intended pattern is one placement function
applied to both the solid and its frames:

```js
const place = (x) => x.rotateY(180);
const hand = place(k.implicit(spec));
const lift = [0, 0, -hand.boundingBox().min[2]];
// in a probe:
probes: { handFrames: (k, p, d) => place(k.implicitFrames(handSpec(p))).translate(lift) }
```

A frame set is independent of geometry, so it survives booleans (the hand's nails are
joined on with `k.union`, which would lose anything carried on the solid itself).

Available on both backends: it meshes nothing, so it needs no Manifold. It is pure
and deterministic, so lint's geometry-free probe of builds and probes runs it as is.

## What it reports

`measure`'s probe handling (`resolveProbeValue` in `src/framework/oracle/measure.js`)
recognises a frame set, the way it recognises a Solid or a Shape2D, and writes it out
whole. Otherwise its methods would read as "probe returned a function", and its
nesting would hit the walker's four-level depth cap once a probe wrapped it in an
object. It is recognised by a plain-data marker, never `instanceof`, since a host
may hold two copies of this code. It serializes to:

```json
{
  "frames": {
    "palm":      { "origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1] },
    "index.tip": { "origin": [21.4, 171.2, -38.9], "x": [...], "y": [...], "z": [...] }
  },
  "labels": {
    "index": { "min": [...], "max": [...], "center": [...], "approximate": true }
  },
  "mirrored": false
}
```

- **frames**: every frame the spec declares, in declaration order: its origin and
  unit x/y/z axes in part coordinates after the frame set's transforms. A spec
  with no `frames` reports `{}`.
- **labels**: every node with a `label`, keyed by label. Duplicate labels report the
  union of their boxes.
- **mirrored**: true after an odd number of `mirror` calls. The axes are reported
  as mirrored (a right-handed frame becomes left-handed), so they still match the
  mirrored geometry; the flag says so plainly.
- **Rounding**: every number is rounded to 0.001 (mm, or a unit axis component), and
  −0 is written as 0, so reports diff cleanly.

## Labels

A label's box is the engine's own bounds for that node's subtree (the IR node `box`
from `lowerSpec`, carried to part coordinates through its ancestors and the frame
set's transforms), never a mesh measurement. These bounds are conservative: a smooth
blend pads its box by up to its blend reach, and a rotation of a box widens it. So a
label's box always CONTAINS that labelled shape, can be generous, and is marked
`approximate: true`. Authors who need exact numbers already have the tool: intersect
the solid with a slab in a probe.

Labels come from node bounds, not from assumptions about primitive kinds, so any
future leaf kind (for example the parked generated-mesh `mesh` node) reports with no
change here.

## Errors

- A bad spec throws the same `ImplicitSpecError`, with the same path-prefixed
  message, as `k.implicit` would.
- Bad transform arguments throw the same errors the Solid methods throw
  (shared code).
- Inside a probe, a throw becomes the probe's `{ error }` slot as usual; it never
  breaks the measure report.

## Constraints

- Frames stay plain `{ parent, at, rotate }` data; the report and the coming limb
  helper are layers over them, never a second skeleton format. A future rigger's
  output is then reported through this same path.
- Pure: no clock, no kernel state; the same spec and transforms give byte-identical
  JSON on every machine and backend.
- Computing a frame set must not mesh. It may lower the spec (needed for label
  bounds) but costs at most the compile step `k.implicit` already pays (about 20 ms
  on the hand).

## Testing

- **Frames**: the hand fixture's frames match `resolveFrames` exactly before any
  transform; after `rotateY(180)` and `translate`, each origin equals the same
  transforms applied to the point (and each axis to the direction).
- **Transforms vs the solid**: for a spec with labelled pieces, apply the same
  transform sequence (rotate, translate, scale, mirror) to `k.implicit(spec)` and
  to the frame set; each label box contains that piece's transformed mesh bounds.
- **Mirror**: handedness flips and `mirrored` is true; two mirrors restore it.
- **Sugar parity**: every sugar method on a frame set gives the same result as the
  matching primitive call (shared `SUGAR` — a regression test that it is shared).
- **Measure**: a part whose probe returns a frame set reports the JSON above through
  `measure` (and `--json`); a throwing probe reports `{ error }`.
- **Lint**: `partforge lint` on a part with a frame-set probe raises no
  `probe-throws`.
- **Worked example**: a test reports the index fingertip's world position in the
  hand's fist pose and checks that it lies within the palm's label box — the check
  the October trial was missing.
- **Determinism**: two calls give identical JSON; core on vs off give identical
  JSON.

## Docs

- `docs/KERNEL-CONTRACT.md`: a row for `implicitFrames` (required by
  `test/kernel-contract.test.js`), marked unreleased like `implicit`.
- `docs/ERROR-PATTERNS.md`: an entry for "an implicit part's limbs miss their target
  (fingers miss the rod)": cause, hand-worked frame maths; fix, report the frames
  with a probe and compare against the target.
- The full `k.implicit` authoring guide stays in the later docs PR, which will
  include the placement pattern above.
