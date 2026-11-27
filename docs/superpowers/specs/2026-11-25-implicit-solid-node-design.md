# A solid as a leaf of an implicit tree

Date: 2026-11-25. Status: approved 2026-11-25, with inward offset added at the owner's request. Based on a spike on branch
`claude/solid-field-spike` (uncommitted engine edits plus `spike/solid-field/`), measured
on the development desktop at partforge 0.204.0, print tier, JS engine only.

Revised 2026-11-25 (phase 2): goal 3 and section 4 changed from stitching the solid's own
triangles back in to a sharpen pass in the mesher. Section 4 gives the measurements behind
the change. Waiting for the owner's approval of this revision.

## Why

`k.implicit` can blend, offset, shell, texture and lattice a shape, but only a shape that
was written as an implicit tree. A cage body (`k.subdiv`), an ordinary solid and an import
cannot enter a tree. The organic guide says so: a cage and a tree "join each other only by
ordinary booleans, which leave a sharp seam".

That blocks the uses the owner named as the best ones for implicit surfaces:

- a rounded join between two explicit models, or between a cage body and anything else;
- inner and outer offsets (today `Solid.offset` is a Minkowski sum at about 3 ms per
  triangle);
- a texture or knurl on a body that is not an implicit tree;
- a lattice clipped to a part's shape.

## What the spike showed

A throwaway leaf took a solid's mesh distance (exact nearest-surface distance from the
oracle BVH). Every case built. 0.5 mm grid unless noted. These are the spike's numbers:
the JS engine with no native `MESH` op, on a print-tier kernel. They are not the shipped
numbers; "5. Cost" has those.

| Case | Result | Time |
| --- | --- | --- |
| Rounded join, plate and boss, `union` with `k: 8` | clean blend | 3.2 s |
| Cage body grown out of a post and a base | smooth neck, no seam | 7.0 s |
| Grow by 2 mm (`round`) | volume within 0.13% of `offset(2)` | 4.4 s (`offset`: 31.7 s) |
| Shrink by 2 mm | volume within 0.17% of `offset(-2)` | 3.6 s (`offset`: 31.9 s) |
| Knurl on a plain cylinder (`displace`, 0.35 mm) | works | 5.7 s |
| Noise on a cage body (`detail`) | works | 1.7 s |
| Gyroid inside a skin, clipped to a solid (0.4 mm) | works | 40.5 s |

Two findings shape this design:

1. **Remeshing the whole body damages sharp edges.** The plate's edges and the boss's rim
   came out ragged. The mesh reached within 0.08 mm of the true edge, but it looked rough.
2. **Keeping the exact body away from the change fixes that.** The quadratic blend changes
   nothing farther than `k` from the other body. Taking the implicit mesh only inside a box
   around the join, and the exact union everywhere else, kept every sharp edge. On the flat
   face at the box border the implicit mesh sat exactly on the plane (error 0 over 47,077
   vertices).

## Goals

1. **Any solid can be a leaf.** A `k.implicit` tree accepts a solid built by any op:
   ordinary ops, `k.subdiv`, `k.import`, or another `k.implicit`.
2. **Every existing node works on it.** `union`/`intersect`/`subtract` with `k`, `offset`,
   `onion`, `displace`, the warps, `mirror`, `repeat`, and `detail`. No node gets a
   special case for a solid child.
3. **Sharp edges and corners stay sharp.** Where the field has a sharp edge or corner, the
   mesh has a vertex on it. A flat face of a solid leaf comes out flat, and its edges come
   out straight.
4. **Same bytes with the native core on and off**, as for every other node.
5. **Inward and outward offset, as one node.** A new `offset` node takes a signed
   distance. It replaces `round` in the docs.
6. **Two names added and one retired for the agent.** See "Agent-facing surface".

## Non-goals

- Formulas that read a child's distance (variable blend width, variable wall, morph). That
  is a separate change to `expr`.
- A lattice node, or 2D profile nodes (extrude or revolve of a `Shape2D` as a field).
- Exact STEP for the result. It stays a tessellated solid, as every `k.implicit` result is.
- Pose-drag skinning of a solid leaf. A solid leaf binds to no frame.
- Changing `Solid.offset`. See "Later: offset".

## Anti-goals

- Phase 1 changes no bytes or hashes of any spec that has no solid leaf. Phase 2 does
  change meshes: the sharpen pass runs on every tree, so a box or a sharp `intersect` in an
  existing part gets sharp edges too. The release notes must say so.
- No option that silently changes what shape is built. Goal 3 changes fidelity only: the
  shape is the same field's zero set either way.
- No rule that applies to a solid leaf only. One mesher, one behaviour for every node.
- Part code never passes a function into a spec. The spike's `fn` leaf does not ship.

## The node

```js
const body = k.subdiv(cage);
const post = k.cylinder({ r: 5, h: 22 });
k.implicit({ root: { kind: "union", k: 7, children: [
  { kind: "solid", solid: body },
  { kind: "solid", solid: post },
] } });
```

| kind | required | optional | meaning |
| --- | --- | --- | --- |
| `solid` | `solid` | | The solid's own shape. Its distance is exact: negative inside. |

It takes the common fields (`frame`, `at`, `label`) like any node, so a frame can place it.

Rules:

- The solid is read once, at the call, in its current placement.
- The solid must be closed and non-empty. An empty solid is a spec error that names the
  node's path.
- It is a true distance, so `lipschitz` does not exist on it and its growth bound is 1.
- Its box is the solid's bounds.
- `validateImplicit` (no kernel) accepts the node and checks only that `solid` is a solid.

## The `offset` node

```js
const body = k.import("helmet");
const inner = k.implicit({ root: { kind: "offset", d: -2, child: { kind: "solid", solid: body } } });
const skin = body.cut(inner);   // a 2 mm wall, inside the body
```

| kind | required | optional | meaning |
| --- | --- | --- | --- |
| `offset` | `child`, `d` | | The child's surface moved by `d` mm: out for `d > 0`, in for `d < 0`. `d` must not be 0. |

- The name and the sign match `Solid.offset(d)` and `Shape2D.offset(d)`, which the agent
  already knows.
- `round` is the same node with `d = r > 0`. It leaves the docs and stays accepted, so a
  saved part keeps building. A `round` spec lowers to the same program as before: no byte
  or hash changes.
- No new opcode. It lowers to the op `round` uses today (`ADDC`). The interval rule is the
  same monotone shift, so pruning stays exact.
- The node's box grows by `d` only when `d > 0`. A shrink keeps the child's box.
- The move is exact when the child's field is a true distance: a `solid` leaf, a sphere, a
  capsule, a box. On a blend, an ellipsoid or a warp it is a bound, as `round` is today.
  The guide says so.
- A shrink deeper than the body leaves nothing. That is the existing error, "the shape is
  empty at a … mm grid".

## How it works

### 1. Distance

One BVH per distinct solid, built from its mesh when the spec is compiled. The value at a
point is the distance to the nearest triangle, signed by the angle-weighted pseudonormal of
the nearest feature (face, edge or vertex). That sign is exact for a closed mesh and needs
no ray cast. The spike used ray parity for the edge and vertex cases (about 12% of samples in the plate and boss join)
because the BVH's `closestPoint` does not report the feature. This design adds the feature
to the query's answer, plus one normal per edge and per vertex, computed at build.

### 2. In the engine

- **Lowering** (`ir.js`): a `solid` leaf with `L = 1`, `G = 1`, its box, and a slot in a
  per-spec table of meshes, built the way the texture table is.
- **Interval pass**: `v ± r`, as for a primitive. Pruning is exact for the same reason.
- **Program**: one new op, `MESH dst p slot`. The program format grows by one opcode. No
  existing program's bytes change.
- **Native core**: `native/bvh.cpp` and the implicit evaluator are already in one wasm
  module. The session gains `addMesh` beside `addTexture`, and `MESH` calls the native
  closest-point query. `test/core-parity.test.js` gains solid-leaf cases.
- **Thin features**: the leaf reports no thinnest feature. The grid warning cannot know a
  mesh's wall. `verify`'s min-wall check still runs on the result.

### 3. Identity and caching

- The spec's hash uses the solid's own cache key in place of the object, so two calls with
  the same tree and the same solids hit.
- The sample cache's program identity adds each mesh's digest, as it does each texture's.
- The geometry-free lint probe sees a probe solid with no mesh. It lowers the leaf with the
  probe solid's bounds and skips every rule that needs the field.

### 4. Sharp edges and corners (goal 3)

**What was planned, and why it changed.** The first plan was to stitch: take the implicit
mesh only where the tree changes the surface, and each solid's own triangles elsewhere, by
booleans. A second spike (`spike/exact-faces/`, preview kernel, core on) measured it:

- On a curved face the step at the border is small: 0.010 mm on a cylinder and 0.036 mm on
  a subdivision body at a 0.6 mm grid.
- Where the border crosses a sharp edge there is a visible notch of about 0.2 mm. The
  mesher bevels every sharp edge by about a third of a cell, and the exact edge outside
  the border is not bevelled.
- Each stitch left 115 to 500 zero-height triangles and small ledge faces on the border.
- A hand-drawn region missed a 0.5 mm bulge on the far side of a thin plate. Only an
  automatic region is safe.
- Keeping the exact body and adding only the blend on top removed the notch on outside
  edges, but left 3,100 to 8,800 sliver triangles where the two surfaces coincide.

The bevel is the real defect. With it gone there is nothing to stitch.

**The sharpen pass.** A new mesher stage, after cleanup and the crease cut, before detail.
It is the crease cut's method (crease.js: split an edge at a point moved onto a crease)
with a different test for where a crease is.

1. Each vertex has the field's unit normal at its position. The stage reads the mesh's
   own normals. It never computes normals for the whole mesh.
2. **Edges.** A mesh edge whose two ends' normals are more than `SHARP_ANGLE` apart is a
   candidate. Its crease point is the point nearest the edge's middle on both ends'
   tangent planes, then moved onto the field's zero set as crease.js moves its points. It
   is kept if the field there is within `SHARP_TOL` cells of zero and it moved less than
   `SHARP_MAX_MOVE` cells. A kept point close to an edge end moves that end, as
   `CREASE_SNAP` does. Otherwise it splits the edge.
   - **The density rule.** Each edge belongs to the leaf program of its lower end's
     sparse-grid leaf, and each triangle's area to the program of its lowest vertex. A
     program is dense when it has more than `SHARP_DENSE_PER_CELL` (2) candidates per grid
     cell of its surface area (`2 · n · edge² > SHARP_DENSE_PER_CELL · area2`, where
     `area2` is the sum of the triangles' twice-areas) and more than `SHARP_DENSE_MIN` (400)
     candidates. None of a dense program's candidates is tried. This is decided before any
     field read. Since 0.207 the rule counts area, not edges: a cluster of vertices a hair
     apart adds edges but no area.
   - Why: a texture finer than the grid makes half its edges candidates, and its cleaned
     mesh is already poor. The rule bounds the stage's cost there.
   - Why the floor: a small part is one program, and its candidates per cell grow as it
     shrinks (small boxes under the floor reach 2.5 per cell). A small count costs little
     whatever its density, so a program with few candidates is always tried.
   - What it costs: a fine texture, or facets finer than the grid, stay bevelled as they
     are today. A plain edge elsewhere in the part is still sharpened when its leaves have
     a different program, for example a box away from a knurled solid. A whole-body
     `displace`, or a texture over part of one primitive, shares one program with that
     body, and every edge of that body is skipped.
   - The move is Newton on the two sides of the crease. Each side is read a little way
     along its own plane, away from the other, with six points (central differences).
   - Newton stops when its step is under `1e-5` cells. The point is judged on that read.
   - A candidate whose two sides agree within `SHARP_ANGLE` on each of its first three
     reads, and whose Newton step on the third is not shorter than on the second, is not
     sharp, and stops there. This rule can change the output. It was measured against the
     same stage without it, at 0.6 and 1.0 mm, on the plate (which holds the fade case),
     the bracket, the cylinder, the curved crease, the box, the cage post, and `offset`
     −2 and +2. The output is the same, byte for byte, on all of them: no kept point is
     lost.
   - Moves go first, then splits on edges with no moved end. A snap that cannot be made,
     or that fails its checks, falls back to a split.
   - An edge point carries the two planes of its Newton side gradients, through its own
     position. A moved end carries them too.
   - A change is dropped if a triangle it makes faces against its corners' normals or is
     thinner than 0.001 mm. Then every changed triangle is read against the field at its
     centre, along its normal, at `1e-4` cells and at `0.005` cells each way. The
     candidates behind a triangle that faces against the field are dropped, and the
     commit runs again. The near read catches a centre that sits on a crease of a rough
     field, such as a knurl.
   - **No two vertices at one position** (`SHARP_APART`, 0.001 cells). A split, an end move
     or a corner point is refused when its point lies within `SHARP_APART` cells of any
     other vertex of the mesh, old or placed earlier in the same commit. The vertex a move
     replaces does not count, nor the corner vertex a corner split reuses. The earlier
     candidate in the fixed order keeps its place. The test is a hash grid of cells twice
     `SHARP_APART` wide, asked whether any vertex is near, so no order of the grid decides
     anything. A refused edge change is counted as `apart`. In the corner passes a refused
     try counts as `cornerNear` and the next try is taken. Two vertices at one position can
     weld when the kernel builds the solid and break it.
3. **Corners.** An edge with an edge point at one end, whose two ends carry three distinct
   planes between them, is a corner candidate. It starts at the point where the three
   planes meet. A mesher vertex gives its normal as its one plane. A pinned or crease
   vertex gives none.
   - Since 0.207 the point is then solved on the field. Each step reads each face's
     gradient a little way into that face and moves to where the three faces' planes
     meet, up to `CORNER_STEPS` (12) steps. The first read distance is the farthest seed
     plane's source, at most `CORNER_SIDE_MAX` (0.5) cells. A point is kept if the field
     there is within `SHARP_TOL` cells, it is within `SHARP_MAX_MOVE` cells of the edge's
     middle, and its three gradients are pairwise more than `SHARP_ANGLE` apart. The last
     test refuses a point beside a curved sharp edge, where only two faces meet.
   - Before 0.207 the point was the meeting point of the seed planes. A mesher vertex's
     normal is a rough plane, so that point could lie off the true corner (0.25 mm on the
     hand's palm), and a rim could make a stray corner (10 on the vase at 1.2 mm).
   - Estimates within `0.05` cells of each other are one corner (`CORNER_MERGE`). The
     group keeps the best estimate: the one with the fewest mesher planes, then the one
     whose planes come from farthest away.
   - A corner tries, in order: an end already at the corner; a split of the edge; a move
     of the nearer end; a move of the far end. Each try is checked as an edge change is.
   - A corner vertex is reused only by an edge next to it. An edge that is not next to it
     is refused, so that no two vertices sit at one position.
   - **A second corner pass, across a vertex.** Three creases that meet at a corner need not
     leave two of their edge points side by side: the bevel's own vertices can sit between
     them. Then no edge sees three planes, or only an edge whose third plane is a bevel
     vertex's rough normal. So, after the first pass, a second one takes each edge from an
     edge point v to a vertex u that is not an edge point, and offers v's two planes with
     the two planes of each edge point w that shares a triangle with u (in u's fan order).
     Its candidates must lie within `0.005` cells of the field, not `SHARP_TOL`: their planes
     are all edge points' planes, exact on flat faces, and two tangent lines of one curved
     crease (a rim) meet just off the surface. A candidate within `CORNER_MERGE` of a corner
     the first pass made is not made, and no corner point moves. The tries are the first
     pass's. Where the first pass found every corner, the second changes nothing.
   - The refusal of a corner vertex not next to its edge (`cornerApart`) stays. It is not
     the only path to two vertices at one position. On the knurl at the print grid 0.3 mm,
     two splits on unrelated edges met: the edges share no vertex and no triangle, and lie
     about 0.02 mm apart, mirror images across the plane x = y on either side of a ridge
     on the top cap. Both Newton solves ended on the same ridge point, within 1e-7 mm.
     Three such pairs appeared. The `SHARP_APART` guard above refuses the later split of
     each pair, and it changes no byte on any other measured case. The tests count vertex
     pairs closer than 1e-6 mm on every case, the knurl at 0.3 mm included, and find none.
4. Triangles with one, two or three split edges become two, three or four. A triangle
   left with a repeated vertex is dropped.
5. **A second edge round** runs after corners, on edges with neither end an edge or corner
   point. A corner in place lets a split through that the bevel beside it refused. Its
   candidates are the first round's that passed the judge: their ends did not change, so
   they are not solved again.
6. `untangle` runs after it, as after the crease cut.

A rounded edge is not a candidate once its radius is large enough for the grid to resolve:
neighbouring vertices then differ by less than `SHARP_ANGLE`. A round too small for the
grid fails the `SHARP_TOL` test only when it is larger than about 0.1 cell. Below that it
is drawn sharp.

**Rules it must keep.**

- It never moves a held, pinned or crease vertex.
- A new vertex takes the owner, leaf and frame data that the crease cut gives its new
  vertices, so pose drag and the frame report are unchanged in kind.
- The mesh stays closed and oriented. Edge splits keep it so. The corner pass may drop a
  triangle left with a repeated vertex, and the tests check that the mesh stays closed
  and that no vertex is pinched.
- It makes no flipped or sliver triangle, and leaves no more of either than the mesh it
  was given. It does not repair the mesher's own.
- JS and the native core give the same bytes. It is ported to the core in this phase.
- It runs on every tree and both tiers. It has no option.

**Prototype numbers.** A post-pass in plain JavaScript on the finished mesh
(`spike/exact-faces/sharpen.mjs`), `SHARP_ANGLE` 25°, `SHARP_TOL` 0.05, `SHARP_MAX_MOVE`
1.5. The error is the distance of triangle centres from the exact surface, away from the
blend.

| Case | Grid | 99th percentile before | after | Worst before | after |
| --- | --- | --- | --- | --- | --- |
| Boss near a plate's edge | 0.6 | 0.131 | 0.000 | 0.222 | 0.002 |
| Boss near a plate's edge | 1.0 | 0.280 | 0.000 | 0.361 | 0.002 |
| Boss in an L bracket's inside corner | 0.6 | 0.147 | 0.000 | 0.230 | 0.040 |
| Boss in an L bracket's inside corner | 1.0 | 0.293 | 0.000 | 0.364 | 0.003 |
| Box boss on a cylinder's side | 0.6 | 0.124 | 0.008 | 0.251 | 0.011 |
| Box boss on a cylinder's side | 1.0 | 0.282 | 0.021 | 0.451 | 0.024 |

- It found exactly the plate's 8 corners. On the bracket it found 12 at 0.6 mm (the true
  count) and 14 at 1.0 mm, so two points there are spurious.
- It added 5% to 14% more triangles and took 55 to 660 ms. Most of that time is six field
  calls per vertex for normals over the whole mesh, which the real stage must not do.
- The cylinder's own facets (a few degrees apart) were left alone.
- Every mesh stayed closed and imported as a valid solid.

**What the prototype did not do, and the real stage must.**

- It had no end-snap and no untangle. It left 19 to 54 flipped triangles and 45 to 752
  triangles thinner than 0.001 mm per body. The real stage must make none of either, and
  leave no more than the mesh it was given.
- It took one tangent-plane step. That is exact for flat faces only. A crease between two
  curved surfaces needs the move onto the zero set.
- It left a few stray marks where the plate's edge fades into the blend. There the true
  edge is a round that grows from zero radius. The limits above need tuning on this case.
- It did not run on a cage body, a texture, an `offset`, the print tier, a posed tree or
  the owner path with its own crease vertices.

**Constants.** The five named constants keep their first values: `SHARP_ANGLE_COS`
0.9063077870366499 (25°), `SHARP_TOL` 0.05, `SHARP_MAX_MOVE` 1.5, `SHARP_SNAP` 0.15 and
`SHARP_CORNER_DET` 0.05. The hard cases below passed with them, so none was changed. The
stage's internal values are `CORNER_MERGE` 0.05 cells, `ACROSS_TOL` 0.005 cells (the second
corner pass's field limit), `SHARP_APART` 0.001 cells, the Newton stop `1e-5` cells, three
flat reads, and the flip test's two steps, `1e-4` and `0.005` cells. `SHARP_APART` is 1e-4 mm
at a 0.1 mm grid, far above the 1e-6 mm the tests call coincident, and 50 times below
`CORNER_MERGE`. The native core mirrors every constant as a literal, and
`test/implicit-sharpen-native.test.js` checks that the two agree.

The density limit, 2 candidates per grid cell of area (`SHARP_DENSE_PER_CELL`), was chosen
in 0.207, after cleanup began to merge the mesher's vertex clusters. The rule before it
(`SHARP_DENSE_DIV` 5: dense when more than a fifth of a program's edges are candidates)
counted those clusters' zero-area triangles as edges. With them merged, a clean box 8 cells
wide at 0.6 mm has a share near 0.3 and was taken for dense, so it lost its corners.
Measured per program, in candidates per cell:

- Boxes 3 to 12 cells wide, at 0.6 and 1.0 mm and three offsets: at most 1.26 where a box
  passes the floor (474 candidates, the 8-cell box at 0.6 mm). Under the floor, up to 2.5.
- The hand, the join, the plate, the bracket, the shrink, the box, the cylinder, the curved
  crease, the cage post, `offset` ±2, the posed gap and the spheres: at most 0.42.
- The knurl at the print grid 0.3 mm: 1.32, not dense, so it is sharpened as before.
- Dense: the knurl at 0.6 mm (3.24), a knurled knob of radius 6 mm (4.64) and one of
  radius 1 mm with 619 candidates (6.74). The vase's dense programs are 2.13 to 5.54.
- The vase's least dense program, 2.13 at 0.6 mm, sets the limit at 2. Two vase programs
  the old rule tried are now skipped as dense: 2.31 at 1.2 mm and 2.58 at 1.0 mm. No limit
  keeps both sets as they were.

`SHARP_DENSE_MIN` is 400. Small parts reach a high density: boxes under the floor reach 2.5
per cell. Knurled knobs have at least 619 candidates (a cylinder of radius 1 mm, 0.6 mm
grid). 400 is near the middle of 249 and 619 on a ratio scale. With it every box 3 to 12
cells wide, at 0.6 and 1.0 mm, keeps exactly 8 corners, and a 4 mm boss on a plate keeps
its own corners and edges.

The worst case the floor lets through is a texture with just under 400 candidates. A
knurled cylinder of radius 0.6 mm and height 1 mm at 0.6 mm has 283: the stage takes 62 ms
against 11 ms for the stages before it (546%). It is a small absolute cost. Its mesh is
sound. A knurled knob of radius 6 mm and height 8 mm at 0.6 mm has 11,748 candidates and is
dense: the stage takes 7 ms against 266 ms (2.8%).

**Stage numbers.** JS, preview tier, 0.6 mm grid, milliseconds, median of 3 runs. "Before"
is plan, evaluate, mesh and cleanup. Wall time is the one JS thread. CPU time is the whole
process, so it also counts the garbage collector's helper threads.

| Case | Before (wall) | Stage (wall) | Stage / before | Before (CPU) | Stage (CPU) | Stage / before |
| --- | --- | --- | --- | --- | --- | --- |
| Boss near a plate's edge | 1205 | 255 | 21.2% | 1305 | 388 | 29.7% |
| Boss in an L bracket's inside corner | 1142 | 223 | 19.6% | 1228 | 375 | 30.5% |
| Box boss on a cylinder's side | 635 | 92 | 14.5% | 696 | 142 | 20.4% |
| Knurled cylinder (`displace`) | 1322 | 57 | 4.3% | 1401 | 115 | 8.2% |

- Before this tuning the stage took 816, 655, 323 and 15607 ms of wall time (68%, 59%,
  50% and 1178%). Fewer field reads per point, no second solve in the second round,
  array work without copies, and the density rule made the difference.
- Two more runs of the plate gave 20.4% and 19.8%. The flat rule's added condition (a
  step that is not getting shorter) costs about 40 ms of that: some candidates read on
  where they stopped before, with the same output.
- The target was 10%. 13% to 21% is accepted for ordinary cases. About half of the time
  is field reads (a solid leaf's distance is a BVH query); the other half is the stage's
  own bookkeeping.
- The second corner pass adds about 10 to 25 ms (one more scan of the edges).
- The knurl's 38,936 candidate edges (about half of all its edges) are all skipped by the
  density rule. What is left is one pass over the edges.

**Stage numbers, native core.** The same stage on the core (the SIMD build), against the core's
sample, mesh and cleanup, wall milliseconds, median of 3 after a warm-up.

| Case | Before | Stage | Stage / before |
| --- | --- | --- | --- |
| Boss near a plate's edge | 376 | 68 | 18.2% |
| Boss in an L bracket's inside corner | 348 | 59 | 16.9% |
| Box boss on a cylinder's side | 220 | 30 | 13.8% |
| Knurled cylinder (`displace`) | 397 | 7 | 1.6% |

The `SHARP_APART` guard cost about 2 to 3 points of that share: each round and corner pass
filed every vertex in its grid once. Since 0.207 it files only the vertices near the points it is
asked about (see "Follow-ups (0.207)" below).

**The vase on the core.** The vase test part (`vaseSpec()`, `test/implicit-cleanup.test.js`)
at its 1.2 mm preview grid, core on, wall milliseconds, median of 3 after a warm-up
(measured 2026-11-26). "Before" is plan, sample, mesh and cleanup.

| Case | Before | Stage | Stage / before | Edge points | Corners |
| --- | --- | --- | --- | --- | --- |
| Vase, preview tier, 1.2 mm | 125 | 157 | 125% | 1,157 | 14 |

The stage costs more than everything before it here. The vase's gyroid (`abs` of a formula)
and its `k: 0` intersect have real creases that the grid resolves, so the density rule does
not skip them. In JS the whole build went from 1.07 s to 2.34 s. The rule is not changed for
it. This table is 0.206's. Since 0.207 the vase at 1.2 mm gets no corner point, and one of its
programs is skipped as dense (see the density measurements above).

**A known cost: the knurl at the print grid.** At 0.3 mm the knurl's ridges are resolved. It
has 1.32 candidates per cell, under the limit, so the density rule does not skip it, and it is
sharpened in full. Those points are real creases. The stage then costs about one and a half
times the stages before it. The rule is not changed for it.

| Grid (print tier) | Before | Stage | Stage / before | Edge points | Corners | Triangles |
| --- | --- | --- | --- | --- | --- | --- |
| 0.3 mm | 1716 | 2914 | 170% | 26,356 | 129 | 361,080 to 404,828 |
| 0.6 mm (dense, skipped) | 387 | 7 | 1.7% | 0 | 0 | 82,680, unchanged |

This table is 0.206's. Since 0.207 the knurl at 0.3 mm keeps 56 corners: the other 73 sat
where fewer than three faces meet. Its current cost is in section 5's 0.207 table.

At 0.3 mm the result is sound: no open edge, no pinched vertex, no coincident pair, and no
flip or sliver among the triangles the stage made. The mesher's own flips fall from 3,661 to
3,218 and its slivers from 43 to 41.

**Hard cases.** Tests in `test/implicit-sharpen.test.js`, 0.6 mm grid unless named.

- The fade zone, where the plate's top edge at x = 30 runs into the blend: 35 sharp
  points, each within 0.004 mm of the field (limit 0.03). The longest edge of a triangle
  at one of them is 0.78 mm (limit 1.8). A small zigzag of about one cell stays where the
  box boss's top edge meets the blend on the cylinder case. It was there before this
  tuning.
- A knurl: the density rule skips all its candidates, so it gets no sharp point and stays
  as the mesher left it. The stage takes under 25% of the stages before it (about 4%). The
  cleaned mesh already has 1,084 flipped and 3 sliver triangles by the test's measure.
- A knurled cylinder and a plain box far from it, in one union: the box gets its 8
  corners and sharp edges, and the knurl none.
- A post blended into a subdivision body (`cage-post`): 163 sharp points, all within
  0.002 mm of the post's bottom rim. None on the body.
- `offset` `d: -2` on a box: 8 corners, each on the shrunk box's corner. `d: 2`: no sharp
  point (2 candidates, both not sharp).
- The plate at the print tier's cleanup, 0.3 mm grid: sound, and the 99th percentile
  error away from the blend is 0.000 mm.
- Plain boxes 3 to 12 cells wide, in steps of half a cell, at 0.6 and 1.0 mm, each at
  three offsets against the grid (114 cases): all 114 get exactly 8 corners since 0.207.
  In 0.206, four missed one corner (0.6 mm: 8 and 9 cells; 1.0 mm: 3 and 4 cells; all at
  the offset 0.37, 0.11, 0.73 cells). There the mesher's bevel joined a vertex of one face
  straight to an edge point on the crease above it, so every split or move that put a
  vertex on the corner left a triangle that cut through the solid. Cleanup's cluster merge
  removed that layout, so no edge flip was needed.
- A cut onion box (`intersect(onion(t 0.8, box 30³), z ≤ 5)`) gets its 8 sharp corners (the
  inner box's 4 bottom corners and the 4 where the cut meets its upright edges), and a box
  bent at radius 30 mm gets its 8, at 0.6 and 1.0 mm and both tiers. The onion's outer
  corners are rounded by the onion, so they are not sharp.
- Box minus a through cylinder (`k: 0`) gets exactly its 8 corners at 0.6 and 1.0 mm and
  both tiers, and a torus cut by a plane none. The vase at 1.2 mm gets no corner point
  (10 in 0.206, none of them on three faces), and the knurl at 0.3 mm 56 (129 in 0.206).
- The sharpened plate, bracket and knurl each build as a valid solid with every triangle
  kept, as `k.implicit` builds one.

**What this does not give.** A flat face stays at grid density, not two triangles. A
curved face follows the grid, not the solid's own facets. Both are true today.

**Follow-ups (0.207).** The stage's bookkeeping now follows its candidates. Before, a round did
work over the whole mesh whenever any candidate existed, up to four times (two edge rounds, two
corner passes). On the hand at a 0.8 mm print grid (347 candidates in 264,580 vertices) field
reads were about 1% of the stage. Now the first round tests every edge's angle before it builds
anything, and returns at once when none passes. The apart guard files only the vertices in the 27
cells around each point its commit will ask about; a point it was not built for is answered by
testing every vertex, with the same answer. Re-triangulation subdivides only the triangles on a
split edge and copies the rest in blocks. The corner passes scan only the edge points' fans, and
step 7 finds each retried edge from its own triangles, at the place a full scan would meet it. The
commit loops keep their buffers and put back what a dropped commit moved. The output is the same
on every input, byte for byte: `test/implicit-sharpen-digest.test.js` pins 25 cases (JS and core)
recorded before the change. What is left on the hand is one pass over the triangles for the angle
test and one adjacency build per round and per pass. The vase and the knurl at 0.3 mm gained
less: the vase's stage went from 112% to 94% of the stages before it, and the knurl's from 175% to
161%. There most of the time is solving real creases.

`scripts/bench-implicit.mjs`, CPU milliseconds, median of 3. "Before" is sample, mesh and cleanup
(the hand's crease cut is not counted in it).

| Case | Core | Before | Stage, old | Share, old | Stage, new | Share, new |
| --- | --- | --- | --- | --- | --- | --- |
| Hand, print 0.8 mm | on | 648 | 235 | 36.7% | 46 | 7.1% |
| Hand, preview 1.5 mm | on | 211 | 13 | 6.3% | 5 | 2.4% |
| Hand, print 0.5 mm | on | 1548 | 383 | 24.8% | 102 | 6.6% |
| Boss near a plate's edge, 0.6 mm | on | 391 | 69 | 17.6% | 60 | 15.3% |
| Boss in an L bracket's corner, 0.6 mm | on | 358 | 60 | 16.8% | 54 | 15.1% |
| Two blended spheres, 0.6 mm | on | 31 | 0 | 0% | 0 | 0% |
| Vase, preview 1.2 mm | on | 145 | 167 | 112% | 136 | 94% |
| Knurl, preview 0.6 mm (dense) | on | 411 | 7 | 1.8% | 6 | 1.5% |
| Knurl, print 0.3 mm | on | 1787 | 3097 | 175% | 2885 | 161% |
| Hand, print 0.8 mm | off | 2927 | 813 | 28.0% | 148 | 5.1% |
| Hand, preview 1.5 mm | off | 1097 | 180 | 16.8% | 65 | 5.9% |
| Boss near a plate's edge, 0.6 mm | off | 1302 | 296 | 23.3% | 254 | 19.5% |
| Boss in an L bracket's corner, 0.6 mm | off | 1197 | 311 | 25.4% | 248 | 20.7% |
| Vase, preview 1.2 mm | off | 950 | 1486 | 158% | 1295 | 136% |
| Knurl, print 0.3 mm | off | 5951 | 12551 | 211% | 11581 | 195% |

Each share is against the "Before" of its own runs. The column shows the new runs'; the old runs'
differ by a few percent. Every cell is CPU time. The bench rounds to a millisecond, so the
spheres' stage reads 0 in both runs. A direct wall timing of that stage gives 0.4 ms old and
0.1 ms new, against about 22 and 25 ms of wall time for the stages before it (1.8% and 0.5%).

**Clean rims (0.207).** The mesher puts a cluster of vertices a hair apart where a face lies on a
grid plane, joined by triangles with no area. Cleanup's first pass could merge each vertex only
once, so most of a cluster stayed, and the first relaxation pulled its triangles open into
pleats. Now an edge shorter than 1e-4 of the grid edge merges past that lock, and a merge that
would leave more fold edges around it than before is refused. Fold edges on the cleanup tests'
cases fell from 1,723 to 530. Of the 82 `k.implicit` results of the fold census, 11 still carry
folds as a `solid` leaf (16 before): the tapered cylinder, the 25° wedge and the 40° wedge at
0.8 mm, and the twisted box. The folds left come from two places: the mesher's own folds on a
face that lies on a grid plane, and projection near such a face or at a feature about one cell
thick. Fixing those needs a projection that aims a vertex toward its own face, or a mesher
change; both are left for later. The merge made cleanup slower: up to 10% on the hand at print
0.8 mm and 2.8% over the bench's cleanups. It also lowered the edge count that the old density
rule divided by, which is why the rule now counts area (section 4, step 2).

**Corners solved on their faces (0.207).** Step 3's corner point is now solved on the field from
its three faces and kept only if the three are pairwise past the sharp angle. Box minus a through
cylinder gets exactly its 8 corners, a cut torus none, the vase loses its 10 stray points and the
knurl at 0.3 mm goes from 129 to 56. On the hand's palm, where two of three faces are 24.7° apart
(under the 25° angle), no corner is made; the nearest vertex is 0.012 mm from the true corner, and
the worst vertex of the near-miss sweep went from 0.05 to 0.007 mm off the field. With the core on,
the stage is 1% to 7% slower on the plate, the bracket and the vase. In JS the corner passes
alone take 1.5 to 2 times as long (plate 16 to 26 ms, bracket 16 to 34 ms, vase 13 to 20 ms).

**Blocked corners (0.207).** The plan held an edge flip for a corner the triangle layout blocks.
None was needed: every swept box, a cut onion box and a bent box keep all their sharp corners
after the cluster merge, so no flip was built.

### 5. Cost

- Measured with `node scripts/bench-implicit.mjs --core both` (CPU ms, edge 0.6 mm, the
  development desktop). The native `MESH` op gives the same bits as the JS. The blob
  shrink's body has 2,950 triangles; the script's last lines time `Solid.offset(-2)` on
  it for comparison (about 9.6 s against about 0.47 s for the `k.implicit` offset end to
  end, core on).

  | Case | Core | Compile | Sample | Mesh | Cleanup | Total |
  | --- | --- | --- | --- | --- | --- | --- |
  | Plate and boss join, preview tier | off | 10 | 482 | 32 | 726 | 1250 |
  | Plate and boss join, preview tier | on | 7 | 187 | 7 | 222 | 423 |
  | Plate and boss join, print tier | off | 4 | 514 | 34 | 1732 | 2284 |
  | Plate and boss join, print tier | on | 3 | 176 | 7 | 560 | 747 |
  | Blob shrink, preview tier | off | 24 | 345 | 17 | 565 | 949 |
  | Blob shrink, preview tier | on | 10 | 143 | 4 | 200 | 356 |

- The core makes these cases about three times faster. Sample and cleanup take most of the
  time. Compile includes `buildMeshField`.
- The preview-grid chooser (`preview-edge.js`) weighs a program by its op count. A `MESH`
  op weighs `MESH_OP_WEIGHT × ceil(log2(tris))` (program.js), with `MESH_OP_WEIGHT` 16.
  The weight comes from the times below: `k.implicit` end to end, CPU ms, core on, warm
  field memo, no `preview` set, the median of three runs (measured in Task 9). A
  unit is one leaf unit of the cost model. With a weight of 1, the solid join predicted
  1.19 times the primitive join and took about 4.5 to 5 times as long.

  | Tree | Triangles | Chosen edge | Predicted | ms | µs per unit |
  | --- | --- | --- | --- | --- | --- |
  | Plate and boss join, primitives | none | 0.5 | 4,157 | 150 | 36 |
  | Sphere r 30, primitive | none | 0.5 | 6,723 | 342 | 51 |
  | `offset` 1 over a primitive sphere | none | 0.5 | 7,462 | 386 | 52 |
  | Box 60 × 40 × 6, primitive | none | 0.5 | 2,662 | 75 | 28 |
  | Box solid | 12 | 0.5 | 5,939 | 191 | 32 |
  | Plate and boss join, solids | 12 and 460 | 0.5 | 18,924 | 722 | 38 |
  | Blob shrink | 2,950 | 0.5 | 10,976 | 500 | 46 |
  | Sphere solid r 30 | 3,872 | 0.75 | 14,020 | 520 | 37 |
  | `offset` 1 over the sphere solid | 3,872 | 0.75 | 15,332 | 604 | 39 |
  | Sphere solid (a `k.implicit` sphere) | 53,580 | 0.75 | 16,778 | 795 | 47 |
  | Sphere solid (a `k.implicit` sphere) | 433,914 | 1 | 10,989 | 1027 | 94 |

- The primitive trees cost 28 to 52 µs per unit. Solid leaves up to about 50k triangles
  cost 32 to 47 µs per unit, so the weight puts them in the same range. A weight of 14
  fits the same cases; 16 is the conservative choice.
- A log term does not track a very large leaf. At a fixed 0.6 mm grid, after the weight,
  the 53,580 triangle leaf costs 1.2 times as much per unit as the 3,872 triangle leaf, and
  the 433,914 triangle leaf costs 1.9 times as much. Each build also pays a fixed cost of
  about 0.85 µs per triangle that does not depend on the grid (368 ms for the largest leaf
  at a 3 mm grid). The model does not include it. Without it the largest leaf still costs
  1.7 times as much per unit. So a leaf above about 100k triangles previews slower than
  the budget intends.
- The proposed target was the plate and boss join at the preview tier in under 300 ms with
  the core on. It takes about 420 ms, so it misses the target. This task did no tuning.

**With the sharpen stage (current).** Measured on 2026-11-26 with
`node scripts/bench-implicit.mjs --core both`, after the sharpen stage joined every mesh
(CPU ms, the development desktop, an Apple M1 Max; each cell the median of 3 runs). The
script now times the stage alone, as its own column, on both paths: the core session's
`sharpen` call, or `sharpenMesh` in JS. `Seam` is the crease cut and untangle on the owner
path. "Before" is sample, mesh, cleanup and seam. This table is 0.206's; the 0.207 table
below is the current one. The table above is from before the stage.

| Case | Core | Compile | Sample | Mesh | Cleanup | Seam | Sharpen | Detail | Total | Sharpen / before | Triangles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hand, preview tier, 1.5 mm | off | 4 | 220 | 186 | 643 | 241 | 194 | 225 | 1719 | 15% | 75,408 |
| Hand, print tier, 0.8 mm | off | 4 | 623 | 424 | 1844 | 757 | 817 | 1561 | 6016 | 22% | 537,542 |
| Hand, print tier, 0.5 mm | off | 3 | 1642 | 1013 | 4500 | 1318 | 1649 | 4956 | 15125 | 19% | 1,432,402 |
| Vase, preview tier, 1.2 mm | off | 1 | 294 | 48 | 576 | 0 | 1467 | 279 | 2670 | 160% | 146,804 |
| Plate and boss join, preview tier | off | 11 | 513 | 52 | 738 | 0 | 383 | 0 | 1689 | 29% | 49,884 |
| Plate and boss join, print tier | off | 24 | 511 | 62 | 1665 | 0 | 472 | 0 | 2722 | 21% | 150,274 |
| Blob shrink, preview tier | off | 32 | 342 | 21 | 528 | 0 | 114 | 0 | 1053 | 13% | 23,646 |
| Hand, preview tier, 1.5 mm | on | 3 | 70 | 22 | 116 | 13 | 13 | 17 | 253 | 6% | 75,408 |
| Hand, print tier, 0.8 mm | on | 3 | 201 | 91 | 347 | 89 | 218 | 75 | 1028 | 30% | 537,542 |
| Hand, print tier, 0.5 mm | on | 24 | 508 | 227 | 795 | 187 | 382 | 186 | 2316 | 22% | 1,432,402 |
| Vase, preview tier, 1.2 mm | on | 2 | 67 | 6 | 72 | 0 | 160 | 28 | 334 | 110% | 146,804 |
| Plate and boss join, preview tier | on | 7 | 185 | 7 | 221 | 0 | 49 | 0 | 469 | 12% | 49,884 |
| Plate and boss join, print tier | on | 7 | 197 | 7 | 562 | 0 | 78 | 0 | 851 | 10% | 150,274 |
| Blob shrink, preview tier | on | 18 | 161 | 4 | 201 | 0 | 29 | 0 | 413 | 8% | 23,646 |

- Each Total is the median of the three totals, so a row's cells need not add up to it.
- The vase is the costly case, as above. The hand at its print grid is next: the stage
  takes 30% of the meshing before it on the core and places 225 edge points and 1 corner.
- In the same three runs the blob shrink's `k.implicit` offset −2, end to end, took 464 to
  475 ms, and `Solid.offset(-2)` on the same body 9.2 to 9.3 s.

**0.207 (current).** Measured on 2026-11-26 with `node scripts/bench-implicit.mjs --core both`
at 0.207 (the sharpen stage's local bookkeeping, cleanup's cluster merge, the area density
rule and the corner solve). CPU ms, the same Apple M1 Max, each cell the median of 3 runs.
The columns are those of the 0.206 table above.

| Case | Core | Compile | Sample | Mesh | Cleanup | Seam | Sharpen | Detail | Total | Sharpen / before | Triangles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hand, preview tier, 1.5 mm | off | 4 | 225 | 203 | 762 | 214 | 65 | 238 | 1703 | 4.6% | 75,410 |
| Hand, print tier, 0.8 mm | off | 4 | 623 | 422 | 2247 | 685 | 198 | 1579 | 5759 | 5.0% | 537,518 |
| Hand, print tier, 0.5 mm | off | 3 | 1653 | 1063 | 5197 | 1326 | 372 | 5012 | 14580 | 4.0% | 1,430,878 |
| Vase, preview tier, 1.2 mm | off | 1 | 296 | 50 | 667 | 0 | 1078 | 298 | 2385 | 106% | 146,814 |
| Plate and boss join, preview tier | off | 20 | 494 | 52 | 771 | 0 | 331 | 0 | 1662 | 25% | 48,908 |
| Plate and boss join, print tier | off | 13 | 521 | 62 | 1690 | 0 | 334 | 0 | 2608 | 15% | 147,794 |
| Blob shrink, preview tier | off | 26 | 330 | 16 | 588 | 0 | 121 | 0 | 1121 | 13% | 23,464 |
| Boss near a plate's edge, 0.6 mm | off | 8 | 506 | 60 | 701 | 0 | 272 | 0 | 1542 | 21% | 48,804 |
| Boss in an L bracket's corner, 0.6 mm | off | 15 | 433 | 65 | 734 | 0 | 245 | 0 | 1485 | 20% | 61,142 |
| Knurl, preview 0.6 mm (dense) | off | 8 | 261 | 22 | 1119 | 0 | 29 | 0 | 1434 | 2.1% | 82,702 |
| Knurl, print 0.3 mm | off | 5 | 1226 | 138 | 4908 | 0 | 12577 | 0 | 18901 | 201% | 404,742 |
| Two blended spheres, 0.6 mm | off | 0 | 13 | 11 | 112 | 0 | 0 | 0 | 136 | 0% | 13,568 |
| Hand, preview tier, 1.5 mm | on | 3 | 70 | 22 | 125 | 14 | 6 | 35 | 275 | 2.6% | 75,410 |
| Hand, print tier, 0.8 mm | on | 6 | 203 | 91 | 382 | 82 | 50 | 103 | 918 | 6.6% | 537,518 |
| Hand, print tier, 0.5 mm | on | 24 | 526 | 238 | 870 | 186 | 94 | 219 | 2160 | 5.2% | 1,430,878 |
| Vase, preview tier, 1.2 mm | on | 2 | 68 | 6 | 80 | 0 | 115 | 28 | 300 | 75% | 146,814 |
| Plate and boss join, preview tier | on | 7 | 183 | 7 | 223 | 0 | 46 | 0 | 467 | 11% | 48,908 |
| Plate and boss join, print tier | on | 8 | 196 | 7 | 571 | 0 | 54 | 0 | 841 | 7.0% | 147,794 |
| Blob shrink, preview tier | on | 10 | 142 | 4 | 206 | 0 | 27 | 0 | 390 | 7.7% | 23,464 |
| Boss near a plate's edge, 0.6 mm | on | 3 | 179 | 7 | 216 | 0 | 63 | 0 | 477 | 16% | 48,804 |
| Boss in an L bracket's corner, 0.6 mm | on | 2 | 139 | 8 | 219 | 0 | 58 | 0 | 426 | 16% | 61,142 |
| Knurl, preview 0.6 mm (dense) | on | 2 | 104 | 5 | 322 | 0 | 6 | 0 | 441 | 1.4% | 82,702 |
| Knurl, print 0.3 mm | on | 17 | 382 | 26 | 1406 | 0 | 3080 | 0 | 4904 | 170% | 404,742 |
| Two blended spheres, 0.6 mm | on | 0 | 7 | 2 | 24 | 0 | 0 | 0 | 35 | 0% | 13,568 |

- Against 0.206, with the core on: the sharpen stage on the hand at its print grid fell from
  30% to 6.6% of the meshing before it (218 to 50 ms), at preview from 6% to 2.6%, and at
  0.5 mm from 22% to 5.2%. The vase fell from 110% to 75%; one of its programs is now
  skipped as dense. The join fell from 12% to 11% at preview and from 10% to 7% at print.
- Cleanup is a little slower than in 0.206 on the hand (347 to 382 ms at print 0.8 mm,
  116 to 125 ms at preview), from the cluster merge's fold check. End to end the hand at
  print 0.8 mm went from 1028 to 918 ms with the core on.
- The knurl at 0.3 mm is still the costly case: its creases are real and are sharpened.
- With the core off, the stage's run-to-run swing is wide: on the hand at print 0.8 mm the
  three runs read 198, 211 and 126 ms, and on the join at preview 333, 331 and 239 ms.
- The blob shrink's `k.implicit` offset −2, end to end, took 451 to 464 ms, and
  `Solid.offset(-2)` on the same body 9.3 to 9.5 s. The hand fixture end to end, after a
  warm-up, took 415 ms with the core on and 2193 ms with it off; cold, in a fresh process,
  750 to 779 ms.

## Agent-facing surface

Documented names before and after:

- **Added:** two node kinds, `solid` and `offset`.
- **Retired from the docs:** `round` (still accepted). Net growth: one name.
- **Reworded:** the guide's "The two join each other only by ordinary booleans … Do not
  plan on a smooth join between a cage and a tree" becomes the opposite, with one example.

Nothing else is new: a rounded join is `union` with `k`, a shell is `onion`, a knurl is
`displace`. The agent learns two facts: "a solid can be a leaf", and "`offset` moves a
surface in or out, like `Solid.offset`".

The cloud app's compact prompt has about 68 bytes of headroom under its size ceiling, so
its routing sentence for this must replace words, not add a line.

## Phases

Each is its own PR. Phases 1 and 2 ship in one release: without phase 2, a coarse preview
grid makes every sharp edge of an explicit body look rough.

1. **The nodes.** `offset` (signed, with `round` as its alias). For `solid`: grammar,
   lowering, the pseudonormal sign, the `MESH` op in JS and in the
   core, hashing and sample-cache identity, the lint probe, the preview weight, parity
   tests, and the guide section. Delete the spike's `field` leaf.
2. **Sharp edges and corners.** The sharpen pass in the mesher, in JS and in the core.
3. **Docs and prompt.** The guide's recipes (join, offset, shell, knurl, clipped lattice),
   one reference part, and the cloud prompt sentence with a cloud eval case.

## Later: offset

In the spike (JS engine, print tier), the field offset matched `Solid.offset` within 0.17%
by volume and ran about 7 to 9 times faster on a 4,890-triangle body. As shipped, measured
by `node scripts/bench-implicit.mjs --core on` on a preview kernel: the bench's shrink body
has 2,950 triangles, its `k.implicit` offset −2 at 0.6 mm takes about 465 CPU ms end to
end, and `Solid.offset(-2)` on the same body takes about 9,575 CPU ms. Switching `Solid.offset` to it is
a separate decision, because the results differ in detail: the Minkowski offset keeps
convex edges exactly sharp on a shrink and gives true arcs, and the field gives a grid
mesh. It also left a slightly ragged ring at one concave crease in the spike. Until then,
an `offset` node over a `solid` leaf is the fast route, by the author's choice.

## Open questions

1. Should the sharpen pass run on every tree, as written, or only on a tree with a solid
   leaf? I chose every tree. It is one rule, and a box in a tree deserves sharp edges as
   much as a solid leaf does. The cost is that meshes of existing parts change.
2. Is `solid` the right name for the node, given that `Solid` is also the type?

Settled: inward offset is in, as the signed `offset` node (owner, 2026-11-25).

## Not verified by the spike

- The preview tier, pose drag, STEP export, and an imported scan.
- Any native-core timing.
- The renders were judged by eye. Only the offset volumes and the flat-face error are
  measured.
