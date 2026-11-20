import { beforeAll, describe, expect, test } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/cage.js";
import { subdivide, levelFor } from "../src/framework/geometry/subdiv/surface.js";
import { meshSubdiv } from "../src/framework/geometry/subdiv/index.js";
import { bootManifoldKernel } from "../src/testing.js";

const box = (opts = {}) => createCage({ box: { size: [20, 20, 20], ...opts.box }, mirror: opts.mirror });
const boundsOf = (P) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], P[i + a]); max[a] = Math.max(max[a], P[i + a]); }
  return { min, max };
};
const volume = ({ positions: P, indices: I }) => {
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
};

describe("cage.crease", () => {
  test("a cage with no crease has no creases key", () => {
    expect("creases" in box().snapshot()).toBe(false);
  });
  test("marks the border of a face as sorted point pairs", () => {
    const c = box();
    c.crease("+z:0,0");
    const s = c.snapshot();
    expect(s.creases).toHaveLength(4);
    const top = new Set(s.faces[s.ids.indexOf("+z:0,0")]);
    for (const [a, b] of s.creases) { expect(a).toBeLessThan(b); expect(top.has(a) && top.has(b)).toBe(true); }
  });
  test("a region's inner edges are not creased", () => {
    const c = box({ box: { segs: [2, 1, 1] } });
    c.crease(["+z:0,0", "+z:1,0"]);
    expect(c.snapshot().creases).toHaveLength(6);
  });
  test("a mirrored cage creases both sides, and nothing on the plane", () => {
    const c = box({ box: { segs: [1, 2, 1] }, mirror: "xz" });
    c.crease("+z:0,1");   // touches the plane: joined with its reflection
    const s = c.snapshot();
    expect(s.creases).toHaveLength(6);
    for (const [a, b] of s.creases) expect(s.points[a][1] === 0 && s.points[b][1] === 0).toBe(false);
    const side = box({ box: { segs: [1, 2, 1] }, mirror: "xz" });
    side.crease("+y:0,0");
    expect(side.snapshot().creases).toHaveLength(8);
  });
  test("refuses a reflected id, an unknown face and the whole cage", () => {
    const m = box({ box: { segs: [1, 2, 1] }, mirror: "xz" });
    expect(() => m.crease("+z:0,1~")).toThrow(/reflected face/);
    expect(() => box().crease("+q:0,0")).toThrow(/no face/);
    const c = box();
    expect(() => c.crease(c.faces())).toThrow(/no border to crease/);
  });
  test("an extruded face leaves its crease at the base of the extrusion", () => {
    const c = box();
    c.crease("+z:0,0");
    c.extrude("+z:0,0", { by: 5, id: "top" });
    const s = c.snapshot();
    expect(s.creases).toHaveLength(4);
    for (const [a, b] of s.creases) { expect(s.points[a][2]).toBe(10); expect(s.points[b][2]).toBe(10); }
  });
});

describe("creased subdivision", () => {
  test("every edge creased gives the box itself", () => {
    const c = box();
    for (const id of c.faces()) c.crease(id);
    const mesh = subdivide(c.snapshot(), 3);
    const { min, max } = boundsOf(mesh.positions);
    for (let a = 0; a < 3; a++) { expect(min[a]).toBeCloseTo(-10, 9); expect(max[a]).toBeCloseTo(10, 9); }
    expect(volume(mesh)).toBeCloseTo(8000, 6);
    expect(mesh.regions).toBe(6);
    expect(levelFor(c.snapshot(), 0.05)).toMatchObject({ level: 1, met: true });
  });
  test("one creased face: its border stays on its plane and the rest is smooth", () => {
    const c = box();
    c.crease("+z:0,0");
    const smooth = subdivide(box().snapshot(), 3), creased = subdivide(c.snapshot(), 3);
    expect(creased.regions).toBe(2);
    // The top region is flat at z = 10: every one of its triangles lies on the plane.
    const P = creased.positions, I = creased.indices;
    const topRegion = creased.triRegion[creased.triFace.indexOf(c.snapshot().ids.indexOf("+z:0,0"))];
    let flat = 0;
    for (let t = 0; t < creased.triRegion.length; t++) {
      if (creased.triRegion[t] !== topRegion) continue;
      for (let k = 0; k < 3; k++) expect(P[3 * I[3 * t + k] + 2]).toBeCloseTo(10, 9);
      flat++;
    }
    expect(flat).toBe(2 * 4 ** 3);
    expect(volume(creased)).toBeGreaterThan(volume(smooth));
    expect(boundsOf(smooth.positions).max[2]).toBeLessThan(9);
  });
  test("an uncreased cage is unchanged and carries no regions", () => {
    const mesh = subdivide(box().snapshot(), 2);
    expect(mesh.triRegion).toBeUndefined();
  });
  test("a crease that is not an edge is refused", () => {
    const s = { ...box().snapshot(), creases: [[0, 0]] };
    expect(() => subdivide(s, 1)).toThrow(/is not an edge of the cage/);
  });
  test("meshSubdiv passes the regions through", () => {
    const c = box();
    c.crease("+z:0,0");
    const out = meshSubdiv(c.snapshot(), "preview");
    expect(out.regions).toBe(2);
    expect(out.triRegion).toHaveLength(out.indices.length / 3);
    expect(out.warnings).toEqual([]);
  });
});

describe("k.subdiv with creases", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel(); });
  test("each region is its own surface and shades as creased skin", () => {
    const c = k.cage({ box: { size: [20, 20, 20] } });
    c.crease("+z:0,0");
    const solid = k.subdiv(c);
    const runs = solid._runs();
    expect(new Set(runs.map((r) => r.id)).size).toBe(2);
    for (const r of runs) expect(k._shadingPolicy(r.id)).toMatchObject({ creaseAngle: 80, sameSurfaceLines: false });
    for (const r of runs) expect(k._shadingPolicy(r.id).organic).toBeUndefined();
    const mesh = solid.toMesh();
    expect(mesh.positions.length).toBeGreaterThan(0);
    // The crease draws feature lines; an uncreased body draws none.
    const plain = k.subdiv(k.cage({ box: { size: [20, 20, 20] } })).toMesh();
    expect((mesh.edges?.length ?? 0)).toBeGreaterThan(0);
    expect((plain.edges?.length ?? 0)).toBe(0);
  });
});
