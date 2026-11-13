// The parity inside test (insideShared, behind world.inside, insideOf and world.depth) when its
// ray runs along an edge line of the mesh it tests against. A ray along a facet's edge is
// coplanar with that facet (no hit) and meets the faces at either end exactly on an edge or a
// corner, where whether rayTri counts it is down to rounding: one end can count and the other
// not, and an odd count read as inside. A hit on an edge or a corner is a graze now, and the
// next direction decides.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { buildBVH, insideShared } from "../src/framework/oracle/bvh.js";
import { buildView } from "../src/framework/oracle/build.js";
import { runSweeps } from "../src/framework/oracle/sweep.js";
import { createCollisionWorld } from "../src/framework/collide/world.js";
import { coaxialKnuckles } from "./fixtures/hinge-coaxial-knuckles.js";

const SLOW = 120_000;
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const meshesOf = (part, params = { open: 0 }) => buildView(k, part, "assembly", params);

// A stand-in index: one triangle, and a raycast that answers per direction (a cast that
// skips the triangle finds nothing, as a real index's would).
function fakeIndex(tri, answer) {
  return { vertices: new Float64Array(tri.flat()), raycast: (p, d, { tMin, skipTri = -1 }) => (skipTri === 0 ? null : answer(p, d, tMin)) };
}

describe("insideShared: a ray along an edge line", () => {
  it("a lone hit on a triangle's edge is a graze, so the next direction decides", () => {
    // the triangle's edge (0,0,0)-(0,0,10) sits on the +X ray from (-5, 0, 5): one hit there,
    // nothing anywhere else. Counted, that is one crossing — inside.
    const tri = [[0, 0, 0], [0, 0, 10], [0, 10, 0]];
    const index = fakeIndex(tri, (p, d, tMin) => (d[0] === 1 && d[1] === 0 && d[2] === 0 && tMin < 5 ? { t: 5, tri: 0 } : null));
    expect(insideShared(index, [-5, 0, 5], I)).toBe(false);
  });

  it("a lone hit on a corner is a graze too", () => {
    const tri = [[0, 0, 0], [0, 0, 10], [0, 10, 0]];
    const index = fakeIndex(tri, (p, d, tMin) => (d[0] === 1 && tMin < 5 ? { t: 5, tri: 0 } : null));
    expect(insideShared(index, [-5, 0, 0], I)).toBe(false);
  });

  it("a hit inside the face still counts", () => {
    const tri = [[0, -10, -10], [0, 10, -10], [0, 0, 10]];
    const index = fakeIndex(tri, (p, d, tMin) => (d[0] === 1 && tMin < 5 ? { t: 5, tri: 0 } : null));
    expect(insideShared(index, [-5, 0, 0], I)).toBe(true);
  });

  it("when every direction grazes it answers outside", () => {
    // every cast reports one hit on a tiny triangle at t 5 — on its corner for +X, and off it
    // for the oblique ones (which miss it), read as a graze just the same: no direction decides
    const tri = [[0, 0, 0], [0, 0, 1e-3], [0, 1e-3, 0]];
    const index = fakeIndex(tri, (p, d, tMin) => (tMin < 5 ? { t: 5, tri: 0 } : null));
    expect(insideShared(index, [-5, 0, 0], I)).toBe(false);
  });

  it("a point outside the hinge base on a bore facet's edge line reads outside", () => {
    // every bore and rim edge of the base knuckle's near cap, at its midpoint, carried back to
    // x 0 (outside the base: there it is only the plate, at y >= 0) and to just outside the cap
    for (const T of [6, 9.525]) {
      const L = 30, base = buildBVH(meshesOf(coaxialKnuckles({ L, T })).find((b) => b.name === "base").solid.toMesh());
      const V = base.vertices, cap = L / 2 + 0.15, wrong = [];
      for (let o = 0; o < V.length; o += 9) for (let e = 0; e < 3; e++) {
        const i = o + 3 * e, j = o + 3 * ((e + 1) % 3);
        if (Math.abs(V[i] - cap) > 1e-4 || Math.abs(V[j] - cap) > 1e-4) continue;
        const y = (V[i + 1] + V[j + 1]) / 2, z = (V[i + 2] + V[j + 2]) / 2;
        if (y >= 0) continue; // the plate's own edges: a point there is on the base
        for (const x of [0, cap - 0.1]) if (insideShared(base, [x, y, z], I)) wrong.push([x, y, z]);
      }
      expect(wrong).toEqual([]);
    }
  }, SLOW);

  it("a point inside whose +X ray passes through an edge or a corner reads inside", () => {
    const cube = buildBVH(k.box({ min: [0, 0, 0], max: [10, 10, 10] }).toMesh());
    // +X from these meets the x 10 face on its diagonal, or on the face's corner lines
    for (const p of [[5, 5, 5], [2, 3, 3], [1, 7.5, 7.5], [9.9, 0.001, 0.001]]) expect(insideShared(cube, p, I)).toBe(true);
    // a corner straight ahead: an octahedron's +X vertex
    const oct = { positions: new Float64Array([10,0,0, -10,0,0, 0,10,0, 0,-10,0, 0,0,10, 0,0,-10]),
      indices: new Uint32Array([0,2,4, 2,1,4, 1,3,4, 3,0,4, 2,0,5, 1,2,5, 3,1,5, 0,3,5]) };
    expect(insideShared(buildBVH(oct), [0, 0, 0], I)).toBe(true);
    expect(insideShared(buildBVH(oct), [3, 0, 0], I)).toBe(true);
    expect(insideShared(buildBVH(oct), [-12, 0, 0], I)).toBe(false);
    // inside the hinge base's knuckle wall, on the line of a bore facet's edge pushed into it
    const base = buildBVH(meshesOf(coaxialKnuckles({ L: 30, T: 6 })).find((b) => b.name === "base").solid.toMesh());
    expect(insideShared(base, [20, -6.3, 6 - 4], I)).toBe(true);
    expect(insideShared(base, [20, -6.3, 6], I)).toBe(false); // in the bore
  }, SLOW);
});

describe("world.depth: coaxial knuckles resting apart", () => {
  const dims = [{ L: 20, T: 6 }, { L: 30, T: 6 }, { L: 30, T: 9.525 }, { L: 40, T: 6 }, { L: 60, T: 4 }];
  for (const d of dims) {
    it(`reads no press where nothing overlaps (L ${d.L}, T ${d.T})`, () => {
      const built = meshesOf(coaxialKnuckles(d));
      expect(built[0].solid.intersect(built[1].solid).volume()).toBe(0);
      const w = createCollisionWorld({ meshes: new Map(built.map((b) => [b.name, b.solid.toMesh()])) });
      // 0 up to rounding (a sample on the surface reads ~1e-15), far below TOUCH_TOL_MM
      expect(w.depth("base", "lid", new Map())).toBeLessThan(1e-9);
      expect(w.depth("lid", "base", new Map())).toBeLessThan(1e-9);
      expect(w.inside(new Map(), "base", "lid")).toBe(false);
      w.dispose();
    }, SLOW);
  }

  it("a real 0.5 mm press on the same hinge still reads 0.5", () => {
    for (const d of [{ L: 20, T: 6 }, { L: 30, T: 9.525 }]) {
      const built = meshesOf(coaxialKnuckles(d));
      const w = createCollisionWorld({ meshes: new Map(built.map((b) => [b.name, b.solid.toMesh()])) });
      expect(w.depth("base", "lid", new Map([["lid", [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-0.5,1]]]))).toBeCloseTo(0.5, 3);
      w.dispose();
    }
  }, SLOW);
});

describe("sweep: a printed hinge at clearance 0", () => {
  it("is clear at rest and along the travel", () => {
    for (const d of [{ L: 30, T: 6 }, { L: 30, T: 9.525 }]) {
      const [row] = runSweeps(k, coaxialKnuckles(d), "assembly", { open: 0 });
      expect(row.contacts.filter((c) => !c.allowed)).toEqual([]);
      expect(row.clear).toBe(true);
    }
  }, SLOW);

  it("a lid pressed 0.5 mm into the base blocks at the start", () => {
    const [row] = runSweeps(k, coaxialKnuckles({ L: 30, T: 6, press: 0.5 }), "assembly", { open: 0 });
    expect(row.clear).toBe(false);
    const blocking = row.contacts.filter((c) => !c.allowed);
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking[0].from).toBe(0);
    expect(blocking[0].depth).toBeGreaterThan(0.45);
  }, SLOW);
});
