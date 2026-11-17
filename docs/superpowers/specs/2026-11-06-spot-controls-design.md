# Spot controls: the clicked face's parameters in the selection popover

**Date:** 2026-11-06
**Status:** design, awaiting approval
**Builds on:** partforge-cloud `docs/superpowers/specs/2026-10-14-selection-popover-design.md`
(the popover, its spot page and host slot), `2026-11-02-generic-handles-design.md`
(handles and `showOn`), the read recorder (`src/framework/read-recorder.js`) and
Manifold's per-face `originalID`.

## Intent

A person clicks a piece of the model expecting to edit the thing they clicked.
Today the popover names the piece and offers its appearance; the parameter that
shapes the clicked face is somewhere in the rail, or a sentence to the agent
away. On a phone or tablet the rail covers most of the screen, so the 3D view
has to become the primary way to control a part there, with the rail kept as
the overview and the home of whatever does not fit.

This design puts **up to three sliders under the popover's head row: the
parameters the clicked face was made from, newest first.** A hole shows its
diameter and position. A filleted edge shows its radius. A drawer front shows
the cabinet's width and height. Nothing is authored per part. The agent that
designs a part does not need to know the feature exists.

Shape comes first. Posing is driven by handles, so a parameter that a handle on
the clicked piece drags is left out: the handle is already its control.

## Goals

- Clicking a face shows the one to three parameters most directly behind it,
  without any per-part declaration.
- A slider in the popover behaves exactly like the rail's: the part rebuilds,
  the rail follows, the host receives one commit per release.
- Works unchanged in partforge's own pages and in the partforge-cloud sandbox,
  where the cloud floats its chat composer in the popover's slot. The controls
  sit between the head row and that slot, so the composer moves down on its own.
- Readable and usable at phone width, under a composer.

## Non-goals

- Authored per-piece or per-spot control lists. If inference proves wrong on
  real parts, an authored override is a follow-up, not part of this.
- Camera-aware ranking. Face provenance makes it unnecessary.
- Face provenance on the OCCT backend. OCCT parts fall back to the piece level.
- Exposing provenance through the CLI, `measure()` or the cached preview GLB.
- Appearance controls (the appearance page is unchanged).
- Controls for parameters of other pieces, however related.

## Anti-goals

- A region that lists five or more controls. Past three the popover is a
  second rail, and on a phone it pushes the composer off the screen.
- Any per-face work that costs a rebuild. Provenance is recorded during the
  build the worker already does; a click reads a table.
- A change to how parts are authored. `build` stays a pure function of
  `(k, p, d)`; nothing in it becomes provenance-aware.
- Breaking the popover's slot contract (`setSlotHeight`, `onSlotChange`, the
  44 px floor). The cloud's composer is placed by it today and keeps working
  with only a dependency bump.

## How it works

### 1. The worker records which parameters each face came from

Every face of a Manifold mesh carries an `originalID`: the id of the primitive
(or fillet blend) that created it. The id survives transforms and booleans, so a
cut face belongs to the tool that cut it. `creased-normals.js` already walks
`triOID[t]` per triangle to attach feature labels; the same walk ships an
**origin id per triangle**.

While a sub-part builds, the params recorder (`recordedParams` in jobs.js, the
`recorder` Proxy) already records every `p.x` and `d.y` read into a sink. The
sink gains an **ordered log**: an array of keys in the order they were read,
duplicates kept. (`ownKeys` enumeration, a spread of `p`, logs a single
`"*"` marker rather than every key.)

Every **author-facing op call** is a **boundary**: a call through kernel-front's
factory wrapper (`k[op]`, the `KERNEL_OP_SPECS` loop) or a Solid method. The
keys logged since the previous boundary are the reads that fed this op; one
slice per outer call, however many inner ops a compound such as
`boredCylinder` or a fillet issues underneath. That slice is **appended** to
the origin record of every face the op is responsible for:

- every id the op **mints** during the call (a primitive's `asOriginal`, a
  fillet's or chamfer's blend ids from `reserveBlendRestamp`, roundAll's
  decoupled ids, the inner primitives of a backend compound), reported by the
  backend itself, since no call-site wrapper can see them;
- for a **transform** of a solid, the records of the faces it moved (see the
  per-run rule below), so a translate after a cylinder appends `holeX`,
  `holeY` after `holeD`, and a click on the hole wall ranks `holeY`, `holeX`,
  `holeD`;
- nothing, for a boolean: its faces keep the records of the operands they came
  from.

Appending, not replacing, is what gives "newest first" its meaning.

**Records are keyed per run, not per id.** The solid cache hands two
`k.cylinder({ d: p.holeD })` calls in one build the same solid and the same
id, and `hoistBoolean` collapses identical copies on purpose, so keying on the
id alone would merge hole 1's position with hole 2's and a click on hole 1
would show hole 2's `x`/`y`. Manifold's run table keeps the instances apart
(`runOriginalID` plus `runTransform`, which the backend already reads), and a
transformed Solid's `canon.chain` is the chain that produced that run. The
record key is the id plus that chain; the mesh walk in `creased-normals.js`
matches each run to its record through its `runTransform`. A run that matches
no record falls back to the id's records merged (every chain's record,
newest first). The builder owns the matching; the test is two holes with
different positions, each reporting only its own.

**Restamps inherit.** `label()` today folds every run into one id
(`asOriginal`) on its plain path and every non-blend run into one `baseId`
on its blend path, which would collapse a hole cut before the label into the
body and orphan both records. `label()` changes to a **1:1 restamp**: each run
keeps a distinct new id under the label, carrying its record and its shading
policy forward (the per-id inheritance is simpler than today's majority vote,
which stays only for the fold path). The label registry already merges ids
under one label string into one feature, so features are unchanged. The fold
remains only where a 1:1 restamp is not possible; there, the folded id's record
is the folded runs' records concatenated in run order, then deduplicated
newest first. A fillet's or chamfer's base ids keep their records; only the
blend ids get the fillet's slice.

Rules for the hook:

- It fires on **every op call, cache hit or miss**. The solid cache
  (`cached` / `cache.lookup` in manifold-backend.js) skips the WASM op on a hit
  and never calls `wrap()` again, but the build code still ran and still read
  its params. On a hit the result's runs are the same as last time; the record
  for this build is appended fresh. The test is that an unchanged rebuild
  (all hits) records the same origins as the first build.
- It is a no-op when no sink is installed. The lint probe, the pose probe and
  the oracle's `buildView` build with no sink and must not pay for it or see
  it. jobs.js installs the sink on the kernel for the duration of one
  sub-part's display build and removes it after; the backend's internal
  `replay`/hoist calls are not boundaries.
- A slice containing the `"*"` marker records nothing for that op: a part that
  spreads its params tells us nothing about which face read what.
- Derived keys (`d.y`) in a slice fold back to raw params through the
  **nudged** attribution of §3, never through the recorded one.

The ids and chains are backend-local and never leave the worker. The payload
carries, per sub-part mesh, `originIds` (a `Uint16Array` per triangle, 0 =
unknown) and `origins`, an array where entry *i* is that origin's **param
keys, newest first, deduplicated keeping the newest occurrence**, already
expanded to raw params. Only origins that at least one triangle uses are
shipped, and only when at least one has a non-empty key list. Transfer them
with the other buffers (the `postMessage` transfer lists in jobs.js).

OCCT meshes ship no origins. Their provenance runs through labels alone
(`feature-attribution.js`), and a click falls back to the piece level.

### 2. A click resolves to up to three controls

The picker (`selection/raycast.js`) already returns the hit's `triIndex` and
sub-part. The viewer keeps `originIds`/`origins` on the geometry's `userData`
beside `featureIds`, as `buildGeometry` does for features. A new pure helper
takes the hit and the current state and returns the keys to show:

1. **Face keys.** `origins[originIds[triIndex]]`, newest first. A hit whose
   triangle has origin 0, a mesh with no origins (OCCT, a cached preview), or a
   hit on a cutaway section cap (the picker reports the entry triangle there,
   not the cut face) yields none.
2. **Piece fallback.** When the face gives none, use the piece's whole read
   list (`subPartParamKeys`, today's `runtime.controlsFor`), in the panel's
   order. Fallback keys rank below any face keys; in practice the two sets are
   never mixed, since the fallback is used only when the face gives nothing.
3. **Drop what a handle drags.** Remove the `handleParamKeys` (params plus
   `lock`) of every handle **shown in this view** (`handlesShownInView`) that
   is **on this piece**: its `showOn` names the piece, or it has no `showOn`
   and its located point (`locateHandle`) lies within the piece's posed
   bounding box expanded by 2 mm. A handle on another piece never hides a
   control here.
4. **Keep only keys the panel can draw**: keys that resolve to a control node
   in the parameter tree and are currently relevant (`enabled()`). A key with
   no control (an internal value) is dropped.
5. **Cap at three.** Exclusion happens before the cap, so three always show
   when three remain.

The helper is pure and unit-tested on hand-built inputs; the geometry never
enters the test.

### 3. Derive attribution gets exact

The over-attribution found in the spike is in `derive.js`: a single-function
derive records `depsOf: null`, and `expandDerivedReads` then charges every
derive input to every derived read. Multi-function (grouped) derives already
get per-key deps.

For a single-function derive, `attributed()` adds a **nudge pass** once per
build: for each numeric input key, rerun derive with that one value nudged
(by its control's `step`, else 1e-3 of its magnitude, else 1e-3; booleans
toggled; string and enum inputs are skipped and count as inputs to every
output), and deep-compare the output against the unnudged one. The leaf paths
that differ depend on that input. The recorder on `d` records **paths**, not
only top-level keys: reading `d.open[1]` logs `open.1`, so Drawer 2's placement
depends on `drawer2Open` and `depth` alone, not on the other drawers. Path
depth is capped at 3 and a read of a whole object or array (passing `d.pulls`
to a helper) depends on everything under it.

**The nudged attribution ranks; it never gates.** The recorded attribution
(`expandReads`, stamped on each mesh) decides which sub-parts rebuild
(`mesh-cache.js`'s `isCurrent`) and which are ghosted. A nudge is a sample: a
derive with a threshold, a `Math.round` or a clamp shows no change under a
step-sized nudge, and an input dropped from the stamp would leave a sub-part
un-rebuilt when an edit later crosses the threshold. So the sink carries two
attributions: the recorded one feeds `reads` and relevance exactly as today,
and the nudged one feeds only the origin slices of §1 and the piece ranking of
§2. Where the nudged attribution is missing (budget, a non-numeric input, a
throw) the recorded one stands in for ranking too.

**It runs in the worker only**, once per generate job, memoized by params
content, and ships with the delivery as a small `depsOf` table that the main
thread's resolver reads. The main thread's own `resolveParamsAttributed`
calls (`recordedRelevantKeys`, `subPartReadKeys`, every `onParamChange` and
pose drag frame) are untouched and never nudge; `npm run bench:pose` must not
move. Budget in the worker: the pass is skipped when the first derive call
took longer than 10 ms or the pass would need more than 64 calls. `derive` is
documented as pure; a derive that throws under a nudged value is treated as
"depends on everything" for that input, and the throw is swallowed.

### 4. The popover region

The spot page gains a third element between the head row and the slot:

```
┌──────────────────────────────┐
│ ● Drawer 2          Cabinet  │   head row (unchanged)
├──────────────────────────────┤
│ Width            ──────●  160│
│ Height           ───●─── 150 │   spot controls: 1–3 bare sliders
│ More in the panel            │
├──────────────────────────────┤
│ [ host slot: cloud composer ]│   slot (unchanged contract)
└──────────────────────────────┘
```

- The region is a second `buildControls` instance over the **shared** `params`
  object, in bare mode, with the tree pruned to the chosen keys (the spike's
  `opts.only`). Groups are kept only to carry their children's order and are
  not drawn. Edits flow exactly as the rail's: `onDirty` notifies the animation
  controller, syncs the rail's values and triggers `onParamChange`; `onCommit`
  fires the host's `onParamsCommit` once. The rail's edits and host writes
  (`setParams`, animation, pose, the readout chip) call `syncValues` on both
  panels, as the spike did.
- The region is **hidden entirely** when no key survives, with no empty-state
  text and no note about hidden handle params. The handle's presence is the
  explanation.
- Each shown control gets its tooltip/description as in the rail.
- **More in the panel** is a text link, shown only when the piece's full read
  list (before the cap, after handle exclusion) is longer than what is shown.
  It opens the rail (on a narrow stage: switches to the rail pane through the
  same path the bottom tab bar uses, or the host's `setHostPane` when leased)
  and scrolls it to the first shown control's section, which flashes once with
  the rail's existing attention style if one exists, else no flash.
- Rebuilding the region on each open and on each view switch; the popover's
  existing `place()` re-runs after it is built so the popover flips sides to
  fit. A relevance change while open refreshes the region (`refresh({relevant,
  derived})`); a key that becomes irrelevant disappears and the next key, if
  any, is not pulled in until the next open, so sliders never shift under a
  finger.
- A click while a cached preview is on screen never opens the popover today
  (preview gate), so there is no preview case.

Mobile:

- Below `RAIL_NARROW_BREAKPOINT` the popover already fills the stage's width.
  Its max height becomes the stage height minus its margins, and when the head
  row, three controls and the host slot do not fit, the **controls region
  scrolls** and the slot keeps its floor. Three sliders at the rail's row height
  fit beside a one-line composer on a 375×812 screen, which is the design
  target.
- Slider thumbs in the region use the rail's touch sizes; nothing new.

Styling: tokens from `app.css` only. The region's top border is the same
hairline as the slot's, labels and values set in the rail's control type, no
new colours. The feature should look like the rail moved three rows into the
popover, not like a new widget.

### 5. Public surface

- `runtime.controlsFor(selection)` is **unchanged**: it keeps returning the
  piece's key list as a string array (`types/index.d.ts`), and the host's
  selection object (`selection/resolve.js`) gains no field. Face resolution is
  an internal mount path: the popover resolves from the live hit at the moment
  it opens. A selection restored across a rebuild or remount
  (`getViewerState().selection`) has no live hit and resolves at the piece
  level. A host wanting the face keys is a follow-up, not this.
- `mount(part, { selectionPopover })` turns the region on whenever the popover
  is on. `selectionPopover: { controls: false }` turns it off. No other option.
- The mesh payload gains `originIds`/`origins`. `exportPreview` does not encode
  them; `mountPreview` never shows the popover.
- No change to `PartDefinition`, lint, the oracle or the CLI.

### 6. The cloud

The sandbox passes `selectionPopover: { slot: true }` and places its composer
by the slot rect. Nothing changes there beyond bumping the dependency. The
smoke test `tests/smoke/selection.spec.js` gains a case: click a face, assert a
slider is present above the composer, drag it, assert the composer moved and a
commit arrived. The authoring guide's text on the popover is regenerated into
the cloud's prompt corpus on the bump, as always.

## Current state

The spike on branch `claude/part-controls-popover-16a35b` (uncommitted: the
`SPIKE` blocks in `mount.js`, `selection-popover.js`, `panel/render.js`,
`app.css` and five `app-*.js` files, plus `.claude/launch.json`) proved the
popover plumbing: a second `buildControls` over shared params, two-way
`syncValues`, one commit per release, placement and phone layout. **It is
thrown away**; the first task of the plan reverts it. What it keeps are the
findings: the `opts.only` prune and the sync points are the right shape, and
piece-level attribution is too coarse, which §1 and §3 answer.

## Decided, with reasons

- **Newest first, cap three.** The last-applied operation is the most specific
  to the face. Chosen over panel order, which would put a loft's `height`
  before its `twist` on a wall whose shape is mostly the twist.
- **Piece fallback rather than an empty region** when a face has no record.
  Something adjustable beats nothing, and the fallback shows only when the
  face is unreadable, so it does not dilute the face path.
- **No "hidden by a handle" note.** Text explaining an absence is noise; the
  handle is visible on hover and is the better affordance.
- **No camera signal.** The face is a stronger and cheaper signal than the view.
- **Handle exclusion is per piece, not per view.** A handle elsewhere in view
  must not hide this piece's controls; the spike's per-view rule collapsed the
  drawer box to one slider.
- **Recording is append-only, per run.** Replacing on each op would lose the
  primitive's own parameters to a later translate; keying per id would merge
  repeated holes.
- **`label()` restamps 1:1.** Folding runs under the label is what would turn
  every label-after-cut part back into piece-level, and the planter, the
  guide's example and the hinged box label at both ends of the chain.
- **Nudged attribution never touches `reads`.** Sampling is not recording; a
  missed threshold must not leave stale geometry on screen.
- **No public API change.** The cloud's chips keep calling `controlsFor` and
  get what they got.

## Left to the builder

- The exact seams: the outer boundary (kernel-front's factory wrapper plus
  the Solid method layer) and the backend's mint reporting, subject to the
  cache-hit rule and the per-run keying.
- How a run's `runTransform` is matched to a record's chain (exact floats
  after the same composition, or a tolerance), and the fallback to the merged
  record.
- The sink's shape for the ordered log and the `"*"` marker.
- Whether `origins` dedupes across sub-parts or per mesh (per mesh is fine).
- The nudge pass's deep-compare and path recorder implementation.
- The pure helper's name and home (`selection/` beside the picker, or
  `panel/`).
- How the rail scroll-and-flash is wired on both the wide and narrow layouts.
- Test placement. At minimum: the hook under cache hits; origins for a box, a
  cut hole, a translated tool and a fillet; the nudge pass on the drawer box
  and hand derives; the resolver's five steps on hand-built inputs; the region's
  sync and single-commit behaviour; a worker-layering check that nothing new
  reaches the eager closure.

## Risks

- **Precomputed locals.** A build that computes every number up front and then
  issues ops charges all reads to the first op; the rest fall back to the piece
  list. The authoring guide's inline style avoids this and the agent writes
  that way; hand-written parts will sometimes hit it. Acceptable for v1; an
  authored override is the escape hatch if it matters.
- **Compound ops.** `boredCylinder`, `roundedCylinder`, `tappedBore` and the
  domain ops issue several inner ops after the author's reads. The outer-call
  slice applies to every id minted underneath, so a bored cylinder's bore and
  body both carry `od`, `bore` and `h`; the resolver cannot tell which of the
  three the clicked face is most about. Acceptable: three is the cap anyway.
- **The 1:1 label restamp.** Keeping runs distinct under a label changes what
  `simplify` may collapse across, so triangle counts on labelled parts may
  rise. The builder measures the reference parts (planter, hinged box,
  mixed-smoke) before and after; past a 5% rise on any, the fold stays for
  that path and those faces fall back to the merged record, which is still
  face-level in the common case and piece-level at worst.
- **Nudge pass cost on heavy derives.** Bounded by the 10 ms / 64-call budget;
  the hand's IK derive may exceed it and keep today's attribution, which only
  affects the fallback path there since its faces carry origins.
- **Payload growth.** Two bytes per triangle and a few short arrays; under 1%
  of the positions buffer.
