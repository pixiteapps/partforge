# Dragging a cage body: fast pose drags for `k.cage` + `k.subdiv`

Date: 2026-11-22. Follows `2026-11-19-smooth-organic-surfaces-design.md`, which ruled this
out ("Frames and skinned pose drag for subdivision bodies" is a non-goal there, because
"a cage rebuild is tens of milliseconds"). That holds for a small cage. It does not hold
for a hand.

## Revision, 2026-11-22: the viewer-side route only

The bench and the spike (both below) changed the route. The owner chose it on 2026-11-22.

- **Part 2's worker drag build is dropped.** A worker drag build still runs the Manifold
  import, the cut and the meshing: about 290 ms a move on the hand. Skipping the level
  search and the self-intersection check cannot bring that under 120 ms. Part 2's text
  below is kept as a record; only its "Measure first", "The topology key" and "Stopping
  at the last valid pose" sections still apply.
- **Part 3 is the one path**, for the editor and for public pages. The spike measured
  8 to 9 ms a move plus 1.7 ms of cage code, with no visible error through the hand's
  cut.
- **It plugs into the existing skin drag controller** (`src/framework/skin/skin-drag.js`),
  as a second kind of base. That controller already serves sliders and handle drags,
  schedules the exact build after a 150 ms pause or on release, hides edge lines, and
  restores the exact mesh before a capture. So sliders, handles and captures need no new
  rule of their own.
- **The topology key ignores face ids.** It hashes the quads and the creases only. Face
  ids can swap inside a pose range (the hand's thumb) while the quads stay the same.
- **Version 1 limits.** A sub-part takes the fast path only when its build smooths
  exactly one cage with no creases, and every vertex of its delivered mesh is tied to
  the smooth surface. A cut is fine. A piece unioned onto the body (eyes, nails) has
  vertices that cannot be tied, so that sub-part rebuilds on each move as today. Moving
  such pieces with the skin under them is a follow-up, not built here.
- **Stopping at the last valid pose** runs in the viewer: the coarse check runs before a
  pose is drawn.

## Why

The cage is now the first choice for sculpted bodies. A user who drags a fingertip on a
cage hand should see the hand follow the pointer.

Measured on 0.198.1 (Node, Apple M1 Max, default tier, median of 12):

| Body | One rebuild |
| --- | --- |
| One finger on a small palm (about 20 cage faces) | 19 ms |
| The guide's hand that curls (296 cage faces) | 366 ms |
| The same hand with a flat cut under the wrist | 458 ms |

The viewer rebuilds live during a drag only when the last build took under 120 ms
(`LIVE_REBUILD_MS`, `src/framework/mount.js`). The finger passes. The hand does not: it
fades to a ghost and updates about three times a second.

Fingertip dragging itself already works with no engine change. A test part posed a `limb`
in `derive`, passed `posed.values` to the cage's `rotate` calls, and declared one
`angles` handle on the limb. It lints clean, the limb tip and the cage tip agree within
1 mm, and `partforge measure --drag` moves the knuckle and curl as it does on an
implicit hand. What is missing is speed, and a guide recipe.

## Goals

1. A handle drag in Pose mode, or a panel slider drag, on the guide's cage hand updates
   the shape on screen at 30 moves a second or better (33 ms or less from one drawn
   shape to the next, measured in a browser on the bench machine).
2. The shape on screen during the drag is the real smooth surface for the dragged
   values, not a bent copy of the old one. Small, stated differences are allowed (see
   "What the drag shape may differ in").
3. No new agent-facing API. The agent writes an ordinary cage, an ordinary `limb` and an
   ordinary handle.
4. The guide teaches the limb-driven cage, and the worked hand uses it.
5. A cage body can be dragged on a public forge page, from its cached preview, with no
   worker (owner's decision, 2026-11-22).
6. A drag stops at the last valid pose: the body never shows passing through itself
   (owner's decision, 2026-11-22).

## Non-goals

- Frames, bindings or skinning for a cage. A cage has none and gains none.
- `contact`, surface detail or blends for a cage. Those stay with `k.implicit`.
- A fast path for a change that adds, removes or reorders cage faces (an extrude count,
  a `steps` value, a crease). Those rebuild as today.
- The print tier. The fast path is for the preview tier, in the viewer and in a cached
  preview.
- Animations and `setParams` calls. They rebuild as today, as they do for implicit
  bodies.

## Anti-goals

- A drag must never leave a wrong shape on screen after release. Release always ends in
  a full, checked build.
- A drag must never save, export, capture or measure the drag shape. Those read the last
  exact mesh, as they do during an implicit pose drag.
- The agent must not need to know the fast path exists to get a correct part.

## Approaches considered

1. **Recipe only.** Teach the limb-driven cage in the guide. No engine work. A whole
   hand stutters. Rejected as the whole answer; kept as Part 1.
2. **Reuse the smoothing while only positions move.** Chosen (owner's pick, 2026-11-22).
   Every stage of the smoothing is a fixed weighted sum of the cage points once the
   faces are fixed (`step`, `limit` and `creasePoints` in
   `src/framework/geometry/subdiv/surface.js`). Only the level choice and the quad
   diagonal choice read positions. So the costly, position-independent work can be done
   once per drag.
3. **Bend the last mesh, as implicit bodies do** (`src/framework/skin/`). Rejected: a
   cage has no frames, so it needs a new way to tie faces to joints, which is new
   vocabulary, and the drag shape is only approximate.

## Part 1: the recipe (docs only)

- `docs/domains/organic.md`, "Drag handles on a cage", gains the limb-driven pattern:
  declare a `limb` whose joints sit where the cage's knuckle rings are, pose it in
  `derive`, pass `posed.values` to the `rotate` calls, and give each digit one `angles`
  handle on the limb. State the rule that makes the handle sit on the body: the rings of
  a knuckle are centred on the limb's joint, and the segment lengths match the limb's
  `lengths`.
- "Worked example: a hand that curls" is reworked to that pattern: one limb per finger,
  a knuckle and a curl parameter each, one `angles` handle each. The single `curl`
  slider stays as a preset or is replaced; builder's call.
- A reference part `src/parts/cage-hand.js` carries it, with the usual part tests.
- The lines "No pose drag" and "Every such drag is a shape drag" are rewritten once
  Part 2 lands.

Part 1 is useful without the rest and can ship first.

## Part 2: measure, then a fast drag build in the worker

### Measure first

Add `scripts/bench-cage-drag.mjs` (`npm run bench:cage-drag`), modelled on
`bench-pose-drag.mjs`. On the cage hand and the whale it reports, per stage: running the
part's cage code, `fromSnapshot`, the level search, the smoothing passes, the
self-intersection check, the Manifold import, any boolean after it, and `toMesh` with
normals. Nobody has split the 366 ms yet. Commit messages suggest the self-intersection
check and the level search (which builds one level past the chosen one) dominate.

The numbers decide how much of the rest is built. See "Order and gates".

**Measured** (`npm run bench:cage-drag`, Apple M1 Max, Node v24.19.0, CPU ms, median of
12, preview tier):

| Stage | cage-hand | organic-whale |
| --- | ---: | ---: |
| Level, cage faces, triangles | 4, 300, 153,600 | 2, 132, 4,224 |
| Cage code + `snapshot()` | 3.8 | 0.7 |
| `levelFor` | 14.7 | 1.4 |
| `subdivide` (reusing the search's mesh) | 3.8 | 0.1 |
| `selfIntersections` | 215.6 | 4.6 |
| Manifold import | 164.2 | 3.7 |
| The part's `cut` | 96.1 | 3.1 |
| `toMesh` (preview) | 27.5 | 0.8 |
| Whole `build` + `toMesh` | 527.7 | 60.4 |
| Cage code + Manifold import + cut + `toMesh` | 291.5 | 8.4 |

The self-intersection check is the largest single stage on the hand, then the Manifold
import. The whale's whole build is much more than its stages add up to, so something
outside these stages (about 40 ms) is not yet accounted for.


### The topology key

A cage snapshot is `{ points, faces, ids, creases }`. Its **topology key** is a hash of
everything but `points`: the faces (as point indices), the ids in order, and the
creases. Two snapshots with the same key have the same smoothing weights at every
level.

### The drag build

The viewer already marks builds made while a pose handle is held: they are transient
(`cycleTransient` in `mount.js`), drawn but not reported, and release owes one real
build. A panel slider edit is not transient: it is an ordinary debounced build that is
reported, exported and measured, with no release build after it. Sliders get their own rule (see "Panel sliders" below). The viewer sends a new flag on
drag builds (the
existing `provisional: false` is sent only for skinned drags and playback). For a
flagged build of a `k.subdiv` on the preview tier, when the worker holds a drag entry
with the same topology key:

- **Reuse the level** chosen by the last full build. No level search.
- **Reuse the structure** `fromSnapshot` and each `step` built (edge maps, child
  indices, sharp flags, crease regions). Only positions are recomputed.
- **Reuse the quad diagonals** of the last full build.
- **Run the drag validity check** (below) in place of the full self-intersection
  check.
- Everything after the surface runs as usual: the Manifold import, IDs and shading
  policy, and any `cut` or `union` the part applies. So a flat cut under the wrist is
  exact during the drag.

A flagged build with no drag entry, or a different key, is an ordinary build.

**Drag results stay out of the solid cache.** `k.subdiv` caches its solid under
`h("subdiv", snapshot, tier)`. A drag build must not store its solid, or anything built
from it by a later `cut` or `union`, under the ordinary keys: a release at the last
drag pose would get that entry back and skip the checks. The drag entry holds the
level, the structure and the diagonals, keyed by topology, and nothing else. Release
always runs the full path: level search, diagonals, self-intersection check. (My call.)

**No pause build.** The live-rebuild path has no pause build today; only skinned drags
do. A drag held still keeps the drag shape until release. Adding a pause build would
bring a full build's stall back into the drag. (My call.)

**Panel sliders** (owner's decision, 2026-11-22: sliders are in). A panel edit already
reaches the viewer marked `interactive` (`onParamChange({ interactive: true })`), which
is what an implicit body's bend keys on. For an interactive change that touches a
sub-part with a drag entry, the viewer does what it does for a skinned drag, with a
drag build in place of the bend:

- it sends a flagged drag build at once, and draws the result as a drag shape: not
  reported to the host, not exportable, not measured, and captures read the last exact
  mesh;
- it delays the ordinary build with `loop.delayKick(SKIN_PAUSE_MS)`, so the full,
  checked and reported build runs 150 ms after the last move, or at once on release.

A non-interactive change (`setParams`, an animation, a host write) is an ordinary
build, as today. So a slider, unlike a handle hold, does get a pause build: the panel
has no hold to wait for.

**The viewer must let the hand rebuild live.** Today `hold(true)` decides
`liveRebuild` once, from the time of the last real build (`lastBuildMs <
LIVE_REBUILD_MS`). The hand's real build is always slow, so it would never start, and
no drag build would ever be sent. Change: with each full build of a sub-part that
holds a drag entry, the worker replies that a fast drag build is available, and the
viewer starts such a hold live. The first drag build's own time then drives the
existing `liveSlow` rule: if it runs past the limit, the part fades as today. (My
call; the reply field's name and shape are the builder's.)

### Stopping at the last valid pose

The full self-intersection check is too slow to run on every move (commit messages give
70 ms at level 5 on a 32-face cage). A drag build runs a **drag validity check**
instead: the same edge-through-triangle test (`subdiv/self-intersect.js`) on the plan's
surface at a coarser level, at most level 2, plus the zero-volume test. The builder
picks the level so the check costs 5 ms or less on the cage hand, and the bench reports
it.

- **A pose that fails the check is not drawn.** The worker replies that the pose is
  invalid, with the cage faces named. The shape on screen stays at the last valid pose.
- **A handle drag stops there.** The viewer puts the handle's parameters back to the
  last values that passed, the way a collision stops a dragged piece today, so the
  handle does not run ahead of the body. Moving back into valid poses moves the body
  again.
- **A slider keeps moving but the body does not.** The panel owns the slider's thumb.
  While the value is invalid the body holds the last valid pose. On release, or at the
  pause build, the parameter returns to the last valid value and the panel shows it.
  (My call: partforge cannot stop the panel's thumb mid-drag.)
- **The coarse check can miss a fine crossing.** Release still runs the full check. If
  that refuses the pose, the parameter returns to the last value whose full build
  passed, and that mesh is shown.

A pose `rotate` or `scale` refuses (an edge shorter than 1e-6) is treated the same way
as a failed check.

### What the drag shape may differ in

- **Level.** If the full build would pick another level at the new pose, the drag shape
  is coarser or finer by one level until release.
- **Diagonals.** A quad split the other way moves the surface by less than the chord
  tolerance.
- **Validity.** The drag check is coarser than the full one, so a fine crossing can
  show until release. See above.

All three resolve on release.

## Part 3: re-apply the weights in the viewer

Required, because a public page has no worker (Part 4). The per-move work runs in the
viewer, the way the implicit drag does. Whether the editor uses this path or Part 2's
is decided by measurement once both exist: Part 2 keeps cuts exact, this path runs at
display rate.

**Spike first.** How per-corner weights ride through a Manifold `cut` and `union` is
not known. The spike must show, on the cage hand with its flat cut, that every output
corner can be placed from the smooth surface, before this part is planned.

- **Recognise the case.** `pose-probe-core.js` gives a `subdiv` token a `shapeHash`
  equal to its topology key (today it equals the full hash, so it is never trusted). A
  change is a "cage points only" change when both sides are trusted, have equal
  `shapeHash`, and the result is in its canonical place. This mirrors
  `skinnableBetween` in `skin/skin-drag.js`.
- **Carry the weights.** With the mesh, the worker sends for each output corner a limit
  triangle and three weights, so the viewer can place the corner from the smooth
  surface. The values must survive a `cut` and a `union`, as the implicit bindings do
  (`geometry/mesh-bindings.js`).
- **Per move.** The viewer runs the part's cage code through the probe to get the new
  cage points, applies the cached weights to get the surface, places every corner,
  recomputes normals, and calls `viewer.setSubVertices(name, …, { deformed: true })`.
  Edge lines are hidden while deformed, and captures read the last exact mesh, both as
  today.
- **Validity.** The viewer runs the drag validity check on the coarse surface before
  it draws, and stops at the last valid pose as in Part 2.
- **Exact build.** After a 150 ms pause or on release, as the implicit drag does.

In this part a vertex made by a `cut` moves with the surface it lies on, so a flat base
bends slightly during the drag. That is display only.

### Spike result (Task 10)

`node scripts/spike-cage-weights.mjs` (Apple M1 Max, Node v24.19.0, wall ms, median of
20). The cage hand at level 4: 300 cage faces, 153,600 limit triangles, 76,802 limit
vertices. Pose 0 is the defaults. Pose 1 curls the index, middle and ring fingers (knuckle
+20 to +30°, curl +30 to +40°). The truth is the part's own kernel build at pose 1.

**Result: it works.** Every output vertex could be tied to the smooth surface, through the
part's cut and through a union. Two layouts were tried. Both work. Use layout A.

- **Layout A, `faceID` (use this).** At the import, set `MeshGL.faceID` to the limit
  triangle's index. Manifold keeps an input `faceID` on every output triangle, and it keeps
  the edges between different `faceID`s, so it merges no skin triangles. Pick the skin
  triangles by `runOriginalID`. A corner's weights are its position written in barycentric
  coordinates of its source triangle at rest. This is exact, because a piece of a triangle
  lies in the plane of that triangle. There are no extra vertex properties, and the mesh
  keeps one vertex per position.
- **Layout B, properties per corner.** Each triangle corner is its own property vertex with
  `[triangle, w0, w1]`, and the positions are merged with `mergeFromVert`/`mergeToVert`. A
  boolean interpolates the properties only inside one source triangle, so the triangle stays
  an exact integer. This also works, but it has 6 times as many property vertices (457,604
  against 76,479) and it costs 2 times as much per move.
- **Cutter and tool vertices.** A cutter vertex on the seam loop (where the skin meets the
  cutter) is also a vertex of a skin triangle. It moves with that tie. On the box cuts that
  were tried, the cap had no inner vertices: all its vertices are on the seam. A union tool's
  own vertices away from the seam cannot be tied. The spike keeps them at rest.

Distance from each placed vertex to the true pose-1 surface (layout A; layout B is the same
within 0.5 mm):

| Case | Skin, max / mean | Seam / cap vertices, max / mean | Untied |
| --- | --- | --- | --- |
| Control: skin left at rest | 40.8 / 7.1 mm | | |
| The part's wrist cut | 0.000015 / 0.000001 mm | 0.0000 / 0.0000 mm (272) | 0 |
| Wrist cut + sphere r8 on the palm | 0.000015 / 0.000001 mm | 0.0000 mm (436) | 265 sphere vertices, error 0 (the palm does not move) |
| Stress: a cut through the moving index finger (z > 128) | 1.03 / 0.0002 mm | 1.48 / 0.055 mm (662) | 0 |
| Stress: sphere r6 on the index finger | 0.000015 / 0.000001 mm | 0.0001 mm (430) | 254 sphere vertices, 7.6 / 3.6 mm left behind |

The skin errors are float32 rounding. Against the plan's own pose-1 surface, the skin error
is under 0.00001 mm in every case. In the stress cut the true build cuts the curled finger
at the same world plane, so the cap moves to another place on the finger. The placed cap
moves with the skin. This is the bend that Part 3 accepts, and it is at most 1.5 mm for this
curl. On the part's own cut the error is zero, because the finger curls do not move the
wrist.

**Cost per move** (main thread): 8 to 9 ms with layout A. That is `applySubdivPlan` 4.2 ms,
placing the 76,479 vertices and computing area-weighted vertex normals 2.1 to 2.7 ms, and the
remainder allocation. The part's cage code and `snapshot()` are another 1.7 ms. Layout B is
16 to 23 ms. Reading the tie back (one barycentric per corner) runs once per exact build in
the worker. The spike did not time it.

**Constraints on the design:**

1. **Union tools that are not skin do not follow the drag.** Their vertices must be kept at
   rest (correct only when the skin under them does not move), or moved rigidly with a
   nearby skin point, or the case must be refused. The design must choose one. Cut caps
   with no inner vertices are fine.
2. **The `topologyKey` is not stable over the hand's own thumb range.** `thumbCurl` 20 to 45
   gives a key different from the default (10). `extrude` numbers its side faces from a
   geometric first edge (`cage.js` `orderedSides`/`firstEdge`), so the `thumb2` side faces
   change ids when the thumb turns. The quads are the same and the plan gives the correct
   surface, but the gate in "Recognise the case" would refuse the drag. The spike leaves the
   thumb at its default for this reason. Before Part 3, either number the sides from
   topology only, or make the key ignore which side id a quad has.
3. **The import must set `faceID`** (`manifoldFromWeldedMesh` does not today) and keep the
   rest limit mesh beside the solid (`subdivSources` already holds it). A solid that was
   transformed needs its run's `runTransform` undone before the weights are computed, as
   `bindingRepair` does. A `label()` or other re-stamp that gives the run a new
   `originalID` must map the old id (`idMaps`), or the skin is not found.
4. **Level 4 is the ceiling for display rate:** 153,600 triangles cost about 9 ms per move.
   A body at level 5 (4 times the triangles) would cost about 35 ms.

## Part 4: dragging on a public page

A cached preview (`mountPreview({ part })`) hides a handle whose parameter rebuilds a
sub-part (`previewHandlesStepper`, `src/framework/preview-pose.js`). So today a cage
hand cannot be dragged on a forge page.

- **The preview file carries the weights.** The preview encoder stores Part 3's
  per-corner weights for each sub-part whose build is drag-capable. This is a new
  encoder version (7). A file without them plays as today.
- **The preview shows the handle.** `previewHandlesStepper` accepts a handle when, at
  every sample of its parameters, each sub-part is either rigidly placed (today's rule)
  or is drag-capable with the file's topology key. `partforge measure` then lists it
  under "preview handles".
- **Per move.** The preview runs the part's cage code through the probe (pure
  JavaScript, no kernel), builds the plan once, applies it, runs the drag validity
  check, and places the corners. There is no exact build after it: a preview is display
  only, and its file is not changed.
- **Stopping.** A pose that fails the check is not drawn and the handle stops, as in
  the editor.
- **Host app.** partforge-cloud raises its cache floor to encoder 7 and runs its
  preview backfill, as it did for encoders 4 and 6. Until a forge has a version 7
  file, its cage handles stay hidden on its page.

## Docs, lint and the agent

- The guide's cage section says a pose drag on a cage follows the pointer, names the
  three differences above, and says what does not take the fast path.
- `partforge measure` already prints "hidden in a preview: … rebuilds …" for such a
  handle. No change.
- No new lint rule. `handle-limb-per-joint` already steers a limb to one `angles`
  handle per chain.
- Host app (partforge-cloud), after release: bump, regenerate prompts, and change the
  organic rule, which today keeps "a limb the user drags in Pose mode" for
  `k.implicit`. Then rerun the paw, whale, hand and pebble eval cases.

## Order and gates

1. **PR 1: Part 1**, the recipe, the reworked hand and `cage-hand.js`.
2. **PR 2: the bench and Part 2.** Gate: on the cage hand with its flat cut, the time
   from one drawn drag shape to the next is 33 ms or less in a browser on the bench
   machine (worker build, mesh transfer and the viewer's upload together). The Node
   bench explains the number; it is not the gate. If it lands between 33 and 120 ms, it
   still ships (the hand then follows the pointer, more slowly) and Part 3 is planned.
3. **PR 3: the Part 3 spike, then Part 3.** Gate: the spike places every corner of the
   cut cage hand. Then the editor's drag is measured on both paths and the faster one
   that keeps the anti-goals is used.
4. **PR 4: Part 4**, encoder 7 and the preview drag.
5. **partforge-cloud:** bump, prompts, rule wording, cache floor to 7, backfill,
   evals.

Each PR is useful without the next.

## Tests

- Topology key: equal after `move`, `scale`, `rotate` with other values; different
  after an extra `extrude`, a changed `steps`, a new crease, and a changed face order.
- A drag build with the level and diagonals of a full build at the same pose gives the
  same vertex positions as that full build, to float precision.
- A drag build after a topology change is a full build.
- A release at the last drag pose is not answered from the cache.
- A slider drag draws drag shapes and reports nothing to the host until the pause build
  lands; `setParams` and an animation take the ordinary path.
- A drag into a pose that cuts through itself does not draw it: the handle's
  parameters return to the last valid values, and a slider's value returns on release.
- A fine crossing the coarse check misses is refused by the release build, and the
  parameter returns to the last value whose full build passed.
- A preview with a version 7 file shows the cage hand's handles and drags them; with a
  version 6 file it hides them.
- A mirrored cage and a creased cage take the fast path.
- The cage hand: every handle drags, and `partforge measure --drag` reaches a target
  within reach.

## Left to the builder

- The cache's shape and size, and where it lives beside the existing per-tier body
  cache.
- The name of the held-drag flag and of the worker's "fast drag build available" reply.
- In Part 3, how per-corner weights ride through Manifold booleans.
- Whether the hand keeps one `curl` slider beside the per-finger parameters.

## Open for the owner

1. **Is 33 ms the right target**, or is "under 120 ms, follows the pointer" enough to
   stop after PR 2?
