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

It takes `frame`, `at` and `label` like every node. It sits where a hard `union` of
pieces sits today; blends outside it (e.g. the fingers-to-palm blend) are unchanged.
Validation errors follow the existing path style
(`root.children[2].gap: must be >= 0`).

### Field, before bulge (decided)

For children with fields `d_1 … d_n`, let `m_i` be the minimum of the *other* children
(computed in O(n) from the smallest and second-smallest values).

- **`gap > 0`:** each piece is cut back to the halfway surface, offset by half the gap:
  `c_i = max(d_i, (d_i − m_i + gap) / 2)`, and the node's value is `min_i c_i`. Where two
  pieces overlap or come within `gap`, each stops `gap/2` short of the bisector, so they
  meet as two flat pads separated by `gap`.
- **`gap = 0`:** the node's value is plain `min_i d_i`. Cutting back to the bisector with
  no clearance gives the same solid (the overlap is interior either way), but its field
  is exactly zero along the interior bisector — a crease of zeros the mesher must not be
  shown. So `gap = 0` uses the hard union and gets its "pressing" look from the bulge.

Both forms are exactly L-Lipschitz when every child is (max, min and
`(d_i − m_i)/2` all preserve the bound), so the growth bound `G` and the bounds padding
of the parent spec carry over unchanged.

### Near-miss clearance (decided)

Pairs that are **not in contact** are kept apart by at least one grid cell of the tier
being meshed, even when `gap = 0`: their cut uses a clearance of `max(gap, cell)`.
This is what removes the reported necks — a near miss narrower than the grid now shows
as a clean one-cell gap instead of a fused rod. It only changes geometry within half a
cell of the bisector of a pair that is already within a cell of touching, so it is
invisible everywhere else. The cost is that near-miss geometry depends on the grid
(preview and print differ there by a fraction of a millimetre), and that a pair goes
from "one cell apart" to "touching" in one step as it crosses contact — an accepted
version of the unavoidable first-contact moment.

### Contact detection (decided approach)

Whether a pair is in contact, and how deep, is a property of the pose — and the pose is
fixed for a given build. So the **compiler** decides it, once per build, in pure JS:

- For each pair of children `(i, j)`, find the penetration depth
  `δ_ij = −min_x max(d_i(x), d_j(x))` (positive when they overlap). Use the existing
  interval evaluator as a branch-and-bound search over the pair's overlapping bounds,
  to a fixed tolerance, so the result is deterministic.
- `δ_ij > 0` → the pair is in contact; otherwise it gets the near-miss clearance.
- The per-pair results become constants in the compiled program, so both engines read
  the same numbers and parity holds trivially. They are part of the program's content
  hash (and so of PR 3's cache key).

Pairs whose bounds (padded by the clearance) don't overlap are skipped without a search.

### Bulge (requirements; shape left to the builder)

For each pair in contact, the skin of both pieces swells outward in a band around the
rim of the contact pad. Requirements:

- Zero for pairs not in contact, exactly — never a function of mere proximity.
- Scales continuously with `δ_ij`, reaching 0 as `δ_ij → 0`, so dragging into contact
  grows the bulge smoothly from nothing.
- Maximum outward offset is `bulge` mm; the band's width follows the contact depth (a
  firm press spreads further than a light touch). The exact profile is the builder's
  call, tuned by eye on the hand.
- Has a stated Lipschitz bound that feeds `G`, so culling stays exact.
- Default `bulge` value: tuned on the hand so a firm finger press reads as squish, then
  fixed in the spec addendum.

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
- Contact detection: δ sign and value on analytic cases (two spheres at known
  overlap and separation).
- Bulge: zero for a non-contacting pair (meshes byte-identical with `bulge` on and off);
  grows monotonically with press depth.
- Lint: one firing and one quiet case.

## Where it lands

A new PR, `feat/implicit-2b-contact`, stacked on #280 (base `feat/implicit-2-native`),
merging into `feat/implicit` before the block sample cache (PR 3). No version bump.
The parent spec's grammar table gains the `contact` row in this PR.

## Left to the builder

- The bulge profile and its default value.
- The pruning rule's exact form.
- The δ search tolerance (small next to the preview cell; deterministic).
- The nail-outline root cause.
