# Implicit `solid` and `offset` nodes (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `k.implicit` tree accepts any solid as a leaf (`solid`) and moves any surface in or out by a signed distance (`offset`), with the same bytes on the JS engine and the native core.

**Architecture:** `offset` lowers to the existing `ADDC` op, so it needs no engine work beyond grammar and lowering. `solid` adds one leaf kind, a per-spec table of mesh fields (beside the texture table), and one new program op, `MESH`, that reads a signed mesh distance. The distance is the oracle BVH's nearest point, signed by an angle-weighted pseudonormal.

**Tech Stack:** JavaScript (ES modules, Node 24), vitest, C++ compiled by Emscripten (`em++` is at `/opt/homebrew/bin/em++`), Manifold backend.

**Spec:** `docs/superpowers/specs/2026-11-25-implicit-solid-node-design.md`. This plan covers the design's phase 1 only. Phase 2 (exact unchanged faces) and phase 3 (recipes, reference part, cloud prompt) get their own plans.

## Global Constraints

- **Bit-identical, core on and off.** Every new numeric routine uses only `+ − × ÷`, `Math.sqrt`, `hypot3`, comparisons and `pfAtan2`/`pfSin`/`pfCos` from `src/framework/geometry/js-math.js`. No `Math.acos`, `Math.atan2`, `Math.hypot`. The C++ port does the same operations in the same order.
- **No byte or hash change for any spec without a `solid` or `offset` node.** The pinned implicit hashes and `test/core-parity.test.js` stay as they are. A `round` spec emits the same program bytes as before.
- **Program format grows by exactly one opcode:** `MESH: 26`, layout `[MESH, dst, p, slot]` (4 words). No existing opcode value changes.
- **Part code never passes a function into a spec.** The spike's `field` leaf, `OP.FIELD` (30), `textures.fields` and the core bypass in `meshImplicitCore` are all removed by the end of Task 3.
- **Manifold only.** `k.implicit` is mesh-native. Nothing here touches the OCCT backend.
- **Agent-facing names:** added `solid`, `offset`; `round` leaves the docs and stays accepted.
- **Docs are Simplified Technical English:** short sentences, active voice, no dashes as punctuation.
- **The version bump rides with the PR** (`package.json`, minor bump).
- **The spike is the starting state.** The worktree holds uncommitted spike edits in `core/implicit-core.js` and `geometry/implicit/{grammar,interval,ir,program,reference}.js`, plus `spike/solid-field/`. Task 1 starts by reverting those six files (`git checkout -- <files>`). `spike/solid-field/` stays until Task 7 as a reference and is deleted there.

## Review Focus

1. **A solid whose mesh has duplicate positions for one corner** (every Manifold soup). The pseudonormal tables must key on position, not on vertex index, or every edge reads as a boundary and the sign is wrong near edges. Test in Task 2.
2. **A point exactly on the surface, on an edge, or at a vertex.** Distance 0 must return 0 (not `-0`, not `NaN`), on both engines. Test in Task 2 and Task 5.
3. **Two calls with the same tree and different solids.** They must not share a geometry cache entry or a sample-cache leaf. Test in Task 4.
4. **A shrink deeper than the body** (`offset` with a large negative `d`). It must raise the existing "the shape is empty" error, not hang or return an empty solid. Test in Task 1.
5. **A solid leaf under a frame, a `mirror` and a `repeat`.** Placement is by the node's inverse transform, so the leaf must read the transformed point. Test in Task 3.

---

### Task 1: The signed `offset` node

**Files:**
- Modify: `src/framework/geometry/implicit/grammar.js` (TYPES, NODE_KINDS)
- Modify: `src/framework/geometry/implicit/ir.js` (the `round` case, around line 205)
- Modify: `src/framework/geometry/implicit/frame-report.js:14` (`DISTORTING`)
- Test: `test/implicit-grammar.test.js`, `test/implicit-ir.test.js`, `test/implicit-engine.test.js`

**Interfaces:**
- Produces: node `{ kind: "offset", child, d }`, `d` a finite non-zero number. It lowers to the IR node `{ kind: "round", r: d, … }`, which the interval pass, the reference evaluator and the emitter already handle for any sign.

- [ ] **Step 1: Revert the spike's engine edits**

Run: `git checkout -- src/framework/core/implicit-core.js src/framework/geometry/implicit/grammar.js src/framework/geometry/implicit/interval.js src/framework/geometry/implicit/ir.js src/framework/geometry/implicit/program.js src/framework/geometry/implicit/reference.js && git status --short`
Expected: only `?? spike/solid-field/` and the two docs remain.

- [ ] **Step 2: Write the failing tests**

```js
// test/implicit-grammar.test.js
test("offset takes a child and a signed, non-zero d", () => {
  const ok = (d) => validateSpec({ root: { kind: "offset", d, child: { kind: "sphere", r: 5 } } });
  expect(() => ok(2)).not.toThrow();
  expect(() => ok(-2)).not.toThrow();
  expect(() => ok(0)).toThrow(/root\.d: must be a finite number other than 0/);
  expect(() => validateSpec({ root: { kind: "offset", d: 1 } })).toThrow(/root\.child: required/);
});

// test/implicit-ir.test.js
test("offset lowers to the round node; a grow pads the box, a shrink keeps it", () => {
  const box = (d) => { const c = lowerSpec({ root: { kind: "offset", d, child: { kind: "sphere", r: 5 } } }); return c.bounds; };
  expect(box(2).max).toEqual([7, 7, 7]);
  expect(box(-2).max).toEqual([5, 5, 5]);
});
test("round and offset(d = r) emit the same program", () => {
  const prog = (root) => { const c = lowerSpec({ root }); return Array.from(emitProgram(c, fullDecision(c))); };
  const child = { kind: "box", size: [10, 8, 6] };
  expect(prog({ kind: "offset", d: 1.5, child })).toEqual(prog({ kind: "round", r: 1.5, child }));
});

// test/implicit-engine.test.js
// Add this helper at the top of the file: volumeOf(spec, edge) = k.implicit({ ...spec, resolution: edge }).volume(),
// on a print-tier kernel booted in beforeAll (bootManifoldKernel({ quality: "print" })).
test("offset moves a sphere's surface in and out by d", () => {
  const sphere = (r) => (4 / 3) * Math.PI * r ** 3;
  const v = (d) => volumeOf({ root: { kind: "offset", d, child: { kind: "sphere", r: 10 } } }, 0.4);
  expect(v(2) / sphere(12)).toBeCloseTo(1, 2);
  expect(v(-2) / sphere(8)).toBeCloseTo(1, 2);
});
test("a shrink deeper than the body is the empty-shape error", async () => {
  const k = await bootManifoldKernel({ quality: "print" });
  expect(() => k.implicit({ root: { kind: "offset", d: -6, child: { kind: "sphere", r: 5 } } })).toThrow(/the shape is empty/);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run test/implicit-grammar.test.js test/implicit-ir.test.js test/implicit-engine.test.js`
Expected: FAIL with `unknown kind "offset"`.

- [ ] **Step 4: Implement**

- `grammar.js`: add `TYPES.nonzero` (`"must be a finite number other than 0"`), and `offset: { req: { child: "child", d: "nonzero" } }` to `NODE_KINDS`, placed before `round`.
- `ir.js`: make the `round` case serve both kinds. With `d = node.kind === "offset" ? node.d : node.r`: emit `{ kind: "round", r: d, … }`, box `boxPad(child.box, Math.max(0, d) / G)`, thin `Math.max(0, child.thin + 2 * d)`.
- `frame-report.js`: no change needed (the IR kind is still `"round"`); confirm with a test that `k.implicitFrames` accepts an `offset` spec.

- [ ] **Step 5: Run the tests, then the whole implicit suite**

Run: `npx vitest run test/implicit-*.test.js test/core-parity.test.js`
Expected: PASS, with no pinned hash changed.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/implicit test/implicit-grammar.test.js test/implicit-ir.test.js test/implicit-engine.test.js
git commit -m "implicit: a signed offset node, with round as its alias"
```

---

### Task 2: The mesh field (signed mesh distance, JS)

**Files:**
- Create: `src/framework/geometry/implicit/mesh-field.js`
- Test: `test/implicit-mesh-field.test.js`

**Interfaces:**
- Consumes: `buildBVH(mesh)` and its `closestPoint(p)` → `{ point, dist, tri }` from `src/framework/oracle/bvh.js`; `hypot3`, `pfAtan2` from `../js-math.js`.
- Produces:
  - `buildMeshField(mesh) → MeshField`, where `mesh` is `{ positions, indices? }` (a Manifold soup or an indexed mesh) and `MeshField = { bvh, tris, normals: Float64Array /* 3 per face, 3 per edge (3 edges per tri), 3 per corner: 21 per tri */, min: [x,y,z], max: [x,y,z], digest: string }`.
  - `meshDistance(field, x, y, z) → number`: negative inside, `0` on the surface.
  - `MeshFieldError` (`code: "IMPLICIT_SPEC"`-compatible message text): thrown for an empty mesh or an edge that is not shared by exactly two triangles (an open mesh).

**Approach.** Take `tri` from `closestPoint`. Classify the nearest point on THAT triangle into one of seven regions (face, edge AB/BC/CA, corner A/B/C) with the same branch order as `closestOnTri` in `bvh.js`. Read the region's precomputed pseudonormal `n` from `normals` and return `dist` with the sign of `(p − q) · n` (positive is outside). Pseudonormals: a face's is its unit normal; an edge's is the sum of its two faces' unit normals; a corner's is the sum over every triangle at that position of that triangle's unit normal times its corner angle (computed with `pfAtan2(|u × v|, u · v)`). Edges and corners are matched across triangles by exact position (a `Map` keyed on the coordinates' bits), because a Manifold soup repeats positions. `digest` is an FNV-1a hash over the position bytes, as a base-36 string.

- [ ] **Step 1: Write the failing tests**

```js
// test/implicit-mesh-field.test.js
import { describe, expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { buildMeshField, meshDistance } from "../src/framework/geometry/implicit/mesh-field.js";

let k; beforeAll(async () => { k = await bootManifoldKernel({ quality: "print" }); });
const fieldOf = (s) => buildMeshField(s.toMesh());

describe("meshDistance", () => {
  test("a box: the exact box distance, at faces, edges and corners", () => {
    const f = fieldOf(k.box({ min: [-10, -5, -2], max: [10, 5, 2] }));
    expect(meshDistance(f, 0, 0, 0)).toBeCloseTo(-2, 12);        // inside, nearest face
    expect(meshDistance(f, 0, 0, 5)).toBeCloseTo(3, 12);         // above a face
    expect(meshDistance(f, 13, 9, 0)).toBeCloseTo(5, 12);        // off an edge (3, 4)
    expect(meshDistance(f, 12, 7, 3)).toBeCloseTo(3, 12);        // off a corner (2, 2, 1)
    expect(meshDistance(f, 9.5, 4.5, 1.5)).toBeCloseTo(-0.5, 12); // inside, near a corner
  });
  test("zero on the surface: on a face, an edge and a corner", () => {
    const f = fieldOf(k.box({ min: [-10, -5, -2], max: [10, 5, 2] }));
    for (const p of [[0, 0, 2], [10, 5, 0], [10, 5, 2]]) expect(Object.is(meshDistance(f, ...p), 0)).toBe(true);
  });
  test("a concave L: the sign is right in the notch", () => {
    const L = k.box({ min: [0, 0, 0], max: [20, 20, 10] }).cut(k.box({ min: [10, 10, -1], max: [21, 21, 11] }));
    const f = fieldOf(L);
    expect(meshDistance(f, 12, 12, 5)).toBeCloseTo(Math.hypot(2, 2), 12);   // in the notch: outside
    expect(meshDistance(f, 8, 8, 5)).toBeCloseTo(-2, 12);                    // inside, near the notch edge
  });
  test("a sphere: within the chord error of |p| − r, and never the wrong sign", () => {
    const f = fieldOf(k.sphere(10));
    for (let i = 0; i < 400; i++) {
      const a = i * 2.399963, t = -1 + (2 * i + 1) / 400, s = Math.sqrt(1 - t * t), r = 4 + (i % 13);
      const d = meshDistance(f, r * s * Math.cos(a), r * s * Math.sin(a), r * t);
      expect(Math.abs(d - (r - 10))).toBeLessThan(0.15);
      if (Math.abs(r - 10) > 0.2) expect(Math.sign(d)).toBe(Math.sign(r - 10));
    }
  });
  test("1-Lipschitz between nearby points", () => {
    const f = fieldOf(k.cylinder({ r: 6, h: 20 }));
    for (let i = 0; i < 200; i++) {
      const p = [(i % 7) - 3, ((i * 3) % 11) - 5, ((i * 5) % 23) - 11], q = [p[0] + 0.3, p[1] - 0.2, p[2] + 0.1];
      expect(Math.abs(meshDistance(f, ...p) - meshDistance(f, ...q))).toBeLessThanOrEqual(Math.hypot(0.3, 0.2, 0.1) + 1e-9);
    }
  });
  test("bounds and digest", () => {
    const a = fieldOf(k.box({ min: [-1, -2, -3], max: [4, 5, 6] }));
    expect([a.min, a.max]).toEqual([[-1, -2, -3], [4, 5, 6]]);
    expect(a.digest).toBe(fieldOf(k.box({ min: [-1, -2, -3], max: [4, 5, 6] })).digest);
    expect(a.digest).not.toBe(fieldOf(k.box({ min: [-1, -2, -3], max: [4, 5, 7] })).digest);
  });
  test("an empty mesh and an open mesh are refused", () => {
    expect(() => buildMeshField({ positions: new Float32Array(0) })).toThrow(/empty/);
    expect(() => buildMeshField({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) })).toThrow(/not closed/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/implicit-mesh-field.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `buildMeshField` and `meshDistance`** as described under Approach.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/implicit-mesh-field.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/mesh-field.js test/implicit-mesh-field.test.js
git commit -m "implicit: signed mesh distance by angle-weighted pseudonormals"
```

---

### Task 3: The `solid` leaf on the JS engine

**Files:**
- Modify: `src/framework/geometry/implicit/grammar.js`, `ir.js`, `reference.js`, `interval.js`, `program.js`, `compile.js`
- Modify: `src/framework/core/implicit-core.js` (`meshImplicitCore`: return `null` while `compiled.meshes.length > 0`; Task 5 removes this line)
- Modify: `src/framework/geometry/manifold-backend.js` (the `implicit:` op, around line 1228) and `src/framework/geometry/implicit/distance.js`
- Test: `test/implicit-solid.test.js` (new), `test/implicit-program.test.js`, `test/implicit-grammar.test.js`

**Interfaces:**
- Consumes: `buildMeshField`, `meshDistance` (Task 2).
- Produces:
  - Node `{ kind: "solid", solid }` with the common fields. `TYPES.solidRef` accepts a value with a string `_hash` and a `toMesh` function; its message is `"must be a solid (the result of a kernel op)"`.
  - `compileImplicit(spec, { images, meshFieldOf })`, where `meshFieldOf(solid) → MeshField`. Default: `(s) => buildMeshField(s.toMesh())`. The backend passes one that memoizes per `solid._hash` in a kernel-owned `Map` capped at 32 entries.
  - `compiled.meshes: MeshField[]`, in first-use order; one slot per distinct `_hash`.
  - IR leaf `{ kind: "mesh", slot, children: [], L: 1 }`, box = the field's `min`/`max`, `thin: Infinity`, `G: 1`.
  - `OP.MESH = 26`, layout `[MESH, dst, p, slot]`. `runProgram(prog, textures, X, Y, Z, n, out, cap, off)` keeps its signature: the mesh table rides as `textures.meshes` (set in `lowerSpec`, like the texture list it sits beside). `programOps` counts a `MESH` op as `1 + ceil(log2(tris))` instructions.

- [ ] **Step 1: Write the failing tests**

```js
// test/implicit-solid.test.js
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { validateSpec } from "../src/framework/geometry/implicit/grammar.js";

let k; beforeAll(async () => { k = await bootManifoldKernel({ quality: "print" }); });
const leaf = (solid, extra = {}) => ({ kind: "solid", solid, ...extra });

describe("solid leaf", () => {
  test("grammar: a solid is required, and it must be a solid", () => {
    expect(() => validateSpec({ root: { kind: "solid" } })).toThrow(/root\.solid: required/);
    expect(() => validateSpec({ root: { kind: "solid", solid: {} } })).toThrow(/root\.solid: must be a solid/);
  });
  test("a lone leaf reproduces the solid's volume", () => {
    const box = k.box({ min: [-10, -6, -4], max: [10, 6, 4] });
    const v = k.implicit({ resolution: 0.4, root: leaf(box) }).volume();
    expect(v / box.volume()).toBeCloseTo(1, 2);
  });
  test("a blended union lies between the plain union and the plain union grown by k/4", () => {
    const A = k.box({ min: [-30, -20, 0], max: [30, 20, 6] }), B = k.cylinder({ r: 8, h: 26 }).at([0, 0, 4]);
    const plain = A.union(B).volume();
    const soft = k.implicit({ resolution: 0.5, root: { kind: "union", k: 8, children: [leaf(A), leaf(B)] } }).volume();
    expect(soft).toBeGreaterThan(plain);
    expect(soft).toBeLessThan(plain * 1.08);   // the spike measured +4.4%
  });
  test("offset over a solid matches Solid.offset by volume, both ways", () => {
    const body = k.sphere(16).union(k.box({ min: [-8, -8, -22], max: [8, 8, 0] }));
    for (const d of [2, -2]) {
      const v = k.implicit({ resolution: 0.5, root: { kind: "offset", d, child: leaf(body) } }).volume();
      expect(v / body.offset(d).volume()).toBeCloseTo(1, 2);
    }
  });
  test("a leaf follows its frame, and works under mirror and repeat", () => {
    const peg = k.cylinder({ r: 3, h: 10 });
    const moved = k.implicit({ resolution: 0.4, frames: { f: { at: [20, 0, 0] } }, root: leaf(peg, { frame: "f" }) });
    // Read the x extent from the mesh: min and max of moved.toMesh().positions over every third value.
    const xs = moved.toMesh().positions.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(17, 1); expect(Math.max(...xs)).toBeCloseTo(23, 1);
    const pair = k.implicit({ resolution: 0.4, root: { kind: "mirror", child: leaf(peg, { at: [10, 0, 0] }) } });
    expect(pair.volume() / (2 * peg.volume())).toBeCloseTo(1, 1);
    const row = k.implicit({ resolution: 0.4, root: { kind: "repeat", linear: { step: [12, 0, 0], count: 3 }, child: leaf(peg) } });
    expect(row.volume() / (3 * peg.volume())).toBeCloseTo(1, 1);
  });
  test("a cage body and an implicit body are both valid leaves", () => {
    const cage = k.cage({ box: { size: [30, 20, 20], segs: [2, 1, 1] } });
    const body = k.subdiv(cage), ball = k.implicit({ root: { kind: "sphere", r: 8 } });
    expect(() => k.implicit({ resolution: 0.6, root: { kind: "union", k: 4, children: [leaf(body), leaf(ball, { at: [18, 0, 0] })] } })).not.toThrow();
  });
  test("one solid used twice takes one mesh slot", async () => {
    const { compileImplicit } = await import("../src/framework/geometry/implicit/compile.js");
    const s = k.sphere(5);
    const c = compileImplicit({ root: { kind: "union", children: [leaf(s), leaf(s, { at: [8, 0, 0] })] } });
    expect(c.meshes.length).toBe(1);
  });
});

// test/implicit-program.test.js
test("the opcode table is pinned, with MESH = 26", () => {
  expect(OP).toEqual({ END: 0, XFORM: 1, XDIR: 2, PRIM: 3, UNION: 4, INTER: 5, NEG: 6, MIN2: 7, MIRRORP: 8, ADDC: 9, ONION: 10, WARP: 11, DISP: 12, SANITIZE: 13, CONTACT: 14, BULGE: 15, GET: 20, CONST: 21, UN: 22, BIN: 23, TER: 24, TEX: 25, MESH: 26 });
});
test("the batch interpreter and the reference evaluator agree on a solid leaf, to the bit", () => {
  // compile union(k: 3) of a box solid leaf and a sphere; evaluate 500 fixed points with
  // evalBatch(emitProgram(c, fullDecision(c)), c.textures, …) and with reference.js's evaluator
  // (the helper this file already uses for the other ops); expect every pair Object.is-equal.
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/implicit-solid.test.js test/implicit-program.test.js test/implicit-grammar.test.js`
Expected: FAIL with `unknown kind "solid"`.

- [ ] **Step 3: Implement**

- `grammar.js`: `TYPES.solidRef`; `solid: { req: { solid: "solidRef" } }`.
- `ir.js`: `lowerSpec(spec, { images, meshFieldOf })`; a `meshes` array and a `Map` from `_hash` to slot; `textures.meshes = meshes`; the `solid` case as in Interfaces; return `meshes` on the compiled object. `buildMeshField`'s refusal becomes an `ImplicitSpecError` with the node's path: `` `${path}.solid: the solid is empty` `` or `` `${path}.solid: the solid's mesh is not closed` ``.
- `reference.js`, `interval.js`: `case "mesh"` calls `meshDistance(c.meshes[n.slot], x, y, z)`; the interval is `v ± n.L * r`.
- `program.js`: `OP.MESH`, the emit case, the `runProgram` case, and the `programOps` weight (it needs the triangle count: `programOps(prog, meshes)`; update its one caller in `preview-edge.js`).
- `compile.js`, `distance.js`: pass `meshFieldOf` through.
- `manifold-backend.js`: the memoizing `meshFieldOf`, passed to `compileImplicit`.
- `implicit-core.js`: the temporary `if (compiled.meshes?.length) return null;`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/implicit-*.test.js test/core-parity.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm no spike leaf remains**

Run: `grep -rn "FIELD\|textures.fields\|kind: \"field\"" src/`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "implicit: a solid as a leaf (JS engine)"
```

---

### Task 4: Identity (cache keys and the sample cache)

**Files:**
- Modify: `src/framework/geometry/implicit/index.js` (`implicitHashable`), `call-id.js` (`stripFrames` / `implicitShapeHash`), `sparse.js` (the leaf key, around line 186)
- Test: `test/implicit-solid.test.js`, `test/implicit-sample-cache.test.js` (or the file that holds the sample-cache tests today; find it with `grep -ln createSampleCache test/`)

**Interfaces:**
- Consumes: `compiled.meshes[i].digest` (Task 2), `solid._hash`.
- Produces:
  - `hashableSpec(spec) → spec'`: a deep copy in which every `solid` field of a `solid` node is replaced by the string `"solid:" + solid._hash`. Exported from `call-id.js`. `implicitHashable` and `implicitShapeHash` both go through it.
  - The sample cache's program identity becomes `{ prog, tex: [...digests], mesh: [...digests] }`. The `mesh` key is omitted when the plan has no meshes, so every existing key keeps its bytes.

- [ ] **Step 1: Write the failing tests**

```js
// test/implicit-solid.test.js
test("the same tree over different solids is two results; over the same solid, one", () => {
  const a = k.sphere(8), b = k.sphere(9);
  const build = (s) => k.implicit({ resolution: 0.6, root: { kind: "offset", d: 1, child: leaf(s) } });
  expect(build(a)).toBe(build(a));                                  // geometry-cache hit
  expect(build(a).volume()).not.toBeCloseTo(build(b).volume(), 0);
});
test("the spec hash names a solid by its hash, not by its object", () => {
  const s = k.sphere(8);
  expect(hashableSpec({ root: leaf(s) })).toEqual({ root: { kind: "solid", solid: `solid:${s._hash}` } });
});

// the sample-cache test file
test("a preview sample cache does not serve one solid's samples for another", async () => {
  const kp = await bootManifoldKernel({ quality: "preview" });
  const spec = (s) => ({ preview: 1, root: { kind: "union", k: 2, children: [{ kind: "solid", solid: s }, { kind: "sphere", r: 4, at: [9, 0, 0] }] } });
  const v1 = kp.implicit(spec(kp.box({ min: [-6, -6, -6], max: [6, 6, 6] }))).volume();
  const v2 = kp.implicit(spec(kp.box({ min: [-6, -6, -6], max: [6, 6, 9] }))).volume();
  expect(v2).toBeGreaterThan(v1 * 1.1);
});
test("a plan with no meshes keeps its leaf-key bytes", () => { /* the existing pinned key in this file still matches */ });
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/implicit-solid.test.js`
Expected: FAIL (`hashableSpec` is not exported; the cache test may pass or fail by accident, since `canon` walks the solid object).

- [ ] **Step 3: Implement** `hashableSpec`, route both hash sites through it, and add the `mesh` digests to the leaf key.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/implicit-*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "implicit: a solid leaf's identity in cache keys and the sample cache"
```

---

### Task 5: The native core

**Files:**
- Modify: `native/implicit_eval.h`, `native/implicit_eval.cpp` (the `Op` enum at line 48, both op walkers, the lane interpreter, the session)
- Modify: `native/bvh.h`, `native/bvh.cpp` only if `bvh_closest_point` cannot be called from `implicit_eval.cpp` as it is
- Modify: `scripts/build-core-wasm.mjs` (the export list), `src/framework/core/implicit-core.js` (`NativeSession.addMesh`, `meshImplicitCore`), `src/framework/core/core-full-wasm.js` (generated)
- Modify: `native/README.md` (one table row)
- Test: `test/implicit-native-eval.test.js`, `test/core-parity.test.js`

**Interfaces:**
- Consumes: the `MESH` op and `MeshField` layout from Tasks 2 and 3.
- Produces:
  - C: `int ip_mesh_field_add(int id, const double* verts9, int tris, const double* normals21)` → the slot, or `-1` on refusal. The session builds its own BVH over `verts9` with the existing native build.
  - JS: `NativeSession.addMesh(field) → slot`, called in plan order after the textures, as `addTexture` is. A wrong slot number throws the existing refusal.
  - `MESH` in C++ runs the same steps as `meshDistance`: `bvh_closest_point`, the seven-region classification in the same branch order, the pseudonormal read from `normals21`, the sign, and `0` for a zero distance.
  - `meshImplicitCore` no longer returns `null` for a spec with meshes.

- [ ] **Step 1: Write the failing tests**

```js
// test/implicit-native-eval.test.js
test("MESH: the core and the JS interpreter agree to the bit on 2,000 points", () => {
  // compile union(k: 3) of solid(box 20×10×4) and solid(cylinder r 6, h 20, at [8, 0, 0]);
  // points on a fixed lattice that includes points ON faces, edges and corners;
  // session.addMesh for each compiled.meshes entry, addProgram, eval; compare with evalBatch by Object.is.
});
test("MESH with a slot the session lacks is a refusal, not a fault", () => { /* expect the CORE_REFUSED code */ });

// test/core-parity.test.js  — add to the fixture list the suite already loops over
// (core on and off, SIMD and scalar): "solid join" (plate + boss, union k: 8, edge 0.6, print and preview)
// and "solid shrink" (offset d: -2 over the blob, edge 0.6). Expect identical positions and indices.
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/implicit-native-eval.test.js`
Expected: FAIL (`addMesh` is not a function).

- [ ] **Step 3: Implement the C++ op and the session call, then rebuild**

Run: `node scripts/build-core-wasm.mjs`
Expected: it rewrites `src/framework/core/core-full-wasm.js` and prints the em++ version.

- [ ] **Step 4: Implement `NativeSession.addMesh`, call it in `meshImplicitCore`, and delete the Task 3 bypass line.**

- [ ] **Step 5: Run the native and parity suites**

Run: `npx vitest run test/implicit-native-*.test.js test/core-parity.test.js`
Expected: PASS, including every fixture that existed before.

- [ ] **Step 6: Record the timings**

Add the two parity fixtures to `scripts/bench-implicit.mjs` and run `node scripts/bench-implicit.mjs --core both`. Put the numbers in the PR description and in the design doc's "Cost" section, replacing "must be measured". If the preview-tier plate and boss join is over 300 ms with the core on, say so in the PR; do not tune in this task.

- [ ] **Step 7: Commit**

```bash
git add native scripts src test docs/superpowers/specs/2026-11-25-implicit-solid-node-design.md
git commit -m "implicit: the MESH op in the native core"
```

---

### Task 6: Lint, the probe, and kernel-free validation

**Files:**
- Modify: `src/framework/domains/organic/lint.js` (`implicitCalls`, around line 41, and each rule that reads `c.compiled`)
- Modify: `src/framework/geometry/kernel.js` only if the probe's solid lacks `_hash` (find the probe kernel with `grep -rn "implicitFrames" src/framework/geometry/kernel.js src/framework/lint`)
- Modify: `src/framework/domains/organic/manifest.js` (if it lists node kinds for the docs)
- Test: `test/organic-lint.test.js`, `test/organic-domain.test.js`

**Interfaces:**
- Consumes: `compileImplicit`'s `meshFieldOf` option (Task 3).
- Produces: lint compiles a recorded spec with `meshFieldOf: () => null`. A `null` field lowers to a `mesh` leaf with an unbounded-safe placeholder: box = `[[-1e3, -1e3, -1e3], [1e3, 1e3, 1e3]]` (the probe has no geometry to bound), and the compiled object gets `hasProbeMesh: true`. Every lint rule that evaluates the field or predicts cost returns no finding when `hasProbeMesh` is set. `validateImplicit` (kernel-free) accepts a `solid` node with any solid-shaped value.

- [ ] **Step 1: Write the failing tests**

```js
// test/organic-lint.test.js
test("a part whose implicit tree has a solid leaf lints clean", () => {
  const part = partWith((k) => k.implicit({ root: { kind: "union", k: 4, children: [
    { kind: "solid", solid: k.box({ min: [-10, -10, 0], max: [10, 10, 4] }) }, { kind: "sphere", r: 6, at: [0, 0, 6] }] } }));
  // lintPart is synchronous; `of(findings, rule)` is this file's filter helper.
  expect(lintPart(part).filter((f) => String(f.rule ?? f.id).startsWith("implicit"))).toEqual([]);
});
test("a solid leaf with a non-solid still reports the spec error through lint", () => {
  const part = partWith((k) => k.implicit({ root: { kind: "solid", solid: 5 } }));
  expect(of(lintPart(part), "implicit-spec-invalid").map((f) => f.message).join("\n")).toMatch(/root\.solid: must be a solid/);
});

// test/organic-domain.test.js
test("IMPLICIT_NODE_KINDS lists solid and offset", () => {
  expect(IMPLICIT_NODE_KINDS).toEqual(expect.arrayContaining(["solid", "offset", "round"]));
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/organic-lint.test.js test/organic-domain.test.js`
Expected: FAIL (the probe solid has no mesh, so lowering throws).

- [ ] **Step 3: Implement** the `null`-field path in `ir.js` and the `hasProbeMesh` guards in `lint.js`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/organic-*.test.js test/implicit-*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "organic lint: a solid leaf in the geometry-free probe"
```

---

### Task 7: Docs, types, version, and removing the spike

**Files:**
- Modify: `docs/domains/organic.md` (node table, "Blends and contact", "When a cage, and when an implicit tree", "Gotchas")
- Modify: `docs/KERNEL-CONTRACT.md` (the implicit entry, near line 854), `docs/ERROR-PATTERNS.md` (the two new spec errors)
- Modify: `types/organic.d.ts` or `types/kernel.d.ts` (wherever the node union lives; `grep -n "onion" types/*.d.ts`)
- Modify: `package.json` (minor version bump)
- Delete: `spike/solid-field/`
- Test: `test/organic-docs.test.js`

**Interfaces:**
- Produces: the guide text below. Every code block in the guide is run by `test/organic-docs.test.js`, so the examples must build.

- [ ] **Step 1: Write the failing docs test**

```js
// test/organic-docs.test.js
test("the node table documents solid and offset, and no longer documents round", () => {
  // Add this helper: nodeTableKinds(md) = the first-column code names of the table under "## Node reference".
  const table = nodeTableKinds(guide);
  expect(table).toEqual(expect.arrayContaining(["solid", "offset"]));
  expect(table).not.toContain("round");
});
test("the guide no longer says a cage and a tree cannot join smoothly", () => {
  expect(guide).not.toMatch(/Do not plan on a smooth join between a cage and a tree/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/organic-docs.test.js`
Expected: FAIL.

- [ ] **Step 3: Edit the guide**

- Node table: add
  `| \`solid\` | \`solid\` | | A solid you already built: an ordinary solid, a \`k.subdiv\` body, an import, or another \`k.implicit\` result. Its distance is exact. It is read once, at the call. |`
  and
  `| \`offset\` | \`child\`, \`d\` | | The child's surface moved by \`d\` mm: out for \`d > 0\`, in for \`d < 0\`. Exact over a \`solid\`, a sphere, a capsule or a box; a bound over a blend, an ellipsoid or a warp. |`
  and delete the `round` row. Under the table add one line: "`round` (`{ child, r }`) is an older name for `offset` with `d = r`. It still builds."
- Replace the third bullet of "When a cage, and when an implicit tree" with: "To join a cage body to anything else with a smooth blend, put both in one tree as `solid` leaves under a `union` with `k`. The result is one mesh at the grid, so sharp edges of an ordinary solid soften to the grid. Keep the grid fine where that matters." Add a tested example (the cage body on a post, from the spike's `b-cage-field` case).
- "Gotchas": replace the `round` sentence with the `offset` one; add "A `solid` leaf is remeshed at the grid with the rest of the tree."
- Add a short "Offsets and shells of any solid" recipe with the `body.cut(k.implicit({ root: { kind: "offset", d: -2, child: … } }))` example.

- [ ] **Step 4: Types, contract, error patterns, version, spike removal.** Then run `npm run docs:domains`.

- [ ] **Step 5: Run everything**

Run: `npm test && npx eslint . && npx knip`
Expected: PASS, no unused export.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "organic: document the solid and offset nodes; bump the version"
```
