# Dragging the pose of an organic part

Date: 2026-10-31. A PR into `feat/implicit`, before #297 merges to main. Replaces design PR 3
("block sample cache", goal "a warm pose move ≤ 80 ms") of
`2026-10-14-implicit-organic-parts-design.md`. Numbers below were measured on the hand
reference part (`src/parts/hand.js`) at `bf58376f`, on the development desktop.

## Why

Posing an organic part is too slow to drag a slider, and slow even stepping between
settings. A pose change on the hand costs ~650–750 ms in the worker before the viewer gets
it: the body's `k.implicit` 250–400 ms at the 1.5 mm preview grid (sampling ~110, cleanup
~120), five fine-grid nails ~90 ms, the Manifold union joining them ~170 ms, `toMesh`
~35 ms. The owner wants to drag pose sliders continuously, "as fast as we can get it".
They accept that the shape looks approximate WHILE dragging, as long as it becomes the
exact shape when they let go.

## Goals

1. **Drag at frame rate.** While a slider that changes only the spec's frames is being
   dragged, the viewer shows the last exact mesh deformed by the new frames, at display
   rate (target: under 16 ms per update on the hand, main thread), with no worker job.
2. **Exact on release.** When the drag ends (pointer up, or no change for a short pause),
   the exact build runs and replaces the deformed mesh. Nothing approximate is ever exported,
   measured, verified or captured.
3. **A faster exact rebuild.** A pose change's exact build reuses the field samples of the
   previous build where the field did not change, and skips work the preview does not need.

## Non-goals

- Re-solving contact while dragging: fingertips may pass into the palm until release.
- Skinning parts whose drag changes shapes, sizes or blend widths (not only frames): those
  take the faster exact rebuild, not the deformed preview.
- Skinning non-organic sub-parts: they already have the pose fast path
  (`pose-fast-path.js`), which this design leaves alone.
- Animations (`animations` timelines). A later step may use the same deformation for them.

## Anti-goals

- The deformed mesh must never reach an export, `measure`, `verify`, a capture
  (`captureViews`, `exportPreview`, thumbnails) or the geometry cache as if it were exact.
- No change to any exact build's output: same mesh bytes, same hashes
  (`test/core-parity.test.js` and the pinned implicit hashes stay as they are).
- No new per-part authoring: a part with frame-posed `k.implicit` bodies gets this without
  declaring anything.

## How it works

### 1. Bindings: which frames move each vertex

Every exact `k.implicit` preview build also produces a **binding** for each output vertex:
up to two frame names and a weight (a vertex near a joint blends between the two bones
that meet there, so the joint bends instead of tearing). My call on how: a vertex binds to
the frame(s) of the nearest posed node(s) of the IR (the nodes a `frame` places); the
builder picks the exact rule (nearest primitive's frame, with a blend weight over a band
around equal distance is the starting point) and makes it cheap — the hand has ~77k
preview vertices and ~60 primitives.

Bindings ride with the delivered mesh to the main thread as extra arrays (two Uint16
frame indices and one weight per vertex, plus the frame-name table). Preview only: export
tiers never compute them.

**The union problem.** A sub-part's solid is often several `k.implicit` bodies joined by
ordinary ops (the hand: body + five nails, unioned). Bindings must survive that. Manifold
carries per-vertex properties through booleans (`numProp` / `vertProperties`), so the
binding can travel as vertex properties and come out of `toMesh`. A vertex that comes from
a non-implicit solid gets no binding (it stays put while dragging). If a sub-part's
bindings cannot be recovered, that sub-part simply does not skin (it waits for the exact
rebuild) — never a wrong binding.

### 2. Detecting a frames-only drag

On each slider change the main thread already runs the geometry-free probe. For a sub-part
whose delivered mesh carries bindings, compare the `k.implicit` specs the probe recorded at
the new params with those recorded at the delivered mesh's params. If every spec is
identical except for values inside `frames`, the change is frames-only: skinnable. Anything
else (a node changed, a frame added or removed, a different number of `k.implicit` calls)
is not.

### 3. Deforming

For a frames-only change, resolve both frame sets (`resolveFrames`, pure, main thread),
compute each frame's motion (new world × inverse old world), and move each bound vertex by
its frames' motions blended by weight (linear blend skinning); normals likewise. Write the
result into the viewer's existing geometry in place (`viewer.requestRender()`; see the
"viewer draws on demand" invariant). The deformation is always computed from the delivered
mesh, never from a previously deformed one, so nothing drifts.

The sub-part's `place()` still applies on top, as today.

### 4. Release and the exact rebuild

The regen loop does not dispatch an exact build while a skinnable drag is in progress (it
is marked stale). On release (pointer up on the control) or after a short pause with no
change (my call: 150 ms), the exact build is dispatched; its delivery replaces the
deformed mesh and its bindings. If the user drags again before it lands, the delivery is
still exact for the pose it was built at and carries bindings, so for a skinnable sub-part
it becomes the new skin base (deformed at once to the current pose) instead of being
discarded as stale; the regen loop's stale-discard contract is unchanged for every other
sub-part. (My call: otherwise the base never advances during a long drag, and contact
errors such as a fingertip inside the palm persist until the user stops.)

A host that drives params itself (`runtime.setParams`) gets the exact build as today: the
deformed preview is for interactive slider drags only. (My call; a host can opt in later.)

### 5. A faster exact rebuild

- **World-aligned sample cache.** Sampling uses a grid anchored to the world lattice
  (multiples of the grid edge), with leaf blocks aligned to it, so two poses share leaves.
  A leaf whose program and inputs are unchanged reuses its samples. Measured potential on
  the hand, share of the new pose's samples identical to the old pose's at the same world
  point: one finger's flex 87–90%, thumb opposition 65%, curl (all fingers) 53%, spread
  35%. Sampling is ~110 ms of a hand build, so this saves up to ~100 ms. The builder
  decides how a leaf knows it is unchanged (e.g. a hash of the leaf's program plus the
  resolved transforms it reads) and how big the cache may grow (bounded; evicts by age).
  Anchoring the grid must not change any EXPORT-tier output; whether it may change the
  preview tier's bytes is for the builder to measure and decide, recorded in the plan.
  **The cache lives in the native core too.** The browser meshes on the native core
  (`NativeSession.sample` evaluates every leaf in `ip_sample`), so the cache needs a native
  entry that skips cached leaves and takes their preloaded values (and owners, on the
  contact path), a rebuilt committed `core-wasm.js`, and parity tests holding core on and
  off bit-identical — in this PR. A JS-only cache would speed only the fallback.
- **Two-stage delivery for unions of implicit bodies (decided by the owner).** The 170 ms
  Manifold union of the hand's nails onto its body dominates after the engine. When a
  sub-part's preview build unions `k.implicit` results, the worker first delivers the
  pieces' meshes concatenated (no boolean: overlapping shells, but each piece exact), then
  the real union, which replaces it moments later. Only the real union is ever "at rest":
  the concatenated stage is marked provisional, the regen loop does not count the sub-part
  current until the union lands, and nothing that reads geometry as exact — the `inspect`
  job (measure/verify), `capture-generate`, `exportPreview`, the change tracker, the
  geometry cache, the cutaway's section cap — ever sees the provisional stage (they read
  the union, built by their own paths, or wait for it). Exports always do the real union.
  Bindings ride on both stages.

## Measuring

- A bench (`scripts/bench-implicit.mjs` or a sibling) reports, on the hand: the deform time
  per drag update, the exact rebuild time for a one-finger and an all-finger pose change
  (cold and warm cache), and the binding cost added to a preview build.
- Targets: deform < 16 ms per update; the warm one-finger exact rebuild noticeably below
  today's ~650 ms (the plan states the measured result; no fixed number is promised).

## Tests

- Bindings: a two-bone `k.implicit` (two capsules on a parent and child frame) binds its
  vertices to the right frames, with blended weights near the joint; bindings survive a
  Manifold union with another `k.implicit` and with a plain box (whose vertices are unbound).
- Detection: frames-only changes are skinnable; a node, size, blend or count change is not.
- Deform: a pure rotation of one frame moves exactly that bone's vertices by that rotation;
  deforming twice from the same delivered mesh gives identical results (no drift).
- Release: the exact build replaces the deformed mesh; an export or capture during a drag
  uses an exact build, never the deformed one.
- Cache: a pose change with a warm cache produces the SAME mesh as a cold build at that pose,
  with the native core on and off.
- Two stages: the concatenated stage arrives first and the union replaces it; an inspect,
  capture or exportPreview started between the two never reads the concatenated stage.
- Stale-but-exact delivery during a drag becomes the skin base for a skinnable sub-part, and
  is still discarded as stale for any other.
- Every existing pinned hash and `core-parity` test unchanged.

## Left to the builder

- The binding rule and its fast evaluation; whether bindings are computed in the native
  core or JS (JS first is fine if the cost is small; parity rules apply if it goes native).
- The leaf-unchanged test and the cache bound.
- How the worker recognises a union of `k.implicit` results and sends the two stages, and
  how mount marks the first provisional.
- The pause length before the exact rebuild.

## Calls I made (not discussed)

- Bindings use up to two frames per vertex with one weight.
- The deformed preview is for interactive slider drags only, not `setParams` from a host.
- 150 ms pause, or pointer up, triggers the exact build.
- A sub-part whose bindings are lost does not skin rather than guessing.
- Animations are out of scope for now.
