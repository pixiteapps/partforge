# Contact groups for `k.implicit` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `contact` grammar node whose children press against each other (flat fused pads or a set gap, a pose-driven bulge, attachments that blend near an anchor) instead of bridging or interpenetrating, in both engines, bit-identical.

**Architecture:** `contact` is a new IR node evaluated by one shared scalar function (`contactValue`) that the reference walker, the bytecode interpreter and the C++ interpreter all mirror. The near-miss clearance depends on the grid edge, so the edge is threaded into the reference walker, the interval pass and program emission; it is baked into each emitted program as a constant, so the native core needs no new session state. Bulge regions are found once per compile by a post-pass (`annotateContacts`) and emitted as constants of a `BULGE` op.

**Tech Stack:** plain ESM JS (src/framework/geometry/implicit/), C++ → WebAssembly via em++ 6.0.10 (`native/implicit_eval.cpp`, `node scripts/build-core-wasm.mjs`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-implicit-contact-design.md` (extends `docs/superpowers/specs/2026-10-14-implicit-organic-parts-design.md`).

## Global Constraints

- Node 24: put the pinned Node's `bin` from `~/.nvm/versions/node/` (the `.nvmrc` version) first on PATH; `source nvm.sh` is blocked in the sandbox.
- Output is bit-identical with the native core on and off, both builds (scalar and SIMD): `test/core-parity.test.js` and the `implicit-native-*` tests are the contract and must never be loosened.
- C++ mirrors JS operation order exactly; use `jsmath::jsmin`/`jsmax` (never `std::min`/`fmin`), `-ffp-contract=off` is already set; no `-ffast-math`. Rebuild with `node scripts/build-core-wasm.mjs` and commit `core-wasm.js` in the same commit as the C++ (`test/core-wasm.test.js` fails on stale WebAssembly).
- Pruning stays exact: sparse vs dense meshing byte-identical (`test/implicit-sparse.test.js`), plan inherit vs full walk equal (`test/implicit-plan-inherit.test.js`).
- Program-format additions only: existing opcode numbers and `FN_CODES` do not change.
- No version bump; never `npm publish`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not commit the untracked dev viewer files (`hand-dev.html`, `src/app-hand-dev.js`, `src/hand-dev-worker.js`, `src/hand-dev-part.js`); they are edited locally only.
- Timing uses CPU time (`test/helpers/cpu-pace.js` `cpuMs`); the machine is heavily loaded.

## Review Focus

1. Pieces whose bounding boxes overlap but whose surfaces never touch (two parallel fingers 1.6 mm apart): no bulge, no region, and a clean gap at both preview (1.5 mm) and print (0.6 mm) edges — Task 3 `parallel near miss` test, Task 5 topology test.
2. A pair touching in two separate places (knuckles and tips): two regions, each bulging independently — Task 3 `two regions` test.
3. Attachment anchor whose frame moves with the pose (curl the finger): the joined zone follows the base, the tip still pads into the palm — Task 5 `fist` test.
4. A `contact` nested inside a warp, mirror or repeat, or carrying `frame`/`at`: anchors and regions are in the node's local coordinates — Task 1 `framed contact` test, Task 3 `regions under a frame` test.
5. Degenerate inputs: one child, identical children, `bulge` on with `gap > 0` — Task 1 validation test (fewer than two children is an error) and Task 2 `identical children` parity case.

---

### Task 1: Grammar, IR and reference semantics

**Files:**
- Create: `src/framework/geometry/implicit/contact.js`
- Modify: `src/framework/geometry/implicit/grammar.js` (NODE_KINDS, new `attach` type, contact checks)
- Modify: `src/framework/geometry/implicit/ir.js` (lower `contact`)
- Modify: `src/framework/geometry/implicit/reference.js` (edge parameter, `contact` case)
- Test: `test/implicit-contact.test.js` (new)

**Interfaces:**
- Produces (contact.js):
  - `export const C_MIN_CELLS = 2` — near-miss clearance in grid cells (Task 5 may tune it; tests import the constant, never a literal).
  - `export function clearance(gap: number, edge: number): number` → `Math.max(gap, C_MIN_CELLS * edge)`; `edge = 0` gives `gap`.
  - `export const ATTACH_STRIDE = 8` — packed attachment layout `[ia, ib, ax, ay, az, r0, band, k]`, `ia`/`ib` are slot indices into the value array.
  - `export function attachWeight(att: Float64Array, o: number, x, y, z): number` — `t = clamp((|p − anchor| − r0) / band, 0, 1)`, returns `1 − t·t·(3 − 2t)`.
  - `export function contactValue(v: Float64Array, nK: number, cl: number, fuse: 0|1, att: Float64Array, nA: number, x, y, z): number` — the field, below.
- Produces (ir.js): IR node `{ kind: "contact", children: number[], gap, bulge, fuse: 0|1, att: Float64Array (ATTACH_STRIDE·nA), regions: Float64Array[] (one per slot, empty until Task 3), L, box, thin, G }`.
- Produces (reference.js): `evalReference(compiled, x, y, z, edge = 0)` and `export function evalNodeAt(compiled, id, x, y, z, edge = 0)` (evaluates one IR node, applying its own `inv`).

`contactValue` (the operation order is the contract the program and C++ mirror):

```
for each slot i: c_i = v[i]
  for each slot j ≠ i: cut = (v[i] − v[j] + cl) * 0.5
                        w = weight of the attachment joining i and j at p, or 0
                        u = w > 0 ? cut + w * (v[i] − cut) : cut
                        c_i = jsmax(c_i, u)
value = min over i of c_i (slot order)
if fuse: value = jsmin(value, s2)      // s2 = second-smallest of v (a tie counts twice)
for each attachment (slot order): kk = k * w(p); if kk > 0: value = jsmin(value, smin2(c_a, c_b, kk))
```

`smin2` is `unionN` on two values (primitives.js). `fuse = gap === 0 ? 1 : 0`. Attachment pairs are looked up by scanning `att` (n is small; no map).

- [ ] **Step 1: Write the failing tests** in `test/implicit-contact.test.js`:
  - `validates contact` — errors (exact strings follow the existing path style): fewer than 2 children → `root.children: contact needs at least 2 children`; `gap: -1` → `root.gap: must be >= 0` (match the existing `nonneg` wording); `attach[0].a` unknown label → `root.attach[0].a: no child labelled "x"`; `a === b`; unknown `near` frame; duplicate pair; `radius`/`k` must be > 0 / ≥ 0.
  - `near miss keeps a clearance` — two spheres r = 5 at x = ±5.25 (0.5 mm gap), `contact`, edge 1: `evalReference` at the origin ≥ `clearance(0, 1) / 2 − 1e-12`, and at (±(5.25 − 5), 0, 0) on each sphere's inner pole ≥ 0.
  - `overlap fuses a pad` — spheres at x = ±4 (2 mm overlap), `gap: 0`, edge 1: value at origin < 0; along the y axis through the pad the value equals `min(d_a, d_b)` within 1e-12 for |y| < 2.
  - `gap keeps pads apart` — same spheres, `gap: 0.5`, edge 0.1: value at origin ≥ 0.25 − 1e-12; at (0, 0, 0) ± 0.3 on x it is the cut piece.
  - `attachment joins near the anchor` — capsule finger touching a box palm, attached at an anchor frame at the joint with radius 10, band 4, k 3: inside the radius the value equals `unionN([d_a, d_b], 2, 3)`; 20 mm away along the finger the attached pair is cut like any pair.
  - `framed contact` — the same two-sphere tree under a `frame` rotated 90° about z and an `at` offset: values equal the unframed tree at the transformed points (anchor too).
  - `edge 0 is the bare gap` — `clearance(0.3, 0) === 0.3`.
- [ ] **Step 2: Run** `npx vitest run test/implicit-contact.test.js` — expect failures (unknown kind `contact`).
- [ ] **Step 3: Grammar.** Add `contact: { req: { children: "children" }, opt: { gap: "nonneg", bulge: "nonneg", attach: "attach" } }` and the checks above. `attach` entries: `{ a: string, b: string, near: string, radius: pos, k: nonneg, band?: pos }` (default `band = radius / 2`, your call recorded in the spec's "left to the builder" list).
- [ ] **Step 4: IR.** Lower children like `union`. `bulge` default: `BULGE_DEFAULT` exported from contact.js, start `0.6` (Task 5 tunes). Anchor = `invert(W)` applied to the `near` frame's world origin (W is the node's world transform in `lower`). Box: union of child boxes padded by `(bulge + max attach k / 4) / G0`; `G = G0`; `thin` = min child thin; `L` = max child L (informational — interval pruning never reads a combine node's L).
- [ ] **Step 5: Reference.** Thread `edge` through `evalNode`; `contact` case evaluates children, then `contactValue(v, n, clearance(n.gap, edge), n.fuse, n.att, nA, x, y, z)` with the node-local point.
- [ ] **Step 6: Run** the new tests and `npx vitest run test/implicit-*.test.js` — all pass.
- [ ] **Step 7: Commit** `feat(implicit): contact node — grammar, IR and reference field`.

### Task 2: Interval pruning and bytecode (JS), edge threaded through planning

**Files:**
- Modify: `src/framework/geometry/implicit/interval.js` (`contact` case; `edge` param on `blockDecision`, `fullDecision`)
- Modify: `src/framework/geometry/implicit/program.js` (`OP.CONTACT = 14`, `OP.BULGE = 15`, emit + run)
- Modify: `src/framework/geometry/implicit/sparse.js` (pass `edge` to `blockDecision`/`emitProgram`)
- Modify: `src/framework/geometry/implicit/contact.js` (`contactInterval`)
- Test: `test/implicit-contact.test.js`, `test/fixtures/implicit-small-trees.js` (add contact trees), existing `test/implicit-program.test.js`, `test/implicit-sparse.test.js`, `test/implicit-plan-inherit.test.js`, `test/implicit-interval.test.js`

**Interfaces:**
- Consumes: Task 1's `contactValue`, `clearance`, `attachWeight`, IR node shape.
- Produces:
  - `blockDecision(compiled, cx, cy, cz, r, parentDec, edge)`, `fullDecision(compiled, edge)`, `emitProgram(compiled, dec, edge)`.
  - Program layout `[CONTACT, dst, p, cl, fuse, nK, nA, kidReg × nK, (ia, ib, ax, ay, az, r0, band, k) × nA]` (ia/ib re-indexed to emitted slots; attachments with a pruned side are dropped) and `[BULGE, dst, src, p, nR, (cx, cy, cz, A, rho) × nR]` (emitted by Task 3; reserve and implement the interpreter case now, tested with a hand-built program).
  - `contactInterval(...)` used by interval.js.

Pruning rule (exact, pin it): slot j is pruned in a ball only if all hold, with the union's `1e-12` margin pattern: (a) `lo_j > H2`, H2 = second-smallest `hi` over the other slots; (b) for every other slot i, `lo_i + lo_j > cl`; (c) every attachment involving j has `w = 0` over the ball (distance to anchor − r ≥ r0 + band). Firm/inherit bookkeeping follows the union case. If one slot remains, the node's decision returns that child (as `union` does when one value is left); the interval of the node otherwise comes from interval arithmetic over `contactValue`'s formula (w interval from the distance range; `kk/4` lowers `lo`).

- [ ] **Step 1: Failing tests.** Add contact trees to `implicit-small-trees.js`: `contactNearMiss`, `contactOverlap`, `contactGap`, `contactAttach`, `contactThree` (three capsules, one pair touching), `contactIdentical` (two identical spheres). Existing table-driven tests (program == reference on random points; sparse == dense; inherit == full walk; interval contains every sampled value) pick them up. Add `program carries the clearance` — the same compiled tree emitted at edges 0.5 and 1.5 gives programs differing only in the `cl` slot.
- [ ] **Step 2: Run** those test files — new cases fail.
- [ ] **Step 3: Implement** the interval case, the emitter and the interpreter cases; `runProgram`'s CONTACT gathers kid values per lane into a scratch array (like UNION) and calls `contactValue`.
- [ ] **Step 4: Run** `npx vitest run test/implicit-*.test.js` — pass. Run the full suite once (`npm test`) — 0 failures.
- [ ] **Step 5: Commit** `feat(implicit): contact pruning and bytecode; grid edge reaches planning`.

### Task 3: Contact regions and bulge (JS)

**Files:**
- Modify: `src/framework/geometry/implicit/contact.js` (`annotateContacts`, `bulgeOffset`, `bulgeInterval`)
- Modify: `src/framework/geometry/implicit/index.js` (`compileImplicit` calls `annotateContacts(compiled)` after `lowerSpec`)
- Modify: `src/framework/geometry/implicit/interval.js` (export `nodeInterval(compiled, id, x, y, z, r, edge)`; bulge on children)
- Modify: `src/framework/geometry/implicit/program.js` (emit BULGE for children with regions), `reference.js` (bulge on children)
- Test: `test/implicit-contact.test.js`, small-trees fixture

**Interfaces:**
- Consumes: Task 1 `evalNodeAt`, Task 2 interval machinery.
- Produces:
  - `annotateContacts(compiled): void` — fills each contact node's `regions[slot]` as a Float64Array of `(cx, cy, cz, A, rho)` per region (the BULGE op's layout), and appends a region digest to `compiled.digests` so the content hash changes with them.
  - `bulgeOffset(R: Float64Array, o: number, nR: number, x, y, z): number` = Σ over regions in order of `A · φ(|p − c| / rho)`, `φ(t) = t < 1 ? (1 − t²)² : 0`. Piece value is `d − bulgeOffset(...)`.
  - Constants (Task 5 tunes): `REGION_CELL = 0.5` mm, `BULGE_FULL_DEPTH = 1.5` mm, `BULGE_SPREAD = 2`, `MAX_REGION_CELLS = 20000`.

Region search per pair (a, b) of a contact node whose boxes intersect, in the node's local coordinates, using the un-bulged children: octree over the box intersection with `nodeInterval`; drop a cell when `max(lo_a, lo_b) > 0`; at cell size ≤ `REGION_CELL`, a cell is overlapping when `max(d_a, d_b) < 0` at its centre (`evalNodeAt`). Cluster overlapping cells by 26-connectivity in sorted integer-coordinate order (deterministic). Per cluster: `c` = mean of cell centres, `δ` = −min of `max(d_a, d_b)` over its cells, `ρ` = max centre distance from `c` + `REGION_CELL/2`. Drop a cluster whose `c` has attachment weight > 0 for the pair (the joined base). `A = bulge · min(1, δ / BULGE_FULL_DEPTH)`, `rho = ρ + BULGE_SPREAD · δ + 2 · bulge`. One region record for each of a and b. Over `MAX_REGION_CELLS` leaf cells for a pair: stop the search for that pair, keep no regions for it, and push a compile warning (`compiled.warnings`, surfaced by `implicitResult`).

**Amendment (ruling 2026-10-16): the gap-0 pad fill is gated by the regions.** `contactValue` gains a fill gate: with `fuse`, the fill is `f = s2 + (1 − g) · cl`, where `g = max over the node's regions of gateWeight(region, p)`, `gateWeight` = 1 within `ρ + cl + FILL_BAND` of the region centre, smoothstep to 0 over a further `FILL_BAND` (start `FILL_BAND = 2` mm). Regions for the gate are per pair, stored once per node as `fillRegions: Float64Array` of `(cx, cy, cz, rho)` (CONTACT op appends `nF, (cx, cy, cz, rho) × nF` after the attachments; Task 2's interpreter/emitter and Task 4's C++ take this layout). With no regions the fill is `s2 + cl` (never fuses). Task 1's `near miss` test, which had to use `gap: 0.01`, gets a `gap: 0` twin here; the `overlap fuses a pad` test still holds once regions exist.

- [ ] **Step 1: Failing tests:** `gap-0 near miss keeps a clearance` (two spheres 0.5 mm apart, `gap: 0`, edge 1: value at origin ≥ cl/2 − 1e-12); `two spheres overlapping by 2 mm → one region, δ ≈ 1 ± REGION_CELL`; `near miss → no regions`; `parallel near miss` (two capsules 1.6 mm apart, boxes overlapping) → no regions; `two regions` (two bent capsules touching at both ends) → two regions; `regions under a frame` (rotated framed tree → regions in node-local coords equal to unframed); `bulge is zero without contact` (near-miss tree meshes byte-identical with `bulge: 0` and `bulge: 2`); `bulge grows with press depth` (max outward displacement at the rim increases monotonically for overlaps 0.5, 1, 2 mm); `attached base has no region`; `compile cost` — `compileImplicit(handSpec-with-contact)` CPU ≤ 20 ms (cpuMs) — this test lands in Task 5 once the hand uses contact; here use a five-capsule fan.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**; bulge applies to a child's value before `contactValue` in reference, interval (`bulgeInterval` from the ball's distance range to each centre) and program (BULGE op on the child's register).
- [ ] **Step 4: Run** `npx vitest run test/implicit-*.test.js` then `npm test` — pass.
- [ ] **Step 5: Commit** `feat(implicit): contact regions and bulge`.

### Task 4: Native port

**Files:**
- Modify: `native/implicit_eval.h` / `native/implicit_eval.cpp` (ops CONTACT = 14, BULGE = 15 in the decoder and interpreter, scalar and SIMD paths)
- Modify: `native/README.md` (the two ops, operation order)
- Regenerate: `src/framework/core/core-wasm.js`
- Test: `test/fixtures/implicit-native-cases.js` (contact trees from the small-trees fixture are already included via `TREES`; add a `contactHand` case once Task 5 exists — not here), `test/implicit-native-eval.test.js` (a hand-built BULGE program), `test/core-parity.test.js`

**Interfaces:**
- Consumes: the program layout from Task 2/3. Native planning is unchanged (programs carry `cl`).

- [ ] **Step 1: Failing tests:** run `npx vitest run test/implicit-native-*.test.js test/core-parity.test.js` — the contact cases fail (bad opcode → refusal/fallback is a test failure in the parity suites).
- [ ] **Step 2: Implement** the two ops mirroring `contactValue`/`bulgeOffset` operation for operation (`jsmath::jsmin/jsmax`, the same `cut + w*(v_i − cut)` form, `sqrt` for the distance). The decoder validates counts and register indices like UNION and refuses malformed programs.
- [ ] **Step 3: Build** `node scripts/build-core-wasm.mjs`; `node scripts/build-core-wasm.mjs --check` reports current.
- [ ] **Step 4: Run** the native and parity suites, both builds (`PARTFORGE_CORE_SIMD=false` covered by `core-parity.test.js`), then `npm test` — pass.
- [ ] **Step 5: Commit** C++, README and `core-wasm.js` together: `feat(implicit): contact and bulge ops in the native core`.

### Task 5: The hand uses contact; tuning; topology and speed

**Files:**
- Modify: `test/fixtures/implicit-trees.js` (`handSpec`: palm, thumb and four fingers in one `contact`, `gap: 0`, each digit attached to the palm at its base frame (each finger's first bone frame, the thumb's root frame) with `k: palmBlend * s`; remove the outer finger-to-palm blend and the `k: 0` fingers union)
- Modify: `test/fixtures/implicit-native-cases.js` (add a fist-pose hand case at edge 1.5)
- Modify: `test/implicit-topology.test.js`, `test/implicit-speed.test.js`
- Modify (local only, never committed): `src/hand-dev-part.js` — `gap` and `bulge` sliders, a `fist` preset
- Modify: `src/framework/geometry/implicit/contact.js` (tuned constants)

**Interfaces:**
- Consumes: everything above. `handSpec(params)` gains optional `contactGap` (default 0) and `bulge` (default `BULGE_DEFAULT`).

- [ ] **Step 1: Failing tests** in `implicit-topology.test.js`:
  - `near-miss fingertips stay apart` — pose with index/middle tips 0.75 mm apart (find it by a spread sweep; record the parameter value in the test), preview edge 1.5 and print edge 0.6: watertight, and the mesh's connected components restricted to a box around the two tips (cut with a plane through the bisector) show no triangle crossing the bisector.
  - `fist` — curl 100%: watertight; for each fingertip, the region record against the palm exists (from `compiled`), and no smooth-blend fillet: the mesh's max surface distance from the cut-piece surface around the tip pad is ≤ bulge + one edge.
  - `open hand unchanged at the base` — open pose: within the attachment radius, the contact hand's samples equal a plain `unionN` blend of finger and palm (evaluate `evalReference` on a few points).
  - Pose sweep (existing) — still watertight with expected genus.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Restructure `handSpec`**, then tune by eye in the dev viewer (http://localhost:5175/hand-dev.html, server already configured in `.claude/launch.json` as `vite`): `C_MIN_CELLS` (smallest value passing the near-miss test at both edges), `BULGE_DEFAULT`, `BULGE_FULL_DEPTH`, `BULGE_SPREAD`, attachment radii and band. Record each final value and why in the contact spec's "left to the builder" list.
- [ ] **Step 4: Speed.** `npm run bench:implicit` and `test/implicit-speed.test.js`: hand preview stays inside its existing CI gate (450 ms engine, cpuMs); compile with contact ≤ 20 ms. Report before/after numbers in the task report.
- [ ] **Step 5: Run** `npm test` — pass.
- [ ] **Step 6: Commit** `feat(implicit): the hand presses instead of bridging — contact, attachments, tuned bulge`.

### Task 6: Nail outlines, the gap warning, docs

**Files:**
- Modify: `src/framework/geometry/implicit/result.js` (warning), `src/framework/geometry/manifold-backend.js` and/or `src/framework/geometry/shading-policy.js` (nail seam lines)
- Modify: `docs/superpowers/specs/2026-10-14-implicit-organic-parts-design.md` (grammar table row for `contact`), `docs/research/organic-shapes.md` (one paragraph: contact vs blends)
- Test: `test/implicit-shading.test.js`, `test/implicit-contact.test.js`

**Interfaces:**
- Consumes: IR contact nodes (`gap`), `implicitResult`.

- [ ] **Step 1: Failing tests:**
  - `implicit-shading`: the hand with nails unioned on (`k.union([hand, ...nails])`, as `src/hand-dev-part.js` does) produces 0 outline edge floats along nail seams — the same assertion style as the existing ORGANIC test (43,374 → 0). Lines between an ORGANIC surface and a non-organic one (an implicit unioned with a `k.box`) are still drawn.
  - `gap warning` — a contact with `gap: 0.4` meshed at edge 0.6 warns `implicit: contact gap (0.40 mm) is under 2 grid cells at 0.6 mm — the grid cannot show it; raise the gap or mesh finer`; at edge 0.1 no warning; `gap: 0` never warns.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** Find why seams between two ORGANIC original IDs still draw (the boundary between distinct original IDs is drawn regardless of `sameSurfaceLines`); suppress lines where both sides are ORGANIC. Add the warning (needs the smallest non-zero `gap` over contact nodes — record it on `compiled` in `lowerSpec`).
- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run lint:dead`, `npm run typecheck` — clean (pre-existing warnings only).
- [ ] **Step 5: Commit** `fix(implicit): no outline lines along organic seams; contact gap warning; docs`.
