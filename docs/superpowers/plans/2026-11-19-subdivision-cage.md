# Subdivision Cage (`k.cage`, `k.subdiv`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A part can box-model a coarse cage with `k.cage(...)` and turn it into a smooth solid with `k.subdiv(cage)`.

**Architecture:** The cage is plain JavaScript (points, quad faces, face ids) with no kernel work, so the real kernels and both geometry-free probes run the same code. `k.subdiv` copies the cage, runs Catmull-Clark to a level chosen from a chord tolerance, moves every vertex to its limit position, checks the mesh, and hands Manifold one welded mesh shaded with the ORGANIC policy, exactly as `k.implicit` does.

**Tech Stack:** JavaScript (ESM), vitest, the Manifold backend (`manifoldFromWeldedMesh`), the organic domain manifest.

**Spec:** `docs/superpowers/specs/2026-11-19-smooth-organic-surfaces-design.md`, Part 2. This plan is the spec's PR 2. The spec lists the tube fields as PR 1; the cage is planned first because it is the larger surface-quality gain and depends on nothing in PR 1. PR 1 (tube fields) and PR 3 (`sheet`) get their own plans.

## Global Constraints

- No existing build's output changes. The pinned implicit hashes and `test/core-parity.test.js` stay as they are.
- A subdivision body never differs in shape between preview and print beyond the stated chord tolerances. No tier shrinks or grows it.
- The cage has one authoring form, the builder object. No data-spec twin, no shorthand helpers.
- No self-intersecting body reaches an export without an error.
- `k.subdiv` is Manifold only. On OCCT it throws, as `k.implicit` does.
- `k.cage` is changed in place; `c.extrude` returns the new cap's id; the solid comes from `k.subdiv(c)`.
- First version: `box` start only, no creases, no loop cuts, no per-point placement (`nudge` is not shipped), no bridging, no thin-feature warning, no bindings or pose drag.
- `src/framework/geometry/` may not import a domain folder (`test/domain-layering.test.js`).
- Additive kernel ops, no `CONTRACT_VERSION` bump (the `implicit` precedent in `geometry/kernel.js`).
- Version goes to 0.197.0 in this PR.

## Review Focus

1. **A cap scaled to nothing or an extrude of zero length** (`scale: 0`, `by: 0`): the method throws and names the face; it never leaves coincident points for the mesher.
2. **An extrude pushed back through the body** (`by: -40` on a 20 mm box): `k.subdiv` reports self-intersection with the cage faces involved, an error at print and a warning at preview.
3. **A non-finite or wrong-shaped number** (`by: NaN`, `by: [1, 2]`, `segs: [2.5, 1, 1]`, `segs: [0, 1, 1]`): the method throws with the argument's name.
4. **A very fine cage** (`segs: [40, 40, 40]`): refused at `k.cage` with a face-count limit (2,000 cage faces), before any subdivision.
5. **The cage reused or changed after `k.subdiv`**: the first solid is unchanged, a second `k.subdiv(c)` builds the new shape, and passing anything that is not a Cage throws `subdiv: expected a cage from k.cage(...)`.

Each line has its test in the task that owns the code (Tasks 1, 4, 1, 1, 5).

---

## File Structure

| file | responsibility |
| --- | --- |
| `src/framework/geometry/subdiv/cage.js` (create) | The Cage: box start, face ids, `extrude` / `move` / `scale`, read methods, `mirror`, `snapshot()`. |
| `src/framework/geometry/subdiv/surface.js` (create) | Catmull-Clark levels, limit positions, level choice, triangulation. |
| `src/framework/geometry/subdiv/self-intersect.js` (create) | Finds triangle pairs of one closed mesh that cross. |
| `src/framework/geometry/subdiv/index.js` (create) | `createCage`, `meshSubdiv(snapshot, tier)`, `isCage`, the constants. |
| `src/framework/geometry/manifold-backend.js`, `occt-backend.js`, `kernel.js`, `op-options.js`, `probe.js`, `src/framework/pose-probe-core.js`, `src/framework/backend-select.js` (modify) | Wire the two ops. |
| `src/framework/domains/organic/manifest.js`, `lint.js` (modify) | Tag the ops; extend the Manifold-only rule. |
| `src/parts/organic-whale.js` (create), `docs/domains/organic.md`, `docs/KERNEL-CONTRACT.md`, `docs/ERROR-PATTERNS.md` (modify) | Reference part and docs. |

---

### Task 1: The Cage (no mirror)

**Files:**
- Create: `src/framework/geometry/subdiv/cage.js`, `src/framework/geometry/subdiv/index.js`
- Test: `test/subdiv-cage.test.js`

**Interfaces:**
- Produces:
  - `createCage({ box: { size: [x, y, z], center?: [x, y, z], segs?: [nx, ny, nz] }, mirror? }) -> Cage`
  - `cage.extrude(face | face[], { by: number | [x, y, z], scale?: number | [sx, sy, sz], steps?: integer >= 1, id?: string }) -> string | string[]`
  - `cage.move(face | face[], [x, y, z]) -> void`, `cage.scale(face | face[], s: number | [sx, sy, sz], { about?: [x, y, z] }) -> void`
  - `cage.centroid(face) -> [x, y, z]`, `cage.normal(face) -> [x, y, z]` (unit, outward), `cage.size(face) -> [u, v]` (mean edge lengths), `cage.faces(prefix?) -> string[]`, `cage.bounds() -> { min, max }`
  - `cage.snapshot() -> { points: number[][], faces: number[][], ids: string[] }` (a deep copy; `faces[i]` is four point indices, counter-clockwise seen from outside; `ids[i]` names `faces[i]`)
  - `isCage(value) -> boolean`
  - `MAX_CAGE_FACES = 2000`

Decisions the tests pin:
- Face ids are `${side}:${i},${j}`. `±x` sides: `i` indexes Y, `j` indexes Z. `±y`: `i` X, `j` Z. `±z`: `i` X, `j` Y. Indices rise with the coordinate.
- Default cap id is the extruded face's id plus `>`. With `steps: n`, intermediate rings are not caps; only the last cap exists as a face.
- Side faces are `${capId}.s0` … `.s3` for a single face. **Order rule:** side `k` sits on the extruded face's edge `k`, where edge 0 is the edge whose midpoint has the smallest value on the face's first in-plane axis, then counter-clockwise seen from outside. The in-plane axes of a face are the two world axes least aligned with its normal, in `x, y, z` order. With `steps`, segment `m` (1-based, from the base) names its sides `${capId}.${m}.s0` …; the last segment drops the `.${m}`.
- A region (a list of faces) must be edge-connected. Its caps are `${id}:0`, `${id}:1`, … in the order listed (`id` defaults to the first face's id plus `>`). Its side faces are `${id}.s0` … walking the region's boundary counter-clockwise from the boundary edge chosen by the same rule applied to the region's mean normal.
- Extruding removes the face. Naming a removed face throws `cage: face "<id>" was extruded; it is now <ids…>`. An unknown id throws `cage: no face "<id>"` followed by up to 8 nearest ids by prefix.
- Throws (message starts `cage: `): `scale` that makes any cap edge shorter than 1e-6 mm; `by` of zero length; non-finite numbers; `segs` not positive integers; more than `MAX_CAGE_FACES` faces after any call; a disconnected region; an `id` already in use.

- [ ] **Step 1: Write the failing tests** in `test/subdiv-cage.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createCage, isCage, MAX_CAGE_FACES } from "../src/framework/geometry/subdiv/index.js";

const box = (segs = [1, 1, 1]) => createCage({ box: { size: [40, 20, 20], segs } });

describe("cage: box and ids", () => {
  it("names every face by side and index", () => {
    const c = box([2, 1, 1]);
    expect(c.faces().length).toBe(10);
    expect(c.faces("+z").sort()).toEqual(["+z:0,0", "+z:1,0"]);
    expect(c.centroid("+z:1,0")).toEqual([10, 0, 10]);
    expect(c.normal("-x:0,0")).toEqual([-1, 0, 0]);
    expect(c.bounds()).toEqual({ min: [-20, -10, -10], max: [20, 10, 10] });
  });
  it("stays a closed quad mesh after every change", () => {
    const c = box([2, 2, 1]);
    const cap = c.extrude("+x:0,0", { by: 10, scale: 0.5 });
    c.extrude(cap, { by: [5, 0, 5], steps: 3 });
    c.move("+z:0,0", [0, 0, 3]);
    c.scale("-y:1,0", 0.8);
    const { points, faces } = c.snapshot();
    const edges = new Map();
    for (const f of faces) for (let k = 0; k < 4; k++) {
      const key = [f[k], f[(k + 1) % 4]].sort().join("-");
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
    expect(points.length - edges.size + faces.length).toBe(2);
  });
});

describe("cage: extrude", () => {
  it("returns the cap id, removes the face, and names four sides", () => {
    const c = box();
    expect(c.extrude("+x:0,0", { by: 10 })).toBe("+x:0,0>");
    expect(c.faces("+x:0,0").sort()).toEqual(["+x:0,0>", "+x:0,0>.s0", "+x:0,0>.s1", "+x:0,0>.s2", "+x:0,0>.s3"]);
    expect(c.centroid("+x:0,0>")).toEqual([30, 0, 0]);
    expect(() => c.extrude("+x:0,0", { by: 5 })).toThrow(/was extruded; it is now/);
  });
  it("orders the sides by the stated rule", () => {
    const c = box();
    c.extrude("+x:0,0", { by: 10, id: "arm" });
    expect(c.normal("arm.s0")).toEqual([0, -1, 0]);   // smallest Y edge first
    expect(c.normal("arm.s1")).toEqual([0, 0, 1]);    // then counter-clockwise seen from +x
  });
  it("grows a connected region as one piece", () => {
    const c = box([2, 1, 1]);
    expect(c.extrude(["+z:0,0", "+z:1,0"], { by: 5, id: "top" })).toEqual(["top:0", "top:1"]);
    expect(c.faces("top.s").length).toBe(6);
  });
  it("refuses the inputs in Review Focus 1, 3 and 4", () => {
    expect(() => box().extrude("+x:0,0", { by: 10, scale: 0 })).toThrow(/^cage: .*scale/);
    expect(() => box().extrude("+x:0,0", { by: 0 })).toThrow(/^cage: .*by/);
    expect(() => box().extrude("+x:0,0", { by: NaN })).toThrow(/^cage: .*by/);
    expect(() => box().extrude("+x:0,0", { by: [1, 2] })).toThrow(/^cage: .*by/);
    expect(() => box([2.5, 1, 1])).toThrow(/^cage: .*segs/);
    expect(() => box([0, 1, 1])).toThrow(/^cage: .*segs/);
    expect(() => box([40, 40, 40])).toThrow(new RegExp(`^cage: .*${MAX_CAGE_FACES}`));
    expect(() => box([3, 1, 1]).extrude(["+z:0,0", "+z:2,0"], { by: 5 })).toThrow(/^cage: .*connected/);
    expect(() => box().centroid("+q:0,0")).toThrow(/^cage: no face "\+q:0,0"/);
  });
});

it("snapshot is a copy, and isCage tells a cage from data", () => {
  const c = box();
  const before = c.snapshot();
  c.move("+z:0,0", [0, 0, 5]);
  expect(before.points).not.toEqual(c.snapshot().points);
  expect(isCage(c)).toBe(true);
  expect(isCage(before)).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run test/subdiv-cage.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `cage.js` and export `createCage`, `isCage`, `MAX_CAGE_FACES` from `subdiv/index.js`. Store points as an array of `[x, y, z]`, faces as a `Map<id, [a, b, c, d]>`, and a `removed: Map<id, string[]>` for the error message. Points are shared between faces; `move` and `scale` change shared points once. Ignore `mirror` for now except to reject values other than `"yz"`, `"xz"`, `"xy"`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/framework/geometry/subdiv test/subdiv-cage.test.js && git commit -m "Cage: box start, extrude, move, scale and face ids"`

### Task 2: `mirror`

**Files:**
- Modify: `src/framework/geometry/subdiv/cage.js`
- Test: `test/subdiv-cage-mirror.test.js`

**Interfaces:**
- Consumes: Task 1's `createCage`.
- Produces: with `mirror`, every change also runs on the reflected faces; reflected ids are the positive-side id plus `~`.

Decisions: `"xz"` reflects Y, `"yz"` reflects X, `"xy"` reflects Z, through the box `center`. "Positive side" is the side whose face centroid has the larger reflected coordinate at creation. A box face that lies on the far side at creation gets the id of its positive twin plus `~`. Faces of the two sides the plane cuts are named normally on the positive half and with `~` on the other.

- [ ] **Step 1: Write the failing tests:**

```js
import { it, expect } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/index.js";

const fish = () => createCage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
const reflectY = (pts) => pts.map(([x, y, z]) => [x, -y, z].join()).sort();

it("keeps the cage symmetric through every change", () => {
  const c = fish();
  const fin = c.extrude("+y:0,0", { by: 12, scale: 0.7 });
  c.extrude(fin, { by: [-6, 10, 0], scale: 0.4, steps: 2 });
  c.move("+z:1,1", [0, 2, 4]);
  const pts = c.snapshot().points;
  expect(reflectY(pts)).toEqual(pts.map((p) => p.join()).sort());
  expect(c.centroid(`${fin}~`)[1]).toBeCloseTo(-c.centroid(fin)[1], 9);
});
it("moves a point on the plane only within the plane", () => {
  const c = fish();
  c.move("+z:1,1", [0, 5, 0]);                       // this face touches y = 0
  expect(c.snapshot().points.filter((p) => Math.abs(p[1]) < 1e-9).length).toBeGreaterThan(0);
  expect(reflectY(c.snapshot().points)).toEqual(c.snapshot().points.map((p) => p.join()).sort());
});
it("grows a region that touches the plane across it, leaving no wall", () => {
  const c = fish();
  c.extrude("+z:1,1", { by: 6, id: "hump" });
  expect(c.faces("hump").some((id) => Math.abs(c.centroid(id)[1]) < 1e-9 && Math.abs(c.normal(id)[1]) > 0.9)).toBe(false);
});
it("refuses an odd count across the plane and a change to the far side", () => {
  expect(() => createCage({ box: { size: [60, 30, 20], segs: [4, 3, 1] }, mirror: "xz" })).toThrow(/^cage: .*mirror.*even/);
  expect(() => fish().move("+y:0,0~", [1, 0, 0])).toThrow(/^cage: .*reflected/);
  expect(fish().centroid("+y:0,0~")[1]).toBeLessThan(0);
});
```

- [ ] **Step 2: Run** `npx vitest run test/subdiv-cage-mirror.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Each changing method resolves its faces, adds their reflections (a face touching the plane joins its own reflection into one region), reflects `by`, `scale` and `about`, and applies the change once per point; a point within 1e-9 mm of the plane has its offset's normal component zeroed.
- [ ] **Step 4: Run** both cage test files. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Cage: mirror keeps a whole, symmetric cage"` (add the new test file).

### Task 3: The surface

**Files:**
- Create: `src/framework/geometry/subdiv/surface.js`
- Test: `test/subdiv-surface.test.js`

**Interfaces:**
- Consumes: `cage.snapshot()`.
- Produces:
  - `subdivide(snapshot, levels: integer 1..5) -> { positions: Float64Array, indices: Uint32Array, triFace: Uint32Array }`: `levels` Catmull-Clark steps, every vertex then moved to its limit position, each quad split into two triangles along its shorter diagonal. `triFace[t]` is the index of the cage face triangle `t` came from.
  - `levelFor(snapshot, tolerance: mm) -> integer 1..5`: the smallest level whose estimated chord error is at most `tolerance`; 5 when none is.
  - `chordError(snapshot, level) -> mm`: the estimate `levelFor` uses, measured as the largest distance from a level-`level` limit mesh edge midpoint to the limit position of that edge's point at level `level + 1`.
  - `SUBDIV_TOLERANCE = { preview: 0.1, print: 0.02 }`, `MAX_SUBDIV_LEVEL = 5`. These are starting values; record the measured facet sizes on the whale in the PR description.

The lowest level is 1 (`MIN_SUBDIV_LEVEL = 1`), so the stencil always runs on a mesh that has had a step. Limit position of a vertex with valence `n`, on an all-quad mesh: `(n² · v + 4 · Σ edge neighbours + Σ face-diagonal neighbours) / (n · (n + 5))`.

- [ ] **Step 1: Write the failing tests:**

```js
import { it, expect } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/index.js";
import { subdivide, levelFor, chordError, SUBDIV_TOLERANCE, MAX_SUBDIV_LEVEL } from "../src/framework/geometry/subdiv/surface.js";

const cube = () => createCage({ box: { size: [20, 20, 20] } }).snapshot();
const volume = ({ positions: p, indices: t }) => {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
};

it("is closed, outward-facing, and inside the cage", () => {
  const m = subdivide(cube(), 3);
  expect(volume(m)).toBeGreaterThan(0);
  expect(Math.max(...m.positions.map(Math.abs))).toBeLessThan(10);
  expect(m.triFace.length).toBe(m.indices.length / 3);
  expect(new Set(m.triFace).size).toBe(6);
});
it("puts every level on the same limit surface", () => {
  const a = subdivide(cube(), 2), b = subdivide(cube(), 4);
  for (let i = 0; i < 8 * 3; i++) expect(b.positions[i]).toBeCloseTo(a.positions[i], 9);   // the cage's own 8 points come first
  expect(Math.abs(volume(b) - volume(a)) / volume(b)).toBeLessThan(0.01);
});
it("chooses the level from the tolerance", () => {
  const s = cube();
  expect(levelFor(s, 1000)).toBe(1);
  expect(levelFor(s, 1e-9)).toBe(MAX_SUBDIV_LEVEL);
  const l = levelFor(s, SUBDIV_TOLERANCE.print);
  expect(chordError(s, l)).toBeLessThanOrEqual(SUBDIV_TOLERANCE.print);
  expect(levelFor(s, SUBDIV_TOLERANCE.preview)).toBeLessThanOrEqual(l);
});
it("handles an extraordinary point (valence 3 and 5) without a seam", () => {
  const c = createCage({ box: { size: [30, 30, 30], segs: [2, 2, 2] } });
  c.extrude("+z:0,0", { by: 15, scale: 0.6 });
  const m = subdivide(c.snapshot(), 3);
  expect(volume(m)).toBeGreaterThan(0);
  expect(m.positions.every(Number.isFinite)).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run test/subdiv-surface.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `surface.js`. Keep original points first, then face points, then edge points at each step, so point indices are stable (the second test depends on it).
- [ ] **Step 4: Run.** Expected: PASS. Also time `subdivide` at level 5 on the Task 1 extruded cage and note it in the commit body.
- [ ] **Step 5: Commit** `git commit -am "Subdivision: Catmull-Clark with limit positions and a tolerance-chosen level"`.

### Task 4: Self-intersection check

**Files:**
- Create: `src/framework/geometry/subdiv/self-intersect.js`
- Test: `test/subdiv-self-intersect.test.js`

**Interfaces:**
- Consumes: `subdivide`'s `{ positions, indices, triFace }`.
- Produces: `selfIntersections({ positions, indices, triFace }, { limit = 8 } = {}) -> Array<[cageFaceA: number, cageFaceB: number]>`: distinct pairs of cage face indices whose triangles cross, at most `limit`. Two triangles that share a vertex are never a pair.

- [ ] **Step 1: Write the failing tests:**

```js
import { it, expect } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/index.js";
import { subdivide } from "../src/framework/geometry/subdiv/surface.js";
import { selfIntersections } from "../src/framework/geometry/subdiv/self-intersect.js";

it("finds nothing on a clean body", () => {
  const c = createCage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } });
  c.extrude("+x:0,0", { by: 15, scale: 0.6 });
  expect(selfIntersections(subdivide(c.snapshot(), 3))).toEqual([]);
});
it("finds an extrude pushed back through the body, and names cage faces", () => {
  const c = createCage({ box: { size: [20, 20, 20] } });
  c.extrude("+x:0,0", { by: -40, scale: 0.5 });
  const snap = c.snapshot();
  const hits = selfIntersections(subdivide(snap, 3));
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.length).toBeLessThanOrEqual(8);
  for (const [a, b] of hits) { expect(snap.ids[a]).toBeTypeOf("string"); expect(snap.ids[b]).toBeTypeOf("string"); }
});
```

- [ ] **Step 2: Run** `npx vitest run test/subdiv-self-intersect.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Build a bounding-box tree over the triangles in this file (the oracle's `bvh.js` has no self-query and may not be changed here); test candidate pairs with a triangle-triangle intersection test; skip pairs sharing a vertex index.
- [ ] **Step 4: Run.** Expected: PASS. Time it on a level-5 mesh of the Task 1 cage and note it in the commit body. If it is over 150 ms, the preview tier runs it on a mesh two levels lower (decide in Task 5 from this number).
- [ ] **Step 5: Commit** `git commit -am "Subdivision: self-intersection check that names cage faces"`.

### Task 5: `k.cage` and `k.subdiv` on the kernels and probes

**Files:**
- Modify: `src/framework/geometry/subdiv/index.js`, `src/framework/geometry/manifold-backend.js` (beside `implicit`, ~line 1118), `src/framework/geometry/occt-backend.js` (beside `implicit`, ~line 770), `src/framework/geometry/kernel.js:20-40`, `src/framework/geometry/op-options.js:343`, `src/framework/geometry/probe.js:80` (`kernelQueries`), `src/framework/pose-probe-core.js:128` (`kernelQueries`) and `:141`, `src/framework/domains/organic/manifest.js`, `docs/KERNEL-CONTRACT.md`
- Test: `test/subdiv-kernel.test.js`; extend `test/kernel-contract.test.js`, `test/domain-kernel-ops.test.js`, `test/pose-probe.test.js` as their existing `implicit` cases do

**Interfaces:**
- Consumes: `createCage`, `isCage`, `subdivide`, `levelFor`, `selfIntersections`, `SUBDIV_TOLERANCE`.
- Produces:
  - `meshSubdiv(snapshot, tier: "preview" | "print") -> { positions, indices, warnings: string[] }` in `subdiv/index.js`. It throws `subdiv: the body has no volume` on volume <= 0, and at print tier throws `subdiv: the body passes through itself between <idA> and <idB>` (up to 8 pairs); at preview the same text is a warning.
  - `k.cage(opts)` on both backends: `createCage(opts)`.
  - `k.subdiv(cage)` on Manifold: a Solid, ORGANIC policy, cached on `h("subdiv", snapshot, quality)`. On OCCT: throws, with a message built like `IMPLICIT_ON_OCCT` naming `k.subdiv`.
  - Both probes: `cage` is a real function in `kernelQueries` (it returns a real Cage, not a token); `subdiv` returns a solid token whose hash covers `args[0].snapshot()`, with no `_implicit` flag.
  - `KERNEL_OPS` gains `"subdiv"` and `"cage"`; the organic manifest's `kernelOps` gains a throwing `subdiv` fallback and `{ name: "cage", attach: (k) => { k.cage = createCage; } }`.

- [ ] **Step 1: Write the failing tests** in `test/subdiv-kernel.test.js`, using the helper the existing `test/implicit-engine.test.js` uses to get a Manifold kernel at a tier:

```js
// kernelAt(tier) is that file's helper; copy its import.
it("builds a smooth solid that takes ordinary ops", async () => {
  const k = await kernelAt("preview");
  const c = k.cage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } });
  c.extrude("+x:0,0", { by: 15, scale: 0.6 });
  const s = k.subdiv(c);
  expect(s.volume()).toBeGreaterThan(0);
  expect(s.cut(k.box({ size: [100, 100, 20], center: [0, 0, -15] })).volume()).toBeLessThan(s.volume());
});
it("previews and prints the same body", async () => {
  const build = async (tier) => { const k = await kernelAt(tier); const c = k.cage({ box: { size: [40, 20, 20] } }); return k.subdiv(c).volume(); };
  const [a, b] = [await build("preview"), await build("print")];
  expect(Math.abs(a - b) / b).toBeLessThan(0.01);
});
it("copies the cage when called (Review Focus 5)", async () => {
  const k = await kernelAt("preview");
  const c = k.cage({ box: { size: [20, 20, 20] } });
  const first = k.subdiv(c), v = first.volume();
  c.extrude("+z:0,0", { by: 20 });
  expect(first.volume()).toBe(v);
  expect(k.subdiv(c).volume()).toBeGreaterThan(v);
  expect(() => k.subdiv(c.snapshot())).toThrow("subdiv: expected a cage from k.cage(...)");
});
it("errors at print and warns at preview on a body through itself", async () => {
  const bad = (k) => { const c = k.cage({ box: { size: [20, 20, 20] } }); c.extrude("+x:0,0", { by: -40, scale: 0.5 }); return c; };
  const print = await kernelAt("print");
  expect(() => print.subdiv(bad(print))).toThrow(/^subdiv: the body passes through itself between /);
  const preview = await kernelAt("preview");
  preview.subdiv(bad(preview));
  expect(preview.takeBuildWarnings().some((w) => /passes through itself/.test(String(w.message ?? w)))).toBe(true);
});
it("throws on OCCT, and answers cage questions under both probes", async () => {
  // OCCT: follow test/implicit-*.test.js's OCCT case. Probes: createProbeKernel() and the pose probe.
  // In each probe: k.cage({...}).centroid("+z:0,0") returns real numbers, and k.subdiv(c) returns a token
  // whose hash changes when the cage changes.
});
```

Write the last test's body from the existing implicit OCCT and probe tests; its three assertions are the comment's three statements.

- [ ] **Step 2: Run** `npx vitest run test/subdiv-kernel.test.js`. Expected: FAIL (`k.cage is not a function`).
- [ ] **Step 3: Implement** `meshSubdiv` and the wiring. In the Manifold op, follow `implicit`'s cache block: `manifoldFromWeldedMesh(wasm, positions, indices, id)` with one reserved original ID, `oidPolicies.set(id, ORGANIC)`, warnings stored beside the cached value and recorded again on a hit. Do not add the solid to `implicitMs` or `implicitCalls`. Add the `op-options.js` entry and the `KERNEL-CONTRACT.md` rows beside `implicit`'s.
- [ ] **Step 4: Run** `npx vitest run test/subdiv-kernel.test.js test/kernel-contract.test.js test/domain-kernel-ops.test.js test/domain-layering.test.js test/pose-probe.test.js test/core-parity.test.js`. Expected: PASS, and no implicit hash changed.
- [ ] **Step 5: Commit** `git commit -am "k.cage and k.subdiv on both kernels and the probes"`.

### Task 6: Export routing and lint

**Files:**
- Modify: `src/framework/backend-select.js:43-66` (`organicExportParts`), `src/framework/domains/organic/lint.js` (`SPEC_OPS` stays; the `implicit-needs-manifold` rule and its `routing()` helper), `docs/ERROR-PATTERNS.md`
- Test: extend `test/organic-subparts.test.js` and `test/organic-lint.test.js`

**Interfaces:**
- Consumes: the probe's `used` set now records `"subdiv"`.
- Produces: a sub-part whose build calls `k.subdiv` is an organic export part (meshed on Manifold, tessellated in STEP); `implicit-needs-manifold` fires for `k.subdiv` too, with the op's own name in the message.

- [ ] **Step 1: Write the failing tests.** In `test/organic-subparts.test.js`, copy the existing "calls k.implicit" case with a `k.cage` + `k.subdiv` build: `organicExportParts(part)` lists it, and a part that also calls `shell` throws naming `k.subdiv`. In `test/organic-lint.test.js`, copy the `implicit-needs-manifold` cases (an OCCT pin; a function-selector fillet) with a `k.subdiv` build: one error with rule id `implicit-needs-manifold` whose message contains `k.subdiv`. Add one case: a build whose cage call throws (`c.extrude("nope", { by: 1 })`) produces lint's ordinary build-throws error with the `cage: no face "nope"` text.
- [ ] **Step 2: Run** `npx vitest run test/organic-subparts.test.js test/organic-lint.test.js`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** One exported set `MESH_NATIVE_OPS = new Set(["implicit", "subdiv"])` in `geometry/kernel.js`, read by `backend-select.js` and `lint.js`; messages name whichever op the build used. Update the `implicit-needs-manifold` entry in `docs/ERROR-PATTERNS.md` to say it covers both.
- [ ] **Step 4: Run** the same command plus `npx vitest run test/organic-docs.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Subdivision bodies export as tessellated STEP and are covered by the Manifold-only lint"`.

### Task 7: Reference part, guide, version

**Files:**
- Create: `src/parts/organic-whale.js`
- Modify: `docs/domains/organic.md`, `src/framework/domains/organic/manifest.js` (`referenceParts`), `package.json` (0.197.0), and whatever `npm run docs:domains` regenerates
- Test: `test/organic-whale.test.js`; extend `test/organic-docs.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: a whale built from one mirrored cage (body, tail stock, two flukes, a dorsal fin, two pectoral fins), with `length` and `tailLift` controls, a flat belly cut for printing, and `verify` expectations it passes.

- [ ] **Step 1: Write the failing test** `test/organic-whale.test.js`: the part lints clean; it builds at preview and print on Manifold; `verify.ok` is `true`; the bounding box length equals the `length` default within 2%; changing `tailLift` changes the tail's top Z and nothing forward of the body's midpoint by more than 0.5 mm; a full build at print is under 2 s (record the real number).
- [ ] **Step 2: Run** `npx vitest run test/organic-whale.test.js`. Expected: FAIL.
- [ ] **Step 3: Write the part and the guide section.** The guide gains a section "A controlled surface: the subdivision cage" with: when a cage and when an implicit tree (a cage for one continuous skin whose silhouette matters; an implicit tree for pieces that blend, press together, or pose by frames); the face id and index order per side; the side-face order rule from Task 1; the mirror rules; "the surface lies inside the cage: a cube becomes a ball about 80% as wide, and more faces near an edge pull the surface toward it"; a limb is 2 to 4 chained extrudes, a knuckle is a short extrude with scale above 1 then one below 1; the errors; and the whale as the worked example. Fix the guide intro's stale line that says there is no reference part file.
- [ ] **Step 4: Run** `npm run docs:domains && npm test && npm run lint && npm run lint:dead`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Organic guide: the subdivision cage, a whale reference part; 0.197.0"`.

---

## After this plan

- Render the whale and a cage hand at four views and compare by eye against the spike's images before opening the PR.
- partforge-cloud: bump, regenerate prompts, run the paw, whale and hand eval cases against 0.196. A routing sentence naming the cage goes into the compact prompt only if the judges' smooth-flow pass rate rises with no loss elsewhere (spec goal 4).
