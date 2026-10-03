# Place-only pose: decide a sub-part's display pose from `place()` alone

**Status:** design, 2026-10-03
**Trigger:** partforge-cloud feedback #161 (the Lattice Box). The lid and its lattice insert redrew their layer lines every frame of the "Open / close lid" animation, and the insert updated a few times a second instead of moving smoothly — even though every animated param (`openAngle`, `assemblyLift`, `pinInsert`) is read only inside `place()`.
**Depends on:** 2026-07-27 pose fast path, 2026-10-03 recorded param deps (0.140.0).

## The problem

The part is authored the way the docs ask. Its kinematics live in `place()`:

```js
meshAsm: {
  build: (k, p, d) => lidClosedPose(makeMeshInsert(k, p, d), p, d),   // static lattice
  place: (solid, { p, d }) => lidArticulate(solid, p, d),             // openAngle, assemblyLift
},
```

`makeMeshInsert` builds a hole pattern over a 2-D region. Doing that honestly needs geometry queries: `region.boundingBox()` to size the grid, `cell.isEmpty()` / `cell.area()` / `cell.toRegions()` to keep or drop the clipped cells at the border, `region.isEmpty()` to guard the whole thing. Those queries are what the authoring guide teaches (`isEmpty()` guards, "Editing profiles").

Today three things rest on the geometry-free pose probe (`pose-probe-core.js`), and the probe runs `build()` **and** `place()` together against a stub kernel:

1. **The pose fast path** (`pose-fast-path.js`). A param change re-poses the delivered mesh in the viewer only when the probe is trusted and `baseHash` is unchanged. Any query op during `build()` marks the sub-part untrusted (`pose-probe-core.js` "Trust model"), so `meshAsm` can never take the fast path.
2. **The mesh cache** (`mesh-cache.js`). Since 0.140.0 it keys on the reads the worker recorded — but the worker records `build()` and `place()` into **one** sink (`jobs.js` `posedWithReads`) and bakes the display pose into the delivered mesh (`buildPosed`). `openAngle` is therefore a recorded read of `meshAsm`, every frame makes the mesh stale, and with the fast path refusing, every frame is a worker rebuild of the heaviest sub-part in the part.
3. **The layer-line frame** (`materials/print-frame.js`). `pfPrintFrame` is the display→export rigid delta of two probes; an untrusted probe returns IDENTITY, so the layer lines are drawn in the delivered mesh's own frame — which carries the current `openAngle`. Each rebuilt frame re-slices the lid along world Z instead of its print axis. That is the "print lines change during the animation" the report describes.

Confirmed on the reported part with 0.140.0's lint and probe: `meshAsm` untrusted; four `animation-track-rebuilds` notes ("untrusted probe"); `lidAsm` and `textAsm` go untrusted too as soon as italic is on (`styleProfile` calls `toRegions()`).

The author did nothing wrong. The probe's trust model makes a legitimate query in `build()` disable pose-only playback **and** the print frame for that sub-part, because the probe cannot tell a query that fed geometry from one that could have fed the pose. Tuning the dummies does not fix this (the recorded-param-deps spec explains why); it is the coupling of `build()` and `place()` in one probe that has to go.

## The invariant

> **A param read only by `place()` never rebuilds the sub-part's mesh and never re-frames its layer lines, whatever `build()` does.**

Everything below follows from taking the two halves of a sub-part apart:

- `build()` produces the **canonical** solid. What it depends on is known soundly — the worker records its reads (0.140.0).
- `place()` turns the canonical solid into a display or export pose. It is required to be a rigid motion already (`place-not-rigid`), and a rigid motion can be read off `place()` **without running `build()` at all**: hand it a token solid and record the `translate`/`rotate` steps it applies.

So the mesh cache keys on build reads only, the viewer applies the display pose as a matrix, and the print frame is the export pose. None of this is new author-facing vocabulary: `build`, `place`, `purpose`, `view` keep their documented meanings. The change is where partforge decides the pose.

## Design

### 1. Probe `place()` on an identity token (`pose-probe-core.js`, `pose-probe.js`)

`probeSubPartPose(sp, ctx)` gains a `scope` option: `"full"` (today's build+place), `"build"` (build alone), `"place"` (place alone). The place scope does not call `build()`:

```js
const CANONICAL = h("canonical");                         // one fixed hash
let s = token(CANONICAL, []);
if (sp.place) s = sp.place(s, { view, purpose, p, d });
const readable = s?.__poseToken && !state.queried && !state.unhashable && stepsFinite(s._pose);
if (!readable) return { trusted: false };
// baseHash is the token's hash after place(): CANONICAL when only pose steps were
// applied. Lint's place rules compare it across purposes/views; the fast path
// trusts the pose only when it is still CANONICAL.
return { trusted: s._hash === CANONICAL, baseHash: s._hash, pose: s._pose };
```

`_hash === CANONICAL` is the whole rigidity test: a geometry op on the token folds a new hash (`foldOp`), so a `place()` that scales, mirrors, unions or cuts is untrusted for the fast path by construction — while its `baseHash` still lets lint tell "the same reshape on both purposes" (equal hashes, allowed today) from "reshaped on one purpose" (`place-not-rigid`). A sub-part with no `place` is trusted with an empty pose. A `place()` that queries the solid (`s.boundingBox().center`) is untrusted, exactly as today — the probe's answer would be a dummy.

`pose-probe.js`'s `probePoses(part, view, params, { scope })` wraps it per view with the record-through recorders, so each entry carries `reads` as today. The asset-source fold into `baseHash` stays only for the `"full"`/`"build"` scopes (it existed to stop the fast path re-posing stale letters after a font pick; with canonical delivery a font pick is an asset read on every sub-part's stamp — see §3 — and the mesh cache handles it).

`lint-purity.test.js` holds: the core imports nothing new.

### 2. Separate read sinks, canonical delivery (`jobs.js`)

The `generate` job decides per sub-part, with the same pure function the main thread will use:

```js
const placeProbe = probeSubPartPose(sp, { view: msg.view, purpose: "display", p, d }, { scope: "place" });
if (placeProbe.trusted) {
  // canonical: build alone, build reads alone
  solid = sp.build(kernel, rec.p, rec.d);  frame = "canonical";
} else {
  // today's path: pose baked, build + place reads
  solid = buildPosed(kernel, part, name, { purpose: "display", view: msg.view, p: rec.p, d: rec.d });  frame = "posed";
}
```

Each delivered mesh gains **`frame: "canonical" | "posed"`**. Asset-declaration reads are added to both. A reply without `frame` (an older worker, a host's synthetic reply) is read as `"posed"`, which is today's behaviour exactly — old and new hosts and workers stay compatible in both directions.

Why the worker decides: the mesh it builds has to match the flag, and the decision depends only on `place()`'s code path at the job's params, which both sides can evaluate identically. The main thread never needs to re-derive it; it reads the flag off the delivery.

`capture-generate`, every `export-*` job and `inspect` are **unchanged**: they build posed solids in the worker and nothing in the viewer re-poses them (§6).

### 3. The mesh cache keys on build reads (`mesh-cache.js`)

The stamp gains `frame`. `record(name, reads, view, frame)` stores it; `frameOf(name)` returns `"canonical" | "posed" | null`. `isCurrent` is unchanged: for a canonical delivery the recorded keys are the build's, so a change to a param only `place()` reads leaves the mesh current. That is the invariant's first half, and it holds with no probe involved — the reads were recorded from the real build.

### 4. The pose is applied as a matrix (`pose-fast-path.js`, `mount.js`, `viewer.js`)

`viewer.setSubGeometry` today clears the sub-part's local matrix ("fresh worker mesh is baked at current params"). For a canonical delivery mount sets it straight after:

```js
viewer.setSubGeometry(m.name, m);
cache.record(m.name, m.reads, dispatchedView, m.frame ?? "posed");
poses.apply([m.name]);           // canonical → setSubPose(name, matrix); posed → setSubPose(name, null)
```

`pose-fast-path.js` keeps its name and its single caller (`onParamChange`) but becomes a two-rung ladder, decided per in-view sub-part from the stamp's `frame`:

- **Rung 1 — canonical and current.** Compute the display pose at the live params with the place-scope probe (memoized per `(paramsVersion, view)`, as the probe map is today) and `setSubPose(name, composePose(pose))`. No job, no stamp, no delta. If the place probe is untrusted at the live params (the place branched into a query), `cache.forget(name)` so the regen loop rebuilds it — at those params the worker will deliver it posed.
- **Rung 2 — canonical and stale, build probe trusted and unchanged.** Today's delta logic, kept so a part that poses with a trailing `rotate` **inside `build`** (the pre-`place()` idiom the 2026-07-27 spec was written for, and what the agent still writes first) stays smooth: a stamp taken at delivery holds the build-scope probe `{ baseHash, pose }`; when the live build-scope probe is trusted with the same `baseHash`, the applied matrix is `composePose(placeNow) · poseDelta(buildNow, buildStamp)` and the stamp's keys are re-recorded as the union, exactly as `repair()` does today. Without this rung the change would be a regression for every such part.
- **Posed deliveries** (place untrusted): today's full-scope delta logic, unchanged.

The matrix a sub-part carries is always **absolute relative to the delivered mesh** — rung 1's is the place pose itself, rung 2's composes the place pose over the build delta — so nothing accumulates across frames and `setSubGeometry`'s reset stays correct.

Two more call sites apply poses: the stale-shown branch of the `meshes` handler (a delivery during playback is shown best-effort — it now gets its pose at the live params, or is forgotten when the probe is untrusted there) and the view-tab switch (`place()` may read `view`, so the pose is recomputed when the tab changes — which, for canonical deliveries, also removes the stale-geometry failure `view-dependent-display-place` describes; the lint rule stays, see §8).

The debug overlay's `posed` count keeps its meaning: the sub-parts whose param change produced a pose and no job.

### 5. The print frame from place-only probes (`materials/print-frame.js`, `mount.js`)

`printFrameMatrix(subPart, { view, p, d, frame })`:

- `frame === "canonical"`: object space is the canonical frame, so the map to the export frame is the export pose itself, `composePose(placeProbe(purpose: "export").pose)`. An untrusted export probe returns IDENTITY, as today.
- `frame === "posed"`: today's rule, `poseDelta(export, display)` of two full-scope probes, IDENTITY when untrusted.

`mount.js` records the delivered `frame` beside the dispatched `{ view, params }` in `undrawnFrames` and hands it to `computeFrames`. The frame is still lazy and still describes the delivered mesh; the pose applied by §4 is a matrix on the Object3D, and `patterns.js` already works in object space, so a re-posed sub-part's lines ride with it. This is the invariant's second half.

**Sheet frames.** `sheetFrameFor` returns the inverse of the sheet's pose because the delivered mesh was posed. For a canonical delivery the mesh is in `generatedBuild`'s frame — the sheet's own canonical frame — so its `pfSheetFrame` is IDENTITY (keeping `t` and `plies`). `burnsFor` is unchanged in this PR (it still refuses a sheet with an author `place`); lifting that restriction becomes possible once the frame no longer depends on the pose, and is noted as a follow-up, not done here.

### 6. Every consumer of the delivered mesh or its pose

Verified against the code; "unchanged" means the module needs no edit.

| Consumer | How it reads the mesh / pose today | After |
| --- | --- | --- |
| Viewer world bounds, frame-to-fit, visible world positions (`viewer.js` `getVisibleWorldBounds`, `frameTo`, `visibleWorldPositions`) | `geometry.boundingBox` through `mesh.matrixWorld` / `subMesh[name].matrix` | unchanged — already pose-aware for the fast path |
| Silhouette match / size-match depth ray (`viewer.js` ~1365) | proxy copies `mesh.matrixWorld` | unchanged |
| Cutaway stencil passes (`cutaway-render.js`) | stencil meshes are **children of the sub-part mesh**, so they inherit its matrix | unchanged |
| Cutaway outline (`cutaway-outline.js`) | slices `mesh.geometry` under `mesh.matrixWorld`, re-slices when the matrix changes | unchanged; every frame of a pose change re-slices, as a fast-path repair does today |
| `cutaway.updateGeometry(name, geometry)` | receives the raw geometry | unchanged (receives the canonical geometry; matrices come from the mesh) |
| Pick / hover raycast (`selection/raycast.js` `worldToSubPartLocal`) | `worldToLocal` then re-applies `mesh.matrix`, so the reported point is in the **display-posed** frame | unchanged — the pick's "local point" means what it meant (display frame), on both delivery kinds |
| Feature highlight (`selection/feature-highlight.js`), pick flash | follow `setSubPose` | unchanged |
| Measure mode (`measure/measure-mode.js`, `dim3-place.js`, `feature-dims.js`) | every vertex/bbox goes through `m.matrix` / `matrixWorld`; "setSubPose poses are rigid" is already assumed | unchanged |
| Contact shadow, ground placement, depth range (`contact-shadow*.js`, `depth-range.js`, `placeGround`) | world bounds / world positions | unchanged |
| Wood grain axis (`viewer.js` `syncGrain`) | longest axis of the **object-space** bbox | unchanged code; for a canonical delivery the axis is the stock's own, which is the documented intent ("fixed to the sub-part") |
| Layer lines (`materials/patterns.js`, `print-frame.js`) | object space through `pfPrintFrame` | §5 |
| Laser burn (`materials/sheet-look.js`) | object space through `pfSheetFrame` | §5 |
| Live captures: `captureCurrent`, `captureCanonicalViews`, `renderViews` (`viewer.js` `captureIn`) | render the **live scene** | unchanged — matrices are part of the scene |
| Thumbnails: `captureView` → `capture-generate` → `renderMeshPayloads` | the worker bakes the display pose; CAD materials only, no print frame | unchanged |
| Exports (`jobs.js` `export-stl/step/3mf/bundle`) | `buildPosed(…, "export")` in the worker | unchanged |
| Oracle: `inspect`, `measure`, `verify`, `assemblyOverlaps`, probes (`oracle/build.js` `buildView` → `buildPosed(display)`) | posed solids built in the worker | unchanged — overlaps and clearances are checked on the posed solids as today |
| Soft renderer / CLI render (`src/testing/render.js` → `buildView`) | posed solids | unchanged |
| Export controller, download, headless `exportParts` | worker-side | unchanged |

The one viewer edit is in `mount.js`'s ordering: `setSubGeometry` resets the matrix, so the pose must be applied **after** it, on both the fresh and the stale-shown branches.

### 7. What stays on today's path

- A `place()` that **queries the solid** (`s.boundingBox()`, `s.volume()`, …), or passes a **function** into an op: the place probe is untrusted → the worker delivers it posed, with build+place reads, and the full-scope delta fast path applies as today (which, for a querying place, also refuses — so these parts rebuild on pose changes as they do now).
- A `place()` that **reshapes** (`scale`, `mirror`, a boolean): untrusted for the fast path by the `CANONICAL` hash test → posed delivery. If it reshapes on one purpose only, `place-not-rigid` reports it (§8).
- A part with **no `place()`**: canonical delivery with an empty pose; the stamp's keys are the build's. Identical to today in every observable way except the stamp's `frame`.
- A **trailing transform in `build`**: rung 2 (§4), today's fast path on the canonical mesh.

### 8. Lint (`lint/rules-animations.js`, `lint/rules-place.js`)

`animation-track-rebuilds` classifies each tracked key per in-view sub-part:

1. place-scope probe untrusted → **`untrusted`** note, reworded: "`place()` cannot be probed (it queries the solid or passes a function) — playback is best-effort". This is now the **only** way the untrusted note fires.
2. else build-scope probe at `v0` and `v1` trusted with different `baseHash` → **`rebuild`** note (as today).
3. else build-scope probe untrusted → the key is classified by whether `build()` **read** it (the probe's own recorder, derive-expanded, as `subPartReadKeys` does): read → `rebuild` note; not read → `pose`, no note. A prediction, like every probe read; it can miss a read behind a dummy branch, which costs a missing note and never a wrong behaviour.
4. else → `pose`.

On the Lattice Box all four notes go away: `openAngle`, `assemblyLift` and `pinInsert` are read by no `build()`.

`place-not-rigid` and `view-dependent-display-place` run on the place-scope probe. Their semantics are unchanged — display vs export may differ only by a rigid motion; display must not read `view` — but they now **see** a `place()` behind a querying build, where today an untrusted full probe kept them silent. That is the rules' intent; the behaviour change is "more findings on parts that were already wrong" (see Risks).

### 9. Docs

- `AUTHORING-PARTS.md` "The `PartDefinition` contract", the `place` bullet: the display pose is applied by the viewer as a matrix over the canonical mesh; `build()` may query freely; only `place()` must stay query-free and rigid for frame-rate playback.
- "Animations", the pose-only bullet (lines ~288-291): "a param read only inside `place()` plays at frame rate, whatever `build()` does; a param `build()` reads rebuilds at worker cadence; `lint` notes a `place()` the probe cannot read".
- "Caching & determinism" (lines ~786-793): the trailing-transform advice stays (rung 2), with `place()` named as the construction that needs no probe.
- "Linting" rule catalog and `ERROR-PATTERNS.md` `animation-plays-choppy`: cause/fix reworded to the two notes above.
- `AGENTS.md` architecture bullets for `print-frame.js` and the pose fast path; `mount.js`'s embedding-contract comment bumps to 0.141.0 and says canonical delivery.

### 10. Risks

1. **Pose ordering in the meshes handler.** `setSubGeometry` clears the matrix; applying the pose before it leaves a canonical mesh unposed for a frame or permanently. Pinned by a mount-level test with a fake viewer that records call order.
2. **A place that branches into a query at some params.** The worker may deliver canonical at one value and posed at another. Each delivery is self-describing (`frame`), and rung 1 forgets a canonical mesh whose live probe is untrusted, so the regen loop rebuilds it posed. Residual: one extra rebuild at the branch boundary.
3. **Newly surfaced `place-not-rigid` errors.** partforge-cloud refuses to load a part with a lint error. A stored forge whose build queries and whose `place` mirrors on export only was silently wrong before and will not load after. Judged correct (it prints a mirror image) and rare; the error names the fix.
4. **Cutaway outline re-slices per pose frame.** True today for fast-path repairs; now true for more sub-parts. Already throttled by `signatureMatches`.
5. **Grain axis moves** for a wood sub-part with a rotating `place()` — from the posed longest axis to the canonical one. Correct per the documented rule, visible as a one-time change.
6. **Old worker, new host / new worker, old host.** Covered by the `frame` default (§2); a new worker's canonical mesh reaching an old host is NOT possible since the two ship together.
7. **Sheet burn frame.** A canonical sheet delivery with a wrong non-identity frame would char the wrong faces (sub-millimetre errors matter there — `mount.js` says so). The identity rule for canonical deliveries is pinned by a sheet-part test on real geometry (`classifySheetSurface`).

## Decisions needed

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Keep rung 2 (the build-scope delta fast path on the canonical mesh), or drop deltas entirely and let a trailing transform in `build` rebuild? | **Keep it.** Dropping it regresses every part that poses in `build`, including what the agent writes before it learns `place()`. The spec's wording "stamps become absolute" is met: the applied matrix is absolute relative to the delivered mesh. |
| 2 | Run `place-not-rigid` / `view-dependent-display-place` on the place-scope probe (more findings), or keep them on the full probe? | **Place-scope.** It is the rules' intent, and the newly caught parts are genuinely wrong. Mention in the PR that cloud may refuse to load a rare legacy forge until its `place` is fixed. |
| 3 | Lift `burnsFor`'s "no author place" restriction now that the burn frame no longer depends on the pose? | **Not in this PR.** It is a separate behaviour change for sheet forges; file it as the follow-up it is. |
| 4 | Should the `?debug` overlay show the per-sub-part `frame`? | **Yes, one word** beside `posed`, since Scott's browser checks need to see which path a sub-part took without reading worker logs. No author-facing surface. |
| 5 | Minor bump `0.141.0`? | **Yes.** Wire shape grows additively, lint findings change, docs change. |

## Testing

- `pose-probe.test.js`: place scope — trusted with the canonical hash for rigid places, untrusted for `scale`/`mirror`/a query/a function, trusted-empty for no `place`, reads recorded.
- `recorded-reads-jobs.test.js` / new `place-only-jobs.test.js` (Manifold): a querying build with a rigid place delivers `frame: "canonical"` with build-only reads; a querying place delivers `"posed"` with both; no place delivers canonical with an empty pose; the canonical mesh's positions equal `sp.build(...).toMesh()`'s.
- `mesh-cache-recorded.test.js`: `frameOf`, and a place-only key change leaving a canonical stamp current.
- new `pose-apply.test.js` (pure, fake viewer + cache): rung 1 poses with the absolute matrix and no job; rung 2 composes place over the build delta and re-records the union; an untrusted live place forgets the stamp; posed deliveries take today's path.
- `print-frame` tests: canonical → export pose; posed → today's delta; untrusted → identity. `sheet-part.test.js`: canonical sheet frame is identity and classifies real geometry correctly.
- `lint-animations.test.js` / `lint-place.test.js`: the Lattice Box fixture reports zero `animation-track-rebuilds`; a querying place reports the reworded untrusted note; a mirroring export place behind a querying build reports `place-not-rigid`.
- The fixture `test/fixtures/lattice-lid-part.js`, reduced from the reported part: a lid whose build queries (`boundingBox`, `isEmpty`, `toRegions`) and whose `place` articulates by `openAngle`. Its lint notes must be 0 and its `printFrameMatrix` non-identity.
- Scott's browser checks are the last plan task.
