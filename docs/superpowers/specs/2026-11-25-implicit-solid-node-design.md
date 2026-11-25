# A solid as a leaf of an implicit tree

Date: 2026-11-25. Status: approved 2026-11-25, with inward offset added at the owner's request. Based on a spike on branch
`claude/solid-field-spike` (uncommitted engine edits plus `spike/solid-field/`), measured
on the development desktop at partforge 0.204.0, print tier, JS engine only.

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
oracle BVH). Every case built. 0.5 mm grid unless noted.

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
3. **Faces the tree does not change stay exact.** Where the result's surface is one
   solid's own surface, the output uses that solid's own triangles, sharp edges included.
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

- No change to the bytes or hashes of any spec that has no solid leaf.
- No option that silently changes what shape is built. Goal 3 changes fidelity only: the
  shape is the same field's zero set either way.
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

### 4. Keeping unchanged faces exact (goal 3)

The interval pass already knows, per block, which leaves can affect the field there. Call a
block a **passthrough** for solid S when its pruned program is S's leaf alone, with only
rigid placement and `union`/`intersect`/`subtract` above it. In such a block the result's
surface is S's surface (reversed, if S is a subtracted child).

The build then is:

1. Mesh the tree as today.
2. Collect the blocks that are not a passthrough and that hold surface. Merge them into a
   small set of boxes, padded by one cell. This is the **changed region**.
3. Output = (implicit mesh inside the changed region) joined with (each solid's own
   passthrough part outside it), by ordinary booleans.

A tree with no passthrough blocks (an `offset`, `onion`, `displace` or warp over everything)
skips steps 2 and 3 and is today's path.

This is the automatic form of what the spike did by hand with one box.

**Risk to settle first.** At the border of the changed region the implicit mesh meets the
exact faces. On a flat face the spike measured no step. On a curved face the solid's own
mesh is flat facets, so the field's surface is those facets, but the grid mesh can cut a
facet crease and sit off it by a small amount. The implementation must measure that step
on a cylinder and a subdivision body before the stitching is built on. If it is visible,
the fix is to snap border vertices onto the solid's own mesh.

### 5. Cost

- The spike's times are JS and are an upper bound. The native path must be measured before
  any number is promised.
- The preview-grid chooser (`preview-edge.js`) weighs a program by its op count. A `MESH`
  op needs a weight that grows with the mesh's triangle count (about log n), measured, so
  the automatic preview grid stays inside its budget.
- My proposed acceptance target, to confirm by measurement: the plate and boss join at the
  preview tier in under 300 ms on the development desktop with the core on.

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
2. **Exact unchanged faces.** The border measurement, then the passthrough stitching.
3. **Docs and prompt.** The guide's recipes (join, offset, shell, knurl, clipped lattice),
   one reference part, and the cloud prompt sentence with a cloud eval case.

## Later: offset

The field offset matched `Solid.offset` within 0.17% by volume and ran about 7 to 9 times
faster on a 4,890-triangle body, before any native work. Switching `Solid.offset` to it is
a separate decision, because the results differ in detail: the Minkowski offset keeps
convex edges exactly sharp on a shrink and gives true arcs, and the field gives a grid
mesh. It also left a slightly ragged ring at one concave crease in the spike. Until then,
an `offset` node over a `solid` leaf is the fast route, by the author's choice.

## Open questions

1. Should phase 2's stitching be always on, as written, or an explicit option on
   `k.implicit`? I chose always on, because it changes fidelity and not the shape.
2. Is `solid` the right name for the node, given that `Solid` is also the type?

Settled: inward offset is in, as the signed `offset` node (owner, 2026-11-25).

## Not verified by the spike

- The preview tier, pose drag, STEP export, and an imported scan.
- Any native-core timing.
- The border step on a curved face (the risk in section 4).
- The renders were judged by eye. Only the offset volumes and the flat-face error are
  measured.
