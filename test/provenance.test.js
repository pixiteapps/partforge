import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { createProvenance, provenanceKernel } from "../src/framework/geometry/provenance.js";
import { newReadSink, orderedReads, recorder } from "../src/framework/read-recorder.js";
let k; beforeAll(async () => { k = await bootManifoldKernel(); });

function buildWith(build, params) {
  const sink = newReadSink({ log: true });
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

test("a label after a translate, a rotate or a scale keeps the records (label replays onto the canonical base)", () => {
  const box = (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.h] });
  const t = buildWith((k, p) => box(k, p).translate([p.x, 0, 0]).label("Body"), { w: 10, h: 4, x: 7 });
  expect(keysAt(t, faceWithNormal(t, [0, 0, 1]))).toEqual(["x", "h", "w"]);
  for (const a of [0, 30, 37.3]) {
    const r = buildWith((k, p) => box(k, p).rotate(p.a, [0, 0, 0], [0, 0, 1]).label("Body"), { w: 10, h: 4, a });
    expect(keysAt(r, faceWithNormal(r, [0, 0, 1]))).toEqual(["a", "h", "w"]);
  }
  const s = buildWith((k, p) => box(k, p).scale(p.s, [0, 0, 0]).label("Body"), { w: 10, h: 4, s: 1.3 });
  expect(keysAt(s, faceWithNormal(s, [0, 0, 1]))).toEqual(["s", "h", "w"]);
  // label THEN translate: the translate's read comes first, as for any transform.
  const lt = buildWith((k, p) => box(k, p).label("Body").translate([p.x, 0, 0]), { w: 10, h: 4, x: 7 });
  expect(keysAt(lt, faceWithNormal(lt, [0, 0, 1]))).toEqual(["x", "h", "w"]);
});

test("a spread of the params records nothing; a label keeps the records; no provenance means no fields", () => {
  const m = buildWith((k, p) => { const q = { ...p }; return k.box({ min: [0, 0, 0], max: [q.w, q.w, q.w] }); }, { w: 5 });
  expect(m.originIds).toBeUndefined();
  const l = buildWith((k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] }).label("Body"), { w: 5 });
  expect(keysAt(l, 0)).toEqual(["w"]);
  expect(k.box({ min: [0, 0, 0], max: [1, 1, 1] }).toMesh().originIds).toBeUndefined();
});

const wallWithNormal = (m, n, inside) => { for (let t = 0; t < m.triangles; t++) { const d = m.normals[t*9]*n[0] + m.normals[t*9+1]*n[1] + m.normals[t*9+2]*n[2]; if (Math.abs(d) > 0.99 && inside(m.positions.subarray(t*9, t*9+3))) return t; } throw new Error("no wall"); };

test("a Solid extruded from a Shape2D carries the profile's and the extrude's reads", () => {
  const m = buildWith((k, p) => k.shape2d([[0, 0], [p.r, 0], [p.r, p.r], [0, p.r]]).extrude({ h: p.h }), { r: 5, h: 3 });
  expect(keysAt(m, faceWithNormal(m, [1, 0, 0]))).toEqual(["h", "r"]);
});

test("a cut by a translated extrude: the wall carries translate + extrude + profile reads; the box keeps its own", () => {
  const m = buildWith((k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] })
    .cut(k.shape2d([[0, 8], [p.r, 8], [p.r, 12], [0, 12]]).extrude({ h: p.h }).translate([p.x, 0, -5])), { w: 20, r: 4, h: 30, x: 8 });
  const wall = wallWithNormal(m, [0, 1, 0], ([, y]) => y > 7.9 && y < 12.1);
  expect(keysAt(m, wall)).toEqual(["x", "h", "r"]);
  expect(keysAt(m, faceWithNormal(m, [0, 0, 1]))).toEqual(["w"]);
});

test("a tool that misses the body adds no origins entry", () => {
  const m = buildWith((k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, p.w] })
    .cut(k.cylinder({ r: p.r, h: 5 }).translate([100, 0, 0])), { w: 10, r: 2 });
  expect(m.origins).toEqual([["w"]]);
});

test("originsFor skips a run that has no triangles", () => {
  const log = [];
  const prov = createProvenance({ log, expand: (e) => orderedReads(e) });
  const solid = (id) => ({ _runs: () => [{ id, mat: null }] });
  log.push("a"); prov.boundary("box", null, [], () => solid(7));
  log.push("b"); prov.boundary("box", null, [], () => solid(8));
  const g = { triVerts: new Uint32Array(6), runIndex: [0, 0, 6], runOriginalID: [7, 8], runTransform: [] };
  const o = prov.originsFor(g);
  expect(o.origins).toEqual([["b"]]);
  expect(Array.from(o.originIds)).toEqual([1, 1]);
  expect(prov.origins).toEqual([["b"]]);
});
