# Tessellated STEP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A STEP export of a part with `k.implicit` sub-parts writes one file: ordinary sub-parts as exact B-rep, organic ones as AP242 tessellated solids.

**Architecture:** The main thread finds the organic sub-parts with the geometry-free probe, asks the Manifold worker for their export meshes, then sends `export-step` to the OCCT worker with those meshes. OCCT builds the ordinary sub-parts and writes the file with a tiny named, coloured stand-in box per organic sub-part. A pure-JS splicer then turns each stand-in into a `TESSELLATED_SOLID` in place (same entity id, so OCCT's product, name and colour chain is kept), drops the stand-in's B-rep entities, and appends the mesh entities.

**Tech Stack:** plain ESM JS, vitest, Node 24, replicad/OCCT 7.6 WASM, Manifold WASM.

**Spec:** `docs/superpowers/specs/2026-10-31-tessellated-step-design.md`

## Global Constraints

- Run vitest as `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run <files>`. Plain single shell commands only.
- OCCT and Manifold never boot in one test file (AGENTS.md). OCCT test files end in `-occt.test.js`.
- A part with no `k.implicit` writes the same STEP DATA section as before; STL, 3MF and the cut kit are untouched.
- An `export-step` message with no `meshes` behaves exactly as today.
- An export succeeds or fails naming the sub-part; no warning path, no new reply field.
- No triangle cap, no simplification. No version bump.
- Spike result (settled): OCCT writes each body as `PRODUCT` → `PRODUCT_DEFINITION_SHAPE` → `SHAPE_DEFINITION_REPRESENTATION(#pds, #rep)`, `#rep = ADVANCED_BREP_SHAPE_REPRESENTATION('', (#axis, #msb), #ctx)`, `#msb = MANIFOLD_SOLID_BREP(...)`, and colour as `STYLED_ITEM('color', (...), #msb)`. Bodies appear in the order `toSTEP` received them.

## Review Focus

1. A sub-part name with an apostrophe or non-ASCII letters: the splice must not depend on reading names back out of the file (match by write order). Test in Task 1.
2. A hybrid on a printed `views`-map view (bed layout): the mesh must move by the same layout offset its stand-in would. Test in Task 3.
3. A view whose only sub-part is organic (no ordinary solid at all). Test in Task 3.
4. Two organic sub-parts with identical meshes (`-xN` style duplicates are a kit concept, not STEP; still, two bodies must stay two bodies). Test in Task 1.
5. A huge mesh (~180k triangles): the splice must finish in bounded time and memory (no quadratic string building). Test in Task 1 with a synthetic 200k-triangle mesh and a loose time bound.

---

### Task 1: The splicer and a test STEP reader

**Files:**
- Create: `src/framework/geometry/step-tessellated.js`
- Create: `test/helpers/step-reader.js`
- Create: `test/fixtures/step/two-bodies.step` (the spike's output: bodies "plate" and "organic", OCCT 7.6)
- Test: `test/step-tessellated.test.js` (pure, no kernel)

**Interfaces:**
- Produces: `spliceTessellated(stepText: string, bodies: Array<{ index: number, positions: Float32Array|number[], indices: Uint32Array|number[] }>) → Uint8Array`. `index` is the body's 0-based position in the order `toSTEP` wrote them. For each: the `index`-th `SHAPE_DEFINITION_REPRESENTATION`'s representation becomes `TESSELLATED_SHAPE_REPRESENTATION('', (#axis, #msb), #ctx)`; `#msb` becomes `TESSELLATED_SOLID('', (#face), $)`; appended `#face = TRIANGULATED_FACE('', #coords, <npoints>, (), $, (), ((i,j,k),...))` (1-based indices into the coordinates list) and `#coords = COORDINATES_LIST('', <npoints>, ((x,y,z),...))`; every entity reachable only from the old `#msb` body is removed. Throws `Error("STEP splice: …")` if the body count or entity shapes do not match.
- Produces (test helper): `readStep(text) → Map<number, { type: string, body: string }>` and `refsOf(body) → number[]`.
- Number format: each coordinate as the shortest decimal that round-trips the float32 value (`Math.fround`), always with a `.` (`1.`, `-0.5`, `1.25E-05`).

- [ ] **Step 1: Failing tests** in `test/step-tessellated.test.js`, on the fixture: splicing body 1 with a unit tetrahedron (4 points, 4 triangles) gives a file where (a) every `#n` reference resolves; (b) the product named `organic` reaches, through its `SHAPE_DEFINITION_REPRESENTATION`, a `TESSELLATED_SHAPE_REPRESENTATION` whose items include a `TESSELLATED_SOLID` with one `TRIANGULATED_FACE` of 4 triangles over a `COORDINATES_LIST` of 4 points equal to the input; (c) the `STYLED_ITEM` that styled the stand-in now styles the `TESSELLATED_SOLID`; (d) no `MANIFOLD_SOLID_BREP`/`ADVANCED_FACE` reachable from that product remains and body 0's entities are byte-identical; (e) splicing both bodies 0 and 1 with the same mesh gives two distinct tessellated solids; (f) a body index past the count throws `STEP splice:`; (g) a 200k-triangle synthetic mesh splices in under 3 s (`cpuMs` from `test/helpers/cpu-pace.js`) and every index is in range.
- [ ] **Step 2: Run** — `vitest run test/step-tessellated.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the reader helper, then `spliceTessellated`. Build the output as an array of string chunks joined once and encoded with `TextEncoder`; keep entity ids stable (new ids from max+1).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(step): splice AP242 tessellated solids into OCCT's STEP text`.

### Task 2: OCCT writes the hybrid file

**Files:**
- Modify: `src/framework/geometry/occt-backend.js` (`toSTEP` accepts bodies with `mesh`), `src/framework/geometry/occt-step.js` (stand-in bodies, then `spliceTessellated`), `src/framework/jobs.js` (`export-step` reads `msg.meshes`), `types/` if `toSTEP`'s body type is declared.
- Test: `test/step-hybrid-occt.test.js`

**Interfaces:**
- Consumes: `spliceTessellated` (Task 1).
- Produces: `kernel.toSTEP(bodies)` where a body is `{ name, solid, color }` (as today) or `{ name, mesh: { positions, indices }, color }`. A mesh body is written as a stand-in `k.box` of 1 mm at the mesh's bounds' minimum corner, then spliced. `export-step` message gains optional `meshes: { [subPartName]: { positions: Float32Array, indices: Uint32Array } }`; the named sub-parts are not built on OCCT; laid-out pieces use `exportLayoutOffsets` with the mesh's bounding box, and the offset is added to the mesh's positions.

- [ ] **Step 1: Failing tests** (boot OCCT): a two-sub-part part (`plate`: `k.box`; `organic`: `k.box` too, but its mesh supplied through `meshes` — a tetrahedron); `handle({ type: "export-step", meshes: { organic: tet } })` downloads a file whose `organic` product is tessellated and `plate` is B-rep (structure via `test/helpers/step-reader.js`); the same job without `meshes` produces the same DATA section as before this change (compare against a fixture recorded from the pre-change code in this test's first commit); a view whose only sub-part is supplied as a mesh exports; a printed `views`-map view lays the mesh out by the same offset a solid would get (Review Focus 2).
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.** In `jobs.js`, build only names not in `msg.meshes`; pass mesh pieces through layout via their bounding boxes; hand `toSTEP` mixed bodies in the selected order.
- [ ] **Step 4: Run** `vitest run test/step-hybrid-occt.test.js test/step-colours-occt.test.js test/step-schema-occt.test.js` — expected PASS.
- [ ] **Step 5: Commit** `feat(step): OCCT writes organic sub-parts as tessellated bodies`.

### Task 3: Manifold meshes the organic sub-parts; the controller runs both legs

**Files:**
- Modify: `src/framework/backend-select.js` (`organicSubParts`), `src/framework/jobs.js` (`mesh-subparts` job), `src/framework/worker.js` (job listed where export jobs are), `src/framework/export-controller.js` (two-leg STEP), `src/framework/mount.js` (`onStepClick` goes through the export controller, keeping its busy UI)
- Test: `test/organic-subparts.test.js` (pure probe), `test/export-step-hybrid.test.js` (controller with fake `send`), `test/mesh-subparts.test.js` (Manifold)

**Interfaces:**
- Produces: `organicSubParts(part, params) → string[]` — sub-part names whose probe build records `implicit` (from `createProbeKernel().used`); throws `Error` naming the sub-part when a sub-part records both `implicit` and a non-zero `shell` (message suggests `onion`).
- Produces: worker job `{ type: "mesh-subparts", jobId, view, params, parts: string[] }` → `{ type: "subpart-meshes", jobId, meshes: { [name]: { positions, indices } } }` (transferred), each built with `posed(name, "export")` and `toIndexedMesh({ quality: "print" })`; a throwing sub-part fails with `exportPieceError`'s message.
- Produces: `exportParts({ format: "step" })`: when `organicSubParts` of the selected parts is non-empty, sends `mesh-subparts` to `"manifold"` (job id `mesh-<c>-<n>`, added to `CONTROLLER_JOB_ID`), then `export-step` with `meshes` to `"occt"`; progress from both legs reaches `onProgress`; any leg's error rejects. Otherwise unchanged.

- [ ] **Step 1: Failing tests:** `organicSubParts` returns `["grip"]` for a part with `grip` (`k.implicit`) and `plate` (`k.box`), `[]` without implicit, throws naming a sub-part that does both `implicit` and `.shell(...)`; the controller with a recording fake `send` sends `mesh-subparts` to manifold then `export-step` with the reply's meshes to occt, and resolves on the download; a non-organic STEP export sends exactly today's single message; a `mesh-subparts` error rejects without sending `export-step`; on Manifold, `handle({ type: "mesh-subparts", parts: ["grip"] })` replies with a closed mesh in the export pose (a view whose `place()` translates it shows the translation).
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.** In `mount.js` route the STEP button through `exportCtl.exportParts({ format: "step" })`, showing and clearing the busy state around the Promise and surfacing a rejection the way the legacy `error` case does.
- [ ] **Step 4: Run** `vitest run test/organic-subparts.test.js test/export-step-hybrid.test.js test/mesh-subparts.test.js test/export-controller*.test.js test/mount*.test.js` — expected PASS.
- [ ] **Step 5: Commit** `feat(step): STEP export meshes organic sub-parts on Manifold`.

### Task 4: Named failures, docs, and the manual check

**Files:**
- Modify: `occt-backend.js` (the `implicit` throw: no "not supported yet"; says the probe did not see this `k.implicit` call, so STEP sent the sub-part to OCCT, and to make the call unconditional), `test/implicit-occt.test.js`, `docs/domains/organic.md` (Backend section: hybrid STEP, mesh at the export grid, file size), `docs/AUTHORING-PARTS.md` (export section line), `docs/KERNEL-CONTRACT.md` (implicit rows lose "OCCT throws until tessellated STEP"), `docs/ERROR-PATTERNS.md` (`implicit-step-export`), `test/error-patterns.test.js` (baseline id), `test/organic-docs.test.js` (quoted message).
- Create: `scripts/check-step-freecad.mjs` (dev-only: writes a hybrid STEP of the hand beside a box and runs `FreeCADCmd` to import it, printing the bodies it found and their triangle counts). Not run in CI.

- [ ] **Step 1:** Run `vitest run test/organic-docs.test.js test/implicit-occt.test.js test/error-patterns.test.js` after changing the error text — expected FAIL on the quoted message.
- [ ] **Step 2:** Update the docs and tests — expected PASS.
- [ ] **Step 3:** Full suite, typecheck, `npm run lint`, `npm run lint:dead`.
- [ ] **Step 4:** Run the FreeCAD check once; record its output in the PR description. If FreeCAD rejects the file, that is a writer bug: fix it in Task 1's module with a test reproducing it.
- [ ] **Step 5: Commit** `docs(step): hybrid STEP export of organic parts`.
