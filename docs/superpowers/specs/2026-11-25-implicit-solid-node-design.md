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
     sparse-grid leaf. When more than `SHARP_DENSE` (0.2) of a program's edges are
     candidates, none of that program's candidates is tried. This is decided before any
     field read. A texture finer than the grid makes half its edges candidates, and its
     cleaned mesh is already poor. The cost: a fine texture, or facets finer than the
     grid, stay bevelled as they are today. A plain edge elsewhere in the same part is
     still sharpened, because its leaves have their own program.
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
3. **Corners.** An edge with an edge point at one end, whose two ends carry three distinct
   planes between them, is a corner candidate at the point where the three meet, under
   the same two limits. A mesher vertex gives its normal as its one plane. A pinned or
   crease vertex gives none.
   - Estimates within `0.05` cells of each other are one corner (`CORNER_MERGE`). The
     group keeps the best estimate: the one with the fewest mesher planes, then the one
     whose planes come from farthest away.
   - A corner tries, in order: an end already at the corner; a split of the edge; a move
     of the nearer end; a move of the far end. Each try is checked as an edge change is.
   - A corner vertex is reused only by an edge next to it. An edge that is not next to it
     is refused, so that no two vertices sit at one position.
   - This is the only path known to make two vertices at one position. An edge point lies
     within 1.5 cells of its own edge's middle, on that edge's own crease. Two edge points
     meet only where two creases meet, at a corner, and there the corner pass merges its
     estimates and refuses the case above. The tests count vertex pairs closer than
     1e-6 mm on every case, and find none.
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
stage's internal values are `CORNER_MERGE` 0.05 cells, the Newton stop `1e-5` cells, three
flat reads, and the flip test's two steps, `1e-4` and `0.005` cells.

`SHARP_DENSE` is 0.2. It was chosen from the share of candidate edges per leaf program, at
0.6 and 1.0 mm. Where real edges and corners are (the plate, bracket, cylinder, curved
crease, box, cage post and `offset` −2), the share is 0.015 to 0.122. On the knurl it is
0.314 at 0.6 mm and 0.51 at 1.0 mm. 0.2 leaves room on both sides. The share per single
leaf did not separate the two: a leaf is 4 cells across, so one crease through it already
makes 0.1 to 0.75 of its edges candidates, and knurl leaves range from 0.1 to 1.

**Stage numbers.** JS, preview tier, 0.6 mm grid, milliseconds, median of 3 runs. "Before"
is plan, evaluate, mesh and cleanup. Wall time is the one JS thread. CPU time is the whole
process, so it also counts the garbage collector's helper threads.

| Case | Before (wall) | Stage (wall) | Stage / before | Before (CPU) | Stage (CPU) | Stage / before |
| --- | --- | --- | --- | --- | --- | --- |
| Boss near a plate's edge | 1254 | 268 | 21.4% | 1349 | 452 | 33.5% |
| Boss in an L bracket's inside corner | 1197 | 196 | 16.3% | 1265 | 302 | 23.9% |
| Box boss on a cylinder's side | 641 | 82 | 12.7% | 700 | 109 | 15.6% |
| Knurled cylinder (`displace`) | 1322 | 55 | 4.2% | 1364 | 109 | 8.0% |

- Before this tuning the stage took 816, 655, 323 and 15607 ms of wall time (68%, 59%,
  50% and 1178%). Fewer field reads per point, no second solve in the second round,
  array work without copies, and the density rule made the difference.
- Two more runs of the plate gave 20.4% and 19.8%. The flat rule's added condition (a
  step that is not getting shorter) costs about 40 ms of that: some candidates read on
  where they stopped before, with the same output.
- The target was 10%. 13% to 21% is accepted for ordinary cases. About half of the time
  is field reads (a solid leaf's distance is a BVH query); the other half is the stage's
  own bookkeeping.
- The knurl's 38,936 candidate edges (about half of all its edges) are all skipped by the
  density rule. What is left is one pass over the edges.

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
- The sharpened plate, bracket and knurl each build as a valid solid with every triangle
  kept, as `k.implicit` builds one.

**What this does not give.** A flat face stays at grid density, not two triangles. A
curved face follows the grid, not the solid's own facets. Both are true today.

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
