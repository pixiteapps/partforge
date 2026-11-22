# Dragging a cage body: fast pose drags for `k.cage` + `k.subdiv`

Date: 2026-11-22. Follows `2026-11-19-smooth-organic-surfaces-design.md`, which ruled this
out ("Frames and skinned pose drag for subdivision bodies" is a non-goal there, because
"a cage rebuild is tens of milliseconds"). That holds for a small cage. It does not hold
for a hand.

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

1. A handle drag in Pose mode on the guide's cage hand updates the shape on screen at
   30 moves a second or better (33 ms or less from one drawn shape to the next, measured
   in a browser on the bench machine). A panel slider is not in this goal; see "Open
   for the owner".
2. The shape on screen during the drag is the real smooth surface for the dragged
   values, not a bent copy of the old one. Small, stated differences are allowed (see
   "What the drag shape may differ in").
3. No new agent-facing API. The agent writes an ordinary cage, an ordinary `limb` and an
   ordinary handle.
4. The guide teaches the limb-driven cage, and the worked hand uses it.

## Non-goals

- Frames, bindings or skinning for a cage. A cage has none and gains none.
- `contact`, surface detail or blends for a cage. Those stay with `k.implicit`.
- A fast path for a change that adds, removes or reorders cage faces (an extrude count,
  a `steps` value, a crease). Those rebuild as today.
- The print tier. The fast path is for the preview tier in the viewer.
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

### The topology key

A cage snapshot is `{ points, faces, ids, creases }`. Its **topology key** is a hash of
everything but `points`: the faces (as point indices), the ids in order, and the
creases. Two snapshots with the same key have the same smoothing weights at every
level.

### The drag build

The viewer already marks builds made while a pose handle is held: they are transient
(`cycleTransient` in `mount.js`), drawn but not reported, and release owes one real
build. A panel slider edit is not transient: it is an ordinary debounced build that is
reported, exported and measured, with no release build after it. So the fast path
applies to handle holds only, and the viewer sends a new flag on those builds (the
existing `provisional: false` is sent only for skinned drags and playback). For a
flagged build of a `k.subdiv` on the preview tier, when the worker holds a drag entry
with the same topology key:

- **Reuse the level** chosen by the last full build. No level search.
- **Reuse the structure** `fromSnapshot` and each `step` built (edge maps, child
  indices, sharp flags, crease regions). Only positions are recomputed.
- **Reuse the quad diagonals** of the last full build.
- **Skip the self-intersection check.**
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

**The viewer must let the hand rebuild live.** Today `hold(true)` decides
`liveRebuild` once, from the time of the last real build (`lastBuildMs <
LIVE_REBUILD_MS`). The hand's real build is always slow, so it would never start, and
no drag build would ever be sent. Change: with each full build of a sub-part that
holds a drag entry, the worker replies that a fast drag build is available, and the
viewer starts such a hold live. The first drag build's own time then drives the
existing `liveSlow` rule: if it runs past the limit, the part fades as today. (My
call; the reply field's name and shape are the builder's.)

### What the drag shape may differ in

- **Level.** If the full build would pick another level at the new pose, the drag shape
  is coarser or finer by one level until release.
- **Diagonals.** A quad split the other way moves the surface by less than the chord
  tolerance.
- **Validity.** A drag can pass through a pose where the body cuts through itself. The
  drag shape shows it. On release the full build throws or warns as today, and the
  viewer's existing failed-build path applies.

All three resolve on release.

## Part 3: re-apply the weights in the viewer (only if Part 2 is not enough)

If the Manifold import, the booleans or the worker round trip keep the hand above the
goal, move the per-move work to the viewer, the way the implicit drag does.

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
- **Exact build.** After a 150 ms pause or on release, as the implicit drag does.

In this part a vertex made by a `cut` moves with the surface it lies on, so a flat base
bends slightly during the drag. That is display only.

## Part 4: draggable on a public page (separate decision)

A cached preview (`mountPreview`) hides a handle whose parameter rebuilds a sub-part
(`previewHandlesStepper`, `src/framework/preview-pose.js`), so a cage hand cannot be
dragged on a forge page. Part 3's weights, stored in the preview file, would allow it.
That means a new preview encoder version, which moves the host app's cache floor and
needs a backfill there. It is out of this spec unless the owner asks for it; noted so
Part 3's data shape does not rule it out.

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
3. **PR 3: Part 3**, only if PR 2 misses 33 ms.
4. **partforge-cloud:** bump, prompts, rule wording, evals.

Each PR is useful without the next.

## Tests

- Topology key: equal after `move`, `scale`, `rotate` with other values; different
  after an extra `extrude`, a changed `steps`, a new crease, and a changed face order.
- A drag build with the level and diagonals of a full build at the same pose gives the
  same vertex positions as that full build, to float precision.
- A drag build after a topology change is a full build.
- A release at the last drag pose is not answered from the cache.
- Release after a drag runs the self-intersection check: a pose that cuts through
  itself draws during the drag and fails on release, and the previous exact mesh
  returns.
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

0. **Panel sliders.** This spec speeds up handle drags only. A slider edit is an
   ordinary reported build, so giving it the fast path would let the unchecked drag
   shape be exported and measured. Bringing sliders in needs a hold and release for
   the panel, which the viewer does not have. In scope later, or not needed?
1. **Is 33 ms the right target**, or is "under 120 ms, follows the pointer" enough to
   stop after PR 2?
2. **Public pages (Part 4):** in scope later, or not wanted?
3. **A self-cutting pose during a drag** is shown and then refused on release. The
   alternative is to stop the drag at the last valid pose, which costs the check on
   every move.
