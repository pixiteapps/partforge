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
separate Drum-Machine repo; `src/parts/` now has eighteen: `demo.js` (minimal
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
test/vector2d.test.js rather than by the part), and
`relief.js` (the `images`/`k.heightfield` reference part - depth map to
relief plate, swappable source).

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
  entry), `controls.js` + `param-deps.js` (relevance-aware control panel),
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
  front of it and a perspective/orthographic toggle beneath -
  `cube-geom.js` is the pure projection/hit leaf, `cube-canvas.js` the 2D
  renderer, `viewcube-mode.js` the orchestrator, `viewcube-controls.js` the
  stack chrome. The stack hides for either of two independent reasons, OR-ed in
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
  framing pair, and the near/far planes, respectively. The last of those is
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
  `shell`, and the fallback for edge classes the mesh fillet can't blend.

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
