# Shape2D probe summaries and the `wall` band metric

**Date:** 2026-09-21
**Status:** approved design, not yet implemented
**Origin:** partforge-cloud feedback #95 — an agent spent fifteen edits over two
model families failing to make an L-bend's inner and outer arcs concentric,
declaring it fixed four times. Every claim rested on a render zoomed four
times, where a 3.5 mm arc and a 4 mm arc whose centres differ by 1.5 mm look
concentric. Nothing in the apply report carried an arc centre, a radius, or a
wall thickness other than the minimum. The two features below are the cheapest
numeric channels that would have ended that chat on its first turn.

## Goals

1. Let a part author (human or agent) read the exact arcs and corners of any
   `Shape2D` back out of the measure report, with one probe and no coordinate
   maths of their own.
2. Let a part declare that a wall must stay a constant thickness, and get a
   located warning when it does not.

## Non-goals

- Reporting arcs automatically for every profile a build extrudes. Opt-in per
  part, one probe per question, keeps the report bounded and the intent explicit.
- A 2-D wall-thickness oracle over contours (medial axis, offset distance). The
  band metric reuses the existing ray-cast pass and adds no rays.
- New assertion syntax. `wall` takes the existing range form (`"1.8..2.2"`);
  no `±`.
- Any change to the `near` corner selector or to the `corners()` `index` field.
  Those are the subject of a separate partforge change already in flight.
- Anything on the cloud side beyond passing the new fields through and one
  prompt paragraph (listed at the end so the pin bump is not a surprise).

## Feature 1: a `Shape2D` returned from a probe is summarised

### Today

`resolveProbeValue` (`src/framework/oracle/measure.js`) walks a probe's return
value to depth 4, replaces any Solid (duck-typed on `volume` + `toMesh`) with a
fact object, and passes everything else through as JSON. A `Shape2D` is a class
instance: it is walked as a plain object, yielding its private fields or
nothing useful. A `toContours()` result is plain JSON and passes through, but
its arcs are `{to, via}` three-point segments, so a reader must derive the
centre and radius themselves.

### Change

Add a second duck type beside `isSolid`:

```js
const isShape2D = (v) => v !== null && typeof v === "object"
  && typeof v.toContours === "function" && typeof v.area === "function";
```

A matching value anywhere in the return tree (same depth rule as a Solid) is
replaced by `shapeProbeFacts(shape)`:

```js
{
  kind: "shape2d",
  empty: false,                     // true, with everything else null/[] when isEmpty()
  area,                             // mm²
  bbox: { min: [x, y], max: [x, y] },
  regions: [{ outer: RING, holes: [RING, …] }],
  truncated: false,                 // true when any ring hit a cap below
}
```

where `RING` is:

```js
{
  segments: n,                      // total segment count, before any cap
  arcs: [{ center: [x, y], r, from: [x, y], to: [x, y], sweepDeg, fit? }],
  lines: n,                         // straight segments, count only
  corners: [{ point: [x, y], interiorAngleDeg, convex }],
}
```

- **Arcs** come from the contour IR (`toContours()`), never from tessellation.
  A `{to, via}` segment is exact: centre and radius are the circumcircle of
  `from`, `via`, `to`; `sweepDeg` is signed, positive counter-clockwise. A
  collinear triple (a degenerate arc the IR treats as a line) is counted as a
  line. A cubic segment (`{to, c1, c2}`, what `fillet` emits on the
  curve-adjacent path) is reported as an arc with `fit: "cubic"`: centre and
  radius are the circle through its start, midpoint (`t = 0.5`) and end, so the
  reader knows it is a fit and not a construction. Straight segments are
  counted, not listed.
- **Corners** are `profileCorners(contour)` re-shaped to the three fields the
  reader needs. The `index` field is deliberately not carried: it is the
  contour vertex index, and carrying it here is what invites the
  `{indices}` mistake this report documents.
- **Caps:** 64 arcs and 64 corners per ring; past either the list is cut and
  `truncated` is set on the summary. Chosen against partforge-cloud's
  `MAX_PROBES_JSON_CHARS` bound, which would otherwise drop the whole probe
  with `probe value too large to report`. Numbers are rounded to 1e-4 mm.
- The depth cap and the `{error}` contract are unchanged. A shape that throws
  inside `toContours` is that probe's own `{error}` entry, like any other throw.

### What the reader sees for feedback #95's bend

With `probes: { bend: (k, p, d) => trayPocketAt(k, p, d) }` on the part as
saved, the report carries the merged pocket's outer arc as
`{center: [23.75, -3], r: 4}` and the neighbouring pocket's inner arc as
`{center: [25.25, -4.5], r: 3.5, fit: "cubic"}`. Two centres 1.5 mm apart is
the whole diagnosis, in one apply.

### Docs

`AUTHORING-PARTS.md` "Probes: measuring geometry into the report" gains one
paragraph: return the `Shape2D` itself to read its arcs and corners; when the
question is whether two arcs share a centre, whether a fillet took, or what
radius a corner actually got, read the numbers from the probe rather than a
render. `KERNEL-CONTRACT.md`'s probe row names the new value kind.

## Feature 2: the `wall` expectation

### Today

`minWall()` (`src/framework/oracle/min-wall.js`) casts one inward ray per
sampled surface triangle; the nearest hit is the local thickness; only the
minimum and its location survive the loop. `measure` runs it with the full
sample budget when `partGatesMinWall(part)` says a min-wall expectation or a
DFM profile is declared, else the diagnostic budget. `verify-metrics.js` maps
`minWall` to a `warn` check with `locate`.

### Change

**Expectation.** A new sub-part metric `wall`, range form only:

```js
verify: { expect: { tray: { wall: "1.8..2.2" } } }
```

Any other assertion form (`"<=2"`, a bare number) is a parse-time error naming
the metric, because the membership rule below needs both ends.

**Membership rule.** A ray sample belongs to this wall when its thickness lies
in `[0.75 × min, 1.5 × max]`. Everything outside is another feature (a 1.2 mm
floor under a 2 mm wall, a solid boss) and is ignored. The factors are
constants in `min-wall.js`, documented, not tunable from the part: a part that
needs two bands declares two sub-parts.

**Reported value.** `actual` is the member thickness farthest from the band
(above `max` or below `min`), or, when every member is inside the band, the
member farthest from the band's midpoint. Its sample centroid is the location.
So the check reads as a located deviation:

```
tray · wall 2.62 out of 1.8..2.2 — at (22.8, -2.0, 15.1)
```

and a passing check still reports the worst member, which is what a reader
wants to know. A sub-part with no member at all reports `actual: null` and
`skip` with the message `no wall in band` rather than a pass.

**Where it is computed.** `minWall()` takes an optional `band: {min, max}`
and keeps one more running extreme in the same loop: no new rays, no second
BVH walk, one comparison per sample. Its result gains `band: {value, location,
members}` (`members` = how many samples fell in the window) or `band: null`.
`measure` resolves the band per sub-part from the part's expectations for the
params it is measuring, through a new `partWallBands(part, {params})` in
`gates.js` beside `partGatesMinWall` (expectations may be a per-case function,
so the band is a function of the case; `measure` already resolves `p`/`d`
for that case). A declared `wall` also arms the full sample budget exactly as
`minWall` does. The sub-part facts gain `wall: {value, location, band,
members}` or `null`; `minWallSampled`'s stamp covers both readings.

**Registry.** `verify-metrics.js` adds:

```js
wall: { kind: "warn", extract: (s) => s.wall?.value, locate: (s) => s.wall?.location,
  hint: "wall thickness drifts from the declared band at the reported location — a fillet radius, an offset or a boolean tool there is not tracking the wall",
  note: (s) => sampled/members wording, as minWall's },
```

It is a warning, like `minWall`, because it is a sampled ray reading: a
sampled run can miss the widest spot, never invent one. The lint rule
`verify-unknown-metric` reads the registry, so `wall` is known to lint for
free; `rules-verify.js` gains a check that a `wall` assertion is a range.

### What the reader sees for feedback #95's bend

With `topTray: { wall: "1.8..2.2" }` on the part as saved, `verify` warns
`wall 2.62 out of 1.8..2.2 at (22.8, -2.0, 15.1)` on the very apply that was
declared fixed, and passes with `wall 2.0` once the arcs share a centre.

### Docs

`AUTHORING-PARTS.md` "Self-verification" lists `wall` beside `minWall` with
the membership rule stated in one sentence. `ERROR-PATTERNS.md` gains no
entry: the check's own message is the pattern.

## Testing

Unit tests in partforge, under the existing oracle test files:

- Circumcircle from three points (exact), cubic fit on a `fillet`-produced
  corner (radius within 1e-3 of the requested one), collinear triple counted as
  a line, sweep sign on a CW hole.
- A probe returning a filleted `Shape2D`, a probe returning `{a: shape, b:
  solid}`, an empty shape, and a ring over the cap producing `truncated`.
- `wall`: a fixture built from this report's geometry (an L-shaped pocket with
  2 mm walls whose bend has a 3.5 mm inner arc about one centre and a 4 mm outer
  arc about another) must warn at the bend with a location inside it; the same
  fixture with concentric arcs must pass and report `actual` within the band;
  a fixture whose floor is 1.2 mm under a 2 mm wall must ignore the floor; a
  non-range assertion must throw at parse time naming `wall`.
- Lint: `wall` is a known metric; a `wall: "<=2"` is a lint error.

Both features ride the version bump their PR carries, per the repo's
convention (a release-worthy PR bumps `package.json` itself).

## Cloud follow-through (partforge-cloud, after the pin bump)

- `src/sandbox/protocol.js` `sanitizeMeasure`: pass the per-sub-part `wall`
  object (value, location, band, members). `sanitizeProbes` already bounds
  arbitrary JSON and needs nothing.
- `prompts/authoring-compact-essentials.md`: one paragraph — when the question
  is a 2-D relationship (concentric arcs, a constant wall around a bend, a
  tangent), declare a probe that returns the shape and read the arc centres;
  when a wall must stay constant, declare `wall`; never settle a
  sub-millimetre question from a render.
- Pin bump, `npm run docs:generate && npm run prompt:generate`, read the diff.
- Re-run the headless build of the feedback #95 part with both declarations
  added and confirm the report names the defect.
