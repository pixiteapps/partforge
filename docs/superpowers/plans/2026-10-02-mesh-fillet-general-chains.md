# Mesh Fillet General Chains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fillets and chamfers on edges between two curved faces (pipe tees, cross holes, bosses on domes, slanted cuts) build on Manifold instead of rerouting the sub-part to OCCT.

**Architecture:** A fourth chain kind, `general`, produced by a whole-path rescue in `chainEdges` only where today's planar rescue fails. Its tool is a stack of rings, one per path vertex, each ring the existing `profile2D` cross-section built from that vertex's own mesh flank normals in the plane perpendicular to the edge; the stack is meshed by a new off-contract kernel side channel `k._ringStackSolid`. Fillet bands register a new `spine` blend descriptor so they shade exactly.

**Tech Stack:** partforge (plain ESM JS), manifold-3d 3.5.1 WASM, vitest, Node 24. OCCT (replicad) only in an offline reference script.

**Spec:** `docs/superpowers/specs/2026-10-02-mesh-fillet-general-chains-design.md`

## Global Constraints

- Policy: if any selected chain is still unsupported, the sub-part reroutes to OCCT exactly as today (`UnsupportedEdgeError` → `KernelCapabilityError` / `NEEDS_OCCT`). No partial blending.
- The `line` / `arc` / `planar` classifiers and their tools (`prismTool`, `revolveTool`, `planarTool`, corner treatments) are not changed. The general rescue runs only on a path that still has an unsupported run after `buildPlanarPath` returns null.
- No kernel API or `CONTRACT_VERSION` change. New kernel entry points are underscore side channels (`_ringStackSolid`), like `_markBlendSurface`.
- `profile2D`'s default output is byte-identical to today (the new `nArc` parameter is optional).
- Watertightness is asserted with `genus()`, never `isWatertight` (false negatives on swept geometry, see `test/mesh-fillet-planar.test.js` header).
- OCCT and Manifold never boot in the same process.
- roundAll's prism fast path (`manifold-backend.js`, `prismRoundAllFast`) uses `_filletRaw` and falls back on refusal; its tests must stay green unchanged.
- Release: bump `package.json` / `package-lock.json` to **0.137.0** in the final task.
- Node 24: run commands with `~/.nvm/versions/node/v24.19.0/bin` first on PATH if the shell's `node` is older.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01GCWLXk8DdfmucrJLce1J2M`

## Review Focus

1. A fillet whose selector (`{inPlane, at}`, `{dir}`) picks only ordinary edges on a part that also has general chains must keep working exactly as before — the general chain is simply not selected (Task 4 test).
2. A general chain that ends at a corner shared with a straight run (a D-profile rod cut on a slant) must give a watertight Manifold result or a clean reroute, never mangled geometry (Task 4 test).
3. Print quality (`bootManifoldKernel({ quality: "print" })`) must build the same fixtures watertight (Task 4 test).
4. Building the same filleted part twice in one kernel (cache hit, then `cleanup()`) must give the same volume with no "instance already deleted" (Task 3 test).
5. A mirror applied after the fillet must keep finite shading normals and the same genus (Task 5 test).

---

### Task 1: Shared fixtures and OCCT reference volumes

**Files:**
- Create: `test/fixtures/fillet-general-fixtures.js`
- Create: `scripts/fillet-general-reference.mjs`
- Create (generated, committed): `test/fixtures/fillet-general-reference.json`
- Test: `test/fillet-general-fixtures.test.js`

**Interfaces:**
- Produces: `FIXTURES: Record<"tee"|"crossHole"|"domeBoss"|"slantCut", (k) => Solid>`, `GENUS: Record<name, number>`, `CASES: [mode: "fillet"|"chamfer", magnitude: number][]`, `tightBend: (k) => Solid`, `dRodSlant: (k) => Solid`, and the JSON `{ [name]: { [`${mode}${magnitude}`]: number | null } }` where the number is OCCT's volume change (filleted − base) and `null` means OCCT skipped or failed that feature.

- [ ] **Step 1: Write the fixtures module**

```js
// test/fixtures/fillet-general-fixtures.js
// Edges people want rounded that lie between two CURVED faces — the mesh fillet's
// general-chain acceptance set (spec 2026-10-02). Backend-neutral: each builder takes
// a kernel, so the OCCT reference script and the Manifold tests build the same parts.
export const FIXTURES = {
  // boss on a tube: concave saddle junction
  tee: (k) => k.cylinder({ r: 10, h: 60, center: true }).rotateAbout({ axis: "Y", deg: 90 })
    .union(k.cylinder({ r: 5, h: 20 })),
  // through hole across a solid tube: two convex saddle rims
  crossHole: (k) => k.cylinder({ r: 10, h: 60, center: true }).rotateAbout({ axis: "Y", deg: 90 })
    .cut(k.cylinder({ r: 3, h: 40, center: true })),
  // off-axis boss on a dome: concave junction, not coaxial with the sphere
  domeBoss: (k) => k.sphere({ r: 20 }).intersect(k.box({ size: [60, 60, 30] }))
    .union(k.cylinder({ r: 3, h: 30 }).at([8, 0, 0])),
  // tube cut by a 30° plane wholly inside its height: one elliptical rim
  slantCut: (k) => k.cylinder({ r: 10, h: 40 })
    .cut(k.box({ size: [80, 80, 40] }).rotateAbout({ axis: "X", deg: 30 }).at([0, 0, 25])),
};
export const GENUS = { tee: 0, crossHole: 1, domeBoss: 0, slantCut: 0 };
export const CASES = [["fillet", 1], ["fillet", 2], ["chamfer", 1]];
// thin rod on a plate, top cut on a slant: its convex elliptical rim bends tighter
// (radius ~1.5) than a 2 mm fillet section reaches — must reroute, not fold
export const tightBend = (k) => k.box({ size: [20, 20, 2] })
  .union(k.cylinder({ r: 1.5, h: 10 }))
  .cut(k.box({ size: [40, 40, 20] }).rotateAbout({ axis: "X", deg: 30 }).at([0, 0, 7]));
// D-profile rod cut on a slant: the top rim mixes a curved (general) run with a
// straight run meeting it at two corners
export const dRodSlant = (k) => k.cylinder({ r: 6, h: 30 })
  .cut(k.box({ min: [4, -10, -1], max: [10, 10, 40] }))
  .cut(k.box({ size: [80, 80, 40] }).rotateAbout({ axis: "X", deg: 30 }).at([0, 0, 20]));
```

- [ ] **Step 2: Write the fixture sanity test**

```js
// test/fillet-general-fixtures.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { FIXTURES, GENUS, CASES } from "./fixtures/fillet-general-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

describe("general-chain fixtures", () => {
  it("build with the stated genus", () => {
    for (const [name, make] of Object.entries(FIXTURES)) expect(make(k).genus(), name).toBe(GENUS[name]);
  });
  it("have an OCCT reference entry for every case", () => {
    const ref = JSON.parse(readFileSync(new URL("./fixtures/fillet-general-reference.json", import.meta.url), "utf8"));
    for (const name of Object.keys(FIXTURES))
      for (const [mode, m] of CASES) expect(ref[name], name).toHaveProperty(`${mode}${m}`);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/fillet-general-fixtures.test.js`
Expected: the genus test PASSES, the reference test FAILS with ENOENT for `fillet-general-reference.json`.

- [ ] **Step 4: Write the reference script**

```js
// scripts/fillet-general-reference.mjs
// Offline: OCCT's volume change for each general-chain fixture × case, the ground
// truth test/mesh-fillet-general.test.js compares the mesh fillet against. OCCT must
// not share a process with Manifold, hence a script. A change of exactly 0 means
// OCCT's safeOp SKIPPED the feature — recorded as null, never as a reference.
// Usage: node scripts/fillet-general-reference.mjs
import { writeFileSync } from "node:fs";
import { bootOcctKernel } from "../src/testing/occt.js";
import { FIXTURES, CASES } from "../test/fixtures/fillet-general-fixtures.js";

const k = await bootOcctKernel({});
const out = {};
for (const [name, make] of Object.entries(FIXTURES)) {
  const base = make(k);
  const v0 = base.volume();
  out[name] = {};
  for (const [mode, m] of CASES) {
    let dV = null;
    try {
      const s = mode === "fillet" ? base.fillet(m) : base.chamfer(m);
      const d = s.volume() - v0;
      dV = Math.abs(d) > 1e-6 ? +d.toFixed(4) : null;
    } catch { dV = null; }
    out[name][`${mode}${m}`] = dV;
  }
}
const path = new URL("../test/fixtures/fillet-general-reference.json", import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out));
```

- [ ] **Step 5: Generate the reference**

Run: `node scripts/fillet-general-reference.mjs`
Expected: prints JSON. On 2026-10-02 (`slantCut` at its old z=35 placement) OCCT gave non-null values for tee/crossHole all cases and domeBoss fillets, and null (skipped) for domeBoss chamfer. Record whatever it prints now; nulls are expected and handled by Task 4.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/fillet-general-fixtures.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/fillet-general-fixtures.js test/fixtures/fillet-general-reference.json scripts/fillet-general-reference.mjs test/fillet-general-fixtures.test.js
git commit -m "test: general-chain fillet fixtures and OCCT reference volumes"
```

---

### Task 2: Classify general chains and build their stations

**Files:**
- Modify: `src/framework/geometry/mesh-fillet.js` — `chainEdges` (the planar-rescue block near `const rescue = buildPlanarPath(edges, path);`), new `buildGeneralPath` after `buildPlanarPath`, new exported `generalStations`; header comment's "Edge classes supported" list.
- Test: `test/mesh-fillet-general-chains.test.js`

**Interfaces:**
- Consumes: `FIXTURES` (Task 1); existing `detectSharpEdges`, `chainEdges`, `vertPos`, `otherVid`, vector helpers in `mesh-fillet.js`.
- Produces:
  - chain `{ kind: "general", points: number[][], closed: boolean, convex: boolean, flanks: [n1: number[], n2: number[]][] }` — `points` has NO duplicated closing point; member `i` runs `points[i] → points[(i + 1) % n]` when closed, `points[i] → points[i + 1]` when open; `flanks[i]` is member `i`'s continuity-paired flank normals.
  - `export function generalStations(chain): { p: number[], t: number[], n1: number[], n2: number[], tilt: number }[]` — unit tangent `t`; unit `n1`, `n2` perpendicular to `t`; `tilt` (radians) = the largest angle between a station's averaged normal and an incident member's own normal.

- [ ] **Step 1: Write the failing tests**

```js
// test/mesh-fillet-general-chains.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { detectSharpEdges, chainEdges, generalStations } from "../src/framework/geometry/mesh-fillet.js";
import { FIXTURES } from "./fixtures/fillet-general-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const chainsOf = (solid) => chainEdges(detectSharpEdges(solid.toIndexedMesh()));

describe("general chains", () => {
  it("every acceptance fixture classifies with no unsupported chain and at least one general chain", () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const chains = chainsOf(make(k));
      expect(chains.filter((c) => c.kind === "unsupported").map((c) => c.reason), name).toEqual([]);
      expect(chains.some((c) => c.kind === "general"), name).toBe(true);
    }
  });
  it("cross hole rims are closed general chains, convex; the tee junction is concave", () => {
    const hole = chainsOf(FIXTURES.crossHole(k)).filter((c) => c.kind === "general");
    expect(hole.length).toBeGreaterThanOrEqual(2);
    for (const c of hole) { expect(c.closed).toBe(true); expect(c.convex).toBe(true); }
    const tee = chainsOf(FIXTURES.tee(k)).filter((c) => c.kind === "general");
    expect(tee.every((c) => c.convex === false)).toBe(true);
  });
  it("stations carry unit tangents and unit flank normals perpendicular to them", () => {
    for (const c of chainsOf(FIXTURES.tee(k)).filter((ch) => ch.kind === "general")) {
      const st = generalStations(c);
      expect(st.length).toBeGreaterThanOrEqual(c.points.length);
      for (const s of st) {
        for (const v of [s.t, s.n1, s.n2]) expect(Math.hypot(...v)).toBeCloseTo(1, 9);
        expect(Math.abs(s.t[0] * s.n1[0] + s.t[1] * s.n1[1] + s.t[2] * s.n1[2])).toBeLessThan(1e-9);
        expect(Math.abs(s.t[0] * s.n2[0] + s.t[1] * s.n2[1] + s.t[2] * s.n2[2])).toBeLessThan(1e-9);
        expect(s.tilt).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("never claims an edge an existing tool already handles (classification freeze)", () => {
    const blob = Array.from({ length: 72 }, (_, i) => {
      const th = (2 * Math.PI * i) / 72, rr = 20 + 4 * Math.sin(3 * th) + 2 * Math.cos(5 * th);
      return [rr * Math.cos(th), rr * Math.sin(th)];
    });
    const supported = {
      box: k.box({ size: [40, 30, 20] }),
      cylinder: k.cylinder({ r: 10, h: 20 }),
      blobExtrude: k.extrude({ profile: blob, h: 10 }),
      ribOnCylinder: k.cylinder({ r: 15, h: 30 }).union(k.box({ min: [10, -2, 0], max: [25, 2, 20] })),
      dShaft: k.cylinder({ r: 5, h: 20 }).cut(k.box({ min: [3.5, -10, -1], max: [10, 10, 30] })),
      draftedBox: k.loft({ rings: [{ polygon: [[-20, -15], [20, -15], [20, 15], [-20, 15]], z: 0 },
        { polygon: [[-17, -12], [17, -12], [17, 12], [-17, 12]], z: 20 }], ruled: true }),
      filletAfterFillet: k.box({ size: [40, 30, 20] }).fillet({ r: 5, edges: { dir: "Z" } }),
      bossOnPlate: k.box({ size: [60, 60, 5] }).union(k.cylinder({ r: 6, h: 20 })),
    };
    for (const [name, solid] of Object.entries(supported)) {
      const chains = chainsOf(solid);
      expect(chains.some((c) => c.kind === "general"), name).toBe(false);
      expect(chains.some((c) => c.kind === "unsupported"), name).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/mesh-fillet-general-chains.test.js`
Expected: FAIL — `generalStations` is not exported (import error), so every test in the file fails.

- [ ] **Step 3: Add the rescue call in `chainEdges`**

Replace the existing block:

```js
    if (runChains.some((c) => c.kind === "unsupported")) {
      const rescue = buildPlanarPath(edges, path);
      if (rescue) { chains.push(rescue); continue; }
    }
```

with:

```js
    if (runChains.some((c) => c.kind === "unsupported")) {
      const rescue = buildPlanarPath(edges, path);
      if (rescue) { chains.push(rescue); continue; }
      // Last resort before a reroute: the whole path as ONE general chain, whose tool
      // builds its cross-section per vertex from that vertex's own flank normals
      // (generalTool). Runs only where every fixed-section tool has already refused,
      // so no chain any existing tool accepts can ever land here.
      const general = buildGeneralPath(edges, path);
      if (general) { chains.push(general); continue; }
    }
```

- [ ] **Step 4: Add `buildGeneralPath` and `generalStations` after `buildPlanarPath`**

```js
// General-chain rescue (spec 2026-10-02): an edge between two curved faces — a pipe
// tee's saddle, a cross hole's rim, an ellipse where a plane cuts a tube — fails every
// constancy test the fixed-section tools need, yet the mesh still records BOTH exact
// flank normals per member. Accept the whole path if it keeps one convexity and has
// no knife edge; generalTool builds a cross-section per vertex from those normals.
// Flanks are paired against the PREVIOUS member's pairing (continuity), never a world
// frame: over a saddle the flank normals swing far enough that world pairing swaps
// them partway round (fitArcChain's rotating-frame argument, made local).
function buildGeneralPath(edges, path) {
  const members = path.members.map((i) => edges[i]);
  if (members.length < 2) return null;
  const convex = members[0].convex;
  if (!members.every((m) => m.convex === convex)) return null;
  const points = [vertPos(members[0], path.verts[0])];
  members.forEach((m, i) => points.push(vertPos(m, otherVid(m, path.verts[i]))));
  const closed = !!path.loop;
  if (closed) points.pop(); // loop: last vertex is the first; keep one copy
  const flanks = [];
  let prev = [members[0].n1, members[0].n2];
  for (const m of members) {
    const keep = dot(m.n1, prev[0]) + dot(m.n2, prev[1]) >= dot(m.n2, prev[0]) + dot(m.n1, prev[1]);
    const pair = keep ? [m.n1, m.n2] : [m.n2, m.n1];
    if (dot(pair[0], pair[1]) < -1 + 1e-6) return null; // knife edge: no wedge to blend
    flanks.push(pair);
    prev = pair;
  }
  if (closed) {
    const f0 = flanks[0], fl = flanks[flanks.length - 1];
    if (dot(f0[0], fl[0]) + dot(f0[1], fl[1]) < dot(f0[0], fl[1]) + dot(f0[1], fl[0])) return null; // pairing cannot close
  }
  return { kind: "general", points, closed, convex, flanks };
}

// One station per path vertex, plus interior stations on members much longer than the
// median (a long facet between short ones would otherwise step the section). A
// vertex's tangent bisects its two members; its flank normals average the incident
// members' (paired) normals, projected perpendicular to the tangent. `tilt` is how far
// that average sits from the incident facets — generalTool's grazing allowance.
export function generalStations(chain) {
  const { points, closed, flanks } = chain;
  const n = points.length;
  const nMem = closed ? n : n - 1;
  const memDir = (i) => norm(sub(points[(i + 1) % n], points[i]));
  const memLen = (i) => len(sub(points[(i + 1) % n], points[i]));
  const perp = (v, t) => norm(sub(v, scl(t, dot(v, t))));
  const angle = (a, b) => Math.acos(clamp1(dot(a, b)));
  const lens = Array.from({ length: nMem }, (_, i) => memLen(i)).sort((a, b) => a - b);
  const median = lens[lens.length >> 1];
  const vertexStation = (v) => {
    const inc = [];
    if (closed || v > 0) inc.push((v - 1 + nMem) % nMem);
    if (closed || v < n - 1) inc.push(v % nMem);
    const t = norm(inc.reduce((acc, i) => add(acc, memDir(i)), [0, 0, 0]));
    const raw1 = norm(inc.reduce((acc, i) => add(acc, flanks[i][0]), [0, 0, 0]));
    const raw2 = norm(inc.reduce((acc, i) => add(acc, flanks[i][1]), [0, 0, 0]));
    let tilt = 0;
    for (const i of inc) tilt = Math.max(tilt, angle(raw1, flanks[i][0]), angle(raw2, flanks[i][1]));
    return { p: points[v], t, n1: perp(raw1, t), n2: perp(raw2, t), tilt };
  };
  const out = [];
  for (let v = 0; v < n; v++) {
    out.push(vertexStation(v));
    if (!closed && v === n - 1) break;
    const L = memLen(v);
    const extra = Math.ceil(L / (2 * median)) - 1;
    const t = memDir(v), [f1, f2] = flanks[v];
    for (let j = 1; j <= extra; j++) {
      const s = j / (extra + 1);
      out.push({ p: add(points[v], scl(sub(points[(v + 1) % n], points[v]), s)), t,
        n1: perp(f1, t), n2: perp(f2, t), tilt: 0 });
    }
  }
  return out;
}
```

- [ ] **Step 5: Update the module header's edge-class list**

In the header comment of `mesh-fillet.js`, after the "planar contour chains" bullet, add:

```js
//   - general chains between two curved faces       → per-vertex cross-section ring
//     (saddles, cross-hole rims, slanted cuts)          stack (buildGeneralPath /
//                                                       generalTool), tried last
```

and change the following sentence to: `// Anything a general chain also refuses (mixed convexity, knife edges, a bend tighter than the section) raises UnsupportedEdgeError so a caller can reroute the build to the B-rep backend.`

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run test/mesh-fillet-general-chains.test.js`
Expected: PASS (4 tests). If a fixture still reports an unsupported chain, print its `reason` and the path's member count before changing anything: a path with mixed convexity (e.g. a junction that flips) legitimately stays unsupported, and the fixture — not the gate — is then wrong.

- [ ] **Step 7: Run the existing mesh-fillet suite**

Run: `npx vitest run test/mesh-fillet test/filleted-box.test.js test/occt-fillet.test.js`
Expected: PASS, unchanged. `apply()` still throws on general chains here, since no tool exists yet — `toolsFor` falls through to `prismTool` for an unknown kind, so Task 4 must land before any caller fillets a general chain. Guard it now: in `apply()`, directly after `const unsupported = selected.find((ch) => ch.kind === "unsupported");` add

```js
  if (!TOOL_FOR_GENERAL && selected.some((ch) => ch.kind === "general")) throw new UnsupportedEdgeError(`${mode}: general chains not enabled`);
```

and near the top of the file, below the constants, `const TOOL_FOR_GENERAL = false; // flipped by Task 4 when generalTool lands`. This keeps today's reroute behaviour bit-for-bit until then.

- [ ] **Step 8: Commit**

```bash
git add src/framework/geometry/mesh-fillet.js test/mesh-fillet-general-chains.test.js
git commit -m "mesh-fillet: classify edges between curved faces as general chains"
```

---

### Task 3: Ring-stack solids (`k._ringStackSolid`)

**Files:**
- Modify: `src/framework/geometry/mesh-build.js` — new export `ringStackManifold`
- Modify: `src/framework/geometry/manifold-backend.js` — import it; add `_ringStackSolid` next to `_markBlendSurface`
- Test: `test/ring-stack-solid.test.js`

**Interfaces:**
- Consumes: `sideQuads`, `reverseWinding`, `manifoldFromMesh` (mesh-build.js); `cached`, `h`, `T` (manifold-backend.js).
- Produces:
  - `export function ringStackManifold(wasm, rings: number[][][], { closed = false } = {}): Manifold` — every ring the same length `n ≥ 3`; open stacks are capped by a fan from each end ring's vertex 0 (rings must be star-shaped about vertex 0, which every `profile2D` section is — its vertex 0 is the corner); winding normalized to positive volume.
  - kernel `_ringStackSolid(rings, { closed }) → Solid` (cached).

- [ ] **Step 1: Write the failing test**

```js
// test/ring-stack-solid.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// a triangle ring (vertex 0 first) carried along a path
const tri = (p, u, v, s = 1) => [p, [p[0] + s * u[0], p[1] + s * u[1], p[2] + s * u[2]], [p[0] + s * v[0], p[1] + s * v[1], p[2] + s * v[2]]];

describe("_ringStackSolid", () => {
  it("open stack: a capped triangular prism with the right volume, either winding", () => {
    const rings = [0, 5, 10].map((z) => tri([0, 0, z], [1, 0, 0], [0, 1, 0]));
    for (const rs of [rings, rings.map((r) => [r[0], r[2], r[1]])]) {
      const s = k._ringStackSolid(rs, { closed: false });
      expect(s.genus()).toBe(0);
      expect(s.volume()).toBeCloseTo(0.5 * 10, 6);
    }
  });
  it("closed stack: a triangular torus has genus 1 and positive volume", () => {
    const N = 48, R = 10, rings = [];
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N, c = [R * Math.cos(a), R * Math.sin(a), 0];
      const radial = [Math.cos(a), Math.sin(a), 0];
      rings.push(tri(c, radial, [0, 0, 1]));
    }
    const s = k._ringStackSolid(rings, { closed: true });
    expect(s.genus()).toBe(1);
    expect(s.volume()).toBeGreaterThan(0);
  });
  it("rejects rings of unequal size", () => {
    expect(() => k._ringStackSolid([tri([0, 0, 0], [1, 0, 0], [0, 1, 0]), [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]]))
      .toThrow(/equal size/);
  });
  it("survives a cache hit and cleanup() across two builds", () => {
    const rings = [0, 5].map((z) => tri([0, 0, z], [2, 0, 0], [0, 2, 0]));
    const v1 = k._ringStackSolid(rings).volume();
    k.cleanup?.();
    const v2 = k._ringStackSolid(rings).volume();
    k.cleanup?.();
    expect(v2).toBeCloseTo(v1, 9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ring-stack-solid.test.js`
Expected: FAIL with `k._ringStackSolid is not a function`.

- [ ] **Step 3: Implement `ringStackManifold` in `mesh-build.js`**

```js
// A solid from a stack of equal-size 3-D rings (mesh-fillet's general-chain tools:
// one cross-section per edge vertex, each in its own plane). Consecutive rings are
// stitched by sideQuads; `closed` stitches the last ring back to the first (a loop,
// no caps), otherwise each end ring is capped by a fan from ITS vertex 0 — valid for
// rings star-shaped about vertex 0, which every fillet/chamfer section is (vertex 0
// is the section's corner). Ring orientation is arbitrary: the winding is normalized
// by the mesh's signed volume, because ofMesh throws or imports an inverted solid
// when it is wrong (see this file's header).
export function ringStackManifold(wasm, rings, { closed = false } = {}) {
  const n = rings[0]?.length ?? 0;
  if (n < 3 || !rings.every((r) => r.length === n)) throw new Error("ringStack: rings must have equal size (≥ 3 points)");
  const V = [], Tr = [];
  for (const ring of rings) for (const p of ring) V.push(p[0], p[1], p[2]);
  sideQuads(Tr, rings.length, n, closed);
  if (!closed) {
    const last = (rings.length - 1) * n;
    for (let j = 1; j + 1 < n; j++) {
      Tr.push(0, j + 1, j);                  // first cap (flip, as fanCap's bottom)
      Tr.push(last, last + j, last + j + 1); // last cap
    }
  }
  let vol6 = 0;
  for (let t = 0; t < Tr.length; t += 3) {
    const a = Tr[t] * 3, b = Tr[t + 1] * 3, c = Tr[t + 2] * 3;
    vol6 += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1])
      - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c])
      + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
  }
  if (vol6 < 0) reverseWinding(Tr);
  return manifoldFromMesh(wasm, V, Tr);
}
```

- [ ] **Step 4: Register `_ringStackSolid` in `manifold-backend.js`**

Change the mesh-build import to `import { manifoldFromMesh, ringStackManifold } from "./mesh-build.js";` (keep any other names already imported on that line). Immediately before `_markBlendSurface: (tool, surf) => {`, add:

```js
    // Side-channel for mesh-fillet's general-chain tools (underscore = off-contract):
    // a solid from a stack of equal-size 3-D rings (mesh-build.js ringStackManifold).
    _ringStackSolid: (rings, opts = {}) =>
      cached(h("ringStack", rings, { closed: !!opts.closed }), () => T(ringStackManifold(wasm, rings, { closed: !!opts.closed }))),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/ring-stack-solid.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/mesh-build.js src/framework/geometry/manifold-backend.js test/ring-stack-solid.test.js
git commit -m "manifold: ring-stack solids for mesh-fillet's general tools"
```

---

### Task 4: The general tool, wired into `apply()`

**Files:**
- Modify: `src/framework/geometry/mesh-fillet.js` — `profile2D` (optional `nArc`), new `generalTool` and `circumcentre` after `prismTool`, `apply()`'s `toolsFor`, remove the Task 2 `TOOL_FOR_GENERAL` guard.
- Test: `test/mesh-fillet-general.test.js`

**Interfaces:**
- Consumes: `generalStations` (Task 2); `k._ringStackSolid` (Task 3); `FIXTURES`, `GENUS`, `CASES`, `tightBend`, `dRodSlant`, the reference JSON (Task 1); existing `profile2D`, `ballOffset`, `markBlend`, `UnsupportedEdgeError`.
- Produces: `generalTool(k, chain, magnitude, mode, pSegs) → Solid`; registers fillet bands with `markBlend(k, tool, { kind: "spine", pts, closed, r })` — `pts` the ball-centre per station, in station order (Task 5 implements the descriptor; until then `mapSurface` would throw on an unknown kind, so Task 4 passes the descriptor only when `SPINE_SHADING` is true — see Step 4).

- [ ] **Step 1: Write the failing tests**

```js
// test/mesh-fillet-general.test.js
// General chains (edges between two curved faces) blend on Manifold. Volume ground
// truth is OCCT where OCCT actually built the feature (reference JSON, null = OCCT
// skipped), and an independent analytic integral for the slanted cut's elliptical rim.
// Sensitivity: dropping the tee's concave junction alone shifts its fillet-1 volume
// change by ~25%, so the 10% tolerance catches a missing or wrong general tool.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { FIXTURES, GENUS, CASES, tightBend, dRodSlant } from "./fixtures/fillet-general-fixtures.js";

const REF = JSON.parse(readFileSync(new URL("./fixtures/fillet-general-reference.json", import.meta.url), "utf8"));
const relErr = (v, e) => Math.abs(v - e) / Math.abs(e);
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const run = (solid, mode, m, edges) => (mode === "fillet" ? solid._filletRaw(m, edges) : solid._chamferRaw(m, edges));

// spandrel area of a convex fillet of radius r at interior dihedral alpha, integrated
// along the ellipse a tilted plane cuts from a radius-R tube
function slantRimSpandrel(r, R = 10, tiltDeg = 30, n = 3600) {
  const t = (tiltDeg * Math.PI) / 180;
  let V = 0;
  for (let i = 0; i < n; i++) {
    const th = ((i + 0.5) * 2 * Math.PI) / n;
    const alpha = Math.PI - Math.acos(-Math.sin(t) * Math.sin(th));
    const A = r * r * (1 / Math.tan(alpha / 2) - (Math.PI - alpha) / 2);
    V += A * Math.hypot(R, R * Math.tan(t) * Math.cos(th)) * ((2 * Math.PI) / n);
  }
  return V;
}

describe("general-chain fillet and chamfer on Manifold", () => {
  for (const name of Object.keys(FIXTURES)) {
    for (const [mode, m] of CASES) {
      it(`${name} ${mode} ${m}: builds, watertight, volume matches OCCT where OCCT built it`, () => {
        const base = FIXTURES[name](k);
        const out = run(base, mode, m);
        expect(out.genus()).toBe(GENUS[name]);
        const dV = out.volume() - base.volume();
        const ref = REF[name][`${mode}${m}`];
        if (ref != null) expect(relErr(dV, ref)).toBeLessThan(0.1);
        else expect(Number.isFinite(dV) && dV !== 0).toBe(true);
      });
    }
  }
  it("slanted cut: the elliptical rim removes the analytic spandrel volume", () => {
    for (const r of [1, 2]) {
      const base = FIXTURES.slantCut(k);
      const all = run(base, "fillet", r).volume() - base.volume();
      const bottom = run(base, "fillet", r, { inPlane: "XY", at: 0 }).volume() - base.volume();
      expect(relErr(-(all - bottom), slantRimSpandrel(r))).toBeLessThan(0.1);
    }
  });
  it("a bend tighter than the section still reroutes", () => {
    expect(() => run(tightBend(k), "fillet", 2)).toThrow(/bend too tight|NEEDS_OCCT|general chain/);
  });
  it("a selector that picks only ordinary edges ignores the general chain", () => {
    const base = FIXTURES.slantCut(k);
    const out = run(base, "fillet", 1, { inPlane: "XY", at: 0 });
    expect(out.genus()).toBe(0);
    expect(out.volume()).toBeLessThan(base.volume());
  });
  it("a general run meeting a straight run at corners stays watertight", () => {
    const base = dRodSlant(k);
    let out;
    try { out = run(base, "fillet", 1); } catch (e) { expect(e.code).toBe("NEEDS_OCCT"); return; }
    expect(out.genus()).toBe(0);
    expect(out.volume()).toBeLessThan(base.volume());
  });
  it("print quality builds the fixtures watertight", async () => {
    const kp = await bootManifoldKernel({ quality: "print" });
    for (const [name, make] of Object.entries(FIXTURES)) expect(make(kp)._filletRaw(1).genus(), name).toBe(GENUS[name]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/mesh-fillet-general.test.js`
Expected: the fixture cases FAIL with `general chains not enabled` (the Task 2 guard, surfaced as `KernelCapabilityError`); the selector-only test PASSES.

- [ ] **Step 3: Give `profile2D` an optional fixed arc count**

In `profile2D`'s parameter list change `{ P, n1, n2, magnitude, mode, convex, segs, ext = 0 }` to `{ P, n1, n2, magnitude, mode, convex, segs, ext = 0, nArc: nArcFixed }`, and change the line

```js
  const nArc = Math.max(2, Math.ceil((span / (2 * Math.PI)) * segs));
```

to

```js
  // general chains pass a fixed count so every station's ring has the same size
  const nArc = nArcFixed ?? Math.max(2, Math.ceil((span / (2 * Math.PI)) * segs));
```

- [ ] **Step 4: Add `circumcentre` and `generalTool` after `prismTool`**

```js
// Centre of the circle through a, b, c (null when collinear).
function circumcentre(a, b, c) {
  const e1 = sub(b, a), e2 = sub(c, a), w = cross(e1, e2), ww = dot(w, w);
  if (ww < 1e-18) return null;
  const t = add(scl(cross(w, e1), dot(e2, e2)), scl(cross(e2, w), dot(e1, e1)));
  return add(a, scl(t, 1 / (2 * ww)));
}

// Flip to true in Task 5 once blend-surfaces.js knows the "spine" kind.
const SPINE_SHADING = false;

// General-chain tool: one ring per station (generalStations), each the shared
// profile2D section built from THAT station's flank normals in the plane
// perpendicular to the edge, meshed as a ring stack. Every ring carries the same arc
// count — the widest station's — so the stack stitches. Grazing guard per station:
// the arc continues past both tangents by the station's facet tilt (revolveTool's ext
// and clamp), and a chamfer is buried by the matching sagitta. A bend tighter than
// the section's reach toward its own centre would fold the stack: refuse it, which
// reroutes (the spec's policy) rather than emitting a self-intersecting tool.
function generalTool(k, chain, magnitude, mode, pSegs) {
  if (!k._ringStackSolid) throw new UnsupportedEdgeError("general chain: this kernel has no ring-stack builder");
  const { convex, closed } = chain;
  const st = generalStations(chain);
  let maxSpan = 0;
  for (const s of st) maxSpan = Math.max(maxSpan, Math.acos(clamp1(dot(s.n1, s.n2))));
  const nArc = Math.max(2, Math.ceil((maxSpan / (2 * Math.PI)) * pSegs));
  const rings = [], centres = [];
  for (const s of st) {
    const u = s.n1, v = cross(s.t, u);
    const p2 = (w) => [dot(w, u), dot(w, v)];
    const ext = mode === "fillet" ? Math.min(0.4, Math.max(0.01, s.tilt)) : 0;
    let poly = profile2D({ P: [0, 0], n1: p2(s.n1), n2: p2(s.n2), magnitude, mode, convex, segs: pSegs, ext, nArc });
    if (mode === "chamfer") {
      const sag = magnitude * (1 - Math.cos(s.tilt)) + Math.min(2e-4, 0.02 * magnitude);
      const [b1, b2] = p2(add(s.n1, s.n2)), bl = Math.hypot(b1, b2) || 1;
      poly = poly.map(([x, y], i) => (i === 0 && convex ? [x, y] : [x - (sag * b1) / bl, y - (sag * b2) / bl]));
    }
    rings.push(poly.map(([x, y]) => add(s.p, add(scl(u, x), scl(v, y)))));
    centres.push(add(s.p, ballOffset(s.n1, s.n2, magnitude, convex)));
  }
  const m = st.length;
  for (let i = 0; i < m; i++) {
    if (!closed && (i === 0 || i === m - 1)) continue;
    const a = st[(i - 1 + m) % m].p, b = st[i].p, c = st[(i + 1) % m].p;
    const O = circumcentre(a, b, c);
    if (!O) continue;
    const rho = len(sub(O, b)), beta = norm(sub(O, b));
    let reach = 0;
    for (const q of rings[i]) reach = Math.max(reach, dot(sub(q, b), beta));
    if (reach > 0.9 * rho)
      throw new UnsupportedEdgeError(`general chain: bend too tight for ${mode} ${magnitude} (local radius ${rho.toFixed(2)} mm)`);
  }
  if (!closed && convex) {
    // convex cutters overshoot open ends (prismTool's rule); concave fillers end flush
    const over = Math.max(1e-3, 0.05 * magnitude);
    const t0 = st[0].t, tN = st[m - 1].t;
    rings.unshift(rings[0].map((q) => sub(q, scl(t0, over))));
    rings.push(rings[rings.length - 1].map((q) => add(q, scl(tN, over))));
  }
  const tool = k._ringStackSolid(rings, { closed });
  return mode === "fillet" && SPINE_SHADING ? markBlend(k, tool, { kind: "spine", pts: centres, closed, r: magnitude }) : tool;
}
```

- [ ] **Step 5: Route general chains to the tool and remove the Task 2 guard**

In `apply()`, replace

```js
  const toolsFor = (ch) =>
    ch.kind === "planar"
      ? planarTool(k, ch, magnitude, mode, segs, pSegs, endTins, flankAt)
      : ch.kind === "arc"
        ? [revolveTool(k, ch, magnitude, mode, segs, pSegs, flankAt)]
        : [prismTool(k, ch, magnitude, mode, segs, pSegs)];
```

with

```js
  const toolsFor = (ch) =>
    ch.kind === "planar"
      ? planarTool(k, ch, magnitude, mode, segs, pSegs, endTins, flankAt)
      : ch.kind === "arc"
        ? [revolveTool(k, ch, magnitude, mode, segs, pSegs, flankAt)]
        : ch.kind === "general"
          ? [generalTool(k, ch, magnitude, mode, pSegs)]
          : [prismTool(k, ch, magnitude, mode, segs, pSegs)];
```

Delete the `TOOL_FOR_GENERAL` constant and the guard line added in Task 2 Step 7.

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run test/mesh-fillet-general.test.js`
Expected: PASS (all fixture cases plus the five named tests). If a volume misses tolerance, do not loosen it: compare `dV` with the reference and check, in order, (a) flank pairing direction on that fixture (a swapped pair turns a cutter into a filler — the sign of `dV` flips), (b) `nArc` consistency, (c) the end overshoot on an open chain.

- [ ] **Step 7: Run the whole mesh-fillet suite**

Run: `npx vitest run test/mesh-fillet test/filleted-box.test.js test/occt-fillet.test.js test/ring-stack-solid.test.js test/capability.test.js test/feature-skip-warnings.test.js $(ls test | grep -i round | sed 's#^#test/#')`
Expected: PASS, every pre-existing test unchanged. The roundAll files matter here: its prism fast path calls `_filletRaw` and treats a refusal as "use the reference Minkowski path", so a rim that used to refuse can now take the general tool. A roundAll test that changes result is a behaviour change to report, not a test to update.

- [ ] **Step 8: Commit**

```bash
git add src/framework/geometry/mesh-fillet.js test/mesh-fillet-general.test.js
git commit -m "mesh-fillet: blend general chains with per-vertex cross-section ring stacks"
```

---

### Task 5: Exact shading for general bands (`spine` descriptor)

**Files:**
- Modify: `src/framework/geometry/blend-surfaces.js` — header list, `mapSurface`, `surfaceNormal`, `segmentGrid`'s cell size
- Modify: `src/framework/geometry/mesh-fillet.js` — set `SPINE_SHADING = true` (then inline it away: delete the constant and the condition)
- Test: `test/mesh-fillet-general-shading.test.js`

**Interfaces:**
- Consumes: Task 4's `{ kind: "spine", pts, closed, r }` registration.
- Produces: `surfaceNormal({ kind: "spine", pts, closed, r }, x)` = unit direction from the nearest point on the spine polyline to `x`.

- [ ] **Step 1: Write the failing tests**

```js
// test/mesh-fillet-general-shading.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { surfaceNormal, mapSurface } from "../src/framework/geometry/blend-surfaces.js";
import { FIXTURES, GENUS } from "./fixtures/fillet-general-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const deg = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

describe("spine blend descriptor", () => {
  it("normal points from the nearest spine point, and survives mapping", () => {
    const d = { kind: "spine", pts: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: false, r: 1 };
    expect(deg(surfaceNormal(d, [5, 0, 2]), [0, 0, 1])).toBeLessThan(1e-9);
    expect(deg(surfaceNormal(d, [11, 5, 0]), [1, 0, 0])).toBeLessThan(1e-9);
    const moved = mapSurface(d, [1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 4, 5]); // translate by (3,4,5)
    expect(deg(surfaceNormal(moved, [8, 4, 7]), [0, 0, 1])).toBeLessThan(1e-9);
    expect(moved.r).toBeCloseTo(1, 12);
  });
  it("the tee's junction band shades with the analytic rolling-ball normal", () => {
    const r = 2, out = FIXTURES.tee(k)._filletRaw(r);
    const { positions, normals } = out.toMesh();
    // the ball touches tube (axis X, R=10) and boss (axis Z, R=5) from outside: its
    // centre lies at distance 10+r from X and 5+r from Z — sample that spine densely
    const spine = [];
    for (let i = 0; i < 7200; i++) {
      const ph = (2 * Math.PI * i) / 7200, x = (5 + r) * Math.cos(ph), y = (5 + r) * Math.sin(ph);
      spine.push([x, y, Math.sqrt((10 + r) ** 2 - y * y)]);
    }
    let checked = 0, worst = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const p = [positions[i], positions[i + 1], positions[i + 2]];
      const dTube = Math.hypot(p[1], p[2]), dBoss = Math.hypot(p[0], p[1]);
      // strictly inside the band: off both cylinders by more than 0.2 r, near the junction
      if (p[2] < 0 || dTube < 10 + 0.2 * r || dBoss < 5 + 0.2 * r || dTube > 10 + r || dBoss > 5 + r) continue;
      let best = Infinity, c = null;
      for (const s of spine) { const dd = (s[0] - p[0]) ** 2 + (s[1] - p[1]) ** 2 + (s[2] - p[2]) ** 2; if (dd < best) { best = dd; c = s; } }
      worst = Math.max(worst, deg([normals[i], normals[i + 1], normals[i + 2]], unit([p[0] - c[0], p[1] - c[1], p[2] - c[2]])));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(worst).toBeLessThan(2);
  });
  it("draws no stray lines across the tee's and cross hole's bands", () => {
    const r = 1;
    const bandLen = (out, inBand) => {
      const { edges } = out.toMesh();
      let L = 0;
      for (let i = 0; i + 5 < edges.length; i += 6) {
        const m = [(edges[i] + edges[i + 3]) / 2, (edges[i + 1] + edges[i + 4]) / 2, (edges[i + 2] + edges[i + 5]) / 2];
        if (inBand(m)) L += Math.hypot(edges[i + 3] - edges[i], edges[i + 4] - edges[i + 1], edges[i + 5] - edges[i + 2]);
      }
      return L;
    };
    const tee = bandLen(FIXTURES.tee(k)._filletRaw(r), (m) => {
      const dT = Math.hypot(m[1], m[2]), dB = Math.hypot(m[0], m[1]);
      return m[2] > 0 && dT > 10 + 0.1 * r && dB > 5 + 0.1 * r && dT < 10 + 0.9 * r && dB < 5 + 0.9 * r;
    });
    const hole = bandLen(FIXTURES.crossHole(k)._filletRaw(r), (m) => {
      const dT = Math.hypot(m[1], m[2]), dH = Math.hypot(m[0], m[1]);
      return dT < 10 - 0.1 * r && dT > 10 - 0.9 * r && dH > 3 + 0.1 * r && dH < 3 + 0.9 * r;
    });
    // a saddle junction is ~35 mm long; stray lines would run along it
    expect(tee).toBeLessThan(0.05 * 35);
    expect(hole).toBeLessThan(0.05 * 2 * 22);
  });
  it("a mirror after the fillet keeps finite normals and the genus", () => {
    const out = FIXTURES.tee(k)._filletRaw(1).mirror("YZ");
    expect(out.genus()).toBe(GENUS.tee);
    const { normals } = out.toMesh();
    expect(normals.every((x) => Number.isFinite(x))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/mesh-fillet-general-shading.test.js`
Expected: the descriptor test FAILS with `blend surface: unknown kind spine`; the analytic-normal test FAILS (`worst` well above 2° — facet-averaged normals); the others may pass.

- [ ] **Step 3: Implement the `spine` kind in `blend-surfaces.js`**

Add to the header's descriptor list:

```js
//   { kind: "spine", pts, closed, r }
//                                   general chain (mesh-fillet generalTool): the
//                                   ball-centre polyline itself; r is the radius
```

In `mapSurface`, before `default:`:

```js
    case "spine": {
      const s = Math.cbrt(Math.abs(
        M[0] * (M[4] * M[8] - M[5] * M[7]) - M[3] * (M[1] * M[8] - M[2] * M[7]) + M[6] * (M[1] * M[5] - M[2] * M[4])));
      return { kind: "spine", closed: desc.closed, pts: desc.pts.map((p) => applyPt(M, p)), r: desc.r * s };
    }
```

In `segmentGrid`, change the cell size line to include the spine radius:

```js
  const h = Math.max(total / Math.max(1, nSeg), Math.abs(desc.kf ?? 0) + Math.abs(desc.kd ?? 0) + (desc.r ?? 0), 1e-6);
```

In `surfaceNormal`, before the generic spine-point branch:

```js
  if (desc.kind === "spine") {
    const { bi, bt } = nearestSegment(desc, x);
    if (bi < 0) return null;
    const p = desc.pts[bi], q = desc.pts[(bi + 1) % desc.pts.length];
    const c = [p[0] + (q[0] - p[0]) * bt, p[1] + (q[1] - p[1]) * bt, p[2] + (q[2] - p[2]) * bt];
    return norm([x[0] - c[0], x[1] - c[1], x[2] - c[2]]);
  }
```

- [ ] **Step 4: Turn on registration in `mesh-fillet.js`**

Delete `const SPINE_SHADING = false;` and its comment, and change generalTool's last line to:

```js
  return mode === "fillet" ? markBlend(k, tool, { kind: "spine", pts: centres, closed, r: magnitude }) : tool;
```

- [ ] **Step 5: Run the shading tests**

Run: `npx vitest run test/mesh-fillet-general-shading.test.js`
Expected: PASS (4 tests). If the stray-line bound fails, inspect the drawn edges' dihedral signature as the band-line work did (>150° knife pairs = grazing residue → raise the station's `ext` floor; 50-130° pairs at cusps = real geometry) before touching the bound.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS, everything.

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/blend-surfaces.js src/framework/geometry/mesh-fillet.js test/mesh-fillet-general-shading.test.js
git commit -m "blend-surfaces: exact spine normals for general-chain fillet bands"
```

---

### Task 6: Census benchmark, docs, release

**Files:**
- Create: `scripts/bench-mesh-fillet-census.mjs`
- Modify: `src/framework/geometry/kernel.js` — Solid `fillet` / `chamfer` synopses (the `@property` lines)
- Modify: `docs/AUTHORING-PARTS.md` — the "contract v3 that **includes fillet and chamfer**" paragraph
- Modify: `docs/ERROR-PATTERNS.md` — `## mesh-fillet-unsupported-edge` Cause line
- Modify: `package.json`, `package-lock.json` — version 0.137.0

**Interfaces:**
- Consumes: everything above.
- Produces: `node scripts/bench-mesh-fillet-census.mjs <dir>` — `<dir>` holds one sub-directory per part tree (`part.js` entry + its files); prints per sub-part `OK <ms>` or `REROUTE <reason>`, then totals by reason.

- [ ] **Step 1: Write the benchmark script**

```js
// scripts/bench-mesh-fillet-census.mjs
// The 2026-10 fillet census as a repeatable measurement: for every part tree under
// <dir>, build each sub-part at default params on Manifold and fillet ALL its sharp
// edges at 0.5 mm with the throwing primitive, recording success or the refusal
// reason. Selector-free on purpose: it is an upper bound on what the mesh fillet
// refuses, not a model of what authors write. One child process per part (WASM state,
// runaway builds), killed after 240 s.
// Usage: node scripts/bench-mesh-fillet-census.mjs <dir>
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const R = 0.5;
if (process.argv[2] === "--one") {
  const dir = process.argv[3];
  const { resolveParams, buildPosed, viewSubParts } = await import("../src/framework/part-model.js");
  const { bootManifoldKernel } = await import("../src/testing/manifold.js");
  const { fontsFor } = await import("../src/framework/fonts.js");
  const part = (await import(pathToFileURL(resolve(dir, "part.js")))).default;
  const k = await bootManifoldKernel({ fonts: fontsFor(part, part.defaults ?? {}), imports: part.imports });
  const { p, d } = resolveParams(part, {});
  const names = new Set();
  for (const view of Object.keys(part.views)) for (const n of viewSubParts(part, view, p)) names.add(n);
  for (const name of names) {
    let line;
    try {
      const s = buildPosed(k, part, name, { purpose: "display", view: Object.keys(part.views)[0], p, d });
      const t0 = Date.now();
      try { s._filletRaw(R); line = `OK ${Date.now() - t0}`; }
      catch (e) { line = `REROUTE ${String(e?.message ?? e).replace(/[-\d.]+/g, "#").slice(0, 120)}`; }
    } catch (e) { line = `BUILD_ERROR ${String(e?.message ?? e).slice(0, 80)}`; }
    console.log(`${name}\t${line}`);
  }
  process.exit(0);
}

const root = process.argv[2];
if (!root) { console.error("usage: node scripts/bench-mesh-fillet-census.mjs <dir>"); process.exit(2); }
const totals = new Map();
for (const ent of readdirSync(root)) {
  const dir = join(root, ent);
  if (!existsSync(join(dir, "part.js"))) continue;
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "--one", dir], { encoding: "utf8", timeout: 240_000 });
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  if (r.error || r.status !== 0) lines.push(`(part)\tCRASH ${r.error?.code ?? r.status}`);
  for (const l of lines) {
    console.log(`${ent}\t${l}`);
    const kind = l.split("\t")[1]?.startsWith("OK") ? "OK" : l.split("\t")[1] ?? "?";
    totals.set(kind, (totals.get(kind) ?? 0) + 1);
  }
}
console.log("\n--- totals ---");
for (const [kind, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${kind}`);
```

- [ ] **Step 2: Run it against the 2026-10 census corpus (before/after)**

Run (the census trees live in the throwaway worktree; skip this step if it is gone and note that in the PR):
`node scripts/bench-mesh-fillet-census.mjs ../fillet-census/census-parts > /tmp/bench-after-public.txt; tail -15 /tmp/bench-after-public.txt`
Then the same from a checkout of `origin/main` into `/tmp/bench-before-public.txt`.
Expected: the `OK` count rises and no part that was `OK` before is `REROUTE`, `BUILD_ERROR` or `CRASH` after. Diff with `diff <(cut -f1,2,3 /tmp/bench-before-public.txt | grep -v '^---') <(cut -f1,2,3 /tmp/bench-after-public.txt | grep -v '^---') | grep '^>' | grep -v OK` — every line printed is a regression to investigate before release. Record the before/after totals for the PR description.

- [ ] **Step 3: Update the kernel synopses**

In `src/framework/geometry/kernel.js`, change the Solid `fillet` and `chamfer` `@property` synopses from `round edges; mesh-native for straight/circular chains with automatic OCCT fallback; …` / `bevel edges; mesh-native for straight/circular chains with automatic OCCT fallback; …` to `round edges; mesh-native incl. curved-face edges, OCCT fallback otherwise; …` / `bevel edges; mesh-native incl. curved-face edges, OCCT fallback otherwise; …`, keeping the rest of each line as is.

- [ ] **Step 4: Update the authoring docs**

In `docs/AUTHORING-PARTS.md`, in the paragraph beginning "contract v3 that **includes fillet and chamfer**", after "spline profiles all round natively now." insert: "Edges **between two curved faces** — a boss meeting a tube, a cross hole's rim, the ellipse where a plane cuts a cylinder — blend natively too (a per-vertex cross-section, since 0.137)." and change "(helical edges, varying dihedral)" to "(mixed convexity along one edge, a bend tighter than the fillet radius, knife edges)".

In `docs/ERROR-PATTERNS.md`, in `## mesh-fillet-unsupported-edge`, change the Cause's "covers straight and circular-arc sharp-edge chains; the selected edges fall outside that (helical edge, varying dihedral, non-circular curve, or nothing sharp matched)" to "covers straight, circular, planar-rim and curved-face sharp-edge chains; the selected edges fall outside that (an edge that flips between convex and concave, a bend tighter than the radius, a knife edge, or nothing sharp matched)".

- [ ] **Step 5: Bump the version**

Run: `npm version 0.137.0 --no-git-tag-version`
Expected: `package.json` and `package-lock.json` change to 0.137.0 only.

- [ ] **Step 6: Run the full suite and lint**

Run: `npx vitest run && npx eslint src scripts test`
Expected: PASS, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/bench-mesh-fillet-census.mjs src/framework/geometry/kernel.js docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md package.json package-lock.json
git commit -m "mesh-fillet general chains: census benchmark, docs, release 0.137.0"
```
