# Curve profile helpers: `*Profile` means exact curves

**Date:** 2026-09-28
**Status:** approved design, implemented on `claude/arc-exact-profile-helpers`
**Origin:** partforge-cloud feedback #144. A printed twist-lock lid didn't fit. The
agent had built its bayonet lugs and tracks with `ringSectorPolygon`, which bakes
32 facets per circle into a point list: 4 facets on a 36° lug, about 0.09 mm
inside the true arc at r = 30 mm, on a fit designed with 0.25 mm of clearance.
Asked for finer STL facets, the agent spent about 20 doc searches looking for a
resolution setting that doesn't exist, then traced the arcs itself with a
`Math.cos` loop.

## The problem

A point list is built and exported exactly as it was written. Only curves the
kernel knows about get faceted per quality tier and refined at export: `k.cylinder`,
`k.revolve`'s sweep, and the arcs of a `{start, segments}` path contour or a
`Shape2D`. The round `*Polygon` helpers (`ringSectorPolygon`, `slotPolygon`,
`piePolygon`, `roundedRectPolygon`, `filletPolygon`) and `circleProfile` all return
point lists with a fixed, fairly low count: 32 per circle for most of them, which
is 3.6× coarser than the preview's own 116. Nothing in their names or docs says so,
and the docs listed them beside `pathProfile().arcTo` as ways to build curves.

## Goals

1. Round outlines built with partforge's own helpers export smooth: faceted per
   tier by the kernel, refined at export, true CIRCLE edges in STEP.
2. The vocabulary an agent sees does not grow. One naming rule carries the
   distinction: **`*Profile` = exact curves, `*Polygon` = straight edges.**
3. Saved parts keep building exactly as before.
4. A hand-sampled arc coarse enough to show in a print is reported at build time.
5. A partial revolve stops spending a whole circle's segments on its sweep.

## Non-goals

- Changing what the `*Polygon` helpers return. Saved parts map, index and offset
  those arrays, and pass them to `sweep`/`hull`/`loft`, which treat curves differently.
- Hidden state on returned arrays (arcs riding a point list as a secret property).
  Considered and rejected: an author can't see it, and a `.map()` loses it silently.
- Re-rounding arbitrary point lists that happen to look like sampled arcs. That
  would also round off polygons drawn on purpose.
- A curve version of `ellipsePolygon` (an ellipse has no circular-arc form).
- Curve handling in `loft` and `sweep`, which sample curve rings at their own LOD.

## Design

### 1. Four curve twins

In `src/framework/geometry/polygon.js`, beside `roundedProfile`:

| New | Twin | Outline |
| --- | --- | --- |
| `ringSectorProfile(innerR, outerR, arcDeg)` | `ringSectorPolygon` | annular sector from 0 to arcDeg |
| `pieProfile(tipR, arcDeg)` | `piePolygon` | circular sector from the origin |
| `slotProfile(length, r)` | `slotPolygon` | stadium, centres `length` apart (0 = circle) |
| `roundedRectProfile(w, h, r)` | `roundedRectPolygon` | rectangle, corners clamped to min(w,h)/2 |

Each returns a `{start, segments}` path contour of lines and three-point arcs
(`{to, via}`, the `via` at the arc's midpoint, so an arc cannot flip), closed
explicitly on its start, with no zero-length segments. It traces the SAME outline
as its twin: same start point, same CCW direction, same extent. Swapping one for the
other never moves a part; it only makes the arcs exact.

`filletPolygon` already has its curve twin, `roundedProfile`.

Inputs are validated with the helper's own name in the message:
`0 < arcDeg < 360`, `0 < innerR < outerR` (innerR 0 points at `pieProfile`),
`tipR > 0`, `r > 0`, `length ≥ 0`, `w, h > 0`.

### 2. The `*Polygon` round helpers leave the docs

`ringSectorPolygon`, `slotPolygon`, `piePolygon`, `roundedRectPolygon` and
`filletPolygon` stay exported and behave exactly as before. They are marked
`@deprecated` in `types/geometry.d.ts`, pointing at their twin, and are removed
from `AUTHORING-PARTS.md`'s helper lists and examples. The examples are rewritten
to the curve twins. `regularPolygon`, `hexPolygon`, `starPolygon` and
`ellipsePolygon` stay documented: they are straight-edged by nature, and
`ellipsePolygon`'s doc line says it is a fixed 48-point list.

### 3. `circleProfile` stays a point list: the rule's one named exception

Its name already promises a curve, so the rule would be cleanest if it returned one.
A scan settled against it. Of the 68 public forges on www.partforge.ai (all cloned
anonymously, 2026-09-28), six call `circleProfile`, and one live forge maps its
result directly (`circleProfile(r).map(([x, y]) => …)`) to reshape `loftSmooth`
sections; a `{start, segments}` return would throw there. It is also partforge's
standard profile for a `sweep` tube and a `hull` input, and `sweep` takes point lists
only. Changing it would break a user's forge and pull `sweep`, `hull`, `loft` and
`offsetPolygon` into the change.

So `circleProfile` keeps returning its 48-point list. The docs name it as the rule's
one exception and say what it is for: a sweep profile or a small hole (within 0.05 mm
of round up to a 23 mm radius). An exact circle in a 2-D profile is `slotProfile(0, r)`
(its documented length-0 case), and a round solid is `k.cylinder`. The warning in 5 flags a large one. The
"`circleProfile` is a cylinder" doc line is corrected, and `KERNEL-CONTRACT.md` states
the exception beside the naming rule.

### 4. `revolve` accepts a path contour or a region

`k.revolve` used to refuse a `{start, segments}` contour with "lift it with
`k.shape2d` first". `finishKernel` now lifts a contour, or an `{outer, holes}` region
(which `RevolveOptions` already promised), to a `Shape2D` before the spec-wrapped op
runs, the same way `extrude({ bevel })` is desugared. So a curve helper works
everywhere a point list does, and the lathe gets the `Shape2D` path: profile arcs at
the double-curvature count, true arcs on OCCT.

Both `k.revolve({ profile: contour })` and `k.revolve(contour, { degrees })` lift.
A lone `k.revolve(contour)` does not. By KERNEL-CONTRACT's normative rule, a single
plain-object argument is options form, and the lint probe applies that rule too. A
kernel that accepted the lone contour would build a part that lint rejects, and the
cloud loader blocks on lint errors. The kernel and lint refuse it identically.

### 5. Sampled-arc build warning

`profile-warnings.js` gains `worstSampledArc(ring)` and
`sampledArcMessages(prefix, profile)`. A run is three or more consecutive edges of
equal length meeting at equal turns of at most 20°: equal chords at equal turns lie
on one circle, and the turn is the angular step. The run is reported when its chord
sagitta exceeds 0.05 mm. One message per profile names the worst run's radius,
facet angle and error, and points at the `*Profile` helpers and `pathProfile().arcTo`.

It examines point-list rings only (outer and holes), never a path contour or a
`Shape2D`. The warner runs it only for ops that pass `{ sampledArcs: true }`:
`prism`, `extrude`, `revolve` and `k.shape2d`, where a curve would be refined
instead. `loft` and `sweep` don't ask, because the advice wouldn't hold there. The
existing dedupe applies, so six placements of one lug are one line, and at most
three sampled-arc lines are recorded per build (each names its own radius, so dedupe
alone doesn't bound them).

The run's end facets may be shorter than its interior ones: an offset or a boolean
trims them but leaves the turns alone, which is exactly the clearance-shrunk lug.
Lengths and turns tolerate about 0.01 mm of point noise (coordinates rounded with
`toFixed(2)`, or passed through a transform). A two-facet arc isn't reported,
because one turn between two edges can't be told from a bend.

Compositions that tessellate curves themselves don't blame the author. `hull`
lifts its result through the trusted `k.shape2d` path, since a convex hull can't
cross itself. A bevelled `extrude` and `screwSweep` run inside `warn.quietArcs`, and
the bevel checks the author's own outline for sampled arcs up front.

At 0.05 mm: the 32-per-circle helpers warn above about a 10 mm radius,
`circleProfile`'s 48-gon above about 23 mm. Hexagons, octagons and 12-gons (turns
over 20°), small holes, and dense hand loops (1.5 points per degree: 0.0005 mm)
stay silent. Accepted: a deliberate 24-gon at a large radius warns.

### 6. Partial revolve

Manifold takes a revolve's segment count as the slice count for the sweep it is
given. So a 36° revolve got a full circle's 116 slices: 932 triangles where 100
carry the same facet angle. The default count is now
`max(3, ceil(full × |degrees| / 360))`; below 3, Manifold substitutes its own default.
An explicit `segs` (mesh-fillet's blend tools, which rely on exact counts) is left
as given. OCCT is exact and unaffected.

### 7. Docs

In `AUTHORING-PARTS.md`:
- The profiles section leads with the naming rule and the curve helpers.
- "Preview vs print quality" says a point list exports exactly as written.
- The "never sample an arc by hand" bullet names the curve helpers and says the
  facets of a sampled arc are frozen.
- The "`circleProfile` is a cylinder" line is corrected (see 3).
- The reference parts `nameplate.js` and `bracket.js` move from `roundedRectPolygon`
  to `roundedRectProfile`, because agents read the reference parts as examples.
  None of the reference parts trips the new warning at its defaults.

`ERROR-PATTERNS.md` gains `profile-sampled-arc`. `types/geometry.d.ts` declares the
new helpers.

## Testing

- `test/curve-profile-helpers.test.js`: each twin is a path contour, starts and
  closes where its `*Polygon` twin starts, is CCW with the exact analytic area,
  contains its twin's box, has no zero-length segment, degenerates cleanly (a
  0-length slot, a fully clamped rect, r = 0), and validates its inputs.
- `test/curve-profile-kernel.test.js` (Manifold, both tiers): the twin is faceted at
  the circle rule and refined at print, while the `*Polygon` keeps its 9°; volumes
  are exact; a contour revolves exactly as its `k.shape2d` lift in both forms; a
  partial revolve gets `ceil(116 × deg/360)` slices; an explicit `segs` is honoured.
- `test/curve-profile-occt.test.js`: exact volumes and CIRCLE edges in STEP;
  `revolve` of a contour.
- `test/profile-warnings-pure.test.js`, `profile-warnings.test.js`,
  `profile-warnings-occt.test.js`: the message contract, the quiet cases, the
  per-op opt-in, dedupe, and both backends emitting the shared pure function's text.

## Release and downstream

A minor release (0.131.0), since it adds API and a new build warning. After it
publishes, a partforge-cloud PR bumps the pin, regenerates the doc corpus and
prompts, and rewrites the compact prompt's curve paragraph (partforge-cloud #376's
stopgap) to the naming rule.

## Residuals

- `circleProfile`'s name keeps promising a curve it doesn't deliver (see 3). A
  future breaking release could turn it into a curve once `sweep` accepts contours.
- Existing parts are not changed. They keep their facets until they are edited
  onto the curve helpers; the warning surfaces the coarse ones on their next build.
- On OCCT-routed parts, a true-arc cutter at exactly the radius of a revolved face
  is a coincident face, which the exact kernel handles badly (a faceted cutter
  used to miss it by accident). Manifold is unaffected.
