# Smooth organic surfaces: a subdivision op, and better tubes and sheets

Date: 2026-11-19. Approved by the owner 2026-11-19. Written against partforge
0.196.0 (`k.implicit`, `partforge/organic`). Evidence comes from the spike on the
partforge-cloud branch `claude/organic-surfaces-spike` (`spikes/organic-surfaces/`), and from
the organic eval cases in partforge-cloud PR 599.

## Addendum, 2026-11-19: creases

Added after the cage was built, at Scott's request. `cage.crease(face | faces)` marks the
border of a face or region as sharp. The smoothing uses the standard sharp-edge rules (a
sharp edge's point is its midpoint; a point on two sharp edges follows the curve through
them; a point on three or more is a corner). A creased body is built as one original ID
per region between creases with the `CREASED_SKIN` policy, so every crease is a hard seam
with an edge line. Left out on purpose: partly sharp creases (their shape would depend on
the tier's level) and a crease along an open chain of edges (it would not separate two
regions, so nothing would shade it hard).

## Why

Organic parts made with `k.implicit` look lumpy. The owner's words: "Implicit parts aren't as
smooth and controlled surfaces as I'd like. They always look kinda lumpy." The eval judges
agree: with the routing rule on, every hand and whale trial used `k.implicit`, and most still
failed the "surfaces flow smoothly" criterion.

The cause is the modelling method, not the mesher. A body is a sum of round primitives, so
its surface is a row of bumps with blends between them. The author controls where the
centres are, not where the surface is.

The spike tried two other ways, one hand and one whale each, authored by a Sonnet agent in at
most six render-and-revise rounds:

| | Plain implicit | Spline tubes (on the implicit engine) | Subdivision cage |
| --- | --- | --- | --- |
| Surface | lumpy | smooth along a limb, blobby where limbs meet | smoothest everywhere |
| Hand | webbed knuckles, bulb wrist | most hand-like | clean fingers, weak thumb and wrist |
| Whale | tail ends in a lump | good body, rippled flukes | best: clean tail and flukes |
| Build | 250–330 ms, 41–52k triangles | 680–750 ms, 24–41k triangles | 15–21 ms, 10–18k triangles |

One trial per cell, judged by eye. It shows direction only. Most flaws in the two new columns
came from gaps in the spike's small APIs, which this design fills.

## Goals

1. **A controlled smooth surface.** An author places a coarse cage of points and gets a
   surface that follows it, with no bumps the cage does not ask for.
2. **Better limbs and fins on the implicit engine.** A limb is one smooth curve with a
   section that can be flattened; a fin or a palm is one sheet, not a row of blended tubes.
3. **An agent can author both.** Errors that name the line or the path at fault, a way to
   read where things are without building geometry, and names the agent can predict.
4. **A measured result before the agent is taught it.** The judges' smooth-flow pass rate on
   the hand and whale cases rises against 0.196, at no loss on the other criteria.

## Non-goals

- True NURBS authoring, trimmed patches, or B-spline surfaces in STEP. A subdivision surface
  is a bicubic B-spline surface almost everywhere, so a later STEP export is possible. It is
  not in this design.
- Smooth blending between a subdivision body and an implicit body. They join with ordinary
  booleans (a sharp seam).
- Frames and skinned pose drag for subdivision bodies. A cage rebuild is tens of
  milliseconds, so a pose slider rebuilds exactly. Cage points are computed in the part's
  own JavaScript from `params`.
- Sharp and semi-sharp creases on a cage. A flat base is a boolean cut.
- Joining two cages (bridging), and cages with holes through them, in the first version.
- Cutting a new ring of faces into an existing cage (a "loop cut"), and placing cage points
  one by one. Both need face and point names that survive the edit, which is its own design.
  The first version gets detail from the box's `segs` and from extrudes in several steps.
- Per-pair blend widths on the implicit engine. Nested unions already give a small blend
  among fingers and a large one into the palm; the Organic guide will say so.

## Anti-goals

- No change to any existing build's output. The pinned implicit hashes and
  `test/core-parity.test.js` stay as they are. New fields default to today's behaviour.
- A subdivision body must never differ in shape between preview and print beyond a small
  stated chord tolerance. No tier may shrink or grow the body.
- No second way to say the same thing. The cage has one form, the builder object, with no
  data-spec twin. `k.implicit` keeps its one form, the data spec. No helper that is only a
  shorthand for nodes that already exist.
- No self-intersecting body reaches an export without an error.

## Approaches considered

1. **A subdivision op, plus tube and sheet upgrades to the implicit engine (picked).** The
   two fit different jobs. A cage gives control of a whole body's surface. Tubes and sheets
   fix the most common implicit parts (limbs, fins) for bodies that still want blends,
   contact and pose drag.
2. **NURBS patches authored directly.** The agent would place control nets per patch and
   keep the patches joined. Branching shapes (five fingers on a palm) need many patches with
   matched edges or trimming. That bookkeeping is where an agent fails. Rejected.
3. **Only improve the implicit engine.** Cheaper. It fixes limbs and fins, and leaves the
   bumps wherever several primitives make one body. Rejected as the whole answer; kept as
   part 1 of this design.
4. **Smooth the implicit mesh after meshing.** No authoring change, but it shrinks the body,
   rounds off wanted detail, and gives no control. Rejected.

## Part 1: tubes and sheets on the implicit engine

### `tube` gains a smooth curve and a flat section

Today `tube` lowers to a sharp union of capsules and round cones (`implicit/ir.js`): straight
runs, a ball at each point on the outside of a bend and a crease on the inside. Three
optional fields are added. A tube with none of them is byte-identical to today's.

| field | meaning |
| --- | --- |
| `curve: "smooth"` | The centre line is a smooth curve that passes through every point (Catmull-Rom), not straight runs. Radii vary smoothly along it. Default `"straight"`. |
| `squash` | One number, or one per point, each in (0, 1]. The section becomes an ellipse: `r` across, `r × squash` along `up`. Default 1, a circle. |
| `up` | An axis (`"x"`, `"y"`, `"z"` or `[x, y, z]`, default `"z"`). It sets the flat direction at the first point; the engine carries it along the curve without twist (parallel transport). Only read when `squash` is set. |

`r` keeps its meaning exactly (one radius, or one per point); my call, because `r: [4, 2]`
on a two-point tube already means a taper, so a pair could not also mean an ellipse.

A smooth circular tube needs no new primitive: the engine samples the curve and lowers it to
the capsules and cones it has (the spike used 8 pieces per span; the builder picks the
count). A squashed section is a new primitive in both the JavaScript path and the native
core. Its field is a scaled distance, so it must be scaled down to stay within the bound the
sampler's pruning assumes (`implicit/primitives.js`), as `ellipsoid` is. `up` parallel to
the curve at the first point is a spec error.

### A new `sheet` node

A thin curved slab: a fin, a fluke, an ear, the flat of a palm.

| kind | required | optional | meaning |
| --- | --- | --- | --- |
| `sheet` | `points`, `t` | | `points` is a grid: at least 2 rows of at least 2 `[x, y, z]` points, every row the same length. The mid-surface is the smooth surface through the grid. `t` is the thickness: one number, or a grid of numbers the same shape as `points`. The rim is rounded. |

The field is the distance to the mid-surface minus half the thickness. How the engine
computes that distance (a triangulated patch behind the existing BVH core, or a closed form
per patch) and how it bounds it for the sampler are the builder's choice. The JavaScript
path and the native core must agree, as for every node. A grid that folds through itself is
not detected; the guide says to keep rows from crossing.

### Not added

`splineTube` and `splineSheet` from the spike are not shipped. They were shorthands; the
fields above replace them.

## Part 2: `k.cage(...)` and `k.subdiv(cage)`

The cage is a builder object (the owner's decision, 2026-11-19). Each step makes faces the
next step has to name or measure, and the spike's agents worked that way: the whale's agent
picked its fluke faces by reading normals between steps.

```js
build: (k, p) => {
  const c = k.cage({ box: { size: [60, 30, 20], center: [0, 0, 0], segs: [4, 2, 1] }, mirror: "xz" });
  const fin = c.extrude("+y:0,0", { by: 12, scale: 0.7 });       // returns the new cap's id
  c.extrude(fin, { by: [-6, 10, 0], scale: 0.4, steps: 2 });
  c.move("+z:1,1", [0, 0, p.hump]);
  return k.subdiv(c);
},
```

- **`k.cage({ box, mirror? })`** returns a Cage. It is plain JavaScript arithmetic with no
  kernel work, so it behaves the same on every backend and under the geometry-free probe
  that lint and the pose check use. That replaces the earlier draft's `k.subdivCage` report
  op: the cage answers questions about itself, with real numbers, everywhere.
- **`k.subdiv(cage)`** is the one kernel op. It returns a Solid, like `k.implicit`: the same
  solid ops afterwards (`cut`, `union`, `translate`, …), one smooth skin (the ORGANIC
  policy), a tessellated solid in STEP. It copies the cage's points and faces when called;
  changing the cage afterwards does not change the solid. Manifold only; on OCCT it throws,
  as `k.implicit` does.

Adding a kernel op named `subdiv` means adding it wherever `implicit` is routed by name:
`KERNEL_OPS` (`geometry/kernel.js`), the hybrid STEP split (`backend-select.js`),
`pose-probe-core.js`, `op-options.js`, and the `implicit-needs-manifold` lint rule. `k.cage`
is not a kernel op and is routed nowhere.

### The Cage

- **Start:** `box` only in the first version: `size`, optional `center` and `segs` (faces
  per side, default `[1, 1, 1]`). Faces are named `${side}:${i},${j}`, `side` one of
  `+x -x +y -y +z -z`, indices rising with the coordinate. The guide states the index order
  for each side.
- **Methods that change the cage** (it is changed in place; my call, because that is the
  form the spike tested):

  | method | meaning |
  | --- | --- |
  | `c.extrude(face, { by, scale?, steps?, id? })` | Grows the face out and returns the new cap's id. `by` is a distance along the normal or an `[x, y, z]` offset. `scale` shrinks or grows the cap about its centre: a number or `[sx, sy, sz]`. `steps` (default 1) makes that many equal segments. `id` names the cap (default: the face's id plus `>`). A list of connected faces is grown as one region and returns a list of cap ids, in the order given. |
  | `c.move(face, [x, y, z])` | Moves the face's points. Neighbours follow. Takes one face or a list. |
  | `c.scale(face, s, { about? })` | Scales the face's points about their centre, or `about`. |

  Side faces of an extrude are `${capId}.s0`, `${capId}.s1`, … (with `steps`, one set per
  segment). Their order follows one stated rule that does not depend on how the cage is
  stored (the spike's order did). The builder picks the rule and the guide states it.
- **Methods that only read:** `c.centroid(face)`, `c.normal(face)`, `c.size(face)`,
  `c.faces(prefix?)` (ids), `c.bounds()`.
- **Errors are thrown by the method that was called**, so the message points at one line.
  Extruding a face removes it; naming a removed face lists the faces that replaced it.
  Because the cage runs under lint's probe, these surface at lint, before any geometry.
- **`mirror`**: `"yz"`, `"xz"` or `"xy"`, a plane through the cage's `center`. The cage is
  always whole and closed. Every change is done twice: on the faces named and on their
  reflections, with offsets and scales reflected. Calls name faces on the positive side
  only; the reflected faces have the same id with `~` added, can be read, and cannot be
  changed directly. Rules that keep the body symmetric:
  - `segs` across the plane must be even, so the plane runs along cage edges and no face
    straddles it. An odd count throws. Changing a face on the negative side throws.
  - A point on the plane keeps only the in-plane part of a move or scale, applied once.
  - An extrude of a region that touches the plane grows across it as one region with its
    reflection, so no wall is left on the plane.

  This is my call. The other reading, model half a cage and weld a copy, leaves the half
  open while it is being built and makes faces on the cut hard to name.

Not included from the spike: `c.nudge(test, offset)`, which moved every point a test picked.
It is point-by-point placement under another name (see Non-goals).

There is no size option in the first version. Each tier has a fixed chord tolerance (how far
a facet may sit from the true surface), and the level is chosen to meet it.

### The surface

- Catmull-Clark subdivision of the closed quad cage.
- After the last level every vertex is moved to its limit position (the standard limit
  stencils), so preview and print lie on the same surface and differ only in facet size.
  This is my call: without it the surface shrinks a little with each level, and a
  measurement would change with the tier.
- The level per tier is chosen from the tier's chord tolerance and an estimate of the
  surface's curvature, capped at 5 levels. With limit positions a few levels are enough: a
  60 mm cage face at 5 levels has facets under 2 mm, and on a 20 mm radius that is a chord
  error near 0.03 mm. The builder sets the two tolerances and records them. A cage that
  cannot meet the print tolerance at the cap gets a warning.
- The surface lies inside the cage. The guide gives the rule of thumb the spike used: a cube
  becomes a ball about 80% as wide; more loops near an edge pull the surface toward it.

### Validity

- The cage must stay closed and every method keeps it so; there is no way to delete a face.
- The result must have positive volume, or the build throws.
- A body that passes through itself is an error at print tier and a warning at preview. This
  is new code: the BVH core has a mesh-to-mesh triangle distance (`oracle/bvh.js`) but no
  self-query that skips neighbouring triangles. The builder measures its cost; if it is too
  slow at preview it may run there at a lower level. The message names the cage faces
  involved.
- No thin-feature warning in the first version. `k.implicit`'s comes from its distance
  field, which a cage does not have.

### Cache, pose and the viewer

- Cached per quality tier on the copied cage (points and faces), like every solid on its arguments.
- No bindings, no deformed preview, no provisional stage. A param change rebuilds. The
  spike's builds were 15–21 ms before the Manifold conversion; the builder measures the
  whole path on the reference part and records it.

## Docs and lint

- Both parts are taught in the Organic guide (`docs/domains/organic.md`): when a cage and
  when an implicit tree (a cage for one continuous skin whose silhouette matters; an
  implicit tree for pieces that blend, press together, or pose by frames).
- `validateImplicit` covers the new `tube` fields and `sheet`. The cage needs no validator:
  its methods throw. No new subpath.
- A reference part: the whale, as a cage. `organic-hand.js` moves its fingers to smooth
  tubes only if its pinned hashes are allowed to change in that PR; otherwise it stays.

## Order and gates

1. **PR 1: `tube` fields.** Small; it touches the JavaScript compile, the native core and
   the validator.
2. **PR 2: `k.cage` and `k.subdiv`**, with the whale reference part and the guide.
3. **PR 3: `sheet`.**
4. **partforge-cloud:** bump, regenerate the prompts, then run the paw, whale and hand eval
   cases against 0.196. The compact prompt has no organic routing sentence today (it was
   taken out of the 0.196 bump). One naming the cage is added only if goal 4 is met. Until then the guide carries it and the agent
   finds it by `read_docs`.

Each partforge PR is useful without the next.

## Left to the builder

- Sample counts for smooth tubes; the sheet's distance method and bounds.
- The exact cage data structure, and the side-face order rule.
- The two chord tolerances, and the cost of the self-intersection check.
- How `sheet` stays within the sampler's distance bound when its thickness varies.
- Whether `k.subdiv` runs in JavaScript only or also in the native core. The spike's
  JavaScript was fast enough; start there.

## Open for the owner

1. **Settled: the cage is a builder object.** Still yours to check: the cage is changed in
   place and `extrude` returns the cap's id, and the solid is made by `k.subdiv(cage)` and
   not by a method on the cage.
2. **Order.** This draft puts the tube fields first because they are cheap and help today's
   hands. The cage is the bigger win for surface quality and could go first.
3. **Is `sheet` in scope now**, or after the eval shows whether the cage already covers
   fins and flukes (it did on the spike's whale).
4. **How `mirror` works.** This draft keeps the cage whole and repeats each op on the other
   side. Say if you would rather model one half.
