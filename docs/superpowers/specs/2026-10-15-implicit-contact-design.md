# Contact groups for `k.implicit` — design

Status: proposed. Extends `2026-10-14-implicit-organic-parts-design.md` (the "parent
spec"); everything there still holds unless this document says otherwise.

## Why

Separate pieces of one organic body — fingers, toes, lips, a tail against a flank — must
be able to touch without misbehaving. Today the hand joins its fingers with a hard
`union` (`k: 0`), and two failure modes show up while posing:

- **Near misses bridge.** When two fingertips come within about one grid cell (1.5 mm in
  preview) the mesher cannot see the gap, and the surfaces fuse into a blobby neck
  (seen on the hand in the dev viewer, 2026-10-15).
- **Overlaps glue.** When pieces actually overlap they pass through each other and the
  union welds the overlap into a lump with a sharp crease; nothing reads as skin pressing
  on skin.

The goal is that pieces press against each other the way skin does: contact flattens
into a pad, the skin around the pad swells a little, and pieces that are merely close
stay cleanly apart.

## Goals

- A general grammar node, usable for any group of pieces in any part — not a
  hand-specific helper.
- Pieces in contact meet in a flat pad along the halfway surface between them instead of
  interpenetrating.
- A configurable clearance: `gap: 0` fuses touching pieces into one solid at the pad
  (what the hand wants); `gap > 0` keeps that much clearance so pieces print as separate
  surfaces (what some other models will want).
- A configurable bulge: skin around a contact swells outward, scaled by how hard the
  pieces press; `bulge: 0` turns it off.
- No necks or bridges between pieces that are close but not touching.
- Both engines (JS and native C++) stay bit-identical; interval pruning stays provably
  sound.

## Non-goals

- Physical simulation. No mass, stiffness or time — the result is a pure function of the
  pose, like everything else in `build`.
- Exact volume preservation. The bulge should look plausible, not conserve volume.
- Contact between separate `k.implicit` calls (e.g. a nail's own fine-grid implicit
  against the finger). Contact acts only among the children of one `contact` node.
- Changing `union`, `intersect` or `subtract` semantics.

## Anti-goals (failure even if it "works")

- Any bridge, web or neck appearing between pieces that are not in contact. This is the
  reported bug; the feature fails if it survives in another form.
- A bulge that grows before contact and reaches across the gap — that is a smooth blend
  by another name.
- Geometry that pops or jumps visibly while dragging a pose slider through contact,
  beyond the unavoidable moment two surfaces first meet.
- Breaking watertightness, the culling-exactness tests, or core parity.

## The node

```js
{ kind: "contact", children: [...], gap: 0, bulge: <default>, label? }
```

| Field | Meaning | Default |
|---|---|---|
| `children` | two or more nodes; each is one separate body | required |
| `gap` | clearance kept between pieces at contact, mm, ≥ 0 | `0` |
| `bulge` | how far skin swells around a contact, mm, ≥ 0 | tuned on the hand (see below) |
| `attach` | pairs that are joined, not just touching, near an anchor (below) | `[]` |

It takes `frame`, `at` and `label` like every node. It sits where a hard `union` of
pieces sits today; blends outside it (e.g. the fingers-to-palm blend) are unchanged.
Validation errors follow the existing path style
(`root.children[2].gap: must be >= 0`).

### Field (decided)

Contact is decided **locally, point by point, from the children's own values** — there is
no per-pair "in contact" switch. (An earlier draft classified whole pairs; that fails on
the hand, where adjacent fingers touch at the knuckles while their tips are a near miss.)

For children with fields `d_1 … d_n` (after bulge, below), let `m_i` be the minimum of the
*other* children and `s₂` the second-smallest value overall (both O(n) from the smallest
and second-smallest values). Let `cl` be the clearance:

- `gap > 0`: `cl = max(gap, c_min)`.
- `gap = 0`: `cl = c_min`.

`c_min` is the near-miss clearance: the smallest separation the mesher reliably resolves
at the grid edge being meshed (about one cell; the builder fixes the factor by test). It
is a **mesh-time** value, passed to both engines with the edge, not a compiled constant.

- **Cut pieces:** `c_i = max(d_i, (d_i − m_i + cl) / 2)`. Each piece stops `cl/2` short of
  the halfway surface wherever another piece is within `cl` — so a near miss always shows
  as a clean gap of at least `cl`, never a neck.
- **`gap > 0`:** value `= min_i c_i`. Pieces never fuse; contact shows as two flat pads
  `cl` apart.
- **`gap = 0`:** value `= min(min_i c_i, f)` with the pad fill `f = s₂ + (1 − g(x))·cl`.
  `s₂ < 0` exactly where two or more pieces overlap. `g` is 1 within a contact region
  (found by the compiler, below) plus a margin of `cl + band` around it, falling smoothly to
  0 beyond. Near a real contact the fill is `s₂`: the overlap ("the pad") is filled and
  fused, and the wedge around its rim fuses into a natural crease. Away from every contact
  `f ≥ s₂ + cl ≥ cl`, so it never undercuts the clearance cut and a near miss keeps its
  clean gap. (Amended 2026-10-16: an ungated `s₂` fill was small and positive inside a
  near-miss gap and re-closed it — the reported necks again. Caught in Task 1.)

The cut forms are built from min, max and `(d_i − m_i)/2`, so they are exactly L-Lipschitz
when every child is (the fill gate adds `cl·|∇g|`): the upper Lipschitz bound `L` (which drives interval pruning) and the
growth bound `G` (which pads bounds) carry over unchanged.

Cost of the clearance: geometry within `cl/2` of the bisector of two close pieces depends
on the grid, so preview and print differ there by a fraction of a millimetre (the hand's
adjacent fingers, ~1.6 mm apart along their length, get slightly flattened inner sides in
preview). Accepted: that is exactly where today's mesh is wrong.

### Bulge (decided approach; profile left to the builder)

The bulge needs to know how hard a contact presses, which a single point cannot see. So:

- **Contact regions, found by the compiler.** For each pair of children whose padded
  bounds overlap, a deterministic branch-and-bound over the interval evaluator finds every
  separate region where `max(d_i, d_j) < 0` (the pair actually overlaps). Each region
  becomes a constant record: centre, depth `δ` (how far the pieces interpenetrate there),
  and a radius. These are pose facts, fixed per build, so both engines read the same
  numbers and parity holds; they are part of the program's content hash (and PR 3's
  cache key). Bulge regions use the fields before bulge.
- **Per-piece offset.** Each of the pair's pieces gets
  `d_i' = d_i − bulge_i(x)`, a smooth bump confined to a band around the region's rim and
  to within a falloff radius of the region's centre. Its amplitude grows continuously from
  0 at `δ = 0` up to `bulge` mm; its spread grows with `δ`. A pair with no overlap region has
  no bulge, exactly — proximity alone never produces one.
- **Order.** Bulge is applied to each piece first; the clearance cut and pad fill use the
  bulged fields. So a piece bulging toward a third piece is still held apart from it.
- **Bounds.** The bump has a stated Lipschitz bound `L_b`: the bulged piece is
  `(1 + L_b)`-Lipschitz, which raises `L` for pruning; its bounds grow by `bulge / G`.
- **Default `bulge`:** tuned on the hand so a firm finger press reads as squish, then
  written into this spec.

### Attachments: joined at one end, pressing elsewhere (decided)

A finger is joined to the palm at its base, by the existing blend that forms the webbing,
yet its tip must press into the palm in a fist rather than smear into it. So a pair can be
**attached near an anchor**:

```js
attach: [{ a: "index", b: "palm", near: "index_mcp", radius: 14, k: 8 }]
```

- `a`, `b`: labels of two children of this `contact` node.
- `near`: a frame name; its world origin is the anchor (it moves with the pose).
- `radius`: within this distance of the anchor (mm), the pair is joined.
- `k`: the blend width there, in mm, the same meaning as `union`'s `k`.

Within `radius` of the anchor the pair behaves as today's smooth union with width `k`:
no clearance cut and no bulge between those two. Beyond it they follow the contact rules.
Between the two zones the pair's value moves from one to the other over a falloff band
(the builder picks the band and the blend of the two values). The band must be smooth
enough that no crease shows, with a stated Lipschitz bound feeding `L`.

Only the attached pair is exempt. The same finger still keeps clear of its neighbours at
its base, and other pairs are unaffected. Attachments are validated: unknown labels or
frames, `a == b`, and duplicate pairs are compile errors with paths.

The hand fixture puts the palm, the thumb and the four fingers into one `contact` node,
each digit attached to the palm at its base frame with `k = palmBlend`. That replaces
today's outer finger-to-palm blend, which would otherwise refill a near-miss gap
anywhere within 8 mm of the palm.

### Pruning

A child may be dropped from a block only when it provably cannot change the node's value
there: neither as the minimum, nor through any `m_i` within the clearance, nor through a
bulge band. The exact rule is the builder's, held by the existing culling-exactness tests
(sparse vs dense byte-identical) with contact trees added.

## Also in this PR

- **Nail outline lines.** The organic preview still draws outline lines around each nail
  where its separate implicit is unioned onto the finger (visible in the same
  screenshot). Organic sub-parts should draw no outline along those seams. The builder
  finds why the `ORGANIC` shading policy doesn't cover them and fixes it.
- **The hand fixture** (`test/fixtures/implicit-trees.js`) replaces its hard finger union
  with `contact` (thumb included), `gap: 0`. The local dev viewer gets `gap` and `bulge`
  sliders.
- **Lint** (parent spec §6): a warning when `gap` is non-zero but smaller than two cells
  of `preview` or `resolution`, since the grid cannot show it.

## Testing

- Reference evaluator: `contact` added to the plain recursive tree-walker; the batched
  program equals it on random points, including the per-pair contact constants.
- Culling exactness: sparse vs dense byte-identical on contact trees (touching spheres,
  overlapping capsules, near misses at half a cell, `gap > 0`, bulge on and off).
- Native parity: `test/core-parity.test.js` covers contact trees, both builds.
- Topology: the hand over a pose sweep that brings fingertips through near-miss into
  contact — watertight at every step, no bridge components between non-contacting
  fingers (check that each fingertip pair not in contact is separated in the mesh).
- Contact regions: count, depth and centre on analytic cases (two spheres at known
  overlap and separation; a pair touching in two places).
- Attachments: a finger curled into a fist presses a pad into the palm (no fillet or
  bridge at the tip) while its base keeps the same webbing as today's blend. Test it in
  both a fist pose and an open pose, and check the falloff band shows no crease.
- Mixed contact: two capsules touching at one end and a near miss at the other —
  fused pad at one end, clean gap at the other.
- Bulge: zero for a non-contacting pair (meshes byte-identical with `bulge` on and off);
  grows monotonically with press depth.
- Lint: one firing and one quiet case.

## Where it lands

A new PR, `feat/implicit-2b-contact`, stacked on #280 (base `feat/implicit-2-native`),
merging into `feat/implicit` before the block sample cache (PR 3). No version bump.
The parent spec's grammar table gains the `contact` row in this PR. Because the
near-miss clearance depends on the grid edge, PR 3's block-cache key must include the edge
(it already differs per tier).

## Left to the builder

- The bulge profile and its default value.
- The pruning rule's exact form.
- The contact-region search tolerance and how regions are clustered (deterministic).
- The near-miss clearance factor `c_min / edge`.
- The attachment falloff band and how the joined and contact values are blended across it.
- The hand's attachment radii.
- The nail-outline root cause.
