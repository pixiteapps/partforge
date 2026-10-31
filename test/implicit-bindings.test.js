// test/implicit-bindings.test.js
// Pose bindings (bindings.js): each preview vertex's frames and weight, which the viewer's
// skinning deform reads while a pose slider drags (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md §1).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setCoreEnabled } from "../src/framework/core/core.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { bindVertices, BIND_BAND_CELLS, MAX_BIND_FRAMES } from "../src/framework/geometry/implicit/bindings.js";
import { TWO_BONE, TWIST_FRAMES } from "./fixtures/skin-fixtures.js";

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

  test("a frame root below a warp or repeat does not start a unit: the subtree binds to the warp's frame", () => {
    const s = build(TWIST_FRAMES);
    const r = bind(s);
    let bound = 0;
    for (let v = 0; v < r.frameA.length; v++) {
      if (r.frameA[v] === 0) continue;
      bound++;
      expect(r.frameA[v]).toBe(1);
      expect(r.frameB[v]).toBe(0);
    }
    expect(bound).toBe(r.frameA.length);
  });

  test("a spec with more frames than MAX_BIND_FRAMES binds nothing", () => {
    const frames = {};
    for (let i = 0; i <= MAX_BIND_FRAMES; i++) frames[`f${i}`] = { at: [0, 0, 0] };
    const s = build({ frames, root: { kind: "sphere", frame: "f0", r: 5 }, preview: 1 });
    const r = bind(s);
    expect(r.frameA.every((x) => x === 0)).toBe(true);
  });
});
