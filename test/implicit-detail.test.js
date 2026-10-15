// test/implicit-detail.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail, detailHeight, midpointNormal } from "../src/framework/geometry/implicit/detail.js";
import { edgeCheck, eulerChar, volume } from "./helpers/mesh-topology.js";
import { pfCos } from "../src/framework/geometry/js-math.js";

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
});
