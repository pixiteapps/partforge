# Lines phase 3a: drawing the rope — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A declared line is drawn as a tube: in the live viewer (re-meshed on every pose frame, no rebuild), in captures, and in `partforge render`; a pose drag shows each line's live length and tints a line past its limit.

**Architecture:** A pure leaf, `lines/tube.js`, turns a centreline into a mesh payload; a pure `lines/meshes.js` reads every line in a view from `derive`'s output into named tube payloads. Three consumers draw them: `src/testing/render.js` (CLI render, CPU), and the live viewer through a main-thread `lines/line-scene.js` (three.js) that mount updates from the `d` it already resolves per param change. Lines never enter `part.parts`, so measure, overlaps, exports and the kit are untouched.

**Tech Stack:** plain ESM JS, three.js (line-scene only), vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-lines-rope-and-cable-design.md` — §5 "Drawing a line" ("While posing"). Phase 3 is split: this plan is 3a. 3b (the cached preview: tube in the GLB, re-solve while posing) and 3c (skew-axis taut solve, `lineContacts`) are later plans.

## Global Constraints

- `lines/tube.js` and `lines/meshes.js` are pure, DOM-free, three-free and worker-safe; they import only from `src/framework/lines/` and `part-model.js`/`derive.js`, never a domain (`test/lines-layering.test.js` if present, else the layering test that already covers `lines/`).
- `lines/line-scene.js` is main-thread only and is never imported by the worker graph (`test/worker-layering.test.js`).
- Lines are display meshes, not a scene overlay hidden from captures (spec decision 3): never register the tube with `registerCaptureHidden` or `registerCanonicalCaptureHidden`.
- A line is not a sub-part: it is not exported, and it stays out of `aggregate`, `overlaps`, the kit and the export (they enumerate `part.parts`; do not add it there).
- No sub-part rebuilds because a line changed shape. Re-meshing happens on the main thread from `derive` alone.
- A part with no `lines` block pays nothing: no extra derive, no scene object.
- Code that edits the scene in place calls `viewer.requestRender()` (AGENTS.md, draw on demand).
- A mesh name for a line is `line:<name>` wherever it shares a namespace with sub-part names.
- Version bump: `package.json` / `package-lock.json` to **0.209.0** (#377 is 0.208.0).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Node 24: `export PATH=$HOME/.nvm/versions/node/v24.16.0/bin:$PATH`.

## Decisions taken for this plan (controller's calls; record them in the spec in Task 5)

- Tube cross-section: 12 sides, radius `d / 2` from the line's reading; open lines get flat end caps.
- Colour: the declaration may carry `display: { color }` (a CSS colour string); default `LINE_COLOR = "#e8e2d0"` (natural UHMWPE). One CAD-style material per line (`buildCadMaterial`), the same in every render mode in 3a; realistic and cel looks for lines are a later refinement.
- Limit tint colour `LINE_LIMIT_COLOR = "#e5484d"`. A line is past its limit when its `bendRatio < minBendRatio`, or, during a pose drag, when `|length − lengthAtPress|` exceeds the bound of the view's declared `lineDrift` expectation (`verify.expect._view.lineDrift`, parsed with `parseAssertion` from `oracle/assert-dsl.js`; only a `<=`/`<` bound counts, anything else gives no drift limit).
- Readout: one item per readable line in the view during any pose drag, `{ key: "line:<name>", label: <name>, unit: "mm", value: length, text: "<length 2dp> (<signed drift 2dp>)" }`, e.g. `286.51 (+0.03)`, drift against the length at the press.
- A dev-only page `capstan-joint.html` (+ `src/app-capstan-joint.js`, `src/capstan-joint-worker.js`), not in `rollupOptions.input`, added to the lighter smoke shard in `.github/workflows/ci.yml`.

## Review Focus

1. A line whose source throws or reads no length at one pose → that line's tube is hidden (and its readout item left out) at that pose and comes back when readable; other lines and the viewer are unaffected. (Task 3 test "an unreadable line hides its tube and comes back".)
2. A view whose `lines` entries exclude it (`views: [...]`) → no tube there, and switching back shows it again. (Task 3 test "view switch shows only the view's lines".)
3. Degenerate centrelines — repeated points (a wrap's end equals the next span's start), fewer than two distinct points, a closed line → no NaN in positions or normals, empty payload for < 2 distinct points. (Task 1 tests.)
4. The cutaway on → the rope is clipped like the pieces (its material is registered with `registerCutawayMaterial`). (Task 3 test "registers its material with the cutaway".)
5. `partforge render` framing: the tube is in the CPU render's subparts, so it counts toward framing and the contact shadow; a part with no lines renders byte-identically to before. (Task 2 tests.)

---

### Task 1: `lines/tube.js` and `lines/meshes.js`

**Files:**
- Create: `src/framework/lines/tube.js`, `src/framework/lines/meshes.js`
- Modify: `src/framework/lines/read.js` (`normalizeLines` passes `display` through), `src/framework/lint/rules-lines.js` (accept `display`, reject a non-object or a non-string `color` as `line-bad-source`)
- Test: `test/lines-tube.test.js`, `test/lint-lines.test.js` (extend)

**Interfaces:**
- Consumes: `linesInView(part, view)`, `readLine(d, decl)` (read.js) — `readLine` returns `{ name, on, mode, d, closed, length, bendRatio, minBendRatio, points }`.
- Produces:
  - `tubeMesh(points: number[][], { radius: number, sides?: number = 12, closed?: boolean = false }) -> { positions: Float32Array, normals: Float32Array, indices: Uint32Array }` (Z-up part coordinates, the mesh payload shape `viewer.setSubGeometry` and softrender read).
  - `LINE_COLOR = "#e8e2d0"`, `LINE_TUBE_SIDES = 12` (exported from tube.js).
  - `lineMeshes(part, view, d) -> Array<{ name: string /* "line:<decl name>" */, line: string /* decl name */, mesh: {positions, normals, indices} | null, display: { color }, reading: object | null, error: string | null }>` in meshes.js: one entry per `linesInView` decl, in declaration order; an unreadable line has `mesh: null`, `reading: null`, `error` (the first line of the message). Never throws.
  - `normalizeLines` entries gain `display: { color } | null`.

- [ ] **Step 1: Write the failing tests** in `test/lines-tube.test.js`:
  - `tubeMesh` on a straight 2-point line `[[0,0,0],[10,0,0]]`, radius 1: every vertex is at distance 1 (±1e-6) from the x axis except cap centres; normals are unit length; `indices.length % 3 === 0`; every index < vertex count; the mesh is closed (each undirected edge used by exactly two triangles).
  - A 3-point line with a duplicate point `[[0,0,0],[5,0,0],[5,0,0],[5,5,0]]` gives no NaN anywhere and the same triangle count as `[[0,0,0],[5,0,0],[5,5,0]]`.
  - A single distinct point (`[[1,1,1],[1,1,1]]`) and `[]` give empty arrays.
  - A closed square loop (`closed: true`, last point equal to the first, as `solveTaut` returns it) has no end caps (each edge used by two triangles, no cap-centre vertex) and no seam gap (the first and last rings coincide or are shared).
  - A quarter circle of 46 points keeps the ring orientation continuous: no ring twists more than 30° about the tangent between neighbours (parallel transport, not Frenet).
  - `lineMeshes` on `concentricCapstan` (test/fixtures/capstan-fixtures.js) at defaults: one entry named `"line:rope"`, `display.color === LINE_COLOR`, `reading.length` equal to `measureLines`' length, mesh non-empty; with `display: { color: "#ff0000" }` on the decl the colour is passed through; with a derive whose source throws, the entry is `{ mesh: null, reading: null }` with a non-empty `error`.
  - Lint: `lines: { rope: { on: "drive", display: "red" } }` and `display: { color: 3 }` are `line-bad-source` errors; `display: { color: "#ff0000" }` is clean.
- [ ] **Step 2: Run** `npx vitest run test/lines-tube.test.js test/lint-lines.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `tubeMesh` (drop consecutive points closer than 1e-9; parallel-transport frames; one ring of `sides` vertices per kept point; flat caps with their own vertices and axial normals for open lines; a closed line reuses the first ring), `lineMeshes`, the `display` passthrough and the lint check.
- [ ] **Step 4: Run** the same tests, plus `npx vitest run test/lines-read.test.js test/worker-layering.test.js` — expect PASS.
- [ ] **Step 5: Commit** `lines: tubeMesh and lineMeshes; a line's display colour`.

### Task 2: the rope in `partforge render`

**Files:**
- Modify: `src/testing/render.js` (`renderViewImages`)
- Test: `test/render-lines.test.js`

**Interfaces:**
- Consumes: `lineMeshes(part, view, d)` (Task 1); `resolveParams(part, params)` from `part-model.js`.
- Produces: `renderViewImages` subparts gain `{ name: "line:<name>", mesh, display, opacity: 1 }` for each readable line of the view, after the sub-parts, only when the part declares lines (no derive otherwise). `edges` for a line mesh: an empty `Float32Array` (no feature lines on a rope).

- [ ] **Step 1: Write the failing tests**: render `concentricCapstan` (or the `capstan-joint` reference part) at `views: ["top"]`, small size (e.g. 160×120, supersample 1) with and without its `lines` block (`{ ...part, lines: undefined }`): the PNG bytes differ, and the rendered RGBA has pixels within ±12 per channel of `LINE_COLOR` shaded only in the with-lines image. A part with no lines (`src/parts/demo.js`) renders the same bytes as on `HEAD~` — pin this by rendering it twice, once through a call that mocks `lineMeshes` to throw (proving it is never called) and once plain, and comparing.
- [ ] **Step 2: Run** `npx vitest run test/render-lines.test.js` — expect FAIL.
- [ ] **Step 3: Implement** in `renderViewImages`, after `buildView`: if `normalizeLines(part).length`, resolve `d` once at `params` and append the readable `lineMeshes` entries.
- [ ] **Step 4: Run** the test and `npx vitest run test/softrender-render.test.js` — PASS. Then `npx partforge render src/parts/capstan-joint.js --out <scratch dir>` and look at the iso PNG: the rope wraps the drum and runs to the pulley.
- [ ] **Step 5: Commit** `render: draw declared lines as tubes`.

### Task 3: the rope in the live viewer

**Files:**
- Create: `src/framework/lines/line-scene.js`, `capstan-joint.html`, `src/app-capstan-joint.js`, `src/capstan-joint-worker.js`
- Modify: `src/framework/mount.js`, `.github/workflows/ci.yml` (lighter smoke shard), `test/worker-layering.test.js` only if it lists main-thread-only modules explicitly
- Test: `test/line-scene.test.js`, `test/mount-lines.test.js`

**Interfaces:**
- Consumes: `lineMeshes` (Task 1); the viewer's overlay contract — `viewer._subMeshes` (parent the group under the first sub-mesh's `parent`, as `measure/dim3-scene.js` `ensureAttached` does), `viewer.requestRender()`, `viewer.registerCutawayMaterial(mat)`; `buildCadMaterial(display, base)` from `materials/physical.js`; `resolveDerived(part, params)` from `derive.js` (memoized inside mount's `withDeriveMemo`).
- Produces: `createLineScene(viewer, part) -> { update(view: string, d: object): void, readings(): Map<string /* decl name */, reading | null>, setLimit(name: string, on: boolean): void, dispose(): void }`. `update` re-meshes every line of the view (one `THREE.Mesh` per line, named `line:<name>`, geometry disposed and replaced each call), hides lines not in the view or unreadable, applies `LINE_LIMIT_COLOR` to a line whose `bendRatio < minBendRatio` (and to a line `setLimit` turned on), and calls `requestRender()`. `LINE_LIMIT_COLOR = "#e5484d"` exported here.
- Mount: creates the scene only when `normalizeLines(part).length > 0`, and calls `lineScene.update(view(), resolveDerived(part, params).d)`:
  - at the end of `applyParamChange` (inside the existing `withDeriveMemo`, so no extra derive),
  - in `showView` after `viewer.showAssembly` (first show and every view switch),
  - disposed in mount's dispose.

- [ ] **Step 1: Write the failing tests**:
  - `test/line-scene.test.js` with a fake viewer (`{ _subMeshes: { a: { parent: new THREE.Group() } }, requestRender: vi.fn(), registerCutawayMaterial: vi.fn() }`) and `concentricCapstan`'s `d`:
    - "draws each line of the view": after `update("assembly", d)` the parent holds one mesh named `"line:rope"`, visible, with a non-empty position attribute; `requestRender` called.
    - "re-meshes on update": `update` at another `drive` angle replaces the geometry (positions differ) and disposes the old one (spy `dispose`).
    - "an unreadable line hides its tube and comes back": a `d` whose `drive.lineInfo` throws → mesh hidden, `readings().get("rope") === null`; a good `d` → visible again.
    - "view switch shows only the view's lines": a decl with `views: ["other"]` is hidden in `"assembly"` and shown in `"other"`.
    - "registers its material with the cutaway": `registerCutawayMaterial` called with the line's material.
    - "tints a line past its bend limit": a reading with `bendRatio 5, minBendRatio 8` → material colour `LINE_LIMIT_COLOR`; `setLimit("rope", true)` tints, `false` restores `LINE_COLOR` (when the bend is fine).
  - `test/mount-lines.test.js`, following `test/mount-cage-drag.test.js`'s viewer mock: mounting a part with lines adds the line scene and a `setParams` updates it once (one derive per change: count `derive` calls); mounting `src/parts/demo.js` creates no line scene and never calls `lineMeshes` (mock it to throw).
- [ ] **Step 2: Run** `npx vitest run test/line-scene.test.js test/mount-lines.test.js` — FAIL.
- [ ] **Step 3: Implement** `line-scene.js` and the mount wiring; add the dev page and its two glue files (copy `drawer-box`'s), and `capstan-joint.html` to the lighter smoke shard in ci.yml.
- [ ] **Step 4: Run** the two tests, `npx vitest run test/worker-layering.test.js`, and `node scripts/check-app.mjs capstan-joint.html` — PASS. Also drag the motor slider in `npm run dev` → `/capstan-joint.html` (or `--preview` screenshot via check-app if it supports it) and confirm the rope follows the drum.
- [ ] **Step 5: Commit** `viewer: draw declared lines, re-meshed per pose frame; capstan-joint dev page`.

### Task 4: live readout and drift tint while posing

**Files:**
- Modify: `src/framework/pose/pose-mode.js` (`createPoseMode` option), `src/framework/mount.js`, `src/framework/lines/line-scene.js`
- Test: `test/pose-mode.test.js` (extend), `test/line-scene.test.js` (extend)

**Interfaces:**
- Consumes: `createLineScene` (Task 3); `parseAssertion(expr)` from `oracle/assert-dsl.js`.
- Produces:
  - `createPoseMode(viewer, { …, extraReadout = () => [] })`: called as `extraReadout(params, pressParams)` wherever a drag readout is built (`limbReadout` and `genericStep`), its items appended after the handle's own and before the "Stopped at" / "Out of reach" item; `pressParams` is `{ ...part.defaults, ...getParams() }` captured when the drag starts.
  - `lineScene.readout(pressReadings: Map) -> items[]` and `lineScene.dragLimits(pressReadings: Map, bound: number | null)`; mount builds `extraReadout` from them: at the first call of a drag it records the readings at `pressParams` (one `resolveDerived`), then returns one item per readable line (format in Decisions) and sets each line's drift tint with `setLimit`. On drag end (`poseMode.onDragEnd`) mount clears every drift tint.
  - The drift bound: `lineDriftBound(part, view) -> number | null` in `line-scene.js` (or `lines/meshes.js` if kept pure), from `verify.expect._view.lineDrift` when `parseAssertion` gives a `<=`/`<` comparison against a number; null otherwise.

- [ ] **Step 1: Write the failing tests**:
  - pose-mode: with `extraReadout: () => [{ key: "line:rope", label: "rope", unit: "mm", value: 1, text: "1.00 (+0.00)" }]`, a generic handle drag's readout `items` end with that item, after the handle's own items; with a blocked pair, the "Stopped at" item comes after it. `extraReadout` receives the params at the press as its second argument.
  - line-scene: `readout` gives `"286.51 (+0.03)"`-style text (2 dp, signed drift) and leaves unreadable lines out; `dragLimits` with bound 0.2 tints a line whose drift is 0.3 and not one whose drift is 0.1; bound null tints none.
  - `lineDriftBound`: `"<=0.2"` → 0.2, `"<0.5"` → 0.5, `">=1"` → null, absent → null.
- [ ] **Step 2: Run** `npx vitest run test/pose-mode.test.js test/line-scene.test.js` — FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those tests and `npx vitest run test/mount-lines.test.js test/pose-*.test.js` — PASS.
- [ ] **Step 5: Commit** `pose: line lengths in the drag readout; tint a line past its drift bound`.

### Task 5: docs, types, version

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` ("Lines" section: how a line is drawn, `display.color`, readout and tint, not exported), `docs/domains/mechanisms.md` (capstan section: the rope is drawn), `AGENTS.md` (lines paragraph: phase 3a; capstan-joint now has a dev page `capstan-joint.html`), `types/part.d.ts` (`LineDecl.display?: { color?: string }`), the spec (a "Phase 3a as built (0.209.0)" paragraph with this plan's Decisions and any deviation), `package.json` + `package-lock.json` → 0.209.0
- Test: whatever docs-parity tests already cover these files (`npx vitest run test/*docs*.test.js test/domain-index.test.js`)

- [ ] **Step 1:** Write the docs and types; bump the version.
- [ ] **Step 2: Run** `npm run typecheck`, `npm run lint`, `npm run lint:dead`, and `npm test` — all pass.
- [ ] **Step 3: Commit** `lines phase 3a docs; 0.209.0`.
