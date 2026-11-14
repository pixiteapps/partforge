// test/implicit-bindings.test.js
// Pose bindings (bindings.js): each preview vertex's frames and weight, which the viewer's
// skinning deform reads while a pose slider drags (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md §1).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setCoreEnabled } from "../src/framework/core/core.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { bindVertices, BIND_BAND_CELLS, MAX_BIND_FRAMES } from "../src/framework/geometry/implicit/bindings.js";
import { TWO_BONE, TWIST_FRAMES, REPEAT_FRAMES, MIRROR_FRAMES, NESTED_FINGER } from "./fixtures/skin-fixtures.js";

beforeAll(() => setCoreEnabled(false));
afterAll(() => setCoreEnabled(true));

const build = (spec, edge = 1) => {
  const c = compileImplicit(spec);
  return { c, mesh: meshImplicit(c, edge, { tier: "preview" }), edge };
};
const bind = ({ c, mesh, edge }) => bindVertices(c, mesh.positions, edge);
const buf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

describe("bindVertices", () => {
  const twoBone = build(TWO_BONE(0));
  const b = bind(twoBone);
  const P = twoBone.mesh.positions;

  test("the constants", () => {
    expect(BIND_BAND_CELLS).toBe(3);
    expect(MAX_BIND_FRAMES).toBe(1023);
  });

  test("vertices far from the joint bind wholly to their own bone", () => {
    let low = 0, high = 0;
    for (let v = 0; v < P.length / 3; v++) {
      const y = P[v * 3 + 1];
      if (y < 12) { low++; expect([b.frameA[v], b.frameB[v], b.weight[v]]).toEqual([1, 0, 1]); }
      if (y > 28) { high++; expect([b.frameA[v], b.frameB[v], b.weight[v]]).toEqual([2, 0, 1]); }
    }
    expect(low).toBeGreaterThan(50);
    expect(high).toBeGreaterThan(50);
  });

  test("vertices near the joint blend both bones with a weight in [0.5, 1]", () => {
    let nearBlend = 0, blended = 0;
    for (let v = 0; v < P.length / 3; v++) {
      if (b.frameB[v] === 0) continue;
      blended++;
      expect(b.frameA[v]).not.toBe(b.frameB[v]);
      expect(b.weight[v]).toBeGreaterThanOrEqual(0.5);
      expect(b.weight[v]).toBeLessThanOrEqual(1);
      if (Math.abs(P[v * 3 + 1] - 20) < 3) nearBlend++;
    }
    expect(nearBlend).toBeGreaterThan(0);
    expect(blended).toBeGreaterThan(0);
  });

  test("a spec with no frames binds nothing", () => {
    const s = build({ root: { kind: "sphere", r: 5 }, preview: 1 });
    const r = bind(s);
    const n = s.mesh.positions.length / 3;
    expect(n).toBeGreaterThan(0);
    expect(r.frameA.every((x) => x === 0)).toBe(true);
    expect(r.frameB.every((x) => x === 0)).toBe(true);
    expect(r.weight.length).toBe(n);
  });

  test("bindings are sized to the mesh and deterministic", () => {
    const n = P.length / 3;
    expect(b.frameA).toBeInstanceOf(Uint16Array);
    expect(b.frameB).toBeInstanceOf(Uint16Array);
    expect(b.weight).toBeInstanceOf(Float32Array);
    expect([b.frameA.length, b.frameB.length, b.weight.length]).toEqual([n, n, n]);
    const again = bind(twoBone);
    expect(buf(again.frameA).equals(buf(b.frameA))).toBe(true);
    expect(buf(again.frameB).equals(buf(b.frameB))).toBe(true);
    expect(buf(again.weight).equals(buf(b.weight))).toBe(true);
  });

  test.each([["twist", TWIST_FRAMES], ["repeat", REPEAT_FRAMES], ["mirror", MIRROR_FRAMES]])(
    "a frame root below a %s does not start a unit: the subtree binds to the outer node's frame", (_, spec) => {
      const s = build(spec);
      const r = bind(s);
      expect(r.frameA.length).toBeGreaterThan(0);
      for (let v = 0; v < r.frameA.length; v++) {
        expect(r.frameA[v]).toBe(1);
        expect(r.frameB[v]).toBe(0);
        expect(r.weight[v]).toBe(1);
      }
    });

  test("the blend weight is 0.5 + (d_B − d_A) / (2·band), from the bones' own distances", () => {
    // TWO_BONE(0): capsules (0,0,0)–(0,20,0) and (0,20,0)–(0,40,0), r 4. Band 3·edge = 3.
    const capsule = (x, y, z, y0, y1) => Math.hypot(x, y - Math.min(y1, Math.max(y0, y)), z) - 4;
    const band = BIND_BAND_CELLS * twoBone.edge;
    let checked = 0, nearHalf = 0;
    for (let v = 0; v < P.length / 3; v++) {
      if (b.frameB[v] === 0) continue;
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      const d = [capsule(x, y, z, 0, 20), capsule(x, y, z, 20, 40)];
      const dA = d[b.frameA[v] - 1], dB = d[b.frameB[v] - 1];
      expect(dA).toBeLessThanOrEqual(dB + 1e-9);
      const want = Math.min(1, Math.max(0.5, 0.5 + (dB - dA) / (2 * band)));
      expect(b.weight[v]).toBeCloseTo(want, 5);
      if (Math.abs(y - 20) < 0.05) { nearHalf++; expect(b.weight[v]).toBeLessThan(0.51); }
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    expect(nearHalf).toBeGreaterThan(0);
  });

  test.each([0, 2])("a nested unit binds its own vertices, not 50/50 with the unit around it (blend k %s)", (k) => {
    const s = build(NESTED_FINGER(k));
    const r = bind(s);
    expect(s.c.frameNames).toEqual(["finger", "tip"]);
    const Q = s.mesh.positions;
    let tip = 0, finger = 0;
    for (let v = 0; v < r.frameA.length; v++) {
      const y = Q[v * 3 + 1];
      if (y >= 30) { tip++; expect([r.frameA[v], r.frameB[v], r.weight[v]]).toEqual([2, 0, 1]); }   // ≥ 10 mm into the tip
      if (y <= 12) { finger++; expect(r.frameA[v]).toBe(1); }
    }
    expect(tip).toBeGreaterThan(20);
    expect(finger).toBeGreaterThan(20);
  });

  test("a unit with no geometry of its own (its only kid is a unit) binds nothing itself", () => {
    const s = build({
      frames: { outer: { at: [0, 0, 0] }, inner: { parent: "outer", at: [0, 5, 0] } },
      root: { kind: "round", r: 0.5, frame: "outer", child: { kind: "capsule", frame: "inner", b: [0, 10, 0], r: 3 } },
      preview: 1,
    });
    const r = bind(s);
    expect(r.frameA.length).toBeGreaterThan(0);
    for (let v = 0; v < r.frameA.length; v++) expect([r.frameA[v], r.frameB[v], r.weight[v]]).toEqual([2, 0, 1]);
  });

  test("a spec with more frames than MAX_BIND_FRAMES binds nothing", () => {
    const frames = {};
    for (let i = 0; i <= MAX_BIND_FRAMES; i++) frames[`f${i}`] = { at: [0, 0, 0] };
    const s = build({ frames, root: { kind: "sphere", frame: "f0", r: 5 }, preview: 1 });
    const r = bind(s);
    expect(r.frameA.every((x) => x === 0)).toBe(true);
  });
});
