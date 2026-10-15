// test/implicit-detail.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail, detailHeight, midpointNormal, flattenDetail, DETAIL_STRIDE } from "../src/framework/geometry/implicit/detail.js";
import { edgeCheck, eulerChar, volume } from "./helpers/mesh-topology.js";
import { pfCos } from "../src/framework/geometry/js-math.js";
import { evalExprScalar } from "../src/framework/geometry/implicit/expr-lower.js";
import { sampleTexture } from "../src/framework/geometry/implicit/textures.js";
import { OP } from "../src/framework/geometry/implicit/program.js";

const build = (spec, images = new Map(), edge = 1) => {
  const c = lowerSpec(spec, { images }), s = sampleField(c, edge);
  return { c, s, m: cleanupMesh(s, meshStore(s)) };
};

describe("surface detail", () => {
  test("creases height matches the formula", () => {
    const { c } = build({ root: { kind: "sphere", r: 5 }, detail: [{ kind: "creases", amplitude: 0.4, wavelength: 2, axis: "x" }] });
    const h = detailHeight(c.detail[0], c.textures, 0.3, 0, 5, 0, 0, 1);
    expect(h).toBe(-0.4 * Math.max(0, pfCos((2 * Math.PI * 0.3) / 2)));
  });
  test("radius and side limit where detail applies", () => {
    const { c } = build({ root: { kind: "sphere", r: 5 }, detail: [{ kind: "noise", amplitude: 1, wavelength: 1, radius: 2, side: [0, 0, 1] }] });
    expect(detailHeight(c.detail[0], c.textures, 3, 0, 0, 0, 0, 1)).toBe(0);    // outside radius
    expect(detailHeight(c.detail[0], c.textures, 0.5, 0, 0, 0, 0, -1)).toBe(0); // facing away
  });
  test("refines only where detail applies, stays closed, keeps topology", () => {
    const { c, s, m } = build({ root: { kind: "box", size: [20, 20, 6], round: 2 },
      detail: [{ kind: "creases", amplitude: 0.3, wavelength: 1.2, axis: "x", at: [0, 0, 3], radius: 4, side: [0, 0, 1] }] });
    const out = applySurfaceDetail(s, m, c);
    expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(eulerChar(out.positions, out.indices)).toBe(2);
    expect(volume(out.positions, out.indices)).toBeGreaterThan(0);
    expect(out.indices.length).toBeGreaterThan(m.indices.length);
    expect(out.indices.length).toBeLessThan(m.indices.length * 4);   // local, not global
    let minZ = Infinity;
    for (let v = 0; v < out.positions.length / 3; v++) {
      const x = out.positions[3 * v], y = out.positions[3 * v + 1], z = out.positions[3 * v + 2];
      if (Math.hypot(x, y) < 1 && z > 2) minZ = Math.min(minZ, z);
    }
    expect(minZ).toBeLessThan(2.85);   // grooves cut into the top face at z = 3
  });
  test("texture detail embosses where the image is white", () => {
    const data = new Uint16Array(4 * 4).fill(65535);
    const images = new Map([["w", { digest: "w1", width: 4, height: 4, data }]]);
    const { c, s, m } = build({ root: { kind: "box", size: [10, 10, 4] },
      detail: [{ kind: "texture", image: "w", amplitude: 0.5, size: [10, 10], side: [0, 0, 1] }] }, images);
    const out = applySurfaceDetail(s, m, c);
    let maxZ = -Infinity;
    for (let v = 0; v < out.positions.length / 3; v++) maxZ = Math.max(maxZ, out.positions[3 * v + 2]);
    expect(maxZ).toBeGreaterThan(2.4);
    expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
  });
  test("a midpoint left without a normal takes its endpoints' normalized average", () => {
    const N = [0, 0, 1, 1, 0, 0, 0, 0, 0];
    midpointNormal(N, 0, 1, 2);
    expect(N.slice(6)).toEqual([1 / Math.sqrt(2), 0, 1 / Math.sqrt(2)]);
    const Z = [0, 0, 1, 0, 0, -1, 0, 0, 0];
    midpointNormal(Z, 0, 1, 2);
    expect(Z.slice(6)).toEqual([0, 0, 0]);   // opposite endpoints: stays zero
    const K = [0, 0, 1, 1, 0, 0, 0, 1, 0];
    midpointNormal(K, 0, 1, 2);
    expect(K.slice(6)).toEqual([0, 1, 0]);   // a projected normal is kept
  });
  test("a vertex with a zero normal is not displaced (triplanar would read 0/0)", () => {
    const data = new Uint16Array(4 * 4).fill(65535);
    const images = new Map([["w", { digest: "w1", width: 4, height: 4, data }]]);
    const { c, s, m } = build({ root: { kind: "box", size: [10, 10, 4] },
      detail: [{ kind: "texture", image: "w", amplitude: 0.5, size: [10, 10], projection: "triplanar" }] }, images);
    const normals = Float64Array.from(m.normals);
    normals[0] = normals[1] = normals[2] = 0;
    const out = applySurfaceDetail(s, { ...m, normals }, c);
    expect(Array.from(out.positions.subarray(0, 3))).toEqual(Array.from(m.positions.subarray(0, 3)));
    expect(out.positions.every(Number.isFinite)).toBe(true);
  });
  test("flattenDetail: 28 doubles per entry in the documented layout, expr heights as standalone programs", () => {
    const data = new Uint16Array(4 * 4).fill(65535);
    const images = new Map([["w", { digest: "w1", width: 4, height: 4, data }]]);
    const c = lowerSpec({ root: { kind: "sphere", r: 5 }, detail: [
      { kind: "creases", amplitude: 0.4, wavelength: 2, axis: "x", at: [1, 2, 3], radius: 2, side: [0, 0, 1] },
      { kind: "texture", image: "w", amplitude: 0.5, size: [10, 8], projection: "cylindrical", axis: "y" },
      { kind: "expr", height: "return 0.1 * sin(p.x);" },
    ] }, { images });
    const { entries: F, programs } = flattenDetail(c);
    expect(DETAIL_STRIDE).toBe(28);
    expect(F.length).toBe(3 * 28);
    const row = (k) => Array.from(F.subarray(28 * k, 28 * k + 28));
    expect(row(0)).toEqual([1, 1, ...c.detail[0].inv, 2, 1, 0, 0, 1, 0.4, 2, 0, -1, 0, 0, 0, 2 / 3, -1]);
    expect(row(1)).toEqual([3, 0, ...new Array(12).fill(0), -1, 0, 0, 0, 0, 0.5, -1, 1, 0, 1, 10, 8, c.detail[1].target, -1]);
    expect(row(2)).toEqual([4, 0, ...new Array(12).fill(0), -1, 0, 0, 0, 0, 0, -1, 2, -1, 0, 0, 0, Infinity, 0]);
    expect(programs.length).toBe(1);
    const prog = programs[0];
    expect(prog[0]).toBe(1);
    expect(prog[prog.length - 2]).toBe(OP.END);
    expect(Array.from(prog)).not.toContain(OP.SANITIZE);
  });
  test("expr heights run as a program and equal the scalar interpreter; NaN reads as 0", () => {
    const c = lowerSpec({ root: { kind: "sphere", r: 5 }, detail: [
      { kind: "expr", height: "return 0.1 * sin(p.x * 3.0) * cos(p.y) + 0.02 * p.z;", radius: 4, at: [0, 0, 4] },
      { kind: "expr", height: "return sqrt(-1.0 - p.x * p.x);" },
    ] }, { images: new Map() });
    for (const [x, y, z] of [[0.3, -0.2, 4.9], [1.1, 0.7, 4.5], [-2, 1.5, 3.9]]) {
      const lx = x, ly = y, lz = z - 4, f = 1 - (lx * lx + ly * ly + lz * lz) / 16;
      expect(detailHeight(c.detail[0], c.textures, x, y, z, 0, 0, 1)).toBe(evalExprScalar(c.detail[0].height, lx, ly, lz, c.textures, sampleTexture) * (f * f));
      expect(detailHeight(c.detail[1], c.textures, x, y, z, 0, 0, 1)).toBe(0);
    }
  });
});
