# Clean contact seams for `k.implicit` — design

Status: implemented (feat/implicit-2c-seams); exact seams are the default. The final constants and what
the builder decided are recorded at the end, under "Left to the builder". Amends `2026-10-15-implicit-contact-design.md` (the "contact spec"),
which amends `2026-10-14-implicit-organic-parts-design.md`. Everything in those still
holds unless this document says otherwise. Where they conflict, this one wins.

## Why

The contact node (PR #283) made fingers press instead of necking, but trying it on the
hand showed two things that are wrong with how it looks and prints. Both come from the
mesher sampling one field on one grid:

- **Touching pieces merge with a curve outward.** A sharp inward crease samples jagged at
  the 1.5 mm preview grid. To hide that, the gap-0 pad fill blends the pair with a smooth
  union (`PAD_BLEND` 1.5 mm). The blend adds about 0.9 mm of material at the seam, so it
  reads as webbing rather than two soft pieces pressed flat. The bulge (default 1 mm)
  adds about another 0.2 mm right at the seam.
- **Small gaps come out large.** A gap thinner than about one cell has no sample inside
  it, so the two sides fuse. The contact spec avoids that with a floor: no gap is cut
  thinner than 1.5 cells (`C_MIN_CELLS`). That is 2.25 mm in preview and about 1 mm in
  print, whatever `gap` says. A `gap` of 0.001 mm shows a 2.25 mm slot.

What the user wants, in their words: at gap 0 the mesh fuses "and it's ok if it prints as
one piece as long as the mesh looks like it's two soft pieces fitting together". With a
gap set, the result is "separate pieces", for prints made in separate parts or printed in
place. Their example is a hand with hinged fingers that keeps its organic outer shape.

## Goals

- **Gap 0: one solid with a crisp seam.** Pieces in contact flatten against each other
  and meet in a sharp inward crease, with no fill, web or outward curve at the seam. It
  looks right on the coarse preview grid, not only in the print mesh. It prints as one
  piece.
- **Gap above 0: truly separate shells at exactly that gap.** Every pair of pieces that
  could touch is held apart by the set gap, down to small values (0.05 mm on the test
  shapes). There is no hidden minimum. The pieces come out as separate closed bodies in
  the exported mesh, so a slicer prints them as separate parts. The faces either side of
  a gap are the same flattened faces gap 0 would give, pulled apart.
- **Near misses never bridge**, at any `gap`, on any grid. Two pieces 0.3 mm apart stay
  0.3 mm apart.
- **Attachments stay fused when a gap is set.** Where pieces are declared attached
  (finger bases blending into the palm), they keep blending as today; the gap tapers
  shut inside the attachment zone. To hinge a finger, the author leaves out its
  attachment.
- **Clean seams (a hard requirement).** No stray, folded or flipped triangles along a
  seam or a gap, at the preview grid or the export grids. "Testing" below gives the
  measurable form.
- **Preview speed: aim for at most 20% slower than today** while dragging a pose slider
  (the user's limit). **Clean seams win over speed** (the user's ruling): if both can't be
  met, the builder may spend more time, for example by meshing finer only near seams.
  The print tier is reported and aimed at no more than 1.5× today (my call; the user set
  no limit for export).
- **Both engines stay bit-identical**, and the existing watertightness and
  culling-exactness tests still hold.

## Non-goals

- **Hinge geometry.** Pins, sockets and other mechanisms are out of scope. This only
  makes organic shells separate cleanly.
- **Contact between separate `k.implicit` calls** (a nail against its finger). Same as
  the contact spec.
- **Physical simulation or volume conservation.** Same as the contact spec.
- **New controls.** `gap`, `bulge` and `attach` keep their meaning; only what the mesh
  does with them changes.

## Anti-goals (failure even if it "works")

- **Stray triangles along a seam.** That was the user's last complaint about the
  throwaway version. The feature is not done while any are visible at the preview grid.
- **A bridge, web or neck between pieces not in contact.** That was the original bug.
- **A gap that is narrower than set anywhere**, including after skin detail is applied.
  For print-in-place, a gap that closes is a failed print.
- **A mesh that isn't closed**, non-manifold edges, zero-volume slivers, or a break in
  core parity.

## What changes for an author

| | Today (PR #283) | After this |
|---|---|---|
| Gap 0, pieces touching | Smooth blend at the seam, about 0.9 mm of fill | Sharp crease, no fill |
| Gap above 0 | At least 1.5 cells (2.25 mm in preview), whatever is set | Exactly the set gap |
| Near miss | Held at least 1.5 cells apart (exaggerated in preview) | Kept at its true distance |
| Light touch (under ~0.4 mm overlap) | Keeps the clearance gap | Fuses with a crease like any other touch |
| Gap warning ("under 2 grid cells") | Shown | Removed: the grid now shows any gap |

The bulge is unchanged. It still comes from the compiler's contact regions, so it still
appears only for overlaps the region search finds (from about 0.4 mm). That is acceptable:
a crease without a bulge reads correctly, and the bulge grows smoothly from zero.

## How it works (decided)

This is the design the throwaway version (local branch `spike/contact-labels`, commit
`2e9b0976`) proved out on two pressed capsules and on the hand. "Spike findings" below
records what it showed.

### 1. Each sample knows its owner

For a `contact` node, every sample records its **owner**: the child whose cut value
`c_i` is least there (air where the field is positive). The engine can also evaluate,
at any point, every child's cut value and its **share** of the field: its cut value, or
an attachment blend it takes part in, whichever is less. This is a by-product of the
contact op, which already computes every `c_i`; it costs no extra sampling.

**Attached pairs count as one owner inside their attachment zone** (my call; the spike
did not do this and creased the webbing). Wherever a pair's attachment weight is above
zero, its two pieces share one owner for meshing, cleanup and the crease cut, so the palm
webbing and the gap's taper stay a smooth blend as today. The crease therefore starts at
the zone's outer edge. No fade is needed there: the attachment's blend width falls to
zero at that edge, so the field is already a hard crease where the crease cut begins.

*As built:* meshing does not use a merged "one owner per attachment zone" label. Every
owner stage reads the sample's **piece** (`evalBatchContact`'s `piece`): the child of the
least share, a tie going to the child whose own cut is the share, then to the child in fewer
attachments, then the lesser index. It is order-free — the same whatever order the children
are listed in, and the same from every leaf program — whereas a merged owner depends on
child order (a palm listed last would take its digits' webbing). Two attached pieces tie
inside their blend, so the webbing is a digit's piece, and two digits both blended into the
palm stay two pieces. Smoothness in the attachment zone comes from two rules instead of a
shared label: the crease cut (§5) never cuts where the crossing pair's own attachment weight
is above 0 (tested against the anchors in world space, like the mesh), and the seam between
sibling pieces shades smooth when it bends less than `SIBLING_SEAM_ANGLE` (§6). The merged
owner capture (`cap.owner`, and its native twin) is still computed on request but is
test-only; no production stage reads it.

### 2. The field drops its grid-dependent parts

- **Clearance is exactly the gap:** `cl = gap`. The `C_MIN_CELLS` floor is removed. At
  gap 0, `cl` is a hair of overlap (−0.02 mm in the spike), so pieces that touch read as
  fused at their bisector rather than tangent to it.
- **No pad fill.** `PAD_BLEND`, `FILL_BAND`, the gated fill term and its pruning rule
  (d) are removed. At gap 0 the field is the pieces' hard union, cut at the bisector.
- The field no longer depends on the grid edge, so the edge threading the contact spec
  added for `cl` (`evalReference(…, edge)` and the rest) can go, unless something else
  still needs it.

### 3. The mesher meshes each piece as its own skin where they're apart

The mesher stays marching tetrahedra. A cell is handled one of three ways:

- **One owner** (the vast majority): exactly as today.
- **Several owners, all touching (fused):** exactly as today, on the field. This is the
  inside of a gap-0 contact. The crease comes from step 5, not from here.
- **Several owners with a real gap between them** (an owner–owner grid edge where the
  field is positive at the pieces' bisector — a gap thinner than the grid): a
  multi-material scheme. It emits each owner's surface separately and places each
  side's vertices on that owner's own cut surface, half the gap from the middle, so the
  gap is exact. The spike used the barycentric multi-material layout: per tet face, one
  triangle (two edge vertices + the cell vertex) on a two-owner face, three (edge, face
  and cell vertices) on a three-owner face. A face whose owners are all fused is treated
  as one owner, so it joins a plain neighbouring cell without a crack.

Whether an owner–owner edge is **open** (gap) or **fused** is decided per grid edge from
the field at the bisector along it, so every cell sharing the edge agrees. Where a fused
edge sits between open edges on both of its faces in one cell (a line contact thinner
than the grid), the spike resolved it toward the node's intent: close the openings at
gap 0, open the fused edge when a gap is set. That rule has a flaw (see "Spike
findings"). The builder must replace it with one that never bridges a near miss.
**When the two collide, near-miss safety wins** (my call, from the user's ranking: the
bridge was the reported bug, and at gap 0 printing as one piece is allowed, not
required). At gap 0, a slit thinner than the grid left inside a real contact is
acceptable, as long as the mesh stays closed and manifold.

### 4. Cleanup keeps every vertex on its own piece

Every vertex carries an owner (or "field" for vertices that follow the fused surface).
Cleanup changes in three ways:

- **Projection:** a vertex near an open gap is pulled onto its owner's share of the
  field; every other vertex is pulled onto the field as today. The spike used "touches a
  grid point at either end of an open edge" as the test for "near an open gap".
  Projecting everything onto the field let a vertex near a tight near miss land on the
  other piece's skin, which re-bridged the gap.
- **Collapse and decimation** never merge two vertices with different owners.
- **Gap-face vertices** (each side of an open gap) are placed exactly and kept out of
  relaxation, so the gap stays exact.

### 5. The crease is cut in after cleanup

After cleanup, every mesh edge whose two ends have different owners is split at the point
where the two pieces' cut values are equal. That point is then moved onto the crease
(field = 0 and the two cut values equal).

- **Snap:** a split point within 15% of an edge end moves that end instead of adding a
  vertex.
- **Three owners:** a triangle whose three corners belong to three different owners
  (where the palm meets two fingers) is split 1-to-4.
- **No real crease:** a crease point that can't be reached nearby, as across a near
  miss, goes back where it was.

These are pure edge splits on a closed mesh, so the mesh stays closed and oriented.
Placing crease points directly (rather than cutting them in afterwards) is what produced
the stray shards in the first spike.

### 6. Shading and detail

- **The crease shades as a crease:** normals split along it once it bends more than
  `SIBLING_SEAM_ANGLE` = 5° (shading-policy.js), so a shallow press still reads as two
  pieces. Below 5° a seam between sibling pieces shades smooth: the seam between two
  piece IDs also runs through the attachment-zone webbing (§1, as built), where the surface
  is a smooth blend and the seam is near-flat, and that stretch must not shade as hard. A
  crease bends far more (about 44° across the fixtures' 1.2 mm press of two r 8 capsules);
  only a press shallower than a few hundredths of a millimetre on such pieces bends under 5°
  and shades smooth, which is the price of keeping the webbing smooth. It draws no outline line, matching the organic policy
  for seams. Today the backend discards the implicit's own normals and Manifold shades
  under `ORGANIC`, which splits only above 80°. So **each owner becomes its own Manifold
  original ID** (my call). That reuses the organic-to-organic seam handling PR #283 added
  for nails (hard normals, no outline line). It survives later booleans. Picking selects a
  piece (a finger) rather than the whole hand. Attached pieces that share an owner in
  their zone still get separate IDs; their seam runs through the smooth webbing, so that
  stretch must not shade as hard. The builder either keeps the attachment zone under the
  palm's ID or confines hard shading to crease edges, whichever is simpler.
- **Skin detail (creases, noise, textures) fades out near seams and gap faces**, so
  displacement never closes a gap or roughens the crease. The fade distance is left to
  the builder.

### 7. Where it applies

Owner-aware meshing applies when the `contact` node is the root of the `k.implicit`, or
is reached from the root only through transforms and frame references (the hand's case).
Anywhere else (nested under a blend, subtract or displace), the node keeps today's
behaviour, floor and pad fill included, and compiling warns that its seams are
approximate. My call: keeping that path is cheaper than solving nested contact now, and
nothing uses nesting yet.

### 8. Native core

The C++ port mirrors all of it: owner capture, the mesher's three cell paths, owner-aware
cleanup, and the crease cut. Output stays bit-identical with the core on or off
(`test/core-parity.test.js`). As in the contact spec, a ported JS pass and its C++ change
in the same PR, and `native/README.md`'s floating-point rules apply.

### 9. The oversized fallback region goes

With the pad fill gone, contact regions only drive the bulge. When a pair overflows the
region search, the contact spec's fallback (one region over the whole box intersection)
would now just produce a large, wrong bulge. That pair gets no bulge, and the compile
warning stays (my call).

## Spike findings

What the throwaway version showed, so the builder doesn't repeat it:

- **Worked:**
  - Owner labels, exact gap shells, owner-held projection and the crease cut-in.
  - On two capsules at the 1.5 mm grid: gap 0.2 measured 0.200 mm and gap 0.05 measured
    0.050 mm; a 0.3 mm near miss stayed 0.300 mm apart; gap 0 gave one closed solid.
  - The hand stayed closed in the default, fist and near-miss poses, at gap 0 and 0.2.
- **Didn't help, and was removed:**
  - Clamping crease points into their own grid face or cell left them off the surface.
  - Smoothing crease points along the crease left the fold count unchanged.
  - Solving face crease points within their face plane gave a sawtooth crease.
  - Splitting edges where a third owner hides between two samples: there were none.
- **Still open (the builder's to fix):**
  - **Folds.** Today's mesher leaves 13 folded triangle pairs on the fist at the preview
    grid. The spike left about 220 before the crease cut and 410 after. Visibly, the
    shards shrink with the grid (clear at 1.5 mm, a small notch at 0.8 mm, nearly clean
    at 0.6 mm), but the count rises with seam length. Most come from multi-owner cells
    next to an opening, and from crease points the cut moves along the crease.
  - **Near-miss bridging under conflict closing.** At gap 0, closing conflicting openings
    bridged a capsule near miss at its rounded ends. Owner-held projection hid it in that
    test, but the rule itself is unsafe.
  - **A zero-volume sliver.** One 16-triangle sliver appeared in the hand's near-miss
    pose.
  - **Speed.** About 2× today's JS time on the hand. That's expected, because the spike
    samples twice and routes every surface cell through slow generic code. It is no
    measure of the real build's cost.
- **Real, not a defect:** in a tight fist, a couple of sealed air pockets about 1.5 mm
  across appear inside the hand. The old floor hid them. They stay; they're enclosed
  space.

## Testing

- **Seam cleanliness (the hard requirement):**
  - **Fixtures:** the two-capsule press (gap 0, 0.05, 0.2), a capsule near miss (0.3 mm
    at gap 0), and the hand in the default, fist and near-miss poses at gap 0 and 0.2.
  - **Grids:** preview 1.5 mm and print 0.6 mm.
  - **Flipped triangles:** zero. A triangle is flipped when the field steps the wrong way
    across it: evaluated a hair either side along its normal, the outer side must read
    higher. Use its owner's share for gap-face triangles, and the field otherwise.
  - **Folds:** an adjacent pair whose normals turn by more than 150°, not counting pairs
    that straddle a crease edge. No more than the baseline on the same shape and grid.
    The baseline is today's plain marching tetrahedra (no owners) run on the new field
    (my call). That exists for every fixture, including the small-gap capsules, where
    PR #283's floor gives no comparable shape. The bound is a merge gate, not a goal.
  - **Visual:** close-up renders of the fist's finger seams and a capsule crease end, at
    both grids, checked in review.
- **Exact gaps:** shells measured on each gap fixture equal the set gap to within 1% or
  0.01 mm, whichever is larger. Each pair of pieces that are not attached is a separate
  closed component.
- **Near misses:** no triangle crosses the bisector of a near-miss pair, at gap 0 and with
  a gap set, at both grids, over the hand's near-miss sweep.
- **Attachments with a gap:** at gap 0.2 the hand stays one body, because the fingers
  attach to the palm. The fingertips sit 0.2 mm off the palm in the fist.
- **Topology:** closed, manifold and consistently oriented on every fixture. No
  zero-volume components.
- **Speed:** `test/implicit-speed.test.js`:
  - Gates the preview tier on the hand (default and fist) at 1.2× today's native time and
    the print tier at 1.5×.
  - If clean seams need more time than that, the gate is raised to the measured cost,
    and the PR says so and why, rather than the seams giving way.
- **Parity:**
  - Native: core parity covers every new path.
  - Culling: sparse vs dense byte-identical on the contact trees, as today.
- **Removed behaviour:** the PR #283 tests that pin the floor, the pad fill or the gap
  warning are deleted or rewritten to the new behaviour. They are not loosened to pass.

## Where it lands

A new PR, `feat/implicit-2c-seams`, stacked on #283 (base `feat/implicit-2b-contact`),
merging into `feat/implicit` before the block sample cache (PR 3). No version bump. One
PR, not two: the crease and the exact gaps share the owner labels and the cleanup changes,
so splitting them would ship half a mesher. The local dev viewer loses its spike toggle,
and its gap slider keeps 0.01 mm steps.

## Left to the builder

All of it is now decided. What shipped:

- **Switch-on.** `compileImplicit(spec, { exactContact: true })` is the default. A root contact
  (reached from the root through `ref` nodes alone) is exact; a nested one keeps the floor and the
  pad fill and warns at compile with the text in §7. `{ exactContact: false }` remains an internal
  switch (tests, and `createManifoldKernel(wasm, { exactContact })`), kept because the nested
  contact's approximate path needs a way to be exercised on a root contact. The "under 2 grid
  cells" gap warning now fires only for nested (approximate) contacts.
- **The line-contact conflict rule.** Replaced in Task 5, not kept from the spike. The spike's
  closing of conflicting openings bridged near misses at gap 0. The mesher now labels each cell
  node with a `piece` (the least share; a tie goes to the child whose own cut is the tie value,
  then to the one with fewer attachments, then to the lesser index; the rule is order-free, so
  the palm listed last gives the same pieces). An open edge between two pieces is never closed
  across air.
- **The multi-material cell layout.** The barycentric layout is gone: an open cell is refined with
  AIR NODES (a node placed where the edge crosses into air, numbered when its unordered node
  pair is first met), so a gap narrower than a cell is cut at the true surface, not bridged.
- **Spike flaws, and how each was fixed:**
  - Folds (13 on the fist, ~410 after the spike's cut): the crease cut snaps only where it is
    reached, and a post-cut untangle pass (below) removes flipped triangles and the folds they
    cause. Gate: zero flips on every fixture; folds at most the plain mesher's on the same field.
  - Near-miss bridging under conflict closing: the closing rule is gone (above); a triangle never
    crosses a near miss's bisector, at gap 0 or with a gap set.
  - The 16-triangle zero-volume sliver in the hand's near miss: untangle collapses by edge, with
    the gate's zero-volume-component test as backstop.
  - Speed (2x): sampling is once (capture rides the sampling pass), and the owner path is native
    (Task 7/8); see Speed below.
- **Constants** (`implicit/contact.js` unless noted; every one tunable by test):

  | Constant | Value | Role |
  |---|---|---|
  | `CONTACT_OVERLAP` | 0.02 mm | gap 0: the cut sits this far past the bisector so the pieces fuse with a crisp crease |
  | `CREASE_SNAP` | 0.15 (fraction of an edge) | a crease point this close to a vertex moves the vertex instead of splitting |
  | `CREASE_TOL` | 0.005 (x edge) | the crease point's residual the cut accepts (the spike's 0.02 left visible chips) |
  | `DETAIL_SEAM_FADE` | 1 mm | skin detail fades to zero at a gap face over this distance |
  | `SIBLING_SEAM_ANGLE` | 5 deg (`shading-policy.js`) | a seam between sibling pieces shades smooth up to this turn (the attachment webbing) and hard above it (the crease) |
  | `FLIP_PROBE` | 0.03 (x edge) | a triangle is flipped when the field, probed this far either side along its normal, steps the wrong way |
  | `FOLD_COS` | -0.866 | adjacent triangles whose normals turn by more than 150 deg fold |
  | `SUSPECT_COS` | 0.866 | a triangle within this cos of all its corners' normals is not probed for a flip |
  | `REGION_RINGS` / `REGROW_RINGS` | 12 / 3 | untangle works within 12 vertex rings of a flipped triangle, regrowing the region 3 rings per round |
  | `UNTANGLE_ROUNDS` | 24 | rounds before untangle gives up (the gate then reports any remainder) |
  | `DIST_RATIO` | 2 (`project.js`) | an owner-mesh projection step moves at most this many times the field's value |

  The detail weight is `smoothstep(0, DETAIL_SEAM_FADE, s)` with `s = (least cut over the
  other pieces not attached there) - max(gap, 0)`: it is 0 on the gap face itself, so detail can
  never narrow a gap (measuring from the raw bisector let noise narrow a 0.2 gap to 0.19). Crease
  and pinned vertices get weight 0 outright.
- **Near an open gap (projection).** A vertex is held (`ownerHeld`) only where its edge borders
  an open edge (never bisected onto a discontinuous or merged share); it projects onto its own piece's surface (its share's zero set), never onto a
  discontinuous or merged share. A vertex whose own field is not the governing one near a seam
  also takes the owner projection, jump-guarded.
- **Data structures and the native port.** Owner capture rides the single sampling pass
  (`evalBatchContact`: owner, piece, K cuts and shares per sample; fuse = 2 marks an exact node).
  The C++ mirrors the owner mesher, cleanup, crease cut, untangle and the detail fade in one
  session (`ip_mesh_owners` ... `ip_detail`); output is bit-identical with the core on or off.
- **Speed.** The gate was measured on base `4b886eaa`, isolated (hand default 241 ms at 1.5 mm
  and 1652 ms at 0.5 mm; fist 269 and 1839, paced). The owner path measures 316 / 378 ms at
  1.5 mm and 2250 / 2515 ms at 0.5 mm. The preview gate is therefore raised to 1.45x / 1.54x the
  plain native path (plan: 1.2x; clean seams win over speed); print is raised from 1.5x to 1.6x: it measured 1.53x (default) / 1.46x (fist) against today's plain path (1474 / 1707 paced ms), which is itself faster than the 1652 / 1839 base-commit baseline the 1.5x came from; against that base the owner print path (2248 / 2485) is 1.36x / 1.35x. The gate is a
  RATIO to the plain native path (same pose, same grid, `exactContact: false`) measured in the
  same test with the runs interleaved, plus an absolute ceiling of 3x the spec targets: load slows
  both paths alike, whereas an absolute millisecond gate (2478 ms print) failed 3-5% over inside
  the full suite while passing alone. The cost at 1.5 mm is the mesher's 9-11k owner-owner edges
  each bisected in ~25 evaluations (30-51 ms), cleanup's extra projection pass and share capture
  (17-28 ms), the crease cut (12-21 ms), the detail's owner projection and fade (6-7 ms) and
  untangle (1-6 ms). That follow-up is done (2026-10-22): every owner edge solve (the mesher's
  bisector and side zeros, the crease cut's equal-shares point) is a bracketed Illinois solve
  (`bracket.js`, `solve_brackets` in the core: the secant of the kept bracket, the retained end's
  value halved when an end is kept twice, a midpoint step whenever the secant is unusable, leaves
  the bracket, or the step before was a secant that did not halve it; stopping at a bracket 1e-7
  of the edge, within 2^-24 of the sign change). Every two steps at least halve the bracket, so
  the worst case is 48 steps (twice bisection's 24) on a kink, jump or flat crossing, and a
  smooth one takes two or three; a lane a cap stops early answers its end with the smaller
  |g|, never the middle of a wide bracket (`test/implicit-bracket.test.js`). Measured on the hand
  at 1.5 mm, the mesher's solves take 2.5 (default) / 5.3 (fist) steps per edge, plus the two end
  evaluations where the edge's ends were not already evaluated (about 1.9 / 1.7 per edge on
  average), instead of 25; cleanup's final owner projection runs only on vertices
  the previous pass left unsettled (selected for their share, or moved more than 1e-3 of a cell
  (the share-selected ones alone left a fist vertex 3e-3 off the field at 0.6 mm, past the
  plain path's worst)); and the piece capture computes each slot's share once per lane. The owner
  path now measures 284 / 343 ms at 1.5 mm and 1965 / 2395 ms at 0.5 mm (plain 245 / 276 and
  1520 / 1795): 1.17x / 1.24x preview and 1.30x / 1.33x print, so the gate is 1.29x / 1.36x
  preview and 1.43x / 1.46x print (default / fist; measured plus ~10%). Output stays
  bit-identical with the core on or off.
  Then (2026-10-22) the native edge collapse got exact speed-ups that serve both paths alike
  (one walk per test with the cheap guards first, shared edge vectors for a triangle's
  corners, a per-triangle cache of the current normal and sharpness in decimation passes, an
  early corner refusal where no sharpness can be NaN; `implicit_mesh.cpp`'s top comment says
  why each is exact): collapse and decimation on the fist went from ~115 to ~79 ms. Both
  paths lose the same ~45-50 ms at 1.5 mm, so the preview ratios rise: plain now measures
  201 / 238 ms at 1.5 mm (against the 241 / 269 base) and 1446 / 1716 ms at 0.5 mm, the owner
  path 240 / 297 and 1869 / 2280 ms; 1.19x / 1.25x preview and 1.29x / 1.33x print (default /
  fist, three quiet gate runs). Under the full suite's load the preview ratios read higher
  (~1.22x / 1.36x), so the preview gate is the loaded ratio plus ~10%: 1.34x / 1.50x; print
  keeps 1.43x / 1.46x.
