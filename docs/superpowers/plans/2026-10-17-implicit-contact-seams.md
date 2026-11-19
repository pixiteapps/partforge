# Clean Contact Seams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a root `contact` node exact gaps (separate closed shells at any gap), a crisp gap-0 crease with no fill, and clean seams, in both engines.

**Architecture:** Samples record which contact child owns them. The mesher treats cells holding several owners with a real gap between them as multi-material, putting each side on its own cut surface. Cleanup keeps every vertex on its own piece, and a final pass cuts the crease into the mesh by splitting owner-crossing edges. The new behaviour sits behind a compile option (`exactContact`) until the native port lands. The last task turns it on.

**Tech Stack:** plain ESM JavaScript (Node 24, vitest), C++ → WebAssembly (`native/`, built by `scripts/build-core-wasm.mjs`, committed as `src/framework/core/core-wasm.js`), manifold-3d.

**Spec:** `docs/superpowers/specs/2026-10-16-implicit-contact-seams-design.md` (amends `docs/superpowers/specs/2026-10-15-implicit-contact-design.md`). Read both.

**Reference spike:** local commit `2e9b0976` on branch `spike/contact-labels` (never pushed). Read it with `git show 2e9b0976:src/framework/geometry/implicit/spike-labels.js`, and likewise for `spike-crease.js`, `program.js` and `cleanup.js`. It shows the algorithms working; do not copy its structure. It samples twice, uses string keys, and routes every surface cell through slow generic code.

## Global Constraints

- Requires Node 24: prefix commands with `PATH="$(ls -d ~/.nvm/versions/node/v24*/bin | tail -1):$PATH"` (`source nvm.sh` is blocked in the sandbox).
- **Bit-identical engines:** output stays bit-identical with the core on or off (`test/core-parity.test.js`; never loosen it). A ported JS pass changes its C++ in the same task. Ported passes use `hypot3` (`geometry/js-math.js`), never `Math.hypot`. Follow `native/README.md`'s floating-point rules. Rebuild with `node scripts/build-core-wasm.mjs`; `--check` must report current.
- **Interval exactness:** culling stays exact; sparse vs dense are byte-identical on contact trees.
- **Old behaviour is preserved:** until Task 9, `compileImplicit` defaults `exactContact: false`, and every existing test passes unchanged. After Task 9, PR #283 tests that pin the floor, the pad fill or the gap warning are rewritten to the new behaviour or deleted, never loosened.
- **Nested contacts:** a `contact` node not reached from the root through `ref` nodes keeps PR #283 behaviour (floor and pad fill) and warns at compile, with exactly this text: `implicit: a contact group nested inside other operations keeps approximate seams (a minimum gap and a soft pad); make it the top of the k.implicit for exact seams`.
- **Seam gate, on the seam fixtures (Task 2) at preview 1.5 mm and print 0.6 mm:**
  - zero flipped triangles;
  - folds ≤ the baseline (plain mesher on the same exact field);
  - closed, manifold and oriented;
  - no zero-volume component.
- **Speed gate (native, paced ms, measured 2026-10-17 on base `4b886eaa`):**
  - Baseline: hand default 241 at 1.5 mm and 1652 at 0.5 mm; fist 269 at 1.5 mm and 1839 at 0.5 mm.
  - Gates: preview at most 1.2× baseline, print at most 1.5×.
  - Clean seams win: if the seam gate needs more time, raise the speed gate to the measured cost and say why in the commit and the PR. Never trade seam quality for speed.
- **Constants live in `src/framework/geometry/implicit/contact.js`:**

  | Constant | Value |
  |---|---|
  | `CONTACT_OVERLAP` | 0.02 mm |
  | `CREASE_SNAP` | 0.15 (fraction of an edge) |
  | `CREASE_TOL` | 0.02 (×edge, the crease point's residual) |
  | `DETAIL_SEAM_FADE` | 1 mm |

  `SIBLING_SEAM_ANGLE = 5` (degrees) lives in `shading-policy.js`. All of these are tunable by test, and the final values are recorded in the spec's "Left to the builder".
- **Commits:** commit at the end of each task. Never `git stash` (shared stack). Never commit `hand-dev.html`, `src/app-hand-dev.js`, `src/hand-dev-worker.js`, `src/hand-dev-part.js`, `scratch-*.js`, or render output. No version bump. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Three pieces meeting at one spot** (two fingertips touching each other and the palm). The mesh must stay closed: at gap 0, three pieces with crisp creases; at gap 0.2, three separate shells. Test in Task 4 (gap 0) and Task 3 (gap 0.2).
2. **A gap wider than a cell** (2 mm at the 1.5 mm grid, with air samples inside the gap). It must still measure exact, through the plain path. Test in Task 3.
3. **Bulge on with a gap set** (capsule press, gap 0.2, bulge 1). The gap must stay exact; bulge acts before the cut. Test in Task 3.
4. **A contact whose pieces never come near each other.** It must mesh byte-identical to the plain mesher (no owner cells, no cost). Test in Task 2.
5. **A nested contact** (under a `union` with another shape) after the switch-on. It keeps the old look and warns. Test in Task 1 (warning) and Task 9 (default on).

---

### Task 1: Exact contact field and owner capture (JS)

**Files:**
- Modify: `src/framework/geometry/implicit/contact.js`, `ir.js`, `regions.js`, `program.js`, `index.js` (option passthrough)
- Test: `test/implicit-contact.test.js` (new `describe("exact contact")`)

**Interfaces:**
- Produces:
  - `compileImplicit(spec, { images, exactContact = false })`.
  - The compiled tree gains `ownerRoot: number` (the IR id of the root-reachable contact node, or −1) and `ownerK: number` (its child count, ≤ 127).
  - In exact mode that node gets `n.exact = 1`. Other contact nodes keep `exact = 0` and add the nested warning to `compiled.warnings`.
- Produces: `contact.js` exports `CONTACT_OVERLAP = 0.02`, `clearanceExact = (gap) => (gap > 0 ? gap : -CONTACT_OVERLAP)`, and the constants table above.
- Produces (program layout): an exact node emits `fuse = 2`, `nF = 0`, then one child index per emitted slot after the fills: `[CONTACT, dst, p, cl, 2, nK, nA, reg×nK, att×nA, 0, child×nK]`. `cl` is `clearanceExact(gap)` for an exact node.
- Produces: `evalBatchContact(prog, textures, X, Y, Z, out, cap)` in `program.js`.
  - `cap = { K, owner?: Int32Array(N), cuts?: Float64Array(N·K), shares?: Float64Array(N·K) }`. Each array is filled when present, for the program's exact contact op.
  - `cuts[i·K + child]` is that child's cut value; a pruned child reads `+Infinity`.
  - `shares` is the cut value, lowered to any attachment blend `unionN([c_a, c_b], k·w)` the child takes part in with `w > 0`.
  - `owner[i]` is the argmin child of `cuts`. Then, for every attachment with `w > 0` whose pair holds the owner, it becomes the lesser child index of that pair, repeated until stable, so overlapping zones merge to the palm.
  - Owner is never AIR here; the caller applies the sign.

- [ ] **Step 1: Write failing tests** in `test/implicit-contact.test.js`:
  - `exact field: gap is the clearance, no floor`: two spheres r 5 at x = ±5.25 (a 0.5 mm near miss), `gap: 0.01`, exactContact. `evalReference(c, 0, 0, 0, 1)` is within 1e-12 of `0.25`, the raw distance; no cut reaches the bisector. The same node without exactContact reads `0.75`, the floor's cut `clearance(0.01, 1) / 2`.
  - `exact field: gap 0 is the hard union cut a hair past the bisector`: spheres r 5 at x = ±4.5 (overlap 1), `gap: 0`. The value at the origin is `-CONTACT_OVERLAP / 2` (−0.01) within 1e-12; at x = −8 (inside a only) it equals a's own distance; and there is no pad fill: `compiled.ir.nodes[id].fillRegions.length === 0`.
  - `exact field: no fallback region`: force a region-search overflow (reuse the existing over-budget fixture). The pair has zero regions, and the warning is still present.
  - `ownerRoot`: hand (`handSpec()`) with exactContact gives `ownerRoot ≥ 0` and `ownerK === 6`. Without it, −1. `{ root: { kind: "union", children: [contact, sphere] } }` with exactContact gives −1 and the nested warning text verbatim.
  - `evalBatchContact`: on the hand, at 200 random points in its bounds:
    - `out` equals `evalBatch` bit for bit;
    - `owner` is the argmin of `cuts` except inside attachment zones;
    - a point at a finger's mcp frame (attach weight 1) has owner 0 (palm);
    - `shares[k] ≤ cuts[k]` everywhere.
- [ ] **Step 2:** Run `npx vitest run test/implicit-contact.test.js -t "exact"`. Expected: FAIL (option and exports missing).
- [ ] **Step 3: Implement.**
  - `ir.js` decides root-reachability by walking from `ir.root` through `kind === "ref"` nodes only.
  - `regions.js` skips fill regions and the conservative fallback region when `n.exact`.
  - `minGap` ignores exact nodes.
  - `interval.js` needs no change: pruning rule (b) holds for negative `cl`. Verify it with an interval-exactness check in Step 4.
- [ ] **Step 4:** Run `npx vitest run test/implicit-contact.test.js test/implicit-interval.test.js test/implicit-sparse.test.js`. Then add one sparse-vs-dense byte-identity case on an exact capsule press (gap 0 and 0.2) to `test/implicit-sparse.test.js`. Expected: PASS. Then run `npm test`: all pass (default unchanged).
- [ ] **Step 5: Commit** `feat(implicit): exact contact field behind exactContact, owner capture`.

### Task 2: Owner samples and the owner mesher (raw mesh)

**Files:**
- Modify: `src/framework/geometry/implicit/sparse.js`
- Create: `src/framework/geometry/implicit/mesher-owners.js`, `test/fixtures/implicit-seam-cases.js`, `test/helpers/seam-quality.js`, `test/implicit-owner-mesher.test.js`

**Interfaces:**
- Consumes: Task 1's `evalBatchContact`, `compiled.ownerRoot`, and `compiled.ownerK`.
- Produces:
  - `planLeaves` copies `ownerRoot` and `ownerK` onto the plan.
  - `evaluateLeaves` gives each leaf `owner: Int8Array(125)` when `ownerRoot ≥ 0`, from the same evaluation. That is one `evalBatchContact` call replacing `evalBatch`; never sample twice.
  - `owner = OWNER_AIR (−1)` where the stored value is ≥ 0, including after the zero nudge.
- Produces: `meshStoreOwners(store, { gap }) → { positions, indices, vertLeaf, vertOwner: Int32Array, ownerHeld: Uint8Array, pinned: Uint8Array }`, plus exports `OWNER_AIR = -1`.
  - `vertOwner` is always a child index: the solid end's owner for an edge vertex, or the side or merged representative for a face or cell vertex.
  - `ownerHeld = 1` marks vertices that cleanup projects onto their owner's share instead of the field.
  - `pinned = 1` marks gap-face vertices.
- Produces (`test/fixtures/implicit-seam-cases.js`):
  - `capsulePress({ overlap, gap = 0, bulge = 0, r = 8, half = 20 })`: two capsules along z at x = ±(r − overlap/2), labels `a` and `b`. A negative overlap is a near miss.
  - `threePress({ gap })`: three spheres r 6 pairwise overlapping by 1, in a triangle.
  - `SEAM_CASES`: the spec's fixture list as `{ name, spec }`.
    - press gap 0, 0.05 and 0.2;
    - near miss 0.3 at gap 0;
    - hand default, fist and nearMiss at gap 0 and 0.2, via `handSpec({ ...HAND_POSES[x], contactGap })`.
- Produces (`test/helpers/seam-quality.js`):
  - `flippedTriangles(compiled, mesh, edge) → number`. Each triangle is tested with the field of its owner: the owner shared by its non-crease vertices if any, else the plain field. Using `evalBatchContact` shares on a full-decision program, a triangle is flipped when `f(c + εn) < f(c − εn)` at its centroid c, with ε = 0.03·edge.
  - `seamFolds(mesh) → number`: adjacent pairs whose unit normals dot below −0.866, excluding pairs whose shared edge has both ends flagged in `mesh.crease` (absent means none).
  - `pieceGapError(compiled, mesh, a, b, gap) → { min, maxFaceError }`. Over vertices of the component holding child a: `min` is the smallest share of b, and `maxFaceError` is `max |share_b − gap|` over a's pinned vertices.

The mesher's three cell paths (the spec's §3) are an algorithm the signature doesn't fix:

1. **One owner, or all labels equal:** exactly `mesher.js`'s code path. Refactor `meshStore`'s per-tet emission into a shared function, not a copy.
2. **Several solid owners, no open owner–owner edge in the tet:** the same plain tetrahedron emission on the field, skipping all-solid tets.
3. **Any open edge:**
   - the barycentric multi-material layout: per tet face, `(E1, E2, C)` on a two-label face and `(E, F, C)` per crossing edge on a three-label face;
   - before that, merge the labels of a face whose owner pairs are fused on every one of their edges in that face;
   - a solid–solid triangle pair is emitted twice (one per side, opposite winding) unless all its owner–owner edges are fused, in which case it is dropped.

   Open versus fused per grid edge:
   - Bisect `c_X − c_Y` along the edge in 24 steps.
   - The edge is open when the field is positive there, `c_X` is negative at X's end and positive at the bisector, and likewise for Y.
   - An open edge's side vertices sit at each owner's cut-value zero, bisected in 24 steps on its half.
   - Face and cell vertices are seeded from their edge-vertex neighbours, then Newton-projected onto `c_X = 0` (one side) or onto the field and `c_X = c_Y` together (merged beside air). Steps are minimal-norm and capped at 0.5·edge, for 8 iterations.

   Vertex keys stay numeric (grid edge key × owner, face and cell keys from grid indices). The spike's line-contact conflict rule is a known flaw: implement it as in the spike here, and Task 5 replaces it.

- [ ] **Step 1: Write failing tests** in `test/implicit-owner-mesher.test.js`, raw mesh (no cleanup), exactContact on, grid 1.5:
  - `far-apart pieces mesh exactly as the plain mesher`: two capsules 10 mm apart. `meshStoreOwners` positions and indices equal `meshStore` byte for byte.
  - `press gap 0.2 is two closed shells at the gap`:
    - `edgeCheck` all zero, `componentCount === 2`;
    - `pieceGapError(..., "a", "b", 0.2).maxFaceError ≤ 0.002`;
    - `min ≥ 0.2 − 0.002`.
  - `press gap 0.05`: the same at 0.05 with tolerance 0.01.
  - `press gap 0 is one closed solid`: `componentCount === 1`, closed.
  - `near miss 0.3 at gap 0 stays apart`: two components, `min ≥ 0.3 − 0.01`.
  - `owners`: every vertex of the press-0.2 a-shell has `vertOwner` = a's child index.
  - `evaluateLeaves samples once`: spy on `evalBatch`/`evalBatchContact` call counts. One per leaf (plus zero-nudge calls).
- [ ] **Step 2:** Run `npx vitest run test/implicit-owner-mesher.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `sparse.js` owners, `mesher-owners.js`, the fixtures and the helper.
- [ ] **Step 4:** Run the file, plus `npx vitest run test/implicit-mesher.test.js test/implicit-sparse.test.js` and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(implicit): owner samples and the owner mesher`.

### Task 3: Owner-aware cleanup and routing

**Files:**
- Modify: `src/framework/geometry/implicit/project.js`, `cleanup.js`, `index.js`
- Test: `test/implicit-owner-mesher.test.js` (new describe `"through meshImplicit"`)

**Interfaces:**
- Consumes: Task 2's mesh fields.
- Produces:
  - `projectVertices(store, positions, vertLeaf, { maxStep, which, normals, owner = null, held = null })`. A vertex with `held[v]` is projected onto `shares[owner[v]]` through `evalBatchContact`. Unchanged when both are null.
  - `cleanupMesh(store, mesh, opts)` carries `vertOwner`, `ownerHeld` and `pinned` through every compaction:
    - collapse and decimation never merge vertices of different owners or a pinned vertex;
    - pinned vertices are neither projected nor relaxed, and get normals from a zero-step projection;
    - it returns those fields.
- Produces: `meshImplicit(compiled, edge, { tier, owners = true })`.
  - When `compiled.ownerRoot ≥ 0` and `owners`, it runs `meshStoreOwners`, then cleanup, and skips the native core until Task 8.
  - `owners: false` forces the plain mesher on the same field: the seam baseline.
  - The result gains `vertOwner`, `ownerHeld` and `crease` (all-zero until Task 4) when the owner path ran.
- Decided: `ownerHeld = 1` for every vertex created on an edge with an end at either grid end of an open edge, and for every side, face and cell vertex of an open cell. The spec leaves this test to the builder, and the spike's version is the starting point. Task 5 may refine it.

- [ ] **Step 1: Write failing tests** (meshImplicit, tier preview at 1.5 and tier print at 0.6, exactContact on):
  - `press gap 0.2 / 0.05 stay exact through cleanup`: the same assertions as Task 2 on the final mesh, at both grids.
  - `gap wider than a cell`: press gap 2 at 1.5. Two components, `maxFaceError ≤ 0.02`.
  - `bulge with a gap`: press gap 0.2, bulge 1. `min ≥ 0.198`, two components.
  - `near miss never bridges`: near miss 0.3 and 0.5 at gap 0. No triangle has vertices on both sides of the bisector (children values via `evalNodeAt`) at both grids.
  - `three pieces at 0.2`: `threePress({ gap: 0.2 })` gives three closed components.
  - `hand at 0.2 stays one body; fist tips off the palm`:
    - the fist hand at gap 0.2 has `componentCount` 1 plus any sealed pockets (components of negative volume);
    - every fingertip vertex nearest the palm has palm share ≥ 0.198.
  - `owners: false is the old mesher on the new field`: hand default gives the same triangle count as plain `meshStore` plus cleanup on the exact compile.
- [ ] **Step 2:** Run the new describe. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run test/implicit-owner-mesher.test.js test/implicit-cleanup.test.js test/implicit-project.test.js` and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(implicit): owner-aware cleanup; meshImplicit routes root contacts through owners`.

### Task 4: Cut the crease into the cleaned mesh

**Files:**
- Create: `src/framework/geometry/implicit/crease.js`, `test/implicit-crease.test.js`
- Modify: `src/framework/geometry/implicit/index.js` (call after cleanup, before detail), `result.js` (carry `crease`)

**Interfaces:**
- Consumes: the Task 3 mesh.
- Produces: `cutCreases(store, mesh) → { ...mesh, crease: Uint8Array }`. Positions, normals, indices, `vertLeaf`, `vertOwner`, `ownerHeld` and `pinned` grow with the new vertices.
- The algorithm is the spec's §5 with `CREASE_SNAP` and `CREASE_TOL`:
  1. **Re-own vertices:** a non-held vertex is re-owned by the argmin merged owner of its cuts at its final position.
  2. **Split crossing edges:** each edge with differing owners is split at `c_X = c_Y` (bisection, 20 steps), snapping to an end within `CREASE_SNAP`.
  3. **Re-triangulate:**
     - one split: 1-to-2;
     - two splits: 1-to-3;
     - three owners: 1-to-4.
  4. **Project:** move crease points onto the field and `c_X = c_Y` together (Newton, minimal norm, cap 0.25·edge, 6 iterations).
  5. **Revert:** restore any point whose residual exceeds `CREASE_TOL·edge` and clear its flag.

- [ ] **Step 1: Write failing tests:**
  - `crease points lie on the crease`: press gap 0 at both grids. Every `crease[v]` vertex has `|field| ≤ 0.02·edge` and `|c_a − c_b| ≤ 0.02·edge`, and there are at least 40 crease vertices.
  - `closed after the cut`: all `SEAM_CASES` at 1.5 give `edgeCheck` all zero.
  - `three owners`: `threePress({ gap: 0 })` is closed, with crease vertices on all three pairs.
  - `no crease across a near miss`: near miss 0.3 has zero crease vertices and the same bisector-crossing count as before the cut (zero).
  - `no crease inside an attachment zone`: hand default gap 0. No crease vertex within its finger's attachment radius of any `<finger>.mcp` frame origin.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(implicit): cut the contact crease into the mesh`.

### Task 5: Seam cleanliness to the gate

The spike left about 220 folds on the fist before the crease cut and 410 after, against 13 for today's mesher. This task makes the gate pass. It is open-ended by nature; the acceptance tests are fixed.

**Files:**
- Modify as needed: `mesher-owners.js`, `cleanup.js`, `crease.js`
- Create: `test/implicit-seam-quality.test.js`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces: no new exports. The line-contact conflict rule in `mesher-owners.js` is replaced by one that never bridges a near miss and never leaves a non-manifold edge. When the two collide, near-miss safety wins; a closed sub-grid slit inside a real gap-0 contact is acceptable.

- [ ] **Step 1: Write the gate tests** in `test/implicit-seam-quality.test.js`. For every `SEAM_CASES` entry at tier preview 1.5 and tier print 0.6:
  - `flippedTriangles === 0`;
  - `seamFolds(mesh) ≤ seamFolds(baseline)`, where baseline is `meshImplicit(compiled, edge, { tier, owners: false })`;
  - `edgeCheck` all zero;
  - no component with `|volume| < 1e-6`;
  - near-miss cases: zero bisector-crossing triangles.
  - Plus `gap-0 contacts stay one piece`: press gap 0 and `threePress({ gap: 0 })` each have exactly 1 component.
- [ ] **Step 2:** Run it and record the failing counts in the task report.
- [ ] **Step 3: Remove fold and flip sources until it passes.**
  - Known sources, from the spike:
    - multi-owner cells beside an opening;
    - crease points the cut moves along the crease;
    - the conflict rule;
    - cleanup relaxing free vertices against pinned neighbours.
  - Tried in the spike and useless: clamping crease points into their face or cell, smoothing along the crease, and in-plane face solving.
  - Allowed: local grid refinement near seams. It must stay crack-free where fine cells meet coarse ones, and the cost counts against the speed gate per the Global Constraints.
- [ ] **Step 4: Visual check.** Render close-ups for the reviewer, not committed. Use a scratch part in the repo root, like the spike's `scratch-hand.js` and `scratch-press.js` (`git show 2e9b0976:scratch-hand.js`), with `exactContact: true` passed through a module-level flag:
  - the fist's finger seams and a capsule crease end;
  - at grids 1.5 and 0.6;
  - via `npx partforge render <scratch> --views iso,front,top --out <scratchpad dir>`.

  List the PNG paths in the report.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(implicit): contact seams pass the cleanliness gate`.

### Task 6: Detail fade, per-piece IDs and seam shading

**Files:**
- Modify:
  - `src/framework/geometry/implicit/detail.js`, `result.js`;
  - `src/framework/geometry/manifold-backend.js` (implicit), `mesh-build.js`;
  - `src/framework/geometry/shading-policy.js`, `creased-normals.js`;
  - `native/creased_normals.cpp`, `native/creased_normals.h`, and the core wasm rebuild.
- Test: `test/implicit-detail.test.js`, `test/implicit-shading.test.js`, `test/implicit-manifold.test.js`, `test/core-parity.test.js` (creased-normals group case)

**Interfaces:**
- Produces: `applySurfaceDetail` scales each vertex's summed height by `smoothstep(0, DETAIL_SEAM_FADE, s)` when the mesh has `vertOwner`. Here `s` is the least cut value at the vertex over children not merged with its owner. Unchanged otherwise.
- Produces: the meshImplicit result gains `triOwner: Int32Array` when the owner path ran: each triangle's owner is the owner shared by its non-crease vertices, else its first vertex's.
- Produces: `manifoldFromWeldedMesh(wasm, V, Tr, originalID, triOwner = null, ids = null)`. With `triOwner`, triangles are stably sorted by owner into runs, one `runOriginalID` per owner from `ids`.
- Produces:
  - The implicit backend reserves `ownerK` IDs, each with policy `Object.freeze({ ...ORGANIC, group: firstId })`.
  - `shading-policy.js` exports `SIBLING_SEAM_ANGLE = 5`.
  - In `creased-normals.js` (and its C++), a cross-ID seam between two policies with the same non-null `group` shades hard only when bent more than `SIBLING_SEAM_ANGLE`, and never draws a line. All other cross-ID seams are unchanged.

- [ ] **Step 1: Write failing tests:**
  - `detail never closes a gap`: press gap 0.2 plus `detail: [{ kind: "noise", amplitude: 0.08, wavelength: 1.1 }]`, at both grids. `pieceGapError.min ≥ 0.198`.
  - `detail fades at a crease`: press gap 0. Crease vertices move by less than 1e-9 under detail.
  - `one ID per piece`: hand fist gap 0 through the Manifold backend. The result has 6 original IDs, all with `group` equal to the first.
  - `crease shades hard, zone seam smooth`:
    - on the hand fist, `creasedNormals` gives split normals across a sampled crease edge between finger and palm IDs (bend > 5°);
    - and shared normals across a sibling seam bent under 5°, the attachment-zone edge;
    - no feature line at either.
  - Parity: the group case in core-parity.
- [ ] **Step 2:** Run those files. Expected: FAIL.
- [ ] **Step 3: Implement** JS and C++. Rebuild with `node scripts/build-core-wasm.mjs`.
- [ ] **Step 4:** Run `node scripts/build-core-wasm.mjs --check` (current), the files, and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(implicit): detail fades at seams; one ID per contact piece; sibling seam shading`.

### Task 7: Native owner capture

**Files:**
- Modify: `native/implicit_eval.cpp`, `native/implicit_eval.h`, `native/implicit_mesh.cpp` (sampling), `src/framework/core/implicit-core.js`, `native/README.md`, `src/framework/core/core-wasm.js` (rebuilt)
- Test: `test/implicit-native-eval.test.js`, `test/implicit-native-sample.test.js`

**Interfaces:**
- Consumes: Task 1's op layout (`fuse = 2` plus the child map) and `evalBatchContact` semantics.
- Produces:
  - The C++ decoder accepts `fuse == 2`; any other non-0/1 value is still refused.
  - Sampling fills per-leaf owners exactly as `evaluateLeaves` does.
  - `NativeSession` gains `leafOwners()` (an `Int8Array` view per leaf, in plan order) and `evalContact(progIndex, X, Y, Z, cap)` with `evalBatchContact`'s `cap` contract.
  - Export names in C++ are the builder's.

- [ ] **Step 1: Write failing parity tests:**
  - `evalContact` equals `evalBatchContact` bit for bit (out, owner, cuts, shares) on the hand and `threePress` exact compiles, 2000 random points, both builds (scalar and SIMD, as the existing native-eval tests do).
  - Native sampling owners equal JS `evaluateLeaves` owners on every `SEAM_CASES` entry at 1.5.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Rebuild the core.
- [ ] **Step 4:** `--check` is current; the files pass; `npm test` passes.
- [ ] **Step 5: Commit** `feat(core): native owner capture for exact contacts`.

### Task 8: Native owner mesher, cleanup and crease

**Files:**
- Modify: `native/implicit_mesh.cpp`, `native/implicit_mesh.h`, `native/implicit_detail.cpp`, `src/framework/core/implicit-core.js`, `src/framework/geometry/implicit/index.js` (stop skipping the core), `native/README.md`, `src/framework/core/core-wasm.js`
- Test: `test/core-parity.test.js`, `test/implicit-native-mesh.test.js`, `test/implicit-native-cleanup.test.js`, `test/implicit-native-detail.test.js`, `test/implicit-speed.test.js`

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces:
  - `meshImplicitCore` runs the owner path whenever `plan.ownerRoot ≥ 0`: owner mesher, owner cleanup, crease cut and detail fade.
  - It returns the same fields as the JS (`vertOwner`, `ownerHeld`, `crease`, `triOwner`).
  - `meshImplicit` no longer skips the core for owner trees.

- [ ] **Step 1: Write failing tests:**
  - core-parity: every `SEAM_CASES` entry at 1.5 and 0.6, core on vs off, byte-identical positions, indices, normals and every owner field.
  - native-mesh, cleanup and detail: stage-by-stage parity on the press and fist cases, as the existing stage tests do.
  - `implicit-speed.test.js`, new test `owner meshing stays within the speed gate`:
    - hand default and fist, exactContact;
    - gates 289 and 323 paced ms at 1.5, and 2478 and 2759 at 0.5;
    - message lines in the existing `line()` style.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Rebuild the core. If the seam gate forces the speed gate up, change the constants, and put the measured numbers and the reason in the commit message.
- [ ] **Step 4:** `--check` is current; the files pass; `npm test` passes; `npm run bench:core` runs.
- [ ] **Step 5: Commit** `feat(core): native owner mesher, cleanup and crease cut`.

### Task 9: Switch on

**Files:**
- Modify:
  - `src/framework/geometry/implicit/index.js` (default `exactContact: true`), `result.js` (gap warning only for nested approximate contacts);
  - `test/implicit-contact.test.js`, `test/implicit-topology.test.js`, `test/implicit-cleanup.test.js`, `test/implicit-speed.test.js`;
  - `docs/superpowers/specs/2026-10-16-implicit-contact-seams-design.md` ("Left to the builder": final constants), the parent spec's grammar note on `gap` if it mentions the floor.
- Test: the files above.

**Interfaces:**
- Consumes: everything.
- Produces: `exactContact` defaults to true. `{ exactContact: false }` remains available for tests.

- [ ] **Step 1: Find the tests that now fail.** Run `npm test` after flipping the default and list every failure. Each is either a PR #283 test pinning the floor, pad fill, gap warning or "light touch keeps the gap", or a regression.
- [ ] **Step 2: Rewrite or delete the PR #283 behaviour tests** to the new behaviour, per the spec's "What changes for an author" table. Fix any regression at its source. Add:
  - `nested contact keeps the old look`: a contact under a `union` has the nested warning, and its near-miss gap is still `≥ clearance(gap, edge)`.
  - `default compile is exact`: the hand compiles with `ownerRoot ≥ 0`.
- [ ] **Step 3:** Run `npm test`, `npm run lint`, `npm run lint:dead` and `npm run typecheck`. Expected: all pass; lint shows only the 7 pre-existing warnings.
- [ ] **Step 4: Update the docs.** Record the final constants in the spec's "Left to the builder" and note which spike flaws were fixed and how.
- [ ] **Step 5: Commit** `feat(implicit): exact contact seams on by default`.
