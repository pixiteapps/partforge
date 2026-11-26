// test/implicit-solid.test.js
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { validateSpec } from "../src/framework/geometry/implicit/grammar.js";
import { compileImplicit } from "../src/framework/geometry/implicit/compile.js";
import { buildMeshField } from "../src/framework/geometry/implicit/mesh-field.js";
import { hashableSpec, implicitShapeHash, implicitCallId } from "../src/framework/geometry/implicit/call-id.js";
import { implicitFrames } from "../src/framework/geometry/implicit/frame-report.js";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";

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
  test("offset over a solid moves its surface by d, both ways", () => {
    const box = k.box({ min: [-10, -6, -4], max: [10, 6, 4] });
    const off = (solid, d) => k.implicit({ resolution: 0.4, root: { kind: "offset", d, child: leaf(solid) } }).volume();
    // A shrunk box is exactly the smaller sharp box.
    expect(off(box, -2) / (16 * 8 * 4)).toBeCloseTo(1, 2);
    // A grown box is the box swept by a ball of radius r.
    const [a, b, c] = [20, 12, 8], r = 2;
    const grown = a * b * c + 2 * r * (a * b + b * c + c * a) + Math.PI * r * r * (a + b + c) + (4 / 3) * Math.PI * r ** 3;
    expect(off(box, 2) / grown).toBeCloseTo(1, 2);
    // The mesh sphere is faceted: within 1% of the exact balls.
    const ball = k.sphere(16), vol = (R) => (4 / 3) * Math.PI * R ** 3;
    expect(Math.abs(off(ball, 2) / vol(18) - 1)).toBeLessThan(0.01);
    expect(Math.abs(off(ball, -2) / vol(14) - 1)).toBeLessThan(0.01);
  });
  test("a leaf follows its frame, and works under mirror and repeat", () => {
    const peg = k.cylinder({ r: 3, h: 10 });
    const moved = k.implicit({ resolution: 0.4, frames: { f: { at: [20, 0, 0] } }, root: leaf(peg, { frame: "f" }) });
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
  test("one solid used twice takes one mesh slot", () => {
    const s = k.sphere(5);
    const c = compileImplicit({ root: { kind: "union", children: [leaf(s), leaf(s, { at: [8, 0, 0] })] } });
    expect(c.meshes.length).toBe(1);
    expect(c.textures.meshes).toBe(c.meshes);
  });
  test("two solids take two slots, in first-use order", () => {
    const a = k.sphere(4), b = k.box({ min: [-1, -1, -1], max: [1, 1, 1] });
    const c = compileImplicit({ root: { kind: "union", children: [leaf(b), leaf(a, { at: [9, 0, 0] }), leaf(b, { at: [-9, 0, 0] })] } });
    expect(c.meshes.length).toBe(2);
    expect(c.meshes[0].max).toEqual([1, 1, 1]);
    const slots = c.ir.nodes.filter((n) => n.kind === "mesh").map((n) => n.slot);
    expect(slots).toEqual([0, 1, 0]);
  });
  test("the leaf's box is the mesh's box, moved by its placement", () => {
    const b = k.box({ min: [-1, -2, -3], max: [4, 5, 6] });
    const c = compileImplicit({ root: leaf(b, { at: [10, 0, 0] }) });
    const n = c.ir.nodes[c.ir.root];
    expect(n).toMatchObject({ kind: "mesh", slot: 0, children: [], L: 1, thin: Infinity, G: 1 });
    expect(n.box).toEqual({ min: [9, -2, -3], max: [14, 5, 6] });
  });
  test("an empty or an open solid is a spec error at the node's path", () => {
    const empty = { _hash: "empty-test", toMesh: () => ({ positions: new Float32Array(0) }) };
    const issue = (spec) => { try { compileImplicit(spec); } catch (e) { expect(e.code).toBe("IMPLICIT_SPEC"); return e.issues; } return null; };
    expect(issue({ root: { kind: "union", children: [{ kind: "sphere", r: 1 }, leaf(empty)] } }))
      .toEqual(["root.children[1].solid: the solid is empty"]);
    const open = { _hash: "open-test", toMesh: () => ({ positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0) }) };
    const [msg] = issue({ root: leaf(open) });
    expect(msg).toMatch(/^root\.solid: the solid's mesh is not closed: 3 directed edges are not matched by its reverse \(the mesh is open or inconsistently wound\)$/);
  });
  test("meshFieldOf is called once per distinct solid", () => {
    const s = k.sphere(3), seen = [];
    const meshFieldOf = (solid) => { seen.push(solid._hash); return buildMeshField(solid.toMesh()); };
    compileImplicit({ root: { kind: "union", children: [leaf(s), leaf(s, { at: [5, 0, 0] })] } }, { meshFieldOf });
    expect(seen).toEqual([s._hash]);
  });
});

describe("solid leaf identity", () => {
  test("the same tree over different solids is two results; over the same solid, one", () => {
    const a = k.sphere(8), b = k.sphere(9);
    const build = (s) => k.implicit({ resolution: 0.6, root: { kind: "offset", d: 1, child: leaf(s) } });
    // The geometry cache serves a hit only inside a sub-part bracket (solid-cache.js).
    k.beginSubPart("identity");
    try {
      expect(build(a)).toBe(build(a));                                  // geometry-cache hit
      expect(build(a).volume()).not.toBeCloseTo(build(b).volume(), 0);
      expect(build(a)._hash).not.toBe(build(b)._hash);
    } finally { k.endSubPart(); }
  });
  test("the spec hash names a solid by its hash, not by its object", () => {
    const s = k.sphere(8);
    expect(hashableSpec({ root: leaf(s) })).toEqual({ root: { kind: "solid", solid: `solid:${s._hash}` } });
    // Deep in the tree, beside other nodes and frames; the input is not changed.
    const spec = { frames: { f: { at: [1, 0, 0] } }, root: { kind: "union", k: 2, children: [{ kind: "sphere", r: 3 }, leaf(s, { at: [4, 0, 0] })] } };
    const out = hashableSpec(spec);
    expect(out.root.children[1]).toEqual({ kind: "solid", solid: `solid:${s._hash}`, at: [4, 0, 0] });
    expect(out.root.children[0]).toBe(spec.root.children[0]);
    expect(out.frames).toBe(spec.frames);
    expect(spec.root.children[1].solid).toBe(s);
  });
  test("a spec with no solid leaf is returned as it is", () => {
    const spec = { frames: { f: { at: [1, 0, 0] } }, root: { kind: "union", children: [{ kind: "sphere", r: 3 }, { kind: "box", size: [1, 2, 3] }] } };
    expect(hashableSpec(spec)).toBe(spec);
  });
  test("a solid without a _hash (a probe stub) hashes as solid:? and does not throw", () => {
    expect(hashableSpec({ root: leaf({}) })).toEqual({ root: { kind: "solid", solid: "solid:?" } });
    expect(hashableSpec({ root: { kind: "solid" } })).toEqual({ root: { kind: "solid", solid: "solid:?" } });
    expect(() => implicitShapeHash({ root: leaf({}) })).not.toThrow();
  });
  test("the call id's shape hash counts every solid as the same, so the ordinal tells two calls apart", () => {
    const a = k.sphere(8), b = k.sphere(9);
    const spec = (s) => ({ frames: { f: { at: [0, 0, 0] } }, root: leaf(s) });
    expect(hashableSpec(spec(a), { identity: false }).root).toEqual({ kind: "solid", solid: "solid" });
    expect(hashableSpec({ root: { kind: "solid" } }, { identity: false })).toEqual({ root: { kind: "solid", solid: "solid" } });
    expect(implicitShapeHash(spec(a))).toBe(implicitShapeHash(spec(b)));
    expect(implicitShapeHash(spec(a))).toBe(implicitShapeHash(spec({})));   // a probe stub, too
    expect(implicitCallId(spec(b), [spec(a)])).toBe(`${implicitShapeHash(spec(a))}#1`);
    // The geometry-cache form still names each solid.
    expect(hashableSpec(spec(a)).root.solid).not.toBe(hashableSpec(spec(b)).root.solid);
  });
  test("k.implicitFrames builds a solid leaf's field at most once across two calls", () => {
    const real = k.sphere(7.123);   // a solid no other test builds, so its field is not cached yet
    let meshes = 0;
    const counted = Object.create(real, { toMesh: { value: () => { meshes++; return real.toMesh(); } } });
    const spec = { frames: { tip: { at: [0, 0, 7] } }, root: { kind: "offset", d: 1, child: leaf(counted), label: "ball" } };
    const r1 = k.implicitFrames(spec).report(), r2 = k.implicitFrames(spec).report();
    expect(r2).toEqual(r1);
    expect(r1.frames.tip.origin).toEqual([0, 0, 7]);
    expect(meshes).toBe(1);
  });
  test("implicitFrames takes a meshFieldOf option and lowers through it", () => {
    const s = k.sphere(5), seen = [];
    const meshFieldOf = (solid) => { seen.push(solid._hash); return buildMeshField(solid.toMesh()); };
    implicitFrames({ root: leaf(s, { label: "s" }) }, { meshFieldOf });
    expect(seen).toEqual([s._hash]);
  });
});

describe("solid leaf call ids: the pose probe and the worker agree", () => {
  // Two framed calls that differ only in the solid they blend: one shape hash, ordinals #0, #1.
  const spec = (solid, bend) => ({
    frames: { arm: { at: [0, 0, 0] }, tip: { parent: "arm", at: [0, 0, 20], rotate: [{ axis: [1, 0, 0], deg: bend }] } },
    root: { kind: "union", k: 2, children: [
      { kind: "capsule", a: [0, 0, 0], b: [0, 0, 20], r: 3, frame: "arm" },
      { kind: "sphere", r: 3, frame: "tip" },
      { kind: "solid", solid, at: [0, 0, -4] },
    ] },
  });
  const build = (kk, bend) => kk.union([
    kk.implicit({ preview: 1, ...spec(kk.box({ min: [-5, -5, -5], max: [5, 5, 0] }), bend) }),
    kk.implicit({ preview: 1, ...spec(kk.box({ min: [-6, -6, -6], max: [6, 6, 0] }), bend) }).translate([40, 0, 0]),
  ]);
  test("the probe's call ids are the ids the worker names its bound frames by", async () => {
    const probe = probeSubPartPose({ build: (kk) => build(kk, 30) }, { view: "v", p: {}, d: {} });
    expect(probe.implicitSpecs).toHaveLength(2);
    const probeIds = probe.implicitSpecs.map((s, i) => implicitCallId(s, probe.implicitSpecs.slice(0, i)));
    expect(probeIds[0].endsWith("#0") && probeIds[1].endsWith("#1")).toBe(true);
    expect(probeIds[0].split("#")[0]).toBe(probeIds[1].split("#")[0]);

    const kp = await bootManifoldKernel({ quality: "preview" });
    kp.beginSubPart("t");
    let m;
    try { m = build(kp, 30).toMesh(); } finally { kp.endSubPart(); }
    const workerIds = new Set(m.bindings.frames.filter(Boolean).map((f) => f.slice(0, f.lastIndexOf(":"))));
    expect([...workerIds].sort()).toEqual([...probeIds].sort());
    expect(m.bindings.frames).toEqual(expect.arrayContaining(probeIds.flatMap((id) => [`${id}:arm`, `${id}:tip`])));
    // The solid leaf's own vertices (below z = -1, inside the first box) are bound: the solid
    // has no frame of its own, so bindVertices gives each the nearest unit's frame ("arm").
    let low = 0;
    for (let c = 0; c < m.triangles * 3; c++) {
      const x = m.positions[3 * c], z = m.positions[3 * c + 2];
      if (x < 20 && z < -2) {
        low++;
        expect(m.bindings.frames[m.bindings.frameA[c]]).toBe(`${probeIds[0]}:arm`);
      }
    }
    expect(low).toBeGreaterThan(0);
  });
});

test("compileImplicit refuses a meshFieldOf that gives no field: only lint lowers a probe solid", () => {
  const solid = { _hash: "p", toMesh: () => ({ positions: new Float32Array(0) }) };
  expect(() => compileImplicit({ root: leaf(solid) }, { meshFieldOf: () => null }))
    .toThrow("implicit: a solid leaf has no mesh field (only lint's probe lowers one without)");
});
