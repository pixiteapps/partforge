# partforge

This file provides guidance to coding agents when working with code in this
repository.

## What this is

`partforge` is an npm framework that turns a declarative **`PartDefinition`**
(geometry build functions + a parameter schema) into a full parametric-CAD web
app: a three.js viewer, a control panel generated from the schema, geometry Web
Workers, and STL / STEP / 3MF export. The framework knows nothing about any
specific part; a part is plain data + pure functions. It ships as **plain ESM
source** and relies on a consuming app using **Vite** for worker / WASM / CSS
import handling.

This directory is its **own git repo** (`pixiteapps/partforge`), independent of
the surrounding Robot KB wiki. The retired `drum.js` example now lives in the
separate Drum-Machine repo; `src/parts/` now has twenty: `demo.js` (minimal
spacer), `planter.js` (rich - facets/taper/twist/verify block), `filleted-box.js`
(fillet/chamfer dress-ups, mesh-native since contract v3), `bracket.js` (Shape2D union/intersect/cut toolkit),
`gasket.js` (the profile-editing reference part - curve-native `pathProfile`,
`Shape2D` fillet/cut/offset, coincident-edge boss union),
`faceted-vase.js` (k.loft silhouette body), `hull-sweep.js` (k.hull/hullChain),
`nameplate.js` (k.text2d emboss/deboss), `scott-label.js` (a two-layer
engraved nameplate - raised script text over a backing plate, with
font/bold/italic/shear controls and fillet-rounded glyph tops),
`hinged-box.js` (the `animations`
reference part - stepped timeline, camera cues, pose-only tracks), `screw.js`
(the `k.screwSweep` reference part - a periodic ISO thread plus a hex head),
`text-smoke.js` (worker text-render CI fixture), `mixed-smoke.js` (the
split-backend CI fixture — a shelled sub-part beside a plain one, exercising
per-sub-part routing), `import-demo.js` (the `imports`/`k.import`
reference part - STL ghost + deviation gate + import-in-boolean + the `probes`
block, part-declared measurements reported by measure/inspect),
`propeller.js` (the `k.loftSmooth` reference part - spline-interpolated
airfoil blades with a live smooth/raw A/B toggle),
`lofted-bottle.js` (the Shape2D-loft reference part - curve-mode body from a
reused rounded-square ring, resample-mode square-to-circle shoulder), and
`emblem.js` (the `k.vector2d` reference part — ingested vector art embossed on an
authored millimetre plate, exercising both units modes, per-shape add/subtract
roles, and all four contour kinds; the `{ shape }` selector is covered by
test/vector2d.test.js rather than by the part),
`relief.js` (the `images`/`k.heightfield` reference part - depth map to
relief plate, swappable source), and `laser-box.js` (the sheet-parts reference
part - five `fingerBox` panels and a lid as `sheetPart` sub-parts, two printed
hinges keyed into slots; a test fixture and the guide's worked example, with no
demo page), and `material-swatches.js` (not a reference part: the dev-only
contact sheet of material presets behind `materials.html`).

## Node version

**Requires Node 24** - `.nvmrc` pins it and the default shell Node is too old.
Run `nvm use` before `npm install`, tests, or the CLI, or geometry/tests fail
confusingly.

## Commands

```bash
npm run dev        # Vite dev server; open /demo.html, /planter.html, /filleted-box.html
npm run build      # production build (pages in rollupOptions.input - other *.html are dev-only)
npm test           # vitest run (whole suite)
npm run test:watch # vitest in watch mode
npx vitest run test/measure.test.js          # a single test file
npx vitest run -t "assembly has no interpenetrating"   # a single test by name
npm run check      # headless smoke test: boots an app in real Chromium (needs Playwright)
node scripts/check-app.mjs demo.html         # smoke-test a specific app entry
node scripts/time-sheet-inspect.mjs [--browser]    # inspect timing for the sheet-part stress cases (docs/research/sheet-inspect-timing.md)
node scripts/capture-contact-sheet.mjs --out <dir> # realistic captures of materials.html in every environment + the laser-burn diffs
```

The CLI (also the agent-facing surface) builds parts in pure Node - no browser:

```bash
npx partforge lint    src/parts/<part>.js          # static checks, no kernel boot; exits non-zero on errors
npx partforge measure src/parts/<part>.js [view]   # bbox/volume/holes/watertight + verify gate; exits non-zero on failure
npx partforge render  src/parts/<part>.js [view]   # canonical-angle PNGs -> render/
npx partforge pick-serve                           # request-a-pick: agent asks user to click geometry
npx partforge ingest   <file> --out <output-file>  # SVG -> partforge-vector JSON, PNG pass-through, font validation - no browser
```

CI (`.github/workflows/ci.yml`) runs `npm test` then the smoke check against
the app list in ci.yml. Playwright's Chromium is
required for the smoke check only: `npm i -D playwright && npx playwright
install chromium`.

## Releasing

Releasing is automatic — never run `npm publish`, and don't tag by hand. **Bump
`package.json` on the feature branch, as part of the PR.** When that PR merges
to `main`, `.github/workflows/publish.yml` tags the merge commit `v<version>`
and publishes to npm on its own.

Forgetting the bump is the failure mode, and it is quiet: the merge lands, the
version already exists on npm, and the workflow correctly does nothing — the
work simply never ships. The fix is a follow-up PR bumping the version (see
#103 and #108 for the shape); the previous number is already published and
cannot be reused.

The gate is npm itself — "is this version already published?" — not a diff of
`package.json`, so re-runs and merges that don't touch the version are no-ops
rather than errors. Pushing a `v*` tag by hand still works as an escape hatch
for re-running a release, and hits the same guard.

Verify with `npm view partforge version` once the run completes. Downstream
(partforge-cloud) pins `^<version>` and regenerates its prompt corpus against
the installed package, so let the publish finish before bumping the dep there.

## Architecture

- **`src/framework/`** - the reusable engine (part-agnostic): `mount.js` (app
  entry), `controls.js` + `param-deps.js` (relevance-aware control panel; `pose-fast-path.js`
  is the pose ladder: rung 1 poses a canonical `place()`-able delivery by matrix,
  rung 2 keeps the trailing-transform build-delta path, posed deliveries keep the full-scope delta repair),
  `viewer.js` (three.js), `worker.js` / `jobs.js` / `geometry-service.js` (job
  loop across workers), `part-model.js` (the pure part model - `viewSubParts` /
  `resolveParams` / `buildPosed`; a deliberate leaf so the job loop, the
  collision check and the oracle can share it without a cycle), `assembly.js`
  (collision checking), `oracle/` (see below), `geometry/` (the
  kernel), `measure/` (the ruler-button measurement mode: in-scene 3D dimension
  objects; `feature-dims.js`/`dim3-place.js`/`pins.js`/`param-link.js` are pure
  leaves, `dim3-scene.js` renders into the viewer scene, `measure-mode.js`
  orchestrates, `measure-controls.js` is the viewbar chrome), `annotate/` (the
  sketch mode: typed drawing elements - pen/line/rect/ellipse with three ink
  colors, a hand tool for move/resize/rotate, and an interval eraser that
  subtracts parameter spans so shapes stay parametric - sent to the host via
  `onAnnotationSend` as a v3 semantic payload, whose anchors carry parts-frame pick rays (`partforge/oracle`'s `annotationRay`/`rayPlane` reconstruct and intersect them); `elements.js` is the pure
  element model, `ink-canvas.js` the overlay renderer, `annotate-mode.js` the
  orchestrator, `sketch-toolbar.js` the top-centre toolbar that replaces the
  viewbar while the mode is on, `annotate-controls.js` the viewbar pencil
  toggle; sketch mode stops animation playback and hides the transport bar
  (`animation-controls.js`'s `setHidden`), which is what frees the
  bottom-centre slot for a host-drawn composer - playback does not resume on
  exit), `viewcube/` (the orientation
  cube: a ghost cube whose 26 regions - 6 faces, 12 edges, 8 corners - tween
  the camera to canonical angles, with model-frame X/Y/Z arrows drawn in
  front of it - `cube-geom.js` is the pure projection/hit leaf, `cube-canvas.js`
  the 2D renderer, `viewcube-mode.js` the orchestrator, `viewcube-controls.js`
  the stack chrome. The cube's six FACE clicks (and their visually-hidden
  keyboard buttons) pass `autoProjection` to `tweenCameraTo`, which settles
  a face view into orthographic at the end of the tween; an edge, corner or
  iso tween is perspective, and in a face view pan and zoom keep ortho while
  the first rotation (a view-direction change, checked per frame in the
  render loop) swaps back to perspective, size-preserving - Fusion 360's
  "Perspective with Ortho Faces". Both swaps match size at ONE depth, the
  visible surface under the screen centre (`sizeMatchDepth` in viewer.js: a
  ray down the view axis through the target - the first opaque front face
  the cutaway keeps, or the section cap where the ray crosses the plane
  inside solid (found by entry/exit parity, since the cap is no sub-part
  mesh); ghosts (display opacity < 1) are seen through; else the front of
  the visible bounds), never the target's own depth - that was the part's
  centre, and an ortho zoom-in then made the swap back magnify the front
  face (22-53% on the planter). The ray's candidate surfaces are memoized,
  keyed on the target, the direction, the cutaway's plane (null while off)
  and a generation bumped by setSubGeometry / setSubPose / showAssembly /
  hideAssembly: a swap re-derives the direction an ulp off and a ray through
  a triangle edge can flip between hit and miss on it, so the memo is what
  keeps an untouched round trip lossless. A cut changes the matched surface,
  so mount.js places the carried camera AGAIN after restoring the cutaway. There is no projection control and it is
  not persisted; animation cues never pass `autoProjection`. The view style
  button (an eye) that replaced the cube's
  projection toggle now lives in the stage's `#viewbar`, inserted before
  `#theme` behind a `.pf-viewbar-divider` (the bar's appearance group; the
  popover opens above the pill, right edges flush, and closes when the bar
  hides for Sketch); only a stage with no `#viewbar` gets it over the cube's
  bottom-right corner instead (a DOM child of the stack, so it hides with it,
  inside the stack's box so the published size is unchanged). It belongs to
  `view-style-controls.js`: the button and its popover (the style
  thumbnails alone), with `view-style-state.js` as its
  pure half (the style list, thumbnail-cache freshness). Feature lines are
  CAD-only, not a popover control: they draw whenever the style is CAD and
  never in a realistic style. The stack hides for either of two independent reasons, OR-ed in
  mount: Sketch mode, and a crowded animation transport bar - the stack
  publishes its size as `data-pf-w`/`data-pf-h` so
  `animation-controls.js` can judge that crowding against a footprint that does
  not change when the cube goes away), and `app.css` /
  `chrome.css` (the shell/rail layout - `rail.js` binds
  it to the DOM, `rail-state.js` is its pure drag/collapse state machine).
  `camera-tween.js`, `camera-orbit.js`, `projection.js` and `depth-range.js`
  are further pure
  leaves the viewer imports - eased spherical interpolation between camera
  poses (view switches, animation camera cues, viewcube clicks), spherical
  orbit math for external drag sources, the perspective/orthographic
  framing pair plus the face-alignment tests automatic projection runs on,
  and the near/far planes, respectively. The last of those is
  derived per frame from the sphere enclosing what is being drawn (and again
  per offscreen capture, from `sceneBounds`) rather than fixed: a part big
  enough - a ~287mm cube is the first - used to have its back corner cut off
  by a far plane nailed at 1000mm, and zooming out lost the part entirely.
  Both planes are quantized so an orbit does not rewrite the projection matrix
  every frame.
  Below `RAIL_NARROW_BREAKPOINT` (720px) the rail cannot sit beside the viewer:
  the shell shows exactly ONE pane, keyed on `data-pf-pane`, and `mobile-tabs.js`
  draws the bottom tab bar that picks it. A host that wants to draw its own bar
  (partforge-cloud does, at the window level) takes over with
  `runtime.setHostPane('stage' | 'rail')` and releases with `null`. Collapse is
  suspended at that width — `rail.js` ignores a persisted `collapsed` flag there
  rather than clearing it.
  A host can also lease where the rail SITS, with
  `runtime.setRailLayout({mode:'dock', inset, railHeight})` (the rail renders
  into the bottom slice of the host's own sheet) or
  `{mode:'overlay'}` (a right-edge drawer over an unresized stage, opened by the
  rail toggle and ducked by any stage pointerdown); `null` restores partforge's
  layout. `chrome.css` keys both off `data-pf-rail-layout` / `data-pf-rail-open`,
  written by `mobile-tabs.js`. While either lease is held the rail's width is
  zero and resize/collapse are refused — including keyboard seam resize, which
  `rail.js` now also refuses below the breakpoint (previously reachable only
  with custom host CSS, since the seam is `display: none` there).
- **`src/framework/materials/`** - the material library and realistic-mode
  rendering. `presets.js` (the preset table), `environments.js` (the
  environment records), `resolve.js` (display-block -> library lookup, never
  throws; a sub-part with no usable material - none named, or an unknown one -
  keeps the blue-grey CAD look but resolves to `pla-print` in the part's colour
  (else that blue-grey) for realistic mode, so its layer lines get a print
  frame like any PLA part; a laser sheet part is the exception -
  `sheet-look.js`'s `realisticDisplay` gives it its stock's look (`plywood`,
  or `clear-acrylic` for acrylic-like stock); there is no hidden `"default"`
  preset any more, and
  `declaresMaterials` still counts only a named material), `print-frame.js`
  and `sheet-look.js` (pose math for layer lines, and a laser sheet part's
  canonical frame for its burns - from data, no probe; a canonical delivery's
  print frame is its export pose and its sheet burn frame is identity; frames are LAZY -
  `mount.js` only records each delivery, against the params its generate job
  was DISPATCHED with (a delivery shown during playback was built at params
  the live ones have left), and the viewer pulls both kinds
  through `setFrameSource` when it is about to draw the realistic look, live
  or borrowed by a capture, so CAD builds never compute them), `assets.js`
  (asset filename -> URL) and
  `tonemap-readback.js` (below) import **no three.js at all** - deliberately
  three-free and DOM-free so `lint`, the worker's 3MF writer and the
  docs-parity test can all import them without dragging GL or a browser into
  the worker graph. Everything that actually touches
  **three.js** - `physical.js` (CAD vs. `MeshPhysicalMaterial`), `uv.js`
  (box-projected UVs for anisotropy), `patterns.js` (below), `environment.js`
  (the PMREM rig: lighting, backdrop, ground, contact shadow), `print-bed.js`
  (the print-bed environment's cut-out build plate and its canvas-drawn
  markings), and `contact-shadow.js` - is a separate set of modules the viewer alone
  imports, not the worker. `patterns.js` is the **only** shader-injection
  site (`onBeforeCompile`) for layer lines, wood, carbon weave, SLS grain and
  the laser burn (compiled only into the sub-parts `sheet-look.js`'s
  `burnsFor` picks) - a future TSL/WebGPU port only has to rewrite this one
  file. `assets.js`
  is the **only** module allowed a literal `new URL("./assets/x",
  import.meta.url)` (the same rule `docs/AUTHORING-PARTS.md` states for
  fonts/imports/vectors, and the fix for the `partforge/geometry`-class bug
  where a computed asset path is invisible to the bundler and 404s in
  production). `tonemap-readback.js` tone-maps realistic captures in plain JS
  (no three import at all) because three applies tone mapping and output
  colour space only on the canvas path (a bound render target gets
  `NoToneMapping` and linear output on r184) - captures render HDR into a
  half-float target and finish there: exposure -> Khronos PBR Neutral -> sRGB.
  Environment assets (`environment.js`'s baked UltraHDR JPEGs, the ground/wood/
  carbon textures under `src/framework/materials/assets/`) are baked once by
  `scripts/bake-environments.mjs`, a one-shot dev tool whose OUTPUTS ARE
  COMMITTED (nothing runs it at build time); its HDR path shells out to
  Google's `ultrahdr_app` CLI (`brew install libultrahdr`), which is a dev-only
  dependency of that script alone, never of the shipped framework or a running
  part. **`materials.html`** (dev-only, not in `vite.config.js`'s
  `rollupOptions.input`) is the contact sheet - one 30mm sample of every
  preset, the layer-line orientation check, and the Laser-cut views (burning
  sheets beside an unburnt twin that differs only by the burn;
  `scripts/capture-contact-sheet.mjs` renders both in every environment and
  diffs them) - to check by eye after any preset or shader change.
- **`src/framework/sheet/`** + **`src/framework/process/`** - sheet parts
  (laser-cut flat stock). `sheet/constants.js` (the vocabulary, importing
  nothing) and `sheet/pose.js` (SheetPose frames: `poseSteps`, `sheetToWorld`,
  `worldToSheet`; imports only `constants.js`) are pure, because lint and the
  oracle read them; `sheet/joinery.js` is the joinery library (`fingers`, `tabs`, `tSlots`,
  `sheetPanel`, `matchingSlots`, `fingerBox`, `printedTab`, `sheetHole`);
  `sheet/resolve.js` resolves a declaration into shapes and builds the preview;
  `sheet/part.js` is `sheetPart()`; `process/registry.js` lists the
  manufacturing processes (laser is #1, `process/laser/descriptor.js`, plain
  data). All public names are re-exported from `partforge/geometry`; none is a
  kernel op. Three rules hold it together. A sheet sub-part is recognized ONLY
  by its plain-data `sp.sheet` (`isSheetPart`) — never `instanceof`, a
  module-scoped `Symbol()` or a `WeakMap`, because partforge-cloud's part worker
  holds two instances of this code. The generated build calls Shape2D/Solid
  METHODS only — no `isEmpty`/`area`/`boundingBox`/`toContours` and no branching
  on geometry — so the pose probe keeps trusting every sheet part (an empty mark
  is dropped by matching the kernel's error text, `EMPTY_MARK_RE`). And
  `resolve.js`/`pose.js`/`constants.js`/the registry stay paper-free, since the
  oracle imports them (`oracle/measure.js`, `oracle/verify.js`). Spec: partforge-cloud
  `docs/superpowers/specs/2026-09-28-sheet-parts-laser-kit-design.md`.
- **`src/parts/`** - one file per part, default-exporting a `PartDefinition`.
- **`src/framework/ingest/`** - the asset-ingest machinery behind both the panel's
  drop targets and the `partforge ingest` CLI verb. `sniff.js` classifies bytes by
  magic number (never a filename or claimed MIME type); `registry.js` is the one
  table answering "what does this file become" (`ASSET_KINDS`, `rowFor`,
  `classify`, `convertFor` - it does NOT route to part fields, that's still the
  declaration-function pattern below); `svg-ingest.js` is the SVG half of
  `k.vector2d` (SVG text in, `partforge-vector` JSON out — the same format
  `k.vector2d` reads and a part author can write by hand, `docs/VECTOR-FORMAT.md`);
  `image-ingest.js` re-encodes any browser-decodable raster to PNG through a
  `<canvas>` (`imageToPng`); `node-dom.js` installs a headless happy-dom (an
  OPTIONAL peer dependency, dynamically imported) so the CLI can run the SVG
  converter without a browser — raster conversion has no such headless path,
  since happy-dom has no canvas backend. All of it is DOM-dependent except
  `sniff.js`/`registry.js` themselves, deliberately outside the worker graph and
  never imported from it (`test/worker-layering.test.js` proves it). Published as
  `partforge/ingest` (`src/ingest.js`: `ingestSvg`, `imageToPng`), never
  re-exported from the main entry or `partforge/geometry`. The panel-facing half —
  `src/framework/panel/widgets/file-drop.js`'s shared drop/paste/picker widget
  behind `type: "image"`/`"vector"`/`"font"`, and the `onAssetUpload` mount
  option — is documented in `docs/AUTHORING-PARTS.md`'s "Getting files into a
  part".
- **`src/framework/oracle/`** - the geometric oracle: `measure.js`, `verify.js`,
  `build.js`, `gaps.js`, `min-wall.js`, `overhang.js`, `bvh.js`, `mesh.js`, `assert-dsl.js`,
  `dfm-profiles.js`, `cases.js`. Despite reading like test code this is shared
  runtime: the browser worker runs it for the `inspect` job, and `lint` reads its
  DFM profiles and assertion grammar. It is therefore DOM-free, `three`-free and
  `node:`-free, same as the rest of the worker graph
  (`test/worker-layering.test.js` enforces that). The worker loads it LAZILY, per
  job family (`jobs.js`'s dynamic imports — the generate/export hot path touches
  none of it); the same test's eager-closure guard enforces that too.
  The SEMANTIC MESH ORACLE (imported-mesh -> feature report) is NOT in this repo
  and this repo has no verb, job or import for it: it is a separate closed
  package that peer-depends on this one (it consumes `partforge/oracle`'s mesh
  helpers and parsers) and ships its own CLI. A host that installs it registers
  its worker job through the generic seam `runWorker(part, { jobs })` (jobs.js's
  HOST JOBS comment). Never add anything oracle-shaped here — no package name, no
  message types, no error codes: apps without it must keep building.
- **Sheet parts in the oracle.** `measure()` stamps every sub-part row with
  `sheet` — the process's 2-D facts for a `sheetPart()` sub-part (recognised by the
  plain-data `sp.sheet` alone, `isSheetPart`, on both sides), else `null` — and, in a
  view holding a sheet part whose profile has a bed, each printed row with `printBbox`
  (its export-pose size; `printBboxError` when that pose throws). `verify()` changes
  ONLY for such a view: the profile's bed fits each printed sub-part in its print pose
  instead of the assembled view, min wall and overhang skip sheets (declared on one,
  they skip — declared, never evaluated), and the
  process's checks (`sheetBridge`, `sheetGap`, `sheetMarks`, `sheetPieces`,
  `sheetSolidMatch`) are *volunteered* — warnings that never count toward
  `declared`/`evaluated`, so they never set `verify.ok`. The 2-D checks share
  `SHEET_CHECK_BUDGET_MS` per `measure()` call, charged for 2-D work alone; the laser
  descriptor runs each width search on the profile with its circular cubics read as arcs
  (`recoverArcs`, handed over by `resolveSheet`) and every cubic the search could carry
  into the offset engine's slow band as lines, less the holes that cannot take part in
  it; reads a web or slot narrower than its boolean's 0.01 mm margin off the boundary
  itself; and prices every step (a test, the boolean it runs unless it handed back the
  searched shape's own rings, that boundary pass) before it starts, starting none that
  will not fit — so a profile too complex to read is not started. The prices are fitted
  on a desktop: over the calibration corpus read under the budget every step costs about
  its price (0.95–1.04 across runs) and the largest runs 0.9 s (a search's setup is priced for the probes
  its facing-line count makes, superlinear on dense short lines — per line alone it ran
  6.6× on a dense grille); the meter learns a slower device's pace from the steps it has
  run — so the checks end inside their budget plus at most one step's overrun, and a
  device slower than the pace learned so far overruns that step by its own slowness. With
  NO deadline (the bench's 2-D column) every test starts, however long: a line-heavy test
  runs up to 1.8× its price there, and a reading can take tens of seconds. `recoverArcs`
  runs before the first priced step and is unpriced: cheap on real outlines (4,000 cubics
  in 10–35 ms — growth is closer to n^1.6 than linear on a smooth traced blob), still
  superlinear on some rings of thousands of cubics built to
  keep its search long (up to 0.8 s at 4,000). A sheet the budget stops is one
  `sheetChecks` warning; a DECLARED check the engine could not read is unevaluated too.
  Most tests run the budget on a stopped clock (`measure(…, { now: () => 0 })`); the
  timing pins run it on main-thread CPU time and hold each step to 3× its price and to
  ABSOLUTE CPU caps (1–1.5 s a step, 2 s a reading) — never to a pace taken from the
  steps they judge, which let a lone overrun set its own allowance. Those caps are the
  calibration desktop's: `test/helpers/cpu-pace.js`'s `cpuMs` is CPU time divided by a
  PACE measured once per file on a fixed plate of lines and arcs (1 there, clamped at 6,
  forced by `PF_CPU_PACE`), and the meter runs on that clock too, so a slower CI runner
  reads what the desktop reads. A view with no sheet
  part verifies byte-identically — `test/verify-golden.test.js` pins it; re-record only
  for a deliberate verdict change (`PARTFORGE_RECORD_VERIFY_GOLDEN=1 npx vitest run
  test/verify-golden.test.js`). Timings: `docs/research/sheet-inspect-timing.md`.
- **Change tracking in the oracle** (`src/framework/oracle/changes.js`,
  `createChangeTracker`). An `inspect` job that passes a non-empty `changesKey`
  gets back `report.changes` (and/or `report.changesSkipped`) describing what
  moved since the previous inspect under that same key; an inspect with no key —
  or with non-default `params`, a different geometry that must never become or be
  diffed against the baseline — gets exactly the old report, nothing added. The
  tracker lives for the worker's lifetime (one baseline per key, not per job), so
  it is **per worker and best-effort**: a new tab, a retired worker, a fresh key,
  or a `view` switch simply has no baseline yet (`changes` is absent, not an
  error). `changes` is either `{ unchanged: true, subparts: [], unchangedSubparts
  }` or `{ subparts: [...], unchangedSubparts }`, where each entry is
  `{ name, verdict }` — `new` / `deleted` / `moved` (+ `moved: [dx,dy,dz]`, the bounding-box centre's
  offset, and `rotated: true` when the placement's orientation changed too — a
  rotation about the centre reads as `moved` ≈ 0 without it) /
  `added` / `removed` / `reshaped` (+ `volumeDeltaMm3`, and for the latter three,
  `addedMm3`/`removedMm3` plus up to 3 largest `regions` from a mesh boolean
  diff) — each optionally carrying `changedOps`, the named root operations behind
  a changed hash when the op graph covers it. `changesSkipped` names why some
  sub-parts stopped short of a full region diff (`"timeout"`, a mesh-diff
  `reason` like `"too-large"`/`"not-watertight"`) — the verdicts already computed
  still ship. The diffs share a deadline counted from the inspect's START
  (`REPORT_SHARE_MS`, 6 s of partforge-cloud's 8 s whole-report timeout), and a
  sub-part over half of `maxTriangles` is never re-meshed for a diff — it gets the
  volume-delta `reshaped` verdict plus `changesSkipped: "too-large"`. **What's memoized, and what never is**: a sub-part whose final hash
  did not change reuses its previous `measure()` facts and pairwise gap distances
  (via `measure`'s `memo` option, fed `changeTracker.memo`) instead of
  recomputing them — every *changed* sub-part, and anything outside `measure`
  (verify, match scoring), is computed fresh every time. The hash covers only the
  display geometry, so the memo key in `measure.js` must name every OTHER input a
  sub-part's facts read (min-wall budget and band, overhang angle, `exportable`,
  the display→print matrix the overhang reading poses the mesh by); a fact that
  reads anything else — a sheet view, a `reference` sub-part — is never memoized.
  `test/measure-memo.test.js` holds reuse equal to recompute across each input.
- **`src/framework/export/`** - the cut & print kit's writers, process-agnostic.
  `formats.js` is IMPORT-FREE: `EXPORT_FORMATS`, the kit's option contract
  (`validateKitOptions`, `resolveStock`, `KIT_DEFAULTS`, `KIT_LIMITS`) and
  `KIT_OPTIONS_ERROR`, the `cut kit options:` prefix partforge-cloud routes to
  "Back to options" — every error an export option causes must start with it.
  `drawing.js` holds the Drawing IR's services: `refitRing` (`recoverArcs`, then a
  conservative line-run refit — ≥ 8 vertices on one circle, every step turning ≤ 15°
  — so a `circlePolygon` and chorded corners cut as arcs while hexagons and stars stay
  polygons) and `applyKerf` (`+kerf/2` on the cut layer only, refusing by name any
  kerf that closes a slot, joins pieces or loses an arc). `svg.js` (mm-sized, y
  flipped in the coordinates, every path fully styled) and `dxf.js` (R12: bulged
  POLYLINEs, CIRCLE for an all-arc ring, cubics flattened to 0.01 mm) are paper-free
  leaves, and `layout.js` packs one stock group onto sheets (deterministic shelves
  over each piece's all-layer box). A process's exporter is
  `process/<id>/export.js`, reached ONLY through `process/exporters.js`'s dynamic
  import: the drawing stage reaches paper, so lint, the oracle and
  `partforge/geometry` must never load it, and the whole stage must stay
  worker-safe (`test/kit-export-guards.test.js`, which also pins the exporter ids
  to `process/registry.js`'s).
- **`src/framework/export/bundle.js`** - the cut & print kit itself,
  `exportParts({ format: "bundle", options })`. `buildBundle` validates the options
  before anything builds, draws every sheet part through its process's exporter,
  merges identical pieces and prints into `-xN` files, lays each stock group out
  (`layout.js`), writes the sheets, pieces and prints plus `readme.js`'s plain-text
  README.txt and parts.csv, and zips them — asserting every entry name unique and
  safe first. `jobs.js` reaches it only through `loadBundle`, a literal dynamic
  import: `test/worker-layering.test.js` keeps every `export/` module and process
  exporter out of worker boot (the main thread imports `formats.js` alone, through
  `export-rows.js` for `listExportFormats()` and through `src/index.js` for the
  options surface). The kit never loads `./oracle/*`
  (`test/kit-layering.test.js` walks it and runs a real kit with every oracle module
  mocked to throw), so the README's check lines are worded by `checkMessage`, a
  restatement of `assert-dsl.js` that a test holds equal to it.
- **`src/framework/core/`** + **`native/`** - the native core: C++ ports of the
  hottest per-vertex JS (`creasedNormals` with the fillet-surface evaluators,
  and the oracle's BVH + min-wall), compiled to ONE WebAssembly module embedded
  in `core-wasm.js` (generated by `scripts/build-core-wasm.mjs`, committed) and
  instantiated synchronously on first use. `creased-normals.js` dispatches to it,
  and `cachedBVH` hands out core-backed indexes (which `measure()`/`meshGaps()`
  free with `disposeBVHs` — they live in WebAssembly memory); the public
  `buildBVH` stays JS. **Output is bit-identical with the core on or off** —
  `test/core-parity.test.js` is the contract and must never be loosened — so
  editing a ported JS pass means editing its C++ in the same PR and rebuilding
  (`test/core-wasm.test.js` fails on stale WebAssembly). The ported passes call
  `hypot3` (`geometry/js-math.js`), never `Math.hypot`, which JavaScriptCore and
  V8 compute differently. `native/README.md` has the floating-point rules.
  `setCoreEnabled(false)` (partforge/oracle, partforge/testing) or
  `globalThis.PARTFORGE_CORE = false` turns it off per realm.
- **`src/testing/`** - the genuinely Node-only harness, and only that:
  `manifold.js` / `occt.js` (boot a WASM kernel from disk), `render.js` (write
  PNGs), `error-patterns.js` (read `docs/ERROR-PATTERNS.md`). Never import these
  from `src/framework/`.
- **`src/oracle.js`** - the published `partforge/oracle` entry point: the open
  oracle surface (`measure`, `verify`, `buildView`, gaps/BVH/min-wall, silhouette
  match scoring, plus the mesh helpers and file parsers the closed oracle package
  consumes) with a browser-safe import closure (`test/oracle-entry.test.js`
  enforces it, and pins the closed package's peer contract). The seam to import
  the oracle through without dragging in the Node-only harness.
- **`src/testing.js`** - the published `partforge/testing` entry point. A barrel
  over the Node harness plus a re-export of all of `partforge/oracle`
  (`createManifoldKernel`, `measure`, `verify`, `assemblyOverlaps`,
  `bootOcctKernel`, `renderViews`, ...); downstream sees one surface and not the
  split.
- **Capture styles** (`src/framework/renderStyles.js`): the two offscreen looks as
  data — `cad` (agent renders; in the browser its background/edge colour still
  follow the live theme) and `thumbnail` (the product shot: light background,
  softer lights, lighter edges, contact shadow, fixed iso, captured at 4:3 —
  `camera.aspect`, the cloud's card shape; `size` is the width and cad stays square). Both styles frame by
  FIT (`fitPoseToPoints`): the canonical direction, at the distance that brings
  the geometry's projected extent — its vertices, not its bounding box — to the
  style's `fill` (cad 0.9, thumbnail 0.88), centred on it; the old canonical cad
  distance (which cropped medium parts at iso) no longer applies, and the live
  camera (`frameTo`, view cube, reframe) is unchanged. Every offscreen render
  (`renderOffscreen`) sizes fat-line (`LineSegments2`) resolution to the capture
  target for that render, since three's per-draw hook resets it to the canvas.
  The viewer (`viewer-lighting.js`, `renderMeshPayloads`, the live-scene
  `captureViews`) and the CPU renderer
  (`src/framework/softrender/`, behind `partforge/testing`'s `renderViewImages`
  and `renderViews`) both read them, and framing (`style-camera.js`) and the
  shadow mask (`contact-shadow.js`) are shared functions, so the two renderers
  cannot drift. Change a look in `renderStyles.js` only, then run
  `npm run check:softrender` (needs Chromium; it also compares the live-scene
  `captureViews` against the CPU cad render) and read the diffs.
  `renderStyles.js`, `style-camera.js`, `contact-shadow.js` and `softrender/`
  must not import three — they run in the cloud's Vercel Sandbox under plain Node.
  The CPU renderer keeps opacity as pre-blend-toward-background and draws no
  cutaways; both are out of scope by decision, not oversight.
  `npm run bench:softrender` times it: a 1024² cad render of a ~200k-triangle
  part costs ~420ms locally at 2× supersampling (~255ms at 1×).
- **`bin/cli.js`** - the `partforge` CLI dispatch.

**`docs/AUTHORING-PARTS.md` is the authoritative guide** - read it before
writing or editing a part. It has the full `PartDefinition` contract, the
kernel/`Solid` API tables, the parameter-schema format, app wiring, the `verify`
block, and gotchas. Do not duplicate that here; go read it. Its normative twin
for the kernel itself is **`docs/KERNEL-CONTRACT.md`** (conformance classes,
cross-backend semantics, versioning) - read that one before changing
kernel/backend behavior; `test/kernel-contract.test.js` holds its version header
and op coverage to the code.

### Two geometry backends, auto-selected

A part's `build(k, p, d)` is written against a **backend-agnostic kernel** (`k`)
and runs on either backend unchanged:

- **Manifold** (mesh CSG, WASM) - fast preview + STL + 3MF. Default for most
  parts. Implements `fillet`/`chamfer` natively since contract v3
  (`mesh-fillet.js` — straight and circular-arc edge chains, tolerance-band
  parity with OCCT).
- **OCCT / replicad** (OpenCASCADE WASM) - exact B-rep for STEP export, native
  `shell`, and the fallback for edge classes the mesh fillet can't blend. STEP
  is written by `geometry/occt-step.js`, NOT replicad's `exportSTEP`: replicad
  paints a colourless body red and double-gamma-corrects the colours it is
  given (sRGB hex into a linear constructor, then OCCT's writer converts to
  sRGB again, so `#3366cc` came out `#7caae7`). The copy is replicad 0.23.1's
  writer with only the colour construction changed; re-check it on a replicad
  bump. `test/step-colours-occt.test.js` reads each body's colour back out of
  the STEP text.

Before building, the framework runs a **geometry-free probe** of `build` to
detect probe-routed CAD ops (`ROUTED_CAD_OPS` = `shell` **on a Solid** —
`Shape2D`'s fillet/chamfer are shared pure JS and don't count). `fillet`/
`chamfer` no longer probe-route: the mesh backend attempts them and throws
`KernelCapabilityError` (code `NEEDS_OCCT`) only for unsupported edge classes,
which the runtime reroute latch turns into a per-sub-part OCCT fallback (the CLI
re-execs itself once with the backend pinned). Preview routing is
**per sub-part** — a mixed part's regen fans out to both workers in parallel;
exports and the CLI route whole-part (the max over sub-parts, one worker/kernel
per job). The probe re-runs with live params each regen, so routing follows the
parameters in both directions. Override with `meta.backend: "occt" |
"manifold"`. The two WASM kernels run in **separate Web Workers** (`name` =
`"manifold"` / `"occt"`). See `docs/geometry-backend-strategy.md` for the why
(OCCT booleans are about 75-1400x slower).

### Non-obvious invariants

**On any build, test, `measure`, or `verify` failure, grep
`docs/ERROR-PATTERNS.md` for the symptom first** - it maps literal error text /
misbehavior -> cause -> fix, one `##` per pattern. Its preamble is the canonical
statement of this rule.

- **`build` must be a pure function of `(k, p, d)`** - no `Math.random`, clock,
  or module-level mutable state. The preview kernel memoizes geometry by content
  hash; an impure build silently returns stale geometry.
- **Part modules are DOM-free and side-effect-free** - they load in both the main
  thread (schema -> controls) and the worker (build -> kernel).
- **Import geometry helpers from `partforge/geometry`, never `partforge`.** The
  main entry pulls in the DOM viewer/controls; importing it inside a worker build
  throws `document is not defined`.
- **replicad (OCCT) transforms consume their operand** -
  `translate`/`rotate`/`cut`/etc. delete the input and return a new solid. Never
  reuse a solid after transforming it; use `.clone()`.
- **OCCT and Manifold must not boot in the same process.** Keep OCCT-booting
  tests in their own files (vitest isolates per file); boot OCCT via
  `bootOcctKernel()`.
- **Units are millimetres** throughout. **Display placement must not depend on
  the active view** (display meshes cache across views); only
  `place(..., {purpose:"export"})` may.
- **The viewer draws on demand.** Its loop ticks every frame (controls, tweens,
  `onFrame` listeners) but only renders when asked: calls through the viewer's
  API ask automatically (`withRenderRequests` in `viewer.js`; pure reads —
  `get*`/`is*`/`has*`/`on*` — don't), as do camera moves, stage input and the
  viewer's own async landings. Code that edits the scene graph IN PLACE rather
  than through an API call (`measure/dim3-scene.js`, `selection/feature-highlight.js`,
  the cutaway's idle fade, the animation driver) must call
  `viewer.requestRender()`, or the change shows up only on the next orbit.
- `type: "custom"` controls (`panel/widgets/custom.js`, `panel/scoped-params.js`,
  `panel/json-value.js`) run PART-AUTHORED functions in the panel's realm. The value
  contract is `isJsonValue`, shared with hosts through `partforge/panel-values`; a
  widget throw becomes an error card + `runtime.getPanelErrors()`, never a panel
  crash; `runtime.getPanelState()` / `mount({panelState})` is the panel twin of
  `viewerState`. Spec: `docs/superpowers/specs/2026-09-14-custom-panel-controls-design.md`.

### Wiring a part into an app

Three small glue files per part (copy from the demo), because the worker
statically imports its part and cannot be injected at runtime: `<part>.html`
(structural markup, no CSS), `src/app-<part>.js` (`mount(part, {createWorker})`),
`src/<part>-worker.js` (`runWorker(part)`). The
`new Worker(new URL(...))` call **must stay inline** in the app file or Vite will
not bundle the worker.
