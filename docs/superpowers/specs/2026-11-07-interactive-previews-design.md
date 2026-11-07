# Interactive previews: handles, IK and collisions without a kernel

Status: design, 2026-11-07. Follows the cached-preview design
(partforge-cloud `docs/superpowers/specs/2026-10-11-forge-mesh-cache-preview-design.md`),
the animated-preview design (`2026-10-16-preview-animation-design.md` there),
and in this repo `2026-10-30-inverse-kinematics-design.md`,
`2026-11-02-generic-handles-design.md` and `2026-11-02-collisions-design.md`.

## Intent

A cached preview GLB is what a visitor sees first: on the public forge page,
in the in-app viewer before the kernel boots, and in every surface built on
`mountPreview`. Today it is a still, or a baked animation, and nothing more.
The editor's handles (drag a gear, slide a drawer, pull a robot arm's tool
and watch inverse kinematics pose the links, with pieces stopping against
each other) are the part's most compelling behaviour, and the preview hides
all of it.

The observation this design rests on: **Pose mode, the IK solver and the
collision guard never touch geometry.** They read three things, the part's
`derive` (limbs, gear trains), its `handles` block, and each sub-part's
`place()` as a rigid matrix, and they run in plain JavaScript on the main
thread already. Collisions index the viewer's own meshes, which a preview
has. The preview lacks only the part module, and one fact: the parameter
values its meshes were posed at. Supply both and the preview can pose, solve
and collide exactly as the editor does, for every handle that does not
rebuild geometry.

## Goals

- A preview mounted with the part module shows the handles the editor shows
  in that view, less any that would rebuild geometry, and drags them with
  the editor's behaviour: hover reveal, dots, arrows, guides, the aim and
  joint gizmos, pins, the readout pill and release chip, the resting cue,
  touch rules.
- Limb handles (goal and angles) solve IK through the same `param-solve`
  path, with the same pins and joint-ring forward kinematics.
- A part with a `collisions` block that leaves Pose mode on gets the same
  stop-and-slide guard and contact tint in the preview.
- A drag on a preview whose baked animation is playing starts from the pose
  the animation is showing, with no visible jump.
- Nothing changes for a preview mounted without the part module, and
  nothing changes for the editor's own boot preview.

## Non-goals

- Handles that rebuild geometry. A preview has no kernel by definition. Such
  handles are hidden in a preview, never shown half-working.
- A control panel, sliders or any parameter UI in the preview. Drags write a
  local params object the host may read; the preview edits no source.
- Carrying a preview's pose or pins into the editor, or back. The drag is a
  look at the part, not an edit of it.
- Measure, sketch, cutaway or picking in the preview. Unchanged.
- Realistic-mode print frames, sheet looks and the other known preview
  residuals. Unchanged.
- Lifting the editor's preview gate (`mount({ preview })`) for place-only
  handles. The live build lands within seconds there; the value of this
  design is on surfaces that never get one. Noted under "Later".

## Anti-goals

- **A handle that does nothing.** A dot the visitor can grab that moves
  nothing, or moves the wrong piece, is worse than no dot. A handle shows in
  a preview only when the design can prove every piece it moves is moved by
  a rigid placement over the mesh already in the file.
- **A wrong pose.** The preview must never pose a mesh by a matrix computed
  against parameters other than the ones the mesh was built at. Hence the
  file carries its params and the preview seeds from them, never from the
  part's defaults by assumption.
- **A heavier first paint.** A preview mounted without the part module must
  load nothing new. With it, Pose mode's own modules load as the editor
  loads them, and the collision world (BVH and native core) still loads
  lazily on the first idle slice, never before the first frame.
- **Two copies of a rule.** Which handles are place-only, how a mesh is
  carried from one placement to another, how a drag is guarded: each has one
  definition today and keeps it. This design adds a thin layer that calls
  them, not a second spelling.

## Constraints

- The part module is loaded on the main thread, as `mount()` loads it, and
  must stay DOM-free and side-effect-free as `docs/AUTHORING-PARTS.md`
  requires. Nothing here relaxes that.
- No `instanceof` across the part boundary. A limb or point source is
  recognised by plain-data `handleInfo()` / `ikInfo()` (handle-source.js's
  rule), since partforge-cloud's sandbox may hold two copies of this code.
- `encode-preview.js` stays worker-safe and deterministic; its version bumps
  whenever the bytes for the same input change, since downstream caches key
  on `PREVIEW_ENCODER_VERSION`.
- Every file version 1 through 5 still decodes and still mounts as today.
- `test/worker-layering.test.js`, `test/gltf-layering.test.js` and
  `test/oracle-entry.test.js` keep passing: nothing new reaches the worker
  graph or the oracle entry that carries three.js, the DOM or `node:`.
- The release rule holds: bump `package.json` on the feature branch.

## Current state the builder should know

- `src/framework/mount-preview.js` builds `createViewer` from a synthetic
  part (`previewPart`: one sub-part per GLB mesh, its `display` block, no
  parameters, no handles) and draws each decoded mesh through
  `viewer.setSubGeometry`. The meshes are in the part's Z-up model frame,
  POSED: `exportPreview` bakes each sub-part's fast-path matrix into the
  positions (`viewer.getSubMeshPayload`), and the server job encodes
  `buildView`'s posed output. A sub-part's mesh therefore sits at
  place(exportParams) applied to its canonical build, with ONE exception:
  in a file with a baked animation, every tracked sub-part's node carries a
  rest TRS of M(0) · base⁻¹, and the decoder reads positions through the
  node's world matrix, so a tracked mesh decodes at the animation's t = 0
  pose, not at the export params ("meshes decode at the OPENING pose",
  decode-preview.js). The params a file's meshes sit at are the export
  params with the autoplay animation's t = 0 values over them.
- `preview-player.js` poses a baked animation by `viewer.setSubPose(name,
  M(t) · rest⁻¹)`: an absolute matrix over the baked mesh, identity at t = 0.
  The same call is how the editor's pose fast path moves a mesh.
- `collide/world.js`'s `relativeMatsAt(part, view, startP, startD)` returns
  `(p, d) => Map(name → place(p, d) · place(start)⁻¹)` for every in-view
  sub-part, null for one whose placement is not a trusted rigid motion.
  `collide/place.js`'s `placeMatrix` is the one definition of "a placement
  as a rigid matrix": the fast rigid token, else the place-scope probe,
  trusted with the CANONICAL hash, composed and checked by `isRigid`.
- `pose/pose-mode.js`'s `createPoseMode(viewer, opts)` takes the part, the
  viewer's `orbitControls`, and the session effects as functions:
  `getParams`, `write`, `commit`, `restore`, `staleSubParts`, `ghost`,
  `unghost`, `hold`, `collide`, `onBlocked`, `visibleHandles`,
  `hoveredSubPart`, `cueBlocked`. It reads `viewer._subMeshes` for the parts
  frame and `viewer.domElement` for pointer events. Mount's wiring is at
  `mount.js` around the `createPoseMode` call; `attachPoseControls`,
  `attachDragReadout` and `attachReadoutChip` are the three chrome pieces.
- `pose/pose-collide.js`'s `createPoseCollide` takes `part`, `viewer`
  (`hasSubMesh`, `getSubMeshLocal`, `_subMeshes`), a `fastPath` of which it
  calls only `matricesAt(p, d, names)`, `getView`, `getParams`, `isLive`,
  `frameOf(name)` (only `"canonical"` is indexed), and `createHighlight`.
  `handleKeys(handle, allHandles, params)` there is the set of params one
  drag of a handle can write.
- `preview-animation.js`'s `samplePreviewAnimation` already answers "is this
  motion place-only against the file's meshes": build reads first, then,
  because a one-function derive over-reports reads, the build-scope probe's
  identity (`baseHash` + trailing pose) compared across samples. Its rulings
  (fail closed, a querying build is never trusted, the shown set must not
  change) are the rulings this design reuses for handles.
- `lint/rules-handles.js`'s `handle-inert` samples each listed param at
  0 / 25 / 50 / 75 / 100 % of its range (`INERT_SAMPLES`).
- `animation.js`'s `viewAnimations(part).get(view)` finds the autoplay
  animation and `evaluate(anim, t)` returns `{ values, opacity }` at
  normalized t. The preview player's `state()` reports its `t`.
- `mountPreview` throws on any option it does not know (`KNOWN_OPTIONS`).
  Its handle is typed as `PreviewRuntime` in `types/index.d.ts`.
- partforge-cloud mounts previews in `src/sandbox/mountManager.js`
  (`showPreview`), on the public page through `?mode=preview`, which skips
  esbuild and never creates the worker pool. The owner's copy is exported by
  `runtime.exportPreview()` at the params live in the editor; the server's
  copy is built at the part's defaults.

## The design

### 1. The file carries the params it was posed at

`encodePreviewGlb({ meshes, part, view, params?, animation? })` gains
`params`: **the params the meshes sit at**, as the caller knows them. The
writer stores, as a top-level extra `partforgeParams`, the JSON-safe
primitive subset of what it is given: finite numbers, strings and booleans,
nothing else. It does not consult `part.defaults` or the schema (the
server path hands it a `PreviewPart` slice, and that must keep working). An
asset-valued or otherwise non-primitive param is left out; nothing a
placement reads is of that kind. `params` omitted writes no extra: that is
the first-class meaning "posed at the part's defaults", which is exactly
the server job's case. `PREVIEW_ENCODER_VERSION` becomes 6.

`exportPreview` in `mount.js` passes `{ ...part.defaults, ...params,
...opening }`, where `opening` is `evaluate(anim, 0).values` for the
autoplay animation the file bakes (`samplePreviewAnimation`'s returned
`anim`), or nothing when the file carries no animation. That is the
parameter set the decoded meshes sit at (see "Current state"). A server job
that bakes an animation does the same; one that does not passes nothing.

`decodePreviewGlb` returns `params`: the extra as read, or `null` for a file
without it (a version 6 file posed at the defaults, and every version 1
through 5 file). A preview that receives `null` and a part seeds from the
part's defaults. For a legacy file that is right from the server path, and
right from the editor path whenever the owner had not moved a slider and
the view's animation started at the defaults. The residual is accepted: an
old owner's-copy file posed off those could pose wrongly until it is
re-exported, and the cloud's next checkpoint or server lap rewrites it
under the new version.

### 2. `mountPreview({ glb, part })`

A new option, `part`: a `PartDefinition`. Without it the mount is byte-for-
byte today's. With it, once the GLB has decoded and been drawn:

- The preview holds its own `params`, seeded `{ ...part.defaults,
  ...decoded.params }` (decoded.params null: the defaults). Call that seed
  the **file params**: what the meshes sit at. This is the object every
  effect reads and writes, through the same `writePoseValues`-shaped path
  mount uses (clamp to the schema's range, keep a wrapped param's turn),
  with no panel, no regen loop and no source write. While a baked animation
  plays, the params the session and the overlay read follow the player
  (§5).
- A **preview placer** (new module, `src/framework/preview-pose.js`, pure:
  no DOM, no three) is built over the part, the view, the file's params and
  the names of the meshes drawn. It computes each drawn sub-part's base
  placement once with `relativeMatsAt(part, view, p0, d0)`, and offers:
  - `matricesAt(p, d, names)` → `Map(name → place(p, d) · base⁻¹)`, null for
    a sub-part with no trusted rigid placement, exactly the
    `fastPath.matricesAt` contract `pose-collide.js` reads;
  - `apply(params)`: resolve, call `matricesAt`, and `viewer.setSubPose`
    each changed matrix (an unchanged one is never re-sent, as the fast path
    rules: setSubPose restarts the contact shadow). A null matrix leaves the
    mesh where the file put it.
  The placer is mountPreview's whole pose ladder: rung 1 only, every mesh
  canonical, base taken from the file instead of the delivery.
- `createPoseMode(viewer, …)` attaches with: `part`, `orbitControls`,
  `getParams` the preview's params, `write`/`restore` writing them and
  calling the placer's `apply` inside the drag frame's `withDeriveMemo`
  scope, `commit` calling the host's `onDragEnd`-adjacent callback (below),
  `staleSubParts` always `[]` (nothing in a preview is ever stale: a handle
  that would make something stale is not shown, §3), `ghost`/`unghost`
  no-ops, `hold` pausing the player (§5) and otherwise a no-op, `collide`
  and `onBlocked` from §4, `visibleHandles` from §3, `hoveredSubPart` a
  per-frame raycast of the last pointer position against `viewer._subMeshes`
  through `selection/raycast.js` (it treats feature ids as optional, so it
  works on preview meshes as-is; this is what makes a `showOn` handle show
  over its sub-part here as it does in the editor), `cueBlocked` while the
  baked animation is playing (as mount blocks it behind the opening
  autoplay).
- The three chrome pieces attach as mount attaches them: Release pins in
  `#viewbar` when there is one, the drag readout in the viewbar's readout
  slot, the readout chip on the stage. Under `chrome: false` there is no
  viewbar, so no Release pins action and no readout pill; the chip still
  shows (it is the stage's), and `handle.pose.releasePins()` is the host's
  way to drop pins. Pins are not carried in `getViewerState` (non-goal).
- The handle gains `pose`, the subset of mount's `runtime.pose` that means
  something here: `isLive()`, `pinCount()`, `releasePins()`, `handlePoints()`,
  `onDragEnd(cb)`, plus `getParams()` (a copy). Null-safe before `ready`
  and after dispose, like `motion`. A preview mounted without `part` gets
  mount's no-op stand-in (`NOOP_POSE`), never an absent field.
- `dispose` detaches Pose mode late, as mount does, so a drag in flight
  cancels into a torn-down scene without writing anything.

### 3. Which handles a preview shows

A handle shows in a preview when it would show in the editor in that view
(`handlesShownInView`, the one rule) AND it is **place-only against the
file**. Place-only is decided once per handle at mount, geometry-free, by
the rulings `samplePreviewAnimation` already uses:

1. Let `keys` be `handleKeys(handle, allHandles, params)`: every param one
   drag of it can write (its DOFs, a goal's position, aim and seed, its
   joint rings').
2. Let `view set` be the view's sub-parts at the file params, and `drawn`
   that set intersected with the meshes the file holds. The two differ
   legitimately: the encoder gives a sub-part whose build returned EMPTY no
   node, so a view sub-part missing from the file is read as "empty at the
   file params", never as a broken file. It takes part in the identity test
   below (a handle whose key would give it geometry is hidden by that
   test), and is left out of the placement test and of the placer.
3. For each `key` in `keys`, sample it at 0 / 25 / 50 / 75 / 100 % of its
   schema range (the `handle-inert` samples; a key with no numeric range is
   sampled at its current value only). At every sample, with the other
   params at the file's values:
   - `viewSubParts` must equal the view set (a sub-part that comes or goes
     with the key is a rebuild in disguise);
   - every sub-part in `drawn` must have a trusted rigid `placeMatrix`;
   - every sub-part in the view set whose build-scope probe at the file
     params is trusted must keep the same build identity (`baseHash` +
     trailing pose) at the sample; a sub-part whose build probe is NOT
     trusted at the file params (a querying build, a function argument, a
     throw) fails the handle, since nothing can say its mesh would not
     change.
4. Any throw fails the handle. Fail closed.

The reference parts pass as expected: at their defaults every shown
sub-part of robot-arm, hand, gearbox and drawer-box has a trusted build
probe and a rigid placement (checked while this design was reviewed), so
only the drawer box's corner handle is hidden, by the identity test.

Limb handles pass this through their joint params: a robot arm's links are
placed by `d.arm.place`, so every joint's sample keeps every build identity
and moves only placements. The drawer box's corner `plane` handle writes
`width`/`depth`, which the box's build reads, so it fails and is hidden;
each drawer's `axis` handle passes. A `group` whose members all fail shows
nothing; one that keeps a member behaves as a group of what is left.

The test runs after `drawn` resolves, in idle time, so it never delays the
first frame. Handles appear once it finishes (the resting cue then runs
from that frame). Its cost is a geometry-free probe pass per sample per
shown sub-part; for the hand (the largest reference part) that is on the
order of a few hundred probe calls, well under a second on a phone, and the
builder measures it.

The decision is exposed for the oracle and tests as a pure function in
`preview-pose.js` (`previewHandles(part, view, params, meshNames) → { shown:
[ids], hidden: { id: reason } }`), with reasons in the wording of
`samplePreviewAnimation`'s refusals, so a part author can learn from the
CLI why a handle is missing from their forge's preview. `partforge measure`
prints a `preview handles:` line from it when the part declares handles.
Lint does not gain a rule in this design (a handle that rebuilds is a
legitimate editor handle).

### 4. Collisions in the preview

`createPoseCollide` is reused unchanged, constructed with the preview's
pieces: `part`, the viewer, the placer in the `fastPath` seat (only
`matricesAt` is called), `getView` the file's view, `getParams` the
preview's params, `isLive` Pose mode's, `frameOf` answering `"canonical"`
for every drawn mesh (a file holds no posed-frame deliveries; the base
inverse in the placer is what makes every mesh canonical to the guard), and
`createHighlight` the feature highlight, as in mount. `delivered(names)` is
called once with every drawn name after `showAssembly`; `refresh()` never
(a preview has one view).

The world module and the native core load on the first idle slice as they
do in the editor, so a part without a `collisions` block, or with `pose:
false`, loads neither. The settle, the slide, the exemptions, the tint and
"Stopped at <piece>" in the readout all come for free.

### 5. A drag on a playing animation

While the baked animation plays, the meshes sit at the player's matrices.
Pose mode draws its dots, arrows and gizmos from `getParams()` every frame
the params move, hit-tests a press against them, and the session snapshots
`getParams()`, locates the pins' held points and builds the collision guard
from that snapshot BEFORE it calls `hold(true)`. So the params must already
be right when the pointer goes down; a fix-up inside `hold` is too late. The
rule, the same one the editor follows (handles show during playback there,
drawn from the params the animation writes each frame, and a drag pauses
it):

- **The params follow the player.** While the player is started and not
  paused or done, the preview's `getParams()` answers `{ ...fileParams,
  ...evaluate(anim, player.t).values }`, where `anim` is
  `viewAnimations(part).get(view)`'s autoplay animation, the one the file
  baked. Pose mode then re-reads its limbs once per frame while the
  animation plays, as it does in the editor during playback; a `derive`
  per frame is the price, and it is the price the editor already pays.
  Nothing is written: the player keeps posing the meshes by its own
  matrices, and the two agree, since place(p(t)) · base⁻¹ over the same
  mesh is what the baker sampled.
- **A press pauses.** On `hold(true)` with a player started: read its `t`,
  pause it (`player.pause()` cancels any camera tween, as it does from the
  button), and write `{ ...fileParams, ...evaluate(anim, t).values }` into
  the preview's own params, so `getParams()` keeps answering the same
  values once the player no longer drives them. The placer's `apply` finds
  every matrix unchanged. No visible change; the drag proceeds from there.
  The session's snapshot, the pins' held points and the guard's start pose
  were all taken from the same values, so cancel restores to the paused
  pose, not to t = 0.
- **Intro and paused states.** During the intro tween the player's t is 0
  and the rule above holds trivially. A player paused from its button (not
  by a press) already has its params written by the same path, in the
  player's `onChange` handler, so a later press finds them in place.

The animation stays paused afterwards. Play resumes it on its own track
from `t`: the drag's pose is dropped, since the animation's matrices are
absolute, and the params follow the player again from that frame. Opacity
keys are untouched throughout (a sub-part the animation faded stays at the
player's last opacity; a drag never writes opacity).

A player whose animation is not place-only never exists (the file carries no
channels), so this branch only ever meets a bakeable animation, whose
tracked keys are by construction place-only; the §3 test agrees with the
baker on them.

The turntable stops on a handle press as it does on a camera grab: Pose
mode's capture-phase pointerdown on a handle calls the same path the
viewer's `onCameraStart` listeners hear, or the preview wires its
`onDragStart`-equivalent to the turntable's `halt`. Either spelling is the
builder's; the behaviour is: a visitor who grabs a handle on a turning model
gets a still model to pose.

`motion.restart()` on a preview that has been posed puts the params back to
the file params, applies them (every mesh back where the file put it, which
for an animated file IS the t = 0 pose), releases nothing (pins stay), and
then does what it does today.

### 6. Versions and docs

- `PREVIEW_ENCODER_VERSION` 5 → 6 (§1). The decoder reads 1 through 6.
- `types/index.d.ts`: `MountPreviewOptions.part`, `PreviewRuntime.pose`,
  `PreviewRuntime.getParams`; `types/gltf.d.ts`: `EncodePreviewInput.params`,
  and the decoder's `params`.
- `docs/AUTHORING-PARTS.md`: a short "Handles in the cached preview"
  subsection under the handles section, stating the place-only rule in the
  author's terms (a handle whose params only move pieces shows in the
  preview; one that reshapes anything does not) and pointing at the CLI's
  `preview handles:` line.
- `AGENTS.md`'s preview paragraph gains the `part` option and
  `preview-pose.js`.
- `package.json` version bump on the branch.

## Testing

- `test/preview-pose.test.js`: the placer's `matricesAt` equals
  `relativeMatsAt` over robot-arm, hand, gearbox and drawer-box at their
  defaults and at off-default file params; `previewHandles` shows every
  robot-arm, hand and gearbox handle and hides the drawer box's corner
  handle while showing its drawers; a view sub-part missing from the file
  hides only a handle whose key would give it geometry; a querying build
  hides handles that touch it; a file without params seeds the defaults.
- `test/gltf-encode.test.js` and `test/gltf-encode-animation.test.js`: the
  params extra round-trips, non-primitive params are dropped, omitted
  params write no extra and decode to null, the version is 6, fixtures
  `preview-v1.glb` … still decode with `params: null`. An animated gearbox
  exported at `driveAngle: 90` (its animation starting at 0) stores the
  opening params, and a preview seeded from them poses its tracked meshes
  by the identity at t = 0.
- `test/pose-collide-wiring.test.js`-style test with the placer in the
  fastPath seat: a guard is built over the file's meshes, and a drag that
  would push two drawers into each other is held.
- A player test: while a gearbox preview plays, `getParams()` at the
  player's t = 0.4 equals the animation's values there and the placer's
  matrices for them are within 1e-6 of the player's; a press at that t
  pauses the player, writes those values, and a cancel restores them (not
  t = 0).
- A dev-only page `preview-pose.html` (not in `rollupOptions.input`): the
  app exports a preview of robot-arm (or the pose-smoke fixture) through
  `exportPreview`, then mounts it with `mountPreview({ glb, part })` beside
  it. `scripts/check-pose.mjs` gains an entry for it: a drag of the tool
  handle commits once, posts no `generate` job (there is no worker to post
  to; the check asserts no worker was created), shows the readout, and the
  console stays clean. Hand's collisions are checked by one blocked drag.
- `npm run bench:pose` gains the preview page, so posing frame times in a
  preview sit beside the editor's.

## Accepted residuals

- A version 1 through 5 owner's-copy file posed off the defaults (or whose
  animation does not start at them) may pose wrongly in a preview with
  `part` until re-exported. Cloud rewrites them.
- While a baked animation plays, Pose mode re-reads the part's `derive`
  once per frame, the editor's own cost during playback.
- The contact shadow (`contactShadow: true`) is cast once at showAssembly
  and does not follow a posed drag, exactly as it does not follow the
  animation.
- A trailing transform inside a build (the fast path's rung 2) baked into an
  exported mesh is not undone by the base inverse. The §3 identity test
  catches a handle that would move such a transform and hides it; a handle
  that leaves it fixed poses correctly.
- Resuming a paused animation after a drag drops the drag's pose.

## Later (not in this design)

- The editor's boot preview lifting its gate for place-only handles, so the
  first seconds in the editor are interactive too.
- Carrying a preview's pose into the editor as the opening params.
- A host-drawn slider over `handle.getParams()` / a `setParams` on the
  preview handle.
- partforge-cloud: loading the part module in `?mode=preview` (an esbuild
  compile, no worker pool) and passing it to `mountPreview`; the public
  page's "View in 3D" becoming "Pose in 3D" where handles exist.

## What is left to the builder

- The exact split between `preview-pose.js` and `mount-preview.js`; the
  former must stay pure and testable in Node.
- Whether the params write path is lifted out of `mount.js` into a shared
  leaf or re-stated in the preview (the clamp-and-wrap rule is small; one
  definition is preferred).
- How the §3 test is scheduled in idle time and what it does if the handle
  list is asked for before it finishes (hidden until decided is fine).
- The turntable-stop spelling in §5.
- Test fixture choice for the browser check (robot-arm vs the pose-smoke
  fixture), and whether `preview-pose.html` builds its GLB live or loads a
  committed fixture.
