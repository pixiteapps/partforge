# Place-Only Pose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A param read only by `place()` never rebuilds a sub-part's mesh and never re-frames its layer lines, whatever `build()` queries. The worker delivers a `place()`-able sub-part in its canonical frame, the viewer applies the display pose as a matrix, the mesh cache keys on build reads alone, and the print frame is the export pose — all decided from `place()` probed on an identity token, without running `build()`.

**Architecture:**
- `probeSubPartPose(sp, ctx, { scope })` gains `"place"` (place alone, on a `CANONICAL` token; trusted iff only pose steps were applied) and `"build"` (build alone) beside today's `"full"`.
- The `generate` job runs the place probe per sub-part: trusted → `build()` alone, build reads alone, `frame: "canonical"`; else today's posed build, `frame: "posed"`. Absent `frame` reads as `"posed"`.
- The mesh cache stamp carries `frame`. `pose-fast-path.js` becomes a ladder: rung 1 poses a current canonical mesh by the live place probe; rung 2 keeps today's build-delta for a trailing transform inside `build`; posed deliveries keep today's full-probe path.
- `printFrameMatrix` returns the export pose for a canonical delivery; `sheetFrameFor` returns identity for one.
- Lint's `animation-track-rebuilds` fires `untrusted` only for an unprobeable `place()`; the two place rules run on the place probe.

**Tech Stack:** Plain ES modules and vitest (`npm test`). Tests that need the Manifold WASM kernel use `bootManifoldKernel` from `src/testing.js`. Mount-level tests use the fake-worker harness in `test/framework/mount.test.js` (happy-dom).

**Spec:** `docs/superpowers/specs/2026-10-03-place-only-pose-design.md`

## Global Constraints

- `pose-probe-core.js` imports nothing new (`test/lint-purity.test.js`); `jobs.js` may import it (its closure is already kernel- and DOM-free — `test/worker-layering.test.js` will say so if not).
- No author-facing API change: `build`, `place`, `purpose`, `view` keep their meanings. No new keys on `PartDefinition`.
- The `meshes` wire shape changes only additively: `frame: "canonical" | "posed"` per mesh. Absent = `"posed"` (today's behaviour). `capture-meshes`, every `export-*` and `inspect` reply are unchanged.
- The pose a sub-part's Object3D carries is always absolute relative to the delivered mesh; nothing accumulates across frames.
- `viewer.setSubGeometry` keeps clearing the matrix; mount applies the pose **after** it, on every delivery branch.
- `burnsFor` is unchanged (spec decision 3).
- Minor version bump `0.140.0` → `0.141.0`, in this PR; the embedding-contract comment in `mount.js` moves with it.
- Run `npm test` after every task; a task is not done while any test is red.

## Review Focus

1. **Pose ordering at delivery** (spec risk 1): `setSubGeometry` then `setSubPose(name, matrix)` for a canonical mesh, `setSubPose(name, null)` for a posed one. Pinned in Task 5.
2. **A place that branches into a query** (spec risk 2): a canonical mesh whose live place probe is untrusted is forgotten, never left unposed. Pinned in Task 4.
3. **Trailing transform in `build` stays smooth** (spec decision 1): rung 2 composes the place pose over the build delta and re-records the union. Pinned in Task 4.
4. **The sheet burn frame for a canonical delivery is identity** (spec risk 7), proven on real geometry. Pinned in Task 6.
5. **The Lattice Box fixture**: zero `animation-track-rebuilds` notes, no lint errors, `printFrameMatrix` non-identity, `frame: "canonical"` with build-only reads. Pinned across Tasks 1, 2, 6, 7.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/framework/pose-probe-core.js` | `CANONICAL`, `probeSubPartPose(sp, ctx, { scope })` |
| `src/framework/pose-probe.js` | `probePoses(part, view, params, { scope, purpose })`; asset fold only for `full`/`build` |
| `src/framework/jobs.js` | `generate`: per-sub-part place probe → canonical or posed build; `frame` on the wire |
| `src/framework/mesh-cache.js` | Stamp carries `frame`; `frameOf(name)` |
| `src/framework/pose-fast-path.js` | The pose ladder: `recordDelivered`, `forget`, `apply(names)`, `repair()` |
| `src/framework/mount.js` | Delivery branches apply poses; view switch re-poses; `frame` threaded to the material frames; overlay word; contract comment |
| `src/framework/debug-overlay.js` | One `frame` word beside `posed` |
| `src/framework/materials/print-frame.js` | `printFrameMatrix(sp, { view, p, d, frame })` |
| `src/framework/materials/sheet-look.js` | `sheetFrameFor(sp, { p, d, frame })` |
| `src/framework/lint/rules-animations.js`, `lint/rules-place.js` | Place-scope classification and rules |
| `test/fixtures/lattice-lid-part.js` (new) | The Lattice Box reduced: querying build + rigid place + animation |
| `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `AGENTS.md`, `package.json` | Docs and version |

---

### Task 1: The place-scope probe and the Lattice Box fixture

**Files:**
- Modify: `src/framework/pose-probe-core.js` (`probeSubPartPose`, ~line 119; `makeProbeSession`, ~line 24)
- Modify: `src/framework/pose-probe.js` (`probePoses`, ~line 30)
- Create: `test/fixtures/lattice-lid-part.js`
- Test: `test/pose-probe.test.js`

**Interfaces:**
- Produces: `export const CANONICAL` (the fixed token hash, `h("canonical")`).
- Produces: `probeSubPartPose(sp, { view, purpose, p, d }, { scope = "full" })`, `scope ∈ "full" | "build" | "place"`. Place scope: `{ trusted: true, baseHash: CANONICAL, pose: steps }` or `{ trusted: false }`. A sub-part with no `place` is `{ trusted: true, baseHash: CANONICAL, pose: [] }`.
- Produces: `probePoses(part, view, params, { scope = "full", purpose = "display" })` → `Map(name → entry + reads)`. The `with-assets` fold applies only when `scope !== "place"`.

- [ ] **Step 1: Create the fixture**

Reduce the reported part (source at `/private/tmp/claude-501/-Users-scottsykora-Documents-Docs-pixite-code-partforge-cloud/8678e241-1316-4a50-95c6-86c28167006f/scratchpad/f161/part/`) to what the bug needs: a body with no place, a lid whose build cuts a window, a lattice insert whose build **queries** (`boundingBox`, `contains`, `intersect` + `isEmpty`/`area`/`toRegions` on border cells), both articulated by `openAngle` and lifted by `lift` in `place()`, and one animation. Every default is exposed as a control (hidden ones for the two pose params), so lint reports no schema errors.

```js
// test/fixtures/lattice-lid-part.js
// The Lattice Box (partforge-cloud feedback #161), reduced. The insert's build
// queries the region it patterns — boundingBox() to size the grid, intersect()
// + isEmpty()/area()/toRegions() to keep or drop the clipped border cells — which
// is exactly what the old full-scope probe refused to trust. Its pose lives in
// place() and reads openAngle/lift only. Used by the probe, jobs, print-frame
// and lint suites: the notes must be 0 and the print frame non-identity.
function latticeHoles(k, region, cellR, web) {
  const bb = region.boundingBox();
  const pitch = cellR * 2 + web;
  const cells = [];
  for (let y = bb.min[1]; y <= bb.max[1]; y += pitch) {
    for (let x = bb.min[0]; x <= bb.max[0]; x += pitch) {
      const pts = Array.from({ length: 12 }, (_, i) => {
        const a = (i * 2 * Math.PI) / 12;
        return [x + cellR * Math.cos(a), y + cellR * Math.sin(a)];
      });
      if (pts.every((pt) => region.contains(pt))) { cells.push({ outer: pts }); continue; }
      const clipped = k.shape2d(pts).intersect(region);
      if (!clipped.isEmpty() && clipped.area() >= 0.5) cells.push(...clipped.toRegions());
    }
  }
  return cells.length ? k.shape2d(cells) : null;
}

function windowShape(k, p) {
  return k.shape2d([[p.frame, p.frame], [p.w - p.frame, p.frame], [p.w - p.frame, p.d - p.frame], [p.frame, p.d - p.frame]]);
}

function makeLid(k, p) {
  const outer = k.box({ min: [0, 0, 0], max: [p.w, p.d, p.lidH] });
  const inner = k.box({ min: [p.wall, p.wall, p.wall], max: [p.w - p.wall, p.d - p.wall, p.lidH + 1] });
  return outer.cut(inner).cut(windowShape(k, p).extrude({ h: p.wall + 2 }).translate([0, 0, -1]));
}

function makeInsert(k, p) {
  const plate = windowShape(k, p).offset(-p.fit, { corners: "round" });
  const region = plate.offset(-p.web, { corners: "round" });
  const holes = region.isEmpty() ? null : latticeHoles(k, region, p.cellR, p.web);
  return (holes ? plate.cut(holes) : plate).extrude({ h: p.wall });
}

// Rigid articulation about the back edge, then the assembly lift. Reads only pose params.
const articulate = (s, { p }) => s.rotateAbout({ axis: "X", deg: p.openAngle, through: [0, 0, p.h] }).translate([0, 0, p.lift]);

export default {
  meta: { title: "Lattice Lid", units: "mm" },
  parameters: [
    { id: "box", title: "Box", controls: [
      { key: "w", type: "slider", label: "Width", unit: "mm", min: 30, max: 120, step: 1, description: "Outer width." },
      { key: "d", type: "slider", label: "Depth", unit: "mm", min: 30, max: 120, step: 1, description: "Outer depth." },
      { key: "h", type: "slider", label: "Body height", unit: "mm", min: 10, max: 60, step: 1, description: "Body height." },
      { key: "lidH", type: "slider", label: "Lid height", unit: "mm", min: 5, max: 40, step: 1, description: "Lid height." },
      { key: "wall", type: "slider", label: "Wall", unit: "mm", min: 1.2, max: 4, step: 0.2, description: "Wall thickness." },
    ] },
    { id: "lattice", title: "Lattice", controls: [
      { key: "frame", type: "slider", label: "Frame", unit: "mm", min: 3, max: 20, step: 0.5, description: "Lid border around the window." },
      { key: "cellR", type: "slider", label: "Cell radius", unit: "mm", min: 1, max: 8, step: 0.25, description: "Hole radius." },
      { key: "web", type: "slider", label: "Web", unit: "mm", min: 0.6, max: 4, step: 0.1, description: "Material between holes." },
      { key: "fit", type: "slider", label: "Fit", unit: "mm", min: 0, max: 0.5, step: 0.05, description: "Insert clearance." },
    ] },
    { id: "pose", title: "Pose", controls: [
      { key: "openAngle", type: "slider", label: "Open angle", unit: "°", min: 0, max: 180, step: 1, description: "Lid angle about the back edge." },
      { key: "lift", type: "number", label: "Lift", unit: "mm", min: 0, max: 60, step: 1, hidden: true, description: "Assembly lift, animation-driven." },
    ] },
  ],
  defaults: { w: 60, d: 40, h: 20, lidH: 10, wall: 2, frame: 5, cellR: 2.5, web: 1, fit: 0.15, openAngle: 0, lift: 0 },
  parts: {
    body: { label: "Body", views: ["assembly"], build: (k, p) =>
      k.box({ min: [0, 0, 0], max: [p.w, p.d, p.h] }).cut(k.box({ min: [p.wall, p.wall, p.wall], max: [p.w - p.wall, p.d - p.wall, p.h + 1] })) },
    lid: { label: "Lid", views: ["assembly"], display: { color: 0xf5f5f5 },
      build: (k, p) => makeLid(k, p).rotateAbout({ axis: "Y", deg: 180, through: [p.w / 2, 0, 0] }).translate([0, 0, p.h + p.lidH]),
      place: articulate },
    insert: { label: "Lattice insert", views: ["assembly"], display: { color: 0x222222 },
      build: (k, p) => makeInsert(k, p).rotateAbout({ axis: "Y", deg: 180, through: [p.w / 2, 0, 0] }).translate([0, 0, p.h + p.lidH]),
      place: articulate },
  },
  views: {
    assembly: { label: "Assembly", animations: {
      cycleLid: { label: "Open / close lid", camera: "iso", duration: 2, loop: true,
        tracks: { openAngle: [[0, 0], [0.5, 120], [1, 0]], lift: [[0, 0], [0.5, 10], [1, 0]] } },
    } },
  },
};
```

If `lintPart` later reports a schema error on this fixture (Task 7 asserts none), fix the fixture, not the rule.

- [ ] **Step 2: Write the failing probe tests**

Append to `test/pose-probe.test.js`:

```js
import { probeSubPartPose, CANONICAL } from "../src/framework/pose-probe-core.js";
import lattice from "./fixtures/lattice-lid-part.js";

const ctx = (p, extra = {}) => ({ view: "assembly", purpose: "display", p, d: {}, ...extra });

test("place scope: a querying build no longer matters — the insert's rigid place is trusted", () => {
  const p = { ...lattice.defaults, openAngle: 45 };
  expect(probeSubPartPose(lattice.parts.insert, ctx(p)).trusted).toBe(false);                      // full scope, as today
  const r = probeSubPartPose(lattice.parts.insert, ctx(p), { scope: "place" });
  expect(r).toMatchObject({ trusted: true, baseHash: CANONICAL });
  expect(r.pose).toEqual([
    { t: "rotate", deg: 45, center: [0, 0, 20], axis: [1, 0, 0] },
    { t: "translate", v: [0, 0, 0] },
  ]);
});

test("place scope: no place() is trusted with an empty pose", () => {
  expect(probeSubPartPose(lattice.parts.body, ctx(lattice.defaults), { scope: "place" })).toEqual({ trusted: true, baseHash: CANONICAL, pose: [] });
});

test("place scope: a geometry op in place() is untrusted (the hash leaves CANONICAL)", () => {
  for (const place of [(s) => s.scale(2), (s) => s.mirror([0, 0, 0], [1, 0, 0]), (s, { p }) => s.union(s.translate([p.w, 0, 0]))]) {
    expect(probeSubPartPose({ build: (k) => k.box({ size: [1, 1, 1] }), place }, ctx(lattice.defaults), { scope: "place" }).trusted).toBe(false);
  }
});

test("place scope: a query or a function in place() is untrusted", () => {
  const q = (s) => s.translate(s.boundingBox().center);
  const f = (s) => s.fillet({ r: 1, edges: (e) => e });
  for (const place of [q, f]) {
    expect(probeSubPartPose({ build: (k) => k.box({ size: [1, 1, 1] }), place }, ctx({}), { scope: "place" }).trusted).toBe(false);
  }
});

test("build scope ignores place(): the lid's build is trusted on its own and its hash holds across openAngle", () => {
  const a = probeSubPartPose(lattice.parts.lid, ctx({ ...lattice.defaults, openAngle: 0 }), { scope: "build" });
  const b = probeSubPartPose(lattice.parts.lid, ctx({ ...lattice.defaults, openAngle: 90 }), { scope: "build" });
  expect(a.trusted && b.trusted).toBe(true);
  expect(a.baseHash).toBe(b.baseHash);
});

test("probePoses in place scope records only place()'s reads", () => {
  const m = probePoses(lattice, "assembly", lattice.defaults, { scope: "place" });
  expect(m.get("insert").trusted).toBe(true);
  expect(m.get("insert").reads).toEqual(["h", "lift", "openAngle"]);
  expect(m.get("body").reads).toEqual([]);
});
```

Check `mirror`'s calling convention in `src/framework/geometry/solid-sugar.js` / `kernel.js` before relying on the exact arguments; the test needs any geometry op, not that one.

- [ ] **Step 3: Run the tests, confirm they fail**

```bash
npx vitest run test/pose-probe.test.js
```

Expected: the new tests fail (`scope` is ignored, `CANONICAL` is not exported).

- [ ] **Step 4: Implement**

In `pose-probe-core.js`:
- `export const CANONICAL = h("canonical");`
- `probeSubPartPose(sp, { view, purpose = "display", p, d }, { scope = "full" } = {})`:
  - `"full"`: today's body.
  - `"build"`: `sp.build(kernel, p, d)` only; same trust test.
  - `"place"`: `let s = token(CANONICAL, []); if (sp.place) s = sp.place(s, { view, purpose, p, d });` trusted iff `s?.__poseToken && s._hash === CANONICAL && !state.queried && !state.unhashable && stepsFinite(s._pose)`. Return `{ trusted: true, baseHash: CANONICAL, pose: s._pose }`.
  - `token` is created inside `makeProbeSession`; expose it on the session (`{ kernel, state, token }`) rather than moving it out.
- Update the module comment: the trust model now applies **per scope**, and the place scope's rigidity test is the hash.

In `pose-probe.js`: thread `{ scope = "full", purpose = "display" }` through `probePoses`; fold assets into `baseHash` only when `scope !== "place"` (comment why: a place probe hashes nothing geometry-dependent, and the mesh cache's asset reads cover the font case).

- [ ] **Step 5: Run the tests, confirm they pass**

```bash
npx vitest run test/pose-probe.test.js test/lint-purity.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/framework/pose-probe-core.js src/framework/pose-probe.js test/pose-probe.test.js test/fixtures/lattice-lid-part.js
git commit -m "pose probe: place scope on a canonical token, build scope; Lattice Lid fixture"
```

---

### Task 2: The worker delivers canonical meshes with build-only reads

**Files:**
- Modify: `src/framework/jobs.js` (`posedWithReads`, ~line 400; the `generate` loop, ~line 417)
- Test: `test/place-only-jobs.test.js` (new)

**Interfaces:**
- Consumes: Task 1's `probeSubPartPose(…, { scope: "place" })`.
- Produces: each entry in a `{type:"meshes"}` reply carries `frame: "canonical" | "posed"`. Canonical: positions are `sp.build(kernel, p, d).toMesh()`'s, `reads` are the build's (plus asset-declaration reads). Posed: today's.

- [ ] **Step 1: Write the failing tests**

```js
// test/place-only-jobs.test.js
import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { resolveParams } from "../src/framework/part-model.js";
import lattice from "./fixtures/lattice-lid-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const gen = async (part, subparts, params, view = "assembly") => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts, view, params }, post);
  return post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
};

test("a rigid place() behind a querying build delivers the canonical mesh with build-only reads", async () => {
  const params = { ...lattice.defaults, openAngle: 60 };
  const reply = await gen(lattice, ["insert"], params);
  const m = reply.meshes[0];
  expect(m.frame).toBe("canonical");
  expect(m.reads).not.toContain("openAngle");
  expect(m.reads).not.toContain("lift");
  expect(m.reads).toEqual(expect.arrayContaining(["w", "d", "h", "lidH", "wall", "frame", "cellR", "web", "fit"]));
  const { p, d } = resolveParams(lattice, params);
  const canonical = lattice.parts.insert.build(k, p, d).toMesh({ quality: "preview" });
  expect(m.positions.length).toBe(canonical.positions.length);
  expect(Array.from(m.positions.slice(0, 30))).toEqual(Array.from(canonical.positions.slice(0, 30)));
});

test("no place() delivers canonical too, with an identity pose implied", async () => {
  const reply = await gen(lattice, ["body"], lattice.defaults);
  expect(reply.meshes[0].frame).toBe("canonical");
});

test("a place() that queries the solid delivers posed, with place reads included (today's path)", async () => {
  const part = {
    defaults: { r: 3, lift: 7 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }),
      place: (s, { p }) => s.translate([0, 0, p.lift + s.boundingBox().size[2]]) } },
  };
  const m = (await gen(part, ["a"], part.defaults, "v")).meshes[0];
  expect(m.frame).toBe("posed");
  expect(m.reads).toEqual(["lift", "r"]);
});

test("a place() that reshapes delivers posed", async () => {
  const part = {
    defaults: { r: 3 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 2 }), place: (s) => s.scale(2) } },
  };
  expect((await gen(part, ["a"], part.defaults, "v")).meshes[0].frame).toBe("posed");
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npx vitest run test/place-only-jobs.test.js
```

- [ ] **Step 3: Implement**

In `jobs.js`, replace `posedWithReads` with a per-sub-part decision:

```js
import { probeSubPartPose } from "./pose-probe-core.js";
// …
// Canonical delivery (spec 2026-10-03 place-only pose, §2): when place() can be read
// off a token — rigid, no query, no function — the mesh is built WITHOUT it and
// stamped with build reads alone; the viewer applies the display pose as a matrix.
// Otherwise the pose is baked and both halves' reads are recorded, as before 0.141.
const displayWithReads = (name) => {
  const sp = part.parts[name];
  const sink = newReadSink();
  sink.attribution = attribution;
  const rec = recordedParams({ p, d }, sink);
  const canonical = probeSubPartPose(sp, { view: msg.view, purpose: "display", p, d }, { scope: "place" }).trusted;
  const solid = canonical
    ? sp.build(kernel, rec.p, rec.d)
    : buildPosed(kernel, part, name, { purpose: "display", view: msg.view, p: rec.p, d: rec.d });
  for (const key of assetSink.raw) sink.raw.add(key);
  return { solid, reads: expandReads(sink), frame: canonical ? "canonical" : "posed" };
};
```

and push `frame` onto each mesh in the `generate` loop. `capture-generate` stays on `posed(name, "display")`.

Note the probe runs on the plain `p`/`d`, not the recorders — place reads must not land in the canonical stamp.

- [ ] **Step 4: Run**

```bash
npx vitest run test/place-only-jobs.test.js test/recorded-reads-jobs.test.js test/worker-layering.test.js
```

`recorded-reads-jobs.test.js`'s "place() reads count" test now describes a canonical delivery: update it to assert `frame: "canonical"` and `reads: ["r"]`, and add a sibling that keeps `["lift", "r"]` for a querying place.

- [ ] **Step 5: Commit**

```bash
git add src/framework/jobs.js test/place-only-jobs.test.js test/recorded-reads-jobs.test.js
git commit -m "generate: deliver place()-able sub-parts in the canonical frame with build-only reads"
```

---

### Task 3: The mesh cache stamp carries the delivery frame

**Files:**
- Modify: `src/framework/mesh-cache.js`
- Test: `test/mesh-cache-recorded.test.js`

**Interfaces:**
- Produces: `record(name, reads, view = getView(), frame = "posed")`, `frameOf(name) → "canonical" | "posed" | null`.

- [ ] **Step 1: Write the failing tests**

```js
test("a canonical stamp stays current when a place-only param changes", () => {
  const params = { w: 60, openAngle: 0 };
  const { cache, bump } = makeCache(params);
  cache.record("insert", ["w"], "v", "canonical");
  expect(cache.frameOf("insert")).toBe("canonical");
  params.openAngle = 90; bump();
  expect(cache.isCurrent("insert")).toBe(true);
});

test("frame defaults to posed (an older worker's reply), and is null with no stamp", () => {
  const { cache } = makeCache({ a: 1 });
  expect(cache.frameOf("x")).toBe(null);
  cache.record("x", ["a"]);
  expect(cache.frameOf("x")).toBe("posed");
  cache.forget("x");
  expect(cache.frameOf("x")).toBe(null);
});
```

- [ ] **Step 2: Run, confirm failure; implement; run**

```bash
npx vitest run test/mesh-cache-recorded.test.js
```

- [ ] **Step 3: Commit**

```bash
git add src/framework/mesh-cache.js test/mesh-cache-recorded.test.js
git commit -m "mesh cache: stamps carry the delivery frame"
```

---

### Task 4: The pose ladder

**Files:**
- Modify: `src/framework/pose-fast-path.js` (rewrite the decision layer; keep the module name and `createPoseFastPath`)
- Test: `test/framework/pose-fast-path.test.js`

**Interfaces:**
- Consumes: Tasks 1 and 3 (`cache.frameOf`).
- Produces: `createPoseFastPath(part, viewer, cache, { params, getView, getParamsVersion })` →
  - `recordDelivered(name)`: for a canonical stamp, store the build-scope probe entry (rung 2's baseline); for a posed stamp, store the full-scope entry (today).
  - `forget(name)`: drop the stamp.
  - `apply(names)`: for each name in view with a mesh: canonical → `setSubPose(name, composePose(placeNow.pose))`, or `cache.forget(name)` + `setSubPose(name, null)` when the live place probe is untrusted; posed → `setSubPose(name, null)`. Returns nothing. Called by mount right after a delivery and on a view switch.
  - `repair()`: for each stale in-view sub-part with a mesh: canonical + build stamp trusted + live build probe trusted + same `baseHash` → `setSubPose(name, mul(composePose(placeNow), poseDelta(buildNow, buildStamp)))`, re-record the union of reads (today's rule) keeping `frame`; posed → today's full-scope delta. Returns the names repaired. **Rung 1 is not a repair**: a current canonical sub-part is posed by `apply`, which `repair()` also runs for every current canonical name so one call per param change does both.

Memoize three probe maps per `(paramsVersion, view)`: place, build, full — computed lazily (a part with no canonical sub-parts never runs the place or build probes, and vice versa).

- [ ] **Step 1: Write the failing tests**

Extend the harness in `test/framework/pose-fast-path.test.js` so the fake cache carries frames (`record(n, r, view, frame)`, `frameOf`) and `deliver(name, frame = "posed")`. Then:

```js
import lattice from "../fixtures/lattice-lid-part.js";
import { composePose, poseDelta } from "../../src/framework/geometry/pose.js";

test("rung 1: a current canonical sub-part is posed by the live place probe, no stamp consulted", () => {
  const hx = harness(lattice, "assembly");
  hx.deliver("insert", "canonical");
  hx.fp.apply(["insert"]);
  expect(hx.poses.insert).toEqual(composePose([{ t: "rotate", deg: 0, center: [0, 0, 20], axis: [1, 0, 0] }, { t: "translate", v: [0, 0, 0] }]));
  hx.params.openAngle = 45; hx.version++;          // the cache stays current: openAngle is not a build read
  hx.fp.repair();
  expect(hx.poses.insert).toEqual(composePose([{ t: "rotate", deg: 45, center: [0, 0, 20], axis: [1, 0, 0] }, { t: "translate", v: [0, 0, 0] }]));
  expect(hx.current.has("insert")).toBe(true);
});

test("rung 1: a canonical mesh whose live place() is untrusted is forgotten, never left unposed", () => {
  const part = { defaults: { x: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k) => k.box({ size: [1, 1, 1] }),
    place: (s, { p }) => (p.x > 5 ? s.translate(s.boundingBox().center) : s.translate([p.x, 0, 0])) } } };
  const hx = harness(part);
  hx.deliver("a", "canonical");
  hx.params.x = 9; hx.version++;
  hx.fp.repair();
  expect(hx.current.has("a")).toBe(false);          // regen rebuilds it posed
  expect(hx.poses.a).toBe(null);
});

test("rung 2: a trailing transform inside build still re-poses by delta, composed with the place pose", () => {
  const part = { defaults: { w: 10, angle: 0, lift: 0 }, views: { v: { label: "V" } }, parts: { a: { views: ["v"],
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, 10, 5] }).rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
    place: (s, { p }) => s.translate([0, 0, p.lift]) } } };
  const hx = harness(part);
  hx.deliver("a", "canonical"); hx.readsFor("a", ["angle", "w"]);
  hx.edit({ angle: 45, lift: 3 });                  // angle is a build read → stale
  expect(hx.fp.repair()).toEqual(["a"]);
  const delta = poseDelta([{ t: "rotate", deg: 45, center: [0, 0, 5], axis: [1, 0, 0] }], [{ t: "rotate", deg: 0, center: [0, 0, 5], axis: [1, 0, 0] }]);
  expect(hx.poses.a).toEqual(mul(composePose([{ t: "translate", v: [0, 0, 3] }]), delta));   // place over build delta
  expect(hx.current.has("a")).toBe(true);
  expect([...hx.readsOf("a")].sort()).toEqual(["angle", "lift", "w"]);
});

test("rung 2 refuses when the build hash moved (a geometry param changed)", () => { /* same part, edit({ w: 12 }) → repair() === [], not current */ });

test("a posed delivery keeps today's full-scope delta path", () => { /* the pre-existing tests, run with deliver(name, "posed") */ });
```

Export a small `mul` from `pose.js` (`mulMat4` is module-private today) or compute the expected matrix via `composePose([...place, ...])` — either is fine; do not re-implement matrix math in the test.

- [ ] **Step 2: Run, confirm failure**

```bash
npx vitest run test/framework/pose-fast-path.test.js
```

- [ ] **Step 3: Implement**

Rewrite `pose-fast-path.js` per the interface above. Keep the file's header comment honest: it is now the pose ladder, and the delta logic is rung 2 for canonical meshes and the whole path for posed ones. The applied matrix is always absolute relative to the delivered mesh.

- [ ] **Step 4: Run**

```bash
npx vitest run test/framework/pose-fast-path.test.js test/pose.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/framework/pose-fast-path.js src/framework/geometry/pose.js test/framework/pose-fast-path.test.js
git commit -m "pose fast path: canonical meshes are posed by place() alone; build delta kept as rung 2"
```

---

### Task 5: Mount applies poses at delivery, on playback and on a view switch

**Files:**
- Modify: `src/framework/mount.js`:
  - the `meshes` handler, fresh branch (~line 1068) and stale-shown branch (~line 1127)
  - `tabsCtl.onChange` (~line 578)
  - `onParamChange` (~line 1274) — unchanged call, `repair()` now does rung 1 too
  - the `?debug` overlay update calls (`dbg?.update`)
- Modify: `src/framework/debug-overlay.js` (one `frame` word)
- Test: `test/framework/mount.test.js`

- [ ] **Step 1: Write the failing tests**

Follow the harness idiom around line 1104 (`workers.manifold.onmessage({ data: { type: "meshes", meshes: [...] } })`), with a part whose sub-part has a rigid `place` reading one param:

```js
test("a canonical delivery is posed AFTER its geometry lands; a posed one has its matrix cleared", async () => {
  // part: a: build box, place translate([0,0,p.lift]); b: build box, place with s.boundingBox() (never canonical)
  // deliver { name: "a", reads: ["w"], frame: "canonical" }, { name: "b", reads: ["w", "lift"], frame: "posed" }
  const v = fakeViewers[0];
  const geomA = v.setSubGeometry.mock.invocationCallOrder[0];
  const poseA = v.setSubPose.mock.calls.findIndex(([n, m]) => n === "a" && Array.isArray(m));
  expect(poseA).toBeGreaterThan(-1);
  expect(v.setSubPose.mock.invocationCallOrder[poseA]).toBeGreaterThan(geomA);
  expect(v.setSubPose).toHaveBeenCalledWith("b", null);
});

test("a place-only edit on a canonical sub-part re-poses with no job", async () => {
  // runtime.setParams({ lift: 5 }) → setSubPose("a", matrix with [12..14] = [0,0,5]); no new generate posted
});

test("a view switch re-poses canonical sub-parts (place may read view)", async () => {
  // place: (s, { view }) => purpose/view-dependent EXPORT only is the documented contract; here use a
  // display place reading p only and assert apply() ran (setSubPose called again) after setView
});

test("a mesh without `frame` (older worker) is treated as posed", async () => { /* setSubPose(name, null) */ });
```

- [ ] **Step 2: Run, confirm failure; implement**

In the fresh branch:

```js
viewer.setSubGeometry(m.name, m);
cache.record(m.name, m.reads, dispatched.get(m.name)?.view ?? view(), m.frame ?? "posed");
if (m.triangles === 0) emptySubParts.add(m.name); else emptySubParts.delete(m.name);
fastPath.recordDelivered(m.name);
```

then, once per reply, `fastPath.apply(data.meshes.map((m) => m.name))` **before** `recordFrames`/`refreshView`. In the stale-shown branch: `setSubGeometry`, `fastPath.forget`, `cache.forget`, then `fastPath.apply(names)` — a canonical mesh gets its pose at the live params (or is forgotten by `apply`, which is what the next kick needs). In `tabsCtl.onChange`, call `fastPath.apply(viewSubParts(part, view(), params))` after `refreshView()`. Pass `frame` to the overlay: `dbg?.update({ …, frame: <summary> })` where the summary is the canonical/posed counts of the in-view sub-parts (`"3 canonical / 1 posed"`), rendered on the `L1 parts` line.

- [ ] **Step 3: Run the whole mount suite**

```bash
npx vitest run test/framework/mount.test.js test/framework/mount-capture-view.test.js test/framework/regen-loop.test.js
```

- [ ] **Step 4: Commit**

```bash
git add src/framework/mount.js src/framework/debug-overlay.js test/framework/mount.test.js
git commit -m "mount: apply the display pose after every delivery, on playback and on view switch"
```

---

### Task 6: Material frames for canonical deliveries

**Files:**
- Modify: `src/framework/materials/print-frame.js`
- Modify: `src/framework/materials/sheet-look.js` (`sheetFrameFor`, ~line 155)
- Modify: `src/framework/mount.js` (`recordFrames` ~994, `computeFrames` ~1000: carry `frame` from the delivery into `undrawnFrames`)
- Test: `test/framework/print-frame.test.js`, `test/sheet-part.test.js`, `test/framework/mount-realistic.test.js`

**Interfaces:**
- Produces: `printFrameMatrix(sp, { view, p, d, frame = "posed" })`: canonical → `composePose(place-scope export pose)`, identity when that probe is untrusted; posed → today.
- Produces: `sheetFrameFor(sp, { p, d, frame = "posed" })`: canonical → `{ frame: IDENTITY, t, plies }`; posed → today.

- [ ] **Step 1: Write the failing tests**

`test/framework/print-frame.test.js`:

```js
import lattice from "../fixtures/lattice-lid-part.js";
import { resolveParams } from "../../src/framework/part-model.js";

test("the Lattice Lid insert: canonical delivery → the frame is the export pose, non-identity, whatever build() queries", () => {
  const { p, d } = resolveParams(lattice, { ...lattice.defaults, openAngle: 90 });
  const sp = { ...lattice.parts.insert, place: (s, ctx) => (ctx.purpose === "export" ? s : lattice.parts.insert.place(s, ctx)) };
  const m = printFrameMatrix(sp, { view: "assembly", p, d, frame: "canonical" });
  expect(close(m, I)).toBe(false);
  // the export pose here is identity → canonical frame IS the export frame → identity
  expect(close(printFrameMatrix(sp, { view: "assembly", p, d, frame: "canonical" }), I)).toBe(/* see note */ true);
});
```

Note: for the fixture as written, `articulate` applies to **both** purposes, so its export pose at `openAngle: 90` is the rotation and the canonical→export map is that rotation (non-identity). Write the two assertions accordingly: (a) fixture unchanged, `frame: "canonical"` → `close(m, composePose(rotate 90 …))`; (b) a wrapped `place` that is identity on export → `I`. Then:

```js
test("canonical delivery with an untrusted export place → identity", () => { /* export branch queries the solid */ });
test("posed delivery keeps the E·D⁻¹ rule", () => { /* the existing 'stood up / lying flat' case with frame: "posed" and with frame omitted */ });
```

`test/sheet-part.test.js`, beside the existing `sheetFrameFor` test (~line 239):

```js
test("a canonical sheet delivery's burn frame is identity and still classifies the real geometry", () => {
  const f = sheetFrameFor(a, { p, d, frame: "canonical" });
  expect(f.frame).toEqual(IDENTITY); expect(f.t).toBe(sheetFrameFor(a, { p, d }).t);
  // Build the sheet's canonical solid (a.build), take one face-up vertex and one wall vertex from
  // its toMesh(), and assert classifySheetSurface(pos, normal, f.t) returns "face" / "wall" with
  // the identity frame — the same check the posed test runs after mapping through its frame.
});
```

`test/framework/mount-realistic.test.js`: beside "a layer-line material gets its print frame from the delivered pose" (~line 295), deliver the same part with `frame: "canonical"` and assert `pfPrintFrame` equals the export pose (not the display→export delta), and that `printFrameCalls.count` is still 1 (lazy).

- [ ] **Step 2: Run, confirm failure; implement; run**

```bash
npx vitest run test/framework/print-frame.test.js test/sheet-part.test.js test/framework/mount-realistic.test.js test/framework/materials-patterns.test.js
```

- [ ] **Step 3: Commit**

```bash
git add src/framework/materials/print-frame.js src/framework/materials/sheet-look.js src/framework/mount.js test/framework/print-frame.test.js test/sheet-part.test.js test/framework/mount-realistic.test.js
git commit -m "material frames: a canonical delivery's print frame is the export pose; sheet frame identity"
```

---

### Task 7: Lint classifies tracks and checks place() on the place-scope probe

**Files:**
- Modify: `src/framework/lint/rules-animations.js` (`classifyTrack`, ~line 512; the note text, ~line 467)
- Modify: `src/framework/lint/rules-place.js`
- Test: `test/lint-animations.test.js`, `test/lint-place.test.js`

- [ ] **Step 1: Write the failing tests**

`test/lint-animations.test.js`:

```js
import lattice from "./fixtures/lattice-lid-part.js";
const notes = (r) => r.notes.filter((f) => f.rule === "animation-track-rebuilds");

test("the Lattice Lid (#161): a querying build behind a rigid place() earns no rebuild note", () => {
  const r = lintPart(lattice);
  expect(r.errors).toEqual([]);
  expect(notes(r)).toEqual([]);
});

test("a place() the probe cannot read earns the untrusted note, and only that case does", () => {
  const part = { ...lattice, parts: { ...lattice.parts, insert: { ...lattice.parts.insert,
    place: (s, { p }) => s.translate([0, 0, p.lift + s.boundingBox().size[2]]) } } };
  const n = notes(lintPart(part));
  expect(n.map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringContaining("place() cannot be probed")]));
});

test("a track read by build() earns the rebuild note (build-scope hash moves)", () => {
  // track `wall` instead of `openAngle` → "rebuilds geometry"
});

test("a track read by an untrusted build earns the rebuild note by its recorded read", () => {
  // the insert's build reads cellR; a track on cellR → rebuild note even though the build probe is untrusted
});
```

`test/lint-place.test.js`:

```js
test("place-not-rigid is found behind a querying build (the full probe used to stay silent)", () => {
  const part = mk((s, { purpose }) => (purpose === "export" ? s.scale(2) : s));
  part.parts.p.build = (k) => { const b = k.box({ size: [1, 1, 1] }); b.boundingBox(); return b; };
  expect(ids(lintPart(part))).toContain("place-not-rigid");
});
```

- [ ] **Step 2: Run, confirm failure; implement**

`classifyTrack(part, p, key, v0, v1, view)`:
1. For each in-view sub-part: `probeSubPartPose(sp, ctx(v0), { scope: "place" })` and at `v1`; either untrusted → return `"untrusted"`.
2. `scope: "build"` at both: trusted with different `baseHash` → `result = "rebuild"`.
3. Build probe untrusted at either: run `sp.build(probeKernel, recorder(pv, reads), recorder(dv, dSeen))` (the `read-recorder` + `createProbeKernel` pair `param-deps.js` uses; keep the import closure pure — `read-recorder.js` and `geometry/probe.js` are already in lint's graph via `param-deps`? verify with `test/lint-purity.test.js`; if not, import them directly) and expand derived reads; `key` in the set → `result = "rebuild"`.
4. Message for `untrusted`: `` animation "…" track "…" — `place()` cannot be probed (it queries the solid or passes a function), so playback is best-effort ``. Hint: "Keep `place()` to translate/rotate of its argument, reading `p`/`d` only; `build()` may query freely."

`rules-place.js`: both rules call `probeSubPartPose(sp, ctx, { scope: "place" })`. `view-dependent-display-place` compares `pose` lists across views; `place-not-rigid` compares the display and export results' `_hash`-derived `baseHash` — expose it: in place scope return `baseHash: s._hash` when the token is a pose token and no query/function occurred, with `trusted: s._hash === CANONICAL`, so lint can tell "rigid-but-different" (`baseHash !== CANONICAL`, equal across purposes → fine) from "reshaped on one purpose" (unequal). Keep the comment at the top of the file in step.

- [ ] **Step 3: Run**

```bash
npx vitest run test/lint-animations.test.js test/lint-place.test.js test/lint-purity.test.js test/framework/lint
```

- [ ] **Step 4: Commit**

```bash
git add src/framework/lint/rules-animations.js src/framework/lint/rules-place.js test/lint-animations.test.js test/lint-place.test.js
git commit -m "lint: track classification and place rules on the place-scope probe; #161 fixture reports nothing"
```

---

### Task 8: Docs, AGENTS.md, the embedding contract, version 0.141.0

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` — the `place` bullet (~102-115), "Animations" pose-only bullet (~288-291), "Caching & determinism" (~786-793), "Linting" (~3707-3720)
- Modify: `docs/ERROR-PATTERNS.md` — `animation-plays-choppy` (~485), `view-dependent-display-place` (~141), `place-not-rigid` (~147)
- Modify: `AGENTS.md` — the `print-frame.js` bullet (~216-222); add one sentence to the `mount.js`/`param-deps.js` architecture bullet naming the pose ladder
- Modify: `src/framework/mount.js` — the embedding-contract comment (~245): `0.141.0: a place()-able sub-part is delivered in its canonical frame and posed by the viewer; pose-only edits never rebuild`
- Modify: `package.json` — `"version": "0.141.0"`

- [ ] **Step 1: Docs**

Write, in the house voice (plain sentences, the rule then the reason):

- `place` bullet: "The viewer applies the display pose as a matrix over the canonical mesh, so `build()` may query geometry freely; only `place()` has to stay a rigid motion of its argument, reading `p` and `d`, for a pose-only param to play at frame rate and for layer lines to stay on the part."
- Animations: "A param read only inside `place()` plays at frame rate whatever `build()` does. A param `build()` reads rebuilds at worker cadence. `lint` notes a track whose `place()` it cannot read (a query on the solid, a function argument)."
- Caching & determinism: keep the trailing-transform paragraph (rung 2) and add: "`place()` needs no probe at all: the viewer reads the pose off it directly."
- Linting: the `animation-track-rebuilds` sentence and the place-rules paragraph ("An untrusted probe … stays silent" → "A `place()` the probe cannot read stays silent for the two place rules and earns the `animation-track-rebuilds` note").
- `ERROR-PATTERNS.md` `animation-plays-choppy`: cause "a track drives a param `build()` reads, or a `place()` the probe cannot read"; fix names both notes. The two place entries: one sentence each noting the rules now see a `place()` behind any `build()`.

- [ ] **Step 2: AGENTS.md, contract comment, version**

- [ ] **Step 3: Full run**

```bash
npm test
npx eslint . && npx knip
```

- [ ] **Step 4: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md AGENTS.md src/framework/mount.js package.json
git commit -m "docs: place-only pose; embedding contract 0.141.0"
```

---

### Task 9: Scott's browser checks (manual)

Run the demo app against this branch (`npm run dev`, then the Hinged Box and a local copy of the Lattice Box; in partforge-cloud, `npm link` or a tarball install per `docs/AUTHORING-PARTS.md` "Developing against a local (linked) partforge").

- [ ] **Hinged Box (`hinged-box.html`)**: Open lid animation is smooth; `?debug` shows `rebuilt 0 / posed 1` per frame, `frame: 2 canonical`. Realistic mode: walnut grain does not slide as the lid swings.
- [ ] **Lattice Box in cloud (feedback #161's forge)**: in the Assembly view, "Open / close lid" moves the lid, insert and letters smoothly; `?debug` shows `rebuilt 0`. Switch to realistic: the layer lines on the lid and insert stay fixed to the parts through the whole swing (compare to production, where they re-slice each frame). Turn italic ON and repeat — the lid/text used to go untrusted.
- [ ] **Assemble animation**: the filament pin slides; the lid lowers; nothing rebuilds.
- [ ] **Print views (`lid`, `meshInsert`, `textInsert`)**: unchanged geometry; export an STL of the insert and confirm it is the print pose (flange down), i.e. exports are untouched.
- [ ] **Pick and measure on the posed lid**: click a knuckle at `openAngle: 90` — the pick prompt's local point is on the knuckle (display frame, as before); a measure pin lands on the surface and follows a slider drag of `openAngle`.
- [ ] **Cutaway** at `openAngle: 60`: the section outline and cap follow the lid; dragging `openAngle` re-slices without flicker.
- [ ] **Capture / thumbnail**: `captureView()` (the forge's card thumbnail) still shows the assembled pose; `render_part_views` in cloud returns the same framing as production.
- [ ] **A part with a querying `place()`** (edit `hinged-box.js` locally: `s.translate(s.boundingBox().center)` in `place`): still renders, still animates best-effort, `?debug` shows `posed` frame, lint prints the reworded untrusted note.
- [ ] **A laser sheet forge** (any kit forge in cloud): the burn still chars cut edges and engravings only, faces stay wood, in both views.
- [ ] **View switch** on the Lattice Box between Assembly and the print views and back: no misplaced sub-part; a rebuild each way is expected (pre-existing, stamps are per-view).
- [ ] Record anything that differs from production in the PR description; a difference in the print views or exports is a stop.
