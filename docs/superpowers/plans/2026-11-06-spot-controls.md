# Spot Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a face opens the selection popover with up to three sliders for the parameters that face was built from, newest first, with no per-part authoring.

**Architecture:** The worker records an ordered read log per sub-part build and, at every author-facing kernel op, attaches the reads since the previous op to the face runs that op minted or moved (keyed per Manifold run: original id plus run transform). `toMesh` ships an origin index per triangle. On the main thread a pure resolver turns the clicked triangle's origin, the piece's read list, the handles on that piece and the relevant control set into at most three keys, and the popover draws them with a second `buildControls` over the shared `params`.

**Tech Stack:** plain ESM, vitest (happy-dom for DOM tests), Manifold WASM through `manifold-backend.js`, three.js viewer, the schema-driven panel.

**Spec:** `docs/superpowers/specs/2026-11-06-spot-controls-design.md`

## Global Constraints

- Node 24: prefix every command with `PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH` (the shell default is too old; `nvm use` is blocked in the sandbox).
- Run everything from the worktree `/Users/scottsykora/Documents/Docs/pixite/code/partforge/.claude/worktrees/feedback-220-a748ad`; it has its own `node_modules`.
- Every new module imported by `jobs.js` or `manifold-backend.js` is a pure leaf: no DOM, no `node:`, nothing under `oracle/` or `export/` (`test/worker-layering.test.js` enforces it).
- Nudged attribution never enters `expandReads(sink)`, `sink.attribution`, `m.reads` or `mesh-cache.js`: it ranks, it never gates (spec §3).
- The provenance hook fires on every author-facing op call, cache hit or miss; it is a no-op when no sink is installed (spec §1).
- Cap of three controls; handle exclusion before the cap; newest read first (spec §2).
- `runtime.controlsFor(selection)` keeps its signature and return type (spec §5).
- `build` stays a pure function of `(k, p, d)`; parts are not edited.
- `package.json` is bumped on this branch (0.185.0 → 0.186.0).
- A new DOM test file starts with `// @vitest-environment happy-dom`; the default environment is node.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

- A build that spreads its params (`{ ...p }`) reads every key through `ownKeys`; every face must fall back to the piece list, never show three arbitrary keys. Pinned in Task 6.
- A click on a cutaway section cap (`hit.onCutPlane`) reports the entry triangle, not the cut face; it must resolve at the piece level. Pinned in Task 9.
- A derive that throws under a nudged value (a clamp that asserts, a lookup past an array end) must leave the build and its ranking intact. Pinned in Task 3.
- A face whose only keys are all dragged by a handle on its piece must hide the region with no text, and the composer slot must still be placed. Pinned in Task 11.
- A host write (`setParams`) or an animation frame while the popover is open must move the popover's sliders without firing a commit. Pinned in Task 12.

---

### Task 1: Revert the spike and commit the design

**Files:**
- Modify (revert to HEAD): `src/app-drawer-box.js`, `src/app-gearbox.js`, `src/app-hand.js`, `src/app-hinged-box.js`, `src/app-planter.js`, `src/framework/app.css`, `src/framework/mount.js`, `src/framework/panel/render.js`, `src/framework/selection-popover.js`
- Commit: `docs/superpowers/specs/2026-11-06-spot-controls-design.md`, `docs/superpowers/plans/2026-11-06-spot-controls.md`

- [ ] **Step 1: Revert the spike files**

```bash
git checkout -- src/app-drawer-box.js src/app-gearbox.js src/app-hand.js src/app-hinged-box.js src/app-planter.js src/framework/app.css src/framework/mount.js src/framework/panel/render.js src/framework/selection-popover.js
```

- [ ] **Step 2: Verify the tree holds only the two docs**

Run: `git status --short`
Expected: exactly `?? docs/superpowers/plans/2026-11-06-spot-controls.md` and `?? docs/superpowers/specs/2026-11-06-spot-controls-design.md` (`.claude/launch.json` is gitignored).

- [ ] **Step 3: Run the suite once to confirm a green baseline**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-06-spot-controls-design.md docs/superpowers/plans/2026-11-06-spot-controls.md
git commit -m "docs: spot controls design and plan"
```

---

### Task 2: Ordered read log and derived-path recording

**Files:**
- Modify: `src/framework/read-recorder.js`
- Modify: `src/framework/part-model.js:55-57` (`recordedParams`)
- Test: `test/read-recorder.test.js`

**Interfaces:**
- Produces: `newReadSink()` → `{ raw, dSeen, attribution, log: LogEntry[] }` where `LogEntry` is a param key string, the string `"*"` (an enumeration), or `{ path: string }` for a derived read (`"open.1"`, `"palm"`).
- Produces: `recorder(obj, seen, { through = false, log = null, deep = false, prefix = null })`: with `log`, every `get`/`has` appends the key (or `{ path }` when `deep`), `ownKeys` appends `"*"`. With `deep`, a value that is an array or a plain object with no own function-valued property is returned as a nested proxy up to 3 levels, and a nested read replaces its parent's `{ path }` entry (reading `d.open[1]` leaves only `{ path: "open.1" }`; reading `d.open` alone leaves `{ path: "open" }`). A value with a function property (a posed limb) is returned raw and logged as its own path.
- Produces: `orderedReads(log, { nudged = null, attribution = null, order = null })` → `string[] | null`: raw keys newest first, deduplicated keeping the newest; `{ path }` expands through `nudged.depsForPath(path)` when non-null, else `attribution.depsOf?.get(top)`, else `attribution.allInputs`; keys expanded from one entry keep that entry's position and are ordered among themselves by `order` (an array of param keys; declaration order of `allInputs` when null); any `"*"` returns `null`.
- Produces: `recordedParams({ p, d }, sink)` passes `log: sink.log` for both, `deep: true` for `d`.

- [ ] **Step 1: Write the failing tests**

```js
test("the sink logs reads in order, duplicates kept, enumeration as *", () => {
  const sink = newReadSink();
  const p = recorder({ a: 1, b: 2 }, sink.raw, { through: true, log: sink.log });
  void p.a; void p.b; void p.a;
  expect(sink.log).toEqual(["a", "b", "a"]);
  Object.keys(p);
  expect(sink.log.at(-1)).toBe("*");
});

test("deep d recording logs the leaf path and drops the parent entry", () => {
  const sink = newReadSink();
  const d = recorder({ open: [1, 2, 3], pulls: [[0, 1, 2]], palm: { place: () => {}, n: 1 } }, sink.dSeen, { through: true, log: sink.log, deep: true });
  void d.open[1];
  void d.pulls[0][2];
  void d.palm.n;
  expect(sink.log).toEqual([{ path: "open.1" }, { path: "pulls.0.2" }, { path: "palm" }]);
  expect([...sink.dSeen].sort()).toEqual(["open", "palm", "pulls"]);
  expect(Array.isArray(d.open)).toBe(true);
});

test("orderedReads is newest first, expands paths, and refuses an enumeration", () => {
  const attribution = { depsOf: null, allInputs: new Set(["w", "h", "t"]) };
  const nudged = { depsForPath: (path) => (path === "open.1" ? new Set(["t"]) : null) };
  expect(orderedReads(["w", { path: "open.1" }, "h", "w"], { nudged, attribution })).toEqual(["w", "h", "t"]);
  expect(orderedReads(["w", { path: "size" }], { nudged, attribution })).toEqual(["w", "h", "t"]);
  expect(orderedReads(["w", "*"], { nudged, attribution })).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/read-recorder.test.js`
Expected: FAIL (`log` undefined, `orderedReads` not exported).

- [ ] **Step 3: Implement the log, the deep recorder and `orderedReads` in `read-recorder.js`; pass the log from `recordedParams`**

The "parent entry replaced by its child" rule: a nested proxy's `get` finds the last entry whose `path` equals its own path and removes it before pushing the child path. `expandReads` and `expandDerivedReads` stay byte-identical in behaviour.

- [ ] **Step 4: Run the recorder tests and the reads soundness suite**

Run: `npx vitest run test/read-recorder.test.js test/recorded-reads-soundness.test.js test/recorded-reads-jobs.test.js test/param-deps-subpart.test.js test/framework/derive-groups.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/read-recorder.js src/framework/part-model.js test/read-recorder.test.js
git commit -m "feat(reads): ordered read log with derived leaf paths"
```

---

### Task 3: Nudged derive attribution (worker-only, ranking-only)

**Files:**
- Create: `src/framework/derive-nudge.js`
- Test: `test/derive-nudge.test.js`

**Interfaces:**
- Produces: `nudgeAttribution(part, p, { steps = new Map(), budgetMs = 10, maxCalls = 64, now = () => performance.now() } = {})` → `null | { depsOfPath: Map<string, Set<string>>, inputs: string[], depsForPath(path: string): Set<string> | null }`.
  - Runs `resolveDerived(part, { ...p })` once (timed); returns `null` when it took longer than `budgetMs`, when the derive is grouped (`typeof part.derive !== "function"`), when there is no derive, or when the numeric inputs exceed `maxCalls`.
  - `inputs` is every key derive read (via `recorder`), in read order.
  - For each input: a number is nudged by `steps.get(key)`, else `1e-3 * |value|`, else `1e-3`; a boolean is toggled; a string or anything else is skipped and counted as a dependency of every path.
  - Leaf paths come from a deep walk over arrays and plain objects (depth unlimited); function-valued leaves are ignored; a leaf differs when `!Object.is(a, b)` or when types differ. Every differing leaf path maps to the input in `depsOfPath`.
  - A derive that throws under a nudge marks that input as a dependency of every path and swallows the throw.
  - `depsForPath(path)` unions the sets of every entry equal to `path` or starting with `path + "."`; returns `null` when none match.

- [ ] **Step 1: Write the failing tests**

```js
import drawerBox from "../src/parts/drawer-box.js";
import hand from "../src/parts/hand.js";

test("drawer-box: each drawer's opening depends on its own slider and the depth", () => {
  const n = nudgeAttribution(drawerBox, { ...drawerBox.defaults }, { steps: new Map([["drawer2Open", 0.1]]) });
  expect([...n.depsForPath("open.1")].sort()).toEqual(["depth", "drawer2Open"]);
  expect([...n.depsForPath("pulls.0")].sort()).toEqual(["depth", "drawer1Open", "height"]);
  expect(n.depsForPath("nothing")).toBeNull();
});

test("hand: the index finger's pose never depends on the thumb", () => {
  const n = nudgeAttribution(hand, { ...hand.defaults }, { budgetMs: 1000 });
  const deps = n.depsForPath("index");
  expect(deps.has("indexCurl")).toBe(true);
  expect(deps.has("thumbCurl")).toBe(false);
});

test("budget, grouped derives and throws", () => {
  const slow = { derive: (p) => { const t = Date.now(); while (Date.now() - t < 20) {} return { a: p.x }; } };
  expect(nudgeAttribution(slow, { x: 1 }, { budgetMs: 10 })).toBeNull();
  expect(nudgeAttribution({ derive: { g: (p) => ({ a: p.x }) } }, { x: 1 })).toBeNull();
  const throws = { derive: (p) => { if (p.x > 1) throw new Error("no"); return { a: p.x, b: p.y }; } };
  const n = nudgeAttribution(throws, { x: 1, y: 2 });
  expect(n.depsForPath("b").has("x")).toBe(true);   // the throwing input depends everything
  expect(n.depsForPath("a").has("y")).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/derive-nudge.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `derive-nudge.js`**

Import only `resolveDerived` from `./derive.js` and `recorder` from `./read-recorder.js`. Clone `p` for every call; never pass `through`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/derive-nudge.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/derive-nudge.js test/derive-nudge.test.js
git commit -m "feat(derive): nudged per-path attribution for ranking"
```

---

### Task 4: Run lineage on Manifold solids

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (`wrap` l.524, transforms l.756-772, booleans, `cached` l.205, `meshCadOp` l.353, the factory ops l.783-1009)
- Create: `src/framework/geometry/run-lineage.js`
- Test: `test/run-lineage.test.js`

**Interfaces:**
- Produces (`run-lineage.js`, pure): `IDENTITY12`, `composeAffine(outer12, inner12 | null)` (Manifold's 3×4 column-major `runTransform` layout), `translateAffine([x,y,z])`, `rotateAffine(deg, center, axis)`, `mirrorAffine(normal)`, `scaleAffine(factor, center)`, `runKey(id, mat | null)` (id plus the 12 values rounded to 1e-4, joined), `dedupeRuns(runs)`.
- Produces (backend): every Solid wrapper gains `_runs(): Array<{ id: number, mat: number[] | null }>` (memoized on the wrapper; `null` mat is identity) and, on the result of a restamping op, `_idMap: Map<number, number>` (old id → new id). `wrap(m, hash, canon, { runs, idMap } = {})` takes the thunk; when none is given, `_runs()` reads `m.originalID()` and answers `[{ id, mat: null }]` when it is not -1, else reads `m.getMesh()` once (runOriginalID + runTransform).
  - Factory ops (box, cylinder, sphere, prism, extrude, revolve, sweep, helixSweptTube, heightfield, roundedBox, import, unsectored loft): the default (single id) path, no getMesh.
  - `translate`/`rotate`/`mirror`/`scale`: `runs: () => self._runs().map((r) => ({ id: r.id, mat: composeAffine(<this op's affine>, r.mat) }))`.
  - `cut`/`union`/`intersect`/`cutAll` and `k.union`: `dedupeRuns([...operands' _runs()])`.
  - `fillet`/`chamfer` (`meshCadOp`): base runs plus `[{ id, mat: null }]` for each new id (the ids `meshCadOp` already marks BLEND).
  - `boredCylinder`, sectored `loft`, roundAll's reference path, offset, `label`: the getMesh fallback is acceptable (they materialize anyway); Task 5 gives `label` its `idMap`.
  - roundAll's decouple fast path (l.451-456) restamps: give its result `idMap` from `blendIdFor` plus every non-blend old id → `baseId`, and `runs` mapped through it, so Task 6 can carry records across.

- [ ] **Step 1: Write the failing tests**

```js
import { bootManifoldKernel } from "../src/testing.js";
import { runKey, translateAffine } from "../src/framework/geometry/run-lineage.js";
let k; beforeAll(async () => { k = await bootManifoldKernel(); });

test("a primitive has one identity run; a transform composes it", () => {
  const c = k.cylinder({ r: 2, h: 5 });
  expect(c._runs()).toEqual([{ id: expect.any(Number), mat: null }]);
  const t = c.translate([3, 0, 0]);
  expect(t._runs()[0].id).toBe(c._runs()[0].id);
  expect(runKey(t._runs()[0].id, t._runs()[0].mat)).toBe(runKey(c._runs()[0].id, translateAffine([3, 0, 0])));
});

test("a boolean keeps both operands' runs and lineage matches the mesh", () => {
  const tool = k.cylinder({ r: 2, h: 12 }).translate([5, 5, -1]);
  const body = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).cut(tool);
  const keys = new Set(body._runs().map((r) => runKey(r.id, r.mat)));
  const g = body._m.getMesh();
  for (let r = 0; r < g.runOriginalID.length; r++) {
    const mat = g.runTransform?.length >= (r + 1) * 12 ? Array.from(g.runTransform.subarray(r * 12, r * 12 + 12)) : null;
    expect(keys.has(runKey(g.runOriginalID[r], mat))).toBe(true);
  }
  g.delete?.();
});

test("two instances of one cached primitive are distinct runs", () => {
  const a = k.cylinder({ r: 1, h: 4 }).translate([2, 0, 0]);
  const b = k.cylinder({ r: 1, h: 4 }).translate([6, 0, 0]);
  expect(a._runs()[0].id).toBe(b._runs()[0].id);
  expect(runKey(a._runs()[0].id, a._runs()[0].mat)).not.toBe(runKey(b._runs()[0].id, b._runs()[0].mat));
});

test("a fillet adds blend runs and keeps the base's", () => {
  const base = k.box({ min: [0, 0, 0], max: [10, 10, 10] });
  const f = base.fillet(1);
  const baseIds = new Set(base._runs().map((r) => r.id));
  const ids = f._runs().map((r) => r.id);
  expect(ids.some((id) => baseIds.has(id))).toBe(true);
  expect(ids.some((id) => !baseIds.has(id))).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/run-lineage.test.js`
Expected: FAIL (`_runs` is not a function).

- [ ] **Step 3: Implement `run-lineage.js` and thread `runs` through `wrap` and the ops listed above**

If the boolean test fails on `runTransform` matching, check the affine layout against `affineAt` in `blend-surfaces.js` (it already decodes `runTransform`); use the same convention.

- [ ] **Step 4: Run the lineage tests, the fillet suites and the core parity test**

Run: `npx vitest run test/run-lineage.test.js test/mesh-fillet-normals.test.js test/boolean-hoist-kernel.test.js test/core-parity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/run-lineage.js src/framework/geometry/manifold-backend.js test/run-lineage.test.js
git commit -m "feat(kernel): per-run lineage on Manifold solids"
```

---

### Task 5: `label()` restamps 1:1

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js:616-748` (`label`)
- Test: `test/feature-labels.test.js`, `test/loft-shading.test.js`

**Interfaces:**
- Produces: `label(name)` reserves one new id per distinct old id on every path (the sector path's rule generalized), maps each old → new in `g0.runOriginalID`, copies `oidPolicies` and `blendSurfaces` per id, registers `featureLabels` for each new id, and returns `wrap(o, lh, undefined, { runs, idMap })` with `runs` the old runs mapped through `idMap` and the same mats. The triangle-weighted majority votes are deleted. The chain-replay guard at the top is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test("label() keeps the mesh's runs: same triangle count as unlabeled, one new id per old id", () => {
  const make = () => k.box({ min: [0, 0, 0], max: [10, 10, 10] }).cut(k.cylinder({ r: 2, h: 12 }).translate([5, 5, -1]));
  const plain = make(), labeled = make().label("Body");
  expect(labeled.toMesh().triangles).toBe(plain.toMesh().triangles);
  expect(labeled._idMap.size).toBe(2);
  expect(new Set(labeled._runs().map((r) => r.id)).size).toBe(2);
  expect(labeled.toMesh().features).toEqual(["Body"]);
});
```

In `test/loft-shading.test.js`, change the two majority-vote tests (l.97 "label after intersect", l.125 "majority vote") to assert per-id inheritance: the loft's faces keep the loft's policy after `label()`, and the tool's faces carry none.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/feature-labels.test.js test/loft-shading.test.js`
Expected: the new test FAILS (idMap undefined / one id); the rewritten shading tests FAIL.

- [ ] **Step 3: Rewrite `label()`**

One path: `olds = [...new Set(g0.runOriginalID)]`, `base2 = Manifold.reserveIDs(olds.length)`, map, `new Manifold(g0)`, registries per id, dispose per id.

- [ ] **Step 4: Run the kernel suites that touch labels**

Run: `npx vitest run test/feature-labels.test.js test/loft-shading.test.js test/mesh-fillet-boundary-lines.test.js test/roundall-flat-shading.test.js test/rim-bevel-shading.test.js test/boolean-hoist-kernel.test.js test/run-lineage.test.js`
Expected: PASS.

- [ ] **Step 5: Check the triangle budget on the reference parts**

Write a throwaway script in the scratchpad that boots a kernel (`bootManifoldKernel` from `src/testing.js`), runs `buildView(kernel, part, <first view>, part.defaults)` (jobs.js l.689 shows the call) for `src/parts/{planter,hinged-box,mixed-smoke,faceted-vase}.js`, and prints the sum of `toMesh().triangles` over the built sub-parts. Run it once pointed at the main checkout (`/Users/scottsykora/Documents/Docs/pixite/code/partforge/src/testing.js`, which is `main`) and once at this worktree.

Expected: no part's total rises by more than 5%. If one does, keep the fold for that case only (the spec's fallback) and say so in the commit message.

- [ ] **Step 6: Render the faceted vase and look at it**

Run: `npx partforge render src/parts/faceted-vase.js` then open `render/` and compare the facet shading and feature lines against a render from `main`.
Expected: flat caps and facets shade as before.

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/manifold-backend.js test/feature-labels.test.js test/loft-shading.test.js
git commit -m "feat(kernel): label() restamps runs 1:1, keeping per-face provenance"
```

---

### Task 6: Provenance recording and `originIds` in `toMesh`

**Files:**
- Create: `src/framework/geometry/provenance.js`
- Modify: `src/framework/geometry/manifold-backend.js` (`meshOut` l.259, kernel object: `beginProvenance`/`endProvenance`)
- Test: `test/provenance.test.js`

**Interfaces:**
- Produces (`provenance.js`, pure, imports only `run-lineage.js`):
  - `createProvenance({ log, expand })` → `prov` with `prov.boundary(op, receiver, args, run)`, `prov.originsFor(g)`, `prov.table: Map<string, string[]>` (run key → keys newest first), `prov.origins: string[][]`.
    - `boundary` records `cursor = log.length` before `run()`, takes `slice = expand(log.slice(cursorBefore))` after (`expand` returns `string[] | null`; `null` means an enumeration: record nothing for this op), then: for a transform op (`op` in `TRANSFORM_OPS = new Set(["translate","rotate","mirror","scale","rotateX","rotateY","rotateZ","rotateAbout","along","at"])`) every result run's record is `[...slice, ...record(input run with the same index)]`; for any other op, every result run whose key is not among the inputs' keys gets `[...slice, ...record(idMap-mapped old key)]`; a result that is not a Solid (no `_runs`) records nothing. Records are newest-first, deduplicated keeping the first occurrence. Inputs are the receiver (a Solid method) plus every Solid in `args` (one level into arrays).
    - `originsFor(g)` takes a Manifold MeshGL: for each run, `(id, mat)` from `runOriginalID`/`runTransform`, finds the table entry with the same id whose mat is within 1e-3 (max abs difference per component) of the run's, else, when exactly one entry carries that id regardless of mat, that entry, else none; returns `{ originIds: Uint16Array(nTri) (0 = none, else 1-based index into origins), origins }` where `origins` lists the distinct non-empty records used, or `null` when no triangle has one.
  - `provenanceKernel(kernel, prov)` → a Proxy over `kernel`: every function-valued property not starting with `_` is called through `prov.boundary(name, null, args, () => target[name](...unwrapped))`; a returned Solid (has `_runs`) is wrapped in a Solid proxy whose function-valued properties go through `prov.boundary(name, target, args, …)` with `this` bound to the target; proxied Solids passed as arguments (directly, in arrays, or as plain-object values) are unwrapped first. Non-Solid results (Shape2D, numbers, arrays) pass through unproxied.
- Produces (backend): `kernel.beginProvenance(prov)` / `kernel.endProvenance()`; while active, `meshOut` adds `originIds`/`origins` from `prov.originsFor(g)` to the `creasedNormals` result (never on the STL path). `toMesh` on a kernel with no active provenance is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
import { bootManifoldKernel } from "../src/testing.js";
import { createProvenance, provenanceKernel } from "../src/framework/geometry/provenance.js";
import { newReadSink, orderedReads, recorder } from "../src/framework/read-recorder.js";
let k; beforeAll(async () => { k = await bootManifoldKernel(); });

function buildWith(build, params) {
  const sink = newReadSink();
  const p = recorder(params, sink.raw, { through: true, log: sink.log });
  const prov = createProvenance({ log: sink.log, expand: (entries) => orderedReads(entries, { attribution: { depsOf: null, allInputs: new Set() } }) });
  k.beginProvenance(prov);
  try { return build(provenanceKernel(k, prov), p).toMesh(); } finally { k.endProvenance(); }
}
const keysAt = (m, t) => m.origins[m.originIds[t] - 1] ?? null;
const faceWithNormal = (m, n) => { for (let t = 0; t < m.triangles; t++) if (m.normals[t*9]*n[0] + m.normals[t*9+1]*n[1] + m.normals[t*9+2]*n[2] > 0.99) return t; throw new Error("no face"); };

test("a box's faces carry the params its box call read, newest first", () => {
  const m = buildWith((k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.d, p.h] }), { w: 10, d: 8, h: 6 });
  expect(keysAt(m, 0)).toEqual(["h", "d", "w"]);
});

test("a cut hole's wall carries the tool's reads; the translate's reads come first", () => {
  const m = buildWith((k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] })
    .cut(k.cylinder({ r: p.holeD / 2, h: p.w + 2 }).translate([p.holeX, p.holeY, -1])), { w: 20, holeD: 4, holeX: 10, holeY: 10 });
  const wall = (() => { for (let t = 0; t < m.triangles; t++) { const nz = m.normals[t*9+2]; const x = m.positions[t*9]; if (Math.abs(nz) < 0.01 && Math.abs(x - 10) < 2.1) return t; } throw new Error(); })();
  expect(keysAt(m, wall)).toEqual(["holeY", "holeX", "w", "holeD"]); // cylinder read holeD then w (its h); translate read holeX, holeY
  expect(keysAt(m, faceWithNormal(m, [0, 0, 1]))).toEqual(["w"]);
});

test("two holes keep their own positions", () => {
  const m = buildWith((k, p) => k.box({ min: [0, 0, 0], max: [40, 20, 5] })
    .cut(k.cylinder({ r: 2, h: 7 }).translate([p.x1, 10, -1]))
    .cut(k.cylinder({ r: 2, h: 7 }).translate([p.x2, 10, -1])), { x1: 10, x2: 30 });
  const near = (x) => { for (let t = 0; t < m.triangles; t++) if (Math.abs(m.normals[t*9+2]) < 0.01 && Math.abs(m.positions[t*9] - x) < 2.1) return t; };
  expect(keysAt(m, near(10))).toEqual(["x1"]);
  expect(keysAt(m, near(30))).toEqual(["x2"]);
});

test("a fillet's blend faces carry the radius; a rebuild from cache records the same", () => {
  const build = (k, p) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }).fillet(p.r);
  const a = buildWith(build, { r: 1 }), b = buildWith(build, { r: 1 });
  const blend = (() => { for (let t = 0; t < a.triangles; t++) { const n = a.normals.subarray(t*9, t*9+3); if (Math.abs(n[0]) > 0.3 && Math.abs(n[2]) > 0.3) return t; } throw new Error(); })();
  expect(keysAt(a, blend)).toEqual(["r"]);
  expect(keysAt(a, faceWithNormal(a, [0, 0, 1]))).toBeNull();
  expect(Array.from(b.originIds)).toEqual(Array.from(a.originIds));
  expect(b.origins).toEqual(a.origins);
});

test("a spread of the params records nothing; a label keeps the records; no provenance means no fields", () => {
  const m = buildWith((k, p) => { const q = { ...p }; return k.box({ min: [0, 0, 0], max: [q.w, q.w, q.w] }); }, { w: 5 });
  expect(m.originIds).toBeUndefined();
  const l = buildWith((k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).label("Body"), { w: 5 });
  expect(keysAt(l, 0)).toEqual(["w"]);
  expect(k.box({ min: [0, 0, 0], max: [1, 1, 1] }).toMesh().originIds).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/provenance.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `provenance.js`, `beginProvenance`/`endProvenance` and the `meshOut` addition**

`boundary` must not call `getMesh()` itself; it only reads `_runs()`. The transform branch pairs result runs with input runs by index (the backend's transform `runs` thunks preserve order).

- [ ] **Step 4: Run the provenance tests and the worker layering guard**

Run: `npx vitest run test/provenance.test.js test/worker-layering.test.js test/run-lineage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/provenance.js src/framework/geometry/manifold-backend.js test/provenance.test.js
git commit -m "feat(kernel): record which params each face run was built from"
```

---

### Task 7: The worker ships origins and piece keys

**Files:**
- Modify: `src/framework/jobs.js:170-171, 212, 441-452, 476-487, 505-511, 533-534`
- Test: `test/provenance-jobs.test.js`

**Interfaces:**
- Consumes: `nudgeAttribution` (Task 3), `createProvenance`/`provenanceKernel` (Task 6), `orderedReads` (Task 2), `controlNodes`/`desugar` (`panel/model.js`, `panel/legacy.js`; already in the worker closure).
- Produces: each generate mesh entry gains `originIds?: Uint16Array`, `origins?: string[][]`, `pieceKeys: string[]` (the sub-part's `expandReads` with each derived read expanded through the nudged table instead of the recorded one, sorted). `transferOf` adds `m.originIds?.buffer`. `meshes-partial` carries the same fields. The `capture-generate` path is unchanged (no provenance installed).

- [ ] **Step 1: Write the failing test**

```js
import { bootManifoldKernel, handle } from "../src/testing.js";
let k; beforeAll(async () => { k = await bootManifoldKernel(); });
const gen = async (part, subparts, params) => { const post = vi.fn(); await handle(k, part, { type: "generate", subparts, view: "v", params }, post); return post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes"); };

const part = {
  parameters: [{ id: "s", title: "S", controls: [
    { key: "w", type: "slider", min: 1, max: 50, step: 1 }, { key: "a", type: "slider", min: 0, max: 100, step: 0.1 }, { key: "b", type: "slider", min: 0, max: 100, step: 0.1 }] }],
  defaults: { w: 20, a: 10, b: 30 },
  views: { v: { label: "V" } },
  derive: (p) => ({ open: [p.a / 10, p.b / 10] }),
  parts: {
    one: { views: ["v"], build: (k, p, d) => k.box({ min: [0, 0, 0], max: [p.w, p.w, d.open[0]] }) },
    two: { views: ["v"], build: (k, p, d) => k.box({ min: [0, 0, 0], max: [p.w, p.w, d.open[1]] }) },
  },
};

test("generate ships per-triangle origins and nudged piece keys, and leaves reads alone", async () => {
  const { meshes } = await gen(part, ["one", "two"], part.defaults);
  const one = meshes.find((m) => m.name === "one"), two = meshes.find((m) => m.name === "two");
  expect(one.reads).toEqual(["a", "b", "w"]);          // recorded attribution: unchanged, sound
  expect(one.pieceKeys).toEqual(["a", "w"]);           // nudged: open.0 depends on a alone
  expect(two.pieceKeys).toEqual(["b", "w"]);
  expect(one.origins[one.originIds[0] - 1]).toEqual(["a", "w"]);
  expect(two.origins[two.originIds[0] - 1]).toEqual(["b", "w"]);
});

test("capture-generate carries no origins", async () => {
  const post = vi.fn();
  await handle(k, part, { type: "capture-generate", subparts: ["one"], view: "v", params: part.defaults }, post);
  const reply = post.mock.calls.map(([m]) => m).find((m) => m.type === "capture-meshes");
  expect(reply.meshes[0].originIds).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/provenance-jobs.test.js`
Expected: FAIL (`pieceKeys` undefined).

- [ ] **Step 3: Wire jobs.js**

In the generate branch: compute `nudged = nudgeAttribution(part, p, { steps })` once per job (steps from `controlNodes(desugar(part.parameters))`, numeric types only), memoized on `kernel` by a key of the params JSON; in `displayWithReads` create `prov = createProvenance({ log: sink.log, expand: (e) => orderedReads(e, { nudged, attribution }) })`, call `kernel.beginProvenance?.(prov)` and build through `provenanceKernel(kernel, prov)` when `beginProvenance` exists; return `prov` so the loop can call `kernel.endProvenance?.()` in its `finally` after `toMesh`. `pieceKeys` = the sorted unique keys of `orderedReads(sink.log, { nudged, attribution })`, or a copy of `reads` when that returns `null` (an enumeration); the leaf paths in the log are what keep `open.0` from pulling in `b`.

- [ ] **Step 4: Run the jobs suites and layering**

Run: `npx vitest run test/provenance-jobs.test.js test/recorded-reads-jobs.test.js test/cache-jobs.test.js test/place-only-jobs.test.js test/feature-labels.test.js test/worker-layering.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/jobs.js test/provenance-jobs.test.js
git commit -m "feat(worker): ship face origins and nudged piece keys per mesh"
```

---

### Task 8: The viewer keeps origins and answers piece bounds; the picker hands the hit on

**Files:**
- Modify: `src/framework/viewer.js:1865-1895` (`buildGeometry`), `:1945-1976` (beside `getSubMeshPayload`), `:3519-3532` (exports)
- Modify: `src/framework/selection/pick.js:16-43`
- Test: `test/selection-raycast.test.js` (viewer side), `test/selection-pick-hit.test.js` (new), `test/framework/mount.test.js` (`pickBody` helper)

**Interfaces:**
- Produces: `buildGeometry` stores `userData.originIds`/`userData.origins` when present. `viewer.getSubOrigins(name)` → `{ originIds, origins } | null`. `viewer.getSubBounds(name)` → `{ min: [x,y,z], max: [x,y,z] } | null`: the geometry's `boundingBox` transformed by the sub-mesh's current matrix (the fast-path pose), in the shared CAD frame.
- Produces: `attachPicker`'s `onPick(selection, anchor, hit)` gains the internal hit as a third argument (`{ subPart, triIndex, onCutPlane? }` is all mount reads).

- [ ] **Step 1: Write the failing tests**

In `test/selection-raycast.test.js` (happy-dom), using the file's existing viewer fixture:

```js
it("keeps origins on the geometry and answers posed bounds", () => {
  viewer.setSubGeometry("a", { ...payloadOf1mmTriangle(), originIds: new Uint16Array([1]), origins: [["w"]] });
  expect(viewer.getSubOrigins("a")).toEqual({ originIds: new Uint16Array([1]), origins: [["w"]] });
  viewer.setSubPose("a", translationMatrix(5, 0, 0));
  expect(viewer.getSubBounds("a").min[0]).toBeCloseTo(5);
  expect(viewer.getSubOrigins("none")).toBeNull();
});
```

Create `test/selection-pick-hit.test.js` (happy-dom). `vi.mock("../src/framework/selection/raycast.js")` so `raycastViewer` returns `{ subPart: "body", triIndex: 7, pointLocal: [0, 0, 0], normalLocal: [0, 0, 1], pointWorld: new THREE.Vector3(), feature: null }`; call the real `attachPicker(viewerStub, { part, getContext: () => ({ view: "v", params: {}, readsOf: () => null }), onPick })` with a `viewerStub` carrying the `domElement`, `camera`, `flashPoint` and `onPick`-path methods pick.js reads (read `pick.js` l.16-43 for the exact set); dispatch the click pick.js listens for on `domElement`; assert `onPick.mock.calls[0][2].triIndex === 7`. In `test/framework/mount.test.js`, extend the existing `pickBody` helper to take a `hit` and pass it as the third `onPick` argument (Task 12 relies on it).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/selection-raycast.test.js test/selection-pick-hit.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`getSubBounds` reads `subCache[name].boundingBox` and the sub-mesh's `matrix` (see `_subMeshes`); no vertex copy.

- [ ] **Step 4: Run**

Run: `npx vitest run test/selection-raycast.test.js test/selection-pick-hit.test.js test/framework/mount.test.js test/selection-index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewer.js src/framework/selection/pick.js test/selection-raycast.test.js test/selection-pick-hit.test.js test/framework/mount.test.js
git commit -m "feat(viewer): keep face origins, answer piece bounds, pass the hit to onPick"
```

---

### Task 9: The pure spot resolver

**Files:**
- Create: `src/framework/selection/spot-keys.js`
- Test: `test/spot-keys.test.js`

**Interfaces:**
- Produces: `SPOT_CAP = 3`.
- Produces: `resolveSpotKeys({ faceKeys = null, pieceKeys = [], excluded = new Set(), drawable = new Set(), cap = SPOT_CAP })` → `{ keys: string[], source: "face" | "piece" | null, more: boolean }`. Face keys are used in their given order when `faceKeys` is a non-empty array; else `pieceKeys` in its given order with `source: "piece"`; `excluded` keys and keys not in `drawable` are dropped before the cap; `more` is true when the full list (face keys followed by piece keys not already present, after the same filtering) is longer than `keys`; `source: null` and `keys: []` when nothing survives.
- Produces: `faceKeysOf(origins, hit)` → `string[] | null`: `null` when `origins` is null, `hit` is null, `hit.onCutPlane`, or `originIds[hit.triIndex]` is 0.
- Produces: `handleOnPiece(handle, name, { point = null, bounds = null, slack = 2 })` → boolean: true when `handle.showOn` is `name` or a list containing it; else, with no `showOn`, true when `point` lies within `bounds` grown by `slack` on every side; false otherwise.

- [ ] **Step 1: Write the failing tests**

```js
test("face keys win, exclusion precedes the cap, more reflects what was cut", () => {
  const r = resolveSpotKeys({ faceKeys: ["y", "x", "d", "w"], pieceKeys: ["d", "w", "x", "y", "z"], excluded: new Set(["x"]), drawable: new Set(["y", "d", "w", "z"]) });
  expect(r).toEqual({ keys: ["y", "d", "w"], source: "face", more: true });
});
test("piece fallback keeps the panel's order; nothing left hides the region", () => {
  expect(resolveSpotKeys({ faceKeys: null, pieceKeys: ["a", "b"], drawable: new Set(["a", "b"]) })).toEqual({ keys: ["a", "b"], source: "piece", more: false });
  expect(resolveSpotKeys({ faceKeys: ["a"], pieceKeys: ["a"], excluded: new Set(["a"]), drawable: new Set(["a"]) })).toEqual({ keys: [], source: null, more: false });
});
test("faceKeysOf refuses a section cap, a missing hit and an unknown origin", () => {
  const origins = { originIds: new Uint16Array([0, 1]), origins: [["w"]] };
  expect(faceKeysOf(origins, { triIndex: 1 })).toEqual(["w"]);
  expect(faceKeysOf(origins, { triIndex: 1, onCutPlane: true })).toBeNull();
  expect(faceKeysOf(origins, { triIndex: 0 })).toBeNull();
  expect(faceKeysOf(null, { triIndex: 1 })).toBeNull();
});
test("handleOnPiece: showOn wins, else the point inside the grown bounds", () => {
  expect(handleOnPiece({ showOn: "drawer1" }, "drawer1", {})).toBe(true);
  expect(handleOnPiece({ showOn: ["a", "b"] }, "c", {})).toBe(false);
  const bounds = { min: [0, 0, 0], max: [10, 10, 10] };
  expect(handleOnPiece({}, "x", { point: [11.5, 5, 5], bounds })).toBe(true);
  expect(handleOnPiece({}, "x", { point: [13, 5, 5], bounds })).toBe(false);
  expect(handleOnPiece({}, "x", { point: null, bounds })).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/spot-keys.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `spot-keys.js`** (no imports).

- [ ] **Step 4: Run**

Run: `npx vitest run test/spot-keys.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/spot-keys.js test/spot-keys.test.js
git commit -m "feat(selection): pure resolver for a spot's controls"
```

---

### Task 10: `buildControls` draws a subset

**Files:**
- Modify: `src/framework/panel/render.js:31-33`
- Test: `test/framework/panel/render.test.js`

**Interfaces:**
- Produces: `buildControls(root, parameters, params, onDirty, onCommit, { only?: Set<string> })`: with `only`, the tree keeps control nodes whose `key` is in the set and the groups that still hold one; order follows the schema. `syncValues`, `refresh`, `dispose` unchanged.

- [ ] **Step 1: Write the failing test**

```js
it("only: draws the named controls in schema order and nothing else", () => {
  const parameters = [{ id: "c", title: "Cabinet", controls: [
    { key: "width", type: "slider", min: 1, max: 10 }, { key: "depth", type: "slider", min: 1, max: 10 }, { key: "height", type: "slider", min: 1, max: 10 }] }];
  const root = document.createElement("div");
  const panel = buildControls(root, parameters, { width: 2, depth: 3, height: 4 }, () => {}, () => {}, { bare: true, only: new Set(["height", "width"]) });
  expect([...root.querySelectorAll("input[type=range]")].map((i) => i.closest(".slider").querySelector("label").textContent)).toEqual(["width", "height"]);
  expect(root.querySelector(".sec-header")).toBeNull();
  panel.dispose();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/panel/render.test.js -t "only"`
Expected: FAIL (three sliders drawn).

- [ ] **Step 3: Implement the prune** (a local `pruneTree(tree, only)` applied after `buildTree`).

- [ ] **Step 4: Run the panel suites**

Run: `npx vitest run test/framework/panel test/framework/controls.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/render.js test/framework/panel/render.test.js
git commit -m "feat(panel): buildControls can draw a subset of keys"
```

---

### Task 11: The popover's controls region

**Files:**
- Modify: `src/framework/selection-popover.js` (options l.32, DOM l.33-55, `place()` l.105-146, `open()` l.221-232, `close()` l.247-262, handle l.274-298)
- Modify: `src/framework/app.css` (after `.pf-selection-slot`, l.~933)
- Test: `test/selection-popover.test.js`

**Interfaces:**
- Produces: `attachSelectionPopover({ ..., controls = null })` where `controls` is `{ build(container: HTMLElement, spot: { subPart: string, hit: object | null }) => { dispose(): void } | null }`.
- Produces: a `div.pf-selection-controls` between `head` and the slot, `hidden` until `build` returns non-null; built in `open()` after `renderHead()` (when `rowFor(subPart)`), disposed and rebuilt by `refreshControls()`, disposed in `close()` and `detach()`; `place()` runs after each build. `open({ subPart, anchor, page, hit = null })` stores `hit` on `current`; `getState()` is unchanged.
- Produces: in `place()`, after the existing slot shrink to `MIN_SLOT`, when the natural height still exceeds `plan.maxHeight` on the spot page, `ctlEl.style.maxHeight` is set to `max(72, maxHeight - (natural - ctlHeight))` and the region scrolls (`overflow: auto`); otherwise its `maxHeight` is cleared.
- Produces: `.pf-selection-controls { display: flex; flex-direction: column; min-height: 0; overflow: auto; padding-top: 6px; border-top: 1px solid var(--pf-border); }`, `.pf-selection-controls .section { padding: 0; }`, `.pf-selection-controls .slider { margin: 6px 0; }`, `.pf-selection-more { align-self: flex-start; border: 0; background: none; padding: 2px 0 4px; font: inherit; font-size: 11px; color: var(--pf-muted-2); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }` plus the same `:focus-visible` ring the head buttons use. No new colours.

- [ ] **Step 1: Write the failing tests**

```js
describe("selection popover: controls region", () => {
  const controls = (impl) => ({ build: vi.fn(impl) });
  it("builds between the head and the slot, passes the hit, hides when build returns null", () => {
    const c = controls((el, spot) => { el.append(Object.assign(document.createElement("i"), { textContent: spot.subPart })); return { dispose: vi.fn() }; });
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()), controls: c });
    p.open({ subPart: "body", anchor: at, hit: { triIndex: 3 } });
    const spot = p.element.querySelector(".pf-selection-spot");
    expect([...spot.children].map((e) => e.className)).toEqual(["pf-selection-head", "pf-selection-controls", "pf-selection-slot"]);
    expect(c.build.mock.calls[0][1]).toEqual({ subPart: "body", hit: { triIndex: 3 } });
    expect(spot.querySelector(".pf-selection-controls").hidden).toBe(false);
    c.build.mockImplementation(() => null);
    p.refreshControls();
    expect(spot.querySelector(".pf-selection-controls").hidden).toBe(true);
    p.detach();
  });
  it("disposes on close and on rebuild; the slot is still reported when the region is hidden", () => {
    const dispose = vi.fn();
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()), controls: controls(() => ({ dispose })) });
    const reports = []; p.onSlotChange((r) => reports.push(r));
    p.open({ subPart: "body", anchor: at });
    p.refreshControls();
    expect(dispose).toHaveBeenCalledTimes(1);
    p.close("dismiss");
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(reports.some((r) => r.state === "open")).toBe(true);
    p.detach();
  });
  it("a tall region scrolls while the slot keeps its floor", () => {
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()), controls: controls((el) => { el.style.height = "900px"; return { dispose() {} }; }) });
    p.setSlotHeight(300);
    p.open({ subPart: "body", anchor: at });
    const ctl = p.element.querySelector(".pf-selection-controls");
    expect(parseFloat(ctl.style.maxHeight)).toBeGreaterThan(0);
    expect(p.element.querySelector(".pf-selection-slot").style.height).toBe("44px");
    p.detach();
  });
});
```

(happy-dom has no layout: give the test stage the same `getBoundingClientRect` stub the file already uses and stub `pop.offsetHeight` as the existing placement tests do.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/selection-popover.test.js -t "controls region"`
Expected: FAIL.

- [ ] **Step 3: Implement the region, `hit` on open, `refreshControls`, the `place()` rule and the CSS.**

- [ ] **Step 4: Run the popover and mount suites**

Run: `npx vitest run test/selection-popover.test.js test/framework/mount.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection-popover.js src/framework/app.css test/selection-popover.test.js
git commit -m "feat(popover): a controls region between the head row and the host slot"
```

---

### Task 12: Mount wires the spot controls

**Files:**
- Modify: `src/framework/mount.js` (`selectionOpt` l.1060-1061, popover attach l.1081-1116, `onPick` wrapper l.1197-1217, `applyFreshMeshes` l.1697-1710, the rail panel l.1917-1930, `updateRelevance` l.1932-1941, `setParams` l.1977, `applyAnimationValues` l.1988, `writePoseValues` l.2003, `writeChipValues` l.2016, the handle l.2246-2264)
- Modify: `src/framework/mobile-tabs.js:100-200`
- Test: `test/framework/mount.test.js`, `test/mobile-tabs.test.js` (create if none exists)

**Interfaces:**
- Consumes: `resolveSpotKeys`, `faceKeysOf`, `handleOnPiece` (Task 9); `buildControls(..., { only })` (Task 10); `attachSelectionPopover({ controls })` and `open({ hit })` (Task 11); `viewer.getSubOrigins`/`getSubBounds` and `onPick(selection, anchor, hit)` (Task 8); `m.pieceKeys` (Task 7); existing `handlesShownInView`, `handleParamKeys`, `locateHandle`, `recordedRelevantKeys`, `RELEVANT_ALL`, `controlNodes`, `buildTree`, `desugar`, `panelRef.revealParams`.
- Produces: `selectionOpt` becomes `{ slot, controls: selectionPopover.controls !== false }`. A `spotControls` object (built inside the `if (selectionOpt)` block) with `build(container, { subPart, hit })`:
  1. `faceKeys = faceKeysOf(viewer.getSubOrigins(subPart), hit)`; `pieceKeys = spotPieceKeys.get(subPart) ?? subPartParamKeys(part, view(), params, displayReadsOf, subPart)` (`spotPieceKeys` is a `Map` filled in `applyFreshMeshes` from `m.pieceKeys` and cleared with `cache.forget`).
  2. `excluded` = the union of `handleParamKeys(part.handles[id])` over `id` in `poseVisible` (the ids `syncPoseVisible` last computed) for which `handleOnPiece(part.handles[id], subPart, { point, bounds: viewer.getSubBounds(subPart) })` holds, `point` from `locateHandle(part, params, derived, handle)` in a try/catch (a throw means `null`).
  3. `drawable` = keys of `controlNodes(buildTree(desugar(part.parameters)))` that are in `recordedRelevantKeys(...)` (all of them when it returns `RELEVANT_ALL`).
  4. `{ keys, more } = resolveSpotKeys(...)`; with no keys return `null`.
  5. `buildControls(container, part.parameters, params, onDirty, onCommit, { fontCatalog, imageCatalog, onAssetUpload, declaredSource: declaredSourceLookup(part, params), files, panelState: null, bare: true, only: new Set(keys) })` with `onDirty = () => { animCtl?.notifyUserEdit(); panelRef?.syncValues(keys); onParamChange(); }` and `onCommit = onParamsCommit ? (changed) => onParamsCommit({ changed, params: { ...params } }) : undefined`; `refresh({ relevant, derived })` once; keep it as `spotPanel`.
  6. When `more`, append `button.pf-selection-more` with text `More in the panel` whose click calls `revealInRail(keys)`: `paneTabs.showPane("rail")` then `panelRef?.revealParams(keys, keys[0])`; when `showPane` returns false (a host pane lease is held) it also notifies `revealListeners` with `{ keys }`.
  7. Return `{ dispose() { spotPanel = null; sub.dispose(); } }`.
- Produces: `spotPanel?.syncValues(keys)` beside each existing `panel.syncValues(keys)` (four sites) and `spotPanel?.syncValues()` in the rail's onDirty; `spotPanel?.refresh({ relevant, derived })` in `updateRelevance`; `selPopover.refreshControls()` on a view change (beside `closeGone`, which already closes, so no call is needed there: skip) and after `applyFreshMeshes` when the popover is open for a delivered sub-part.
- Produces: the `onPick` wrapper opens with `{ subPart, anchor, hit }`; the carried-selection reopen passes no hit.
- Produces: `handle.selection` gains `onReveal(cb: ({ keys }) => void): () => void`.
- Produces (`mobile-tabs.js`): `showPane(next)` → boolean: sets the standalone `pane` and applies when no host lease is held, returns false otherwise.

- [ ] **Step 1: Write the failing tests**

In `test/framework/mount.test.js`, beside the existing popover block (l.3185-3497), using its harness (`fakeViewers`, `attachPicker` mock, `pickBody`):

```js
describe("spot controls", () => {
  const part = () => ({
    parameters: [{ id: "c", title: "Cabinet", controls: [
      { key: "w", type: "slider", min: 1, max: 100, step: 1 }, { key: "h", type: "slider", min: 1, max: 100, step: 1 },
      { key: "open", type: "slider", min: 0, max: 100, step: 1 }, { key: "z", type: "slider", min: 0, max: 9, step: 1 }] }],
    defaults: { w: 10, h: 20, open: 0, z: 1 },
    views: { v: { label: "V" } },
    parts: { body: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.h] }) } },
    handles: { pull: { point: (p) => [0, -p.open, 0], params: ["open"], drag: "axis", direction: [0, -1, 0], showOn: "body" } },
  });
  const deliver = (worker, extra = {}) => worker.emit({ type: "meshes", meshes: [{ name: "body", positions: new Float32Array(9), triangles: 1, reads: ["h", "open", "w", "z"], pieceKeys: ["h", "open", "w"], originIds: new Uint16Array([1]), origins: [["h", "w", "open"]], ...extra }] });
  const sliders = (el) => [...el.querySelectorAll(".pf-selection-controls input[type=range]")];

  it("shows the face's keys newest first, minus the handle's, and syncs both ways", async () => {
    const onParamsCommit = vi.fn();
    const { worker, elements, handle } = await mountWith(part(), { onPick: vi.fn(), selectionPopover: { slot: true }, onParamsCommit });
    deliver(worker);
    pickBody({ triIndex: 0 });
    const s = sliders(elements.viewer);
    expect(s.map((i) => i.closest(".slider").querySelector("label").textContent)).toEqual(["h", "w"]);
    s[1].value = "15"; s[1].dispatchEvent(new Event("input", { bubbles: true }));
    expect([...elements.controls.querySelectorAll(".slider")].find((el) => el.querySelector("label").textContent === "w").querySelector("input[type=range]").value).toBe("15");
    s[1].dispatchEvent(new Event("change", { bubbles: true }));
    expect(onParamsCommit).toHaveBeenCalledTimes(1);
    handle.setParams({ h: 33 });
    expect(s[0].value).toBe("33");
    expect(onParamsCommit).toHaveBeenCalledTimes(1);
  });
  it("falls back to the piece's keys with no origins, and hides when a handle drags them all", async () => {
    const { worker, elements } = await mountWith(part(), { onPick: vi.fn(), selectionPopover: { slot: true } });
    deliver(worker, { originIds: undefined, origins: undefined, pieceKeys: ["open", "w"] });
    pickBody({ triIndex: 0 });
    expect(sliders(elements.viewer).map((i) => i.closest(".slider").querySelector("label").textContent)).toEqual(["w"]);
    deliver(worker, { originIds: undefined, origins: undefined, pieceKeys: ["open"] });
    pickBody({ triIndex: 0 });
    expect(elements.viewer.querySelector(".pf-selection-controls").hidden).toBe(true);
    expect(elements.viewer.querySelector(".pf-selection-slot")).not.toBeNull();
  });
  it("More in the panel reveals the keys in the rail; controls: false draws nothing", async () => {
    const { worker, elements } = await mountWith(part(), { onPick: vi.fn(), selectionPopover: { slot: true } });
    deliver(worker, { origins: [["h", "w", "z", "open"]] });
    pickBody({ triIndex: 0 });
    const more = elements.viewer.querySelector(".pf-selection-more");
    expect(more.textContent).toBe("More in the panel");
    more.click();
    expect(elements.controls.querySelector(".pf-param-flash")).not.toBeNull();
    const off = await mountWith(part(), { onPick: vi.fn(), selectionPopover: { slot: true, controls: false } });
    deliver(off.worker); pickBody({ triIndex: 0 });
    expect(off.elements.viewer.querySelector(".pf-selection-controls")).toBeNull();
  });
});
```

(`pickBody` is the file's existing helper, extended in Task 8 to take a hit. `mountWith(part, options)` is a small local helper to write over the file's `createWorker`/`makeElements`/`fakeViewers` fixtures, returning `{ worker, elements, handle }` where `worker.emit(msg)` delivers a worker message. The numeric widget's range input carries no `data-key`: read each slider's key from its `.slider label` text, as the first test does, and use the same in the second.)

For `mobile-tabs.js`:

```js
it("showPane sets the standalone pane and yields to a host lease", () => {
  const tabs = attachMobileTabs({ shell, stage, rail, toggle });
  expect(tabs.showPane("rail")).toBe(true);
  expect(shell.dataset.pfPane).toBe("rail");
  tabs.setHostPane("stage");
  expect(tabs.showPane("rail")).toBe(false);
  expect(shell.dataset.pfPane).toBe("stage");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/mount.test.js -t "spot controls" test/mobile-tabs.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement in `mount.js` and `mobile-tabs.js`**

Keep `spotControls` inside the `if (selectionOpt)` block and pass `controls: selectionOpt.controls ? spotControls : null`. `revealListeners` is a `Set`; `onReveal` adds and returns the remover; `cleanup.defer` clears it.

- [ ] **Step 4: Run the mount, popover and pose suites**

Run: `npx vitest run test/framework/mount.test.js test/selection-popover.test.js test/mobile-tabs.test.js test/handle-views.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/mount.js src/framework/mobile-tabs.js test/framework/mount.test.js test/mobile-tabs.test.js
git commit -m "feat(mount): the clicked face's controls in the selection popover"
```

---

### Task 13: Types, docs, version, smoke

**Files:**
- Modify: `types/index.d.ts:224-225` (`selectionPopover`), `:606-624` (`SelectionRuntime`), `types/kernel.d.ts:48-57` (`Mesh`)
- Modify: `docs/AUTHORING-PARTS.md:4160-4181` (the selection popover bullet)
- Modify: `package.json` (version)
- Modify: `AGENTS.md` (one sentence in the `selection-popover`/materials bullet naming the controls region and `selection/spot-keys.js`)

**Interfaces:**
- Produces: `selectionPopover?: { slot: boolean; controls?: boolean }`; `SelectionRuntime.onReveal(cb: (event: { keys: string[] }) => void): () => void`; `Mesh` gains `featureIds?: Uint16Array; features?: string[]; originIds?: Uint16Array; origins?: string[][]`.

- [ ] **Step 1: Update the types and run the typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Rewrite the popover bullet in `docs/AUTHORING-PARTS.md`**

Replace the closing sentence ("…intended source for a future page of the controls…") with a paragraph stating: the popover shows up to three controls for the clicked face, the parameters its creating operation read, newest first; parameters a handle on that piece drags are left out; a face with no record, a part on OCCT, and a section-cap click fall back to the piece's reads; `selectionPopover: { controls: false }` turns it off; `runtime.selection.onReveal` fires when "More in the panel" is pressed while the host holds the pane lease. One sentence of guidance for authors: reads that sit next to the op that uses them attribute best; a build that computes every number first and then issues ops charges all of them to its first op.

- [ ] **Step 3: Bump the version**

`package.json`: `"version": "0.186.0"`. Run `npm install --package-lock-only --no-audit --no-fund` so `package-lock.json` follows.

- [ ] **Step 4: Run the whole suite and the smoke checks**

Run: `npx vitest run`
Expected: PASS.

Run: `node scripts/check-app.mjs hinged-box.html` and `node scripts/check-app.mjs hand.html` (Playwright's Chromium is installed in this worktree's `node_modules`; if not, `npx playwright install chromium`).
Expected: both exit 0.

- [ ] **Step 5: Try it by hand**

Start `npx vite --port 5199 --strictPort`, open `http://localhost:5199/hinged-box.html` and `http://localhost:5199/drawer-box.html`, click a drawer front, a hinge barrel and the cabinet top; drag a slider; press More in the panel; resize to 375 px wide and repeat.
Expected: the drawer front shows Height and Width; the barrel shows its radius keys; the rail follows; the region scrolls on the phone width with the composer slot still visible.

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts types/kernel.d.ts docs/AUTHORING-PARTS.md AGENTS.md package.json package-lock.json
git commit -m "chore: types, docs and 0.186.0 for spot controls"
```

---

## Follow-ups (not in this plan)

- partforge-cloud: bump the dependency; add the `tests/smoke/selection.spec.js` case (click a face, a slider above the composer, drag, one commit); wire `runtime.selection.onReveal` to its own pane switch on phones.
- OCCT provenance through labelled snapshots (`feature-attribution.js`), if OCCT-routed parts turn out to matter.
- An authored per-piece `controls` override, only if inference proves wrong on real parts.
