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

describe("an open run of creases", () => {
  // A roof: the side walls are squashed, so the top slopes up to a ridge on y = 0.
  const roof = (make = createCage) => {
    const c = make({ box: { size: [40, 20, 20], segs: [4, 2, 1] } });
    c.scale(c.faces("+y:"), [1, 1, 0.3]);
    c.scale(c.faces("-y:"), [1, 1, 0.3]);
    return c;
  };
  const ridged = () => {
    const c = roof();
    c.crease(["+z:1,0", "+z:2,0"], ["+z:1,1", "+z:2,1"]);   // the middle two of the four top edges on y = 0
    return c;
  };
  test("crease(face, other) marks only the edges the two share", () => {
    const s = ridged().snapshot();
    expect(s.creases).toHaveLength(2);
    for (const [a, b] of s.creases) { expect(s.points[a][1]).toBe(0); expect(s.points[b][1]).toBe(0); expect(s.points[a][2]).toBe(10); }
    expect(() => box({ box: { segs: [2, 1, 1] } }).crease("+z:0,0", "-z:0,0")).toThrow(/share no edge/);
    expect(() => box().crease("+z:0,0", "+q:0,0")).toThrow(/no face/);
  });
  test("a mirrored cage creases along its plane through a reflected face", () => {
    const c = box({ box: { segs: [2, 2, 1] }, mirror: "xz" });
    c.crease(["+z:0,1", "+z:1,1"], ["+z:0,1~", "+z:1,1~"]);
    const s = c.snapshot();
    expect(s.creases).toHaveLength(2);
    for (const [a, b] of s.creases) { expect(s.points[a][1]).toBe(0); expect(s.points[b][1]).toBe(0); }
  });
  test("the faces beside the run become parts of their own, creased against each other only", () => {
    const mesh = subdivide(ridged().snapshot(), 2);
    // Four faces split out, and the rest of the skin: five parts, two creased pairs.
    expect(mesh.regions).toBe(5);
    expect(mesh.creasePairs).toHaveLength(2);
  });
  test("the ridge is sharp in the middle and fades out at its ends", () => {
    const smooth = subdivide(roof().snapshot(), 3);
    const creased = subdivide(ridged().snapshot(), 3);
    // Highest point on the plane y = 0 near x = 0 (mid-run) and near x = -20 (past the run's end).
    const topAt = (m, x) => {
      let z = -Infinity;
      for (let i = 0; i < m.positions.length; i += 3)
        if (Math.abs(m.positions[i + 1]) < 1e-9 && Math.abs(m.positions[i] - x) < 1.3) z = Math.max(z, m.positions[i + 2]);
      return z;
    };
    const mid = topAt(creased, 0) - topAt(smooth, 0), end = topAt(creased, -20) - topAt(smooth, -20);
    expect(mid).toBeGreaterThan(0.5);
    expect(Math.abs(end)).toBeLessThan(0.2 * mid);
  });
});

describe("k.subdiv with creases", () => {
  test("an open run shades hard along the run only", () => {
    const c = k.cage({ box: { size: [40, 20, 20], segs: [4, 2, 1] } });
    c.scale(c.faces("+y:"), [1, 1, 0.3]);
    c.scale(c.faces("-y:"), [1, 1, 0.3]);
    c.crease(["+z:1,0", "+z:2,0"], ["+z:1,1", "+z:2,1"]);
    const solid = k.subdiv(c);
    expect(new Set(solid._runs().map((r) => r.id)).size).toBe(5);
    const mesh = solid.toMesh();
    // Every feature line lies on the run: y = 0, on top, between the run's two ends.
    expect(mesh.edges.length).toBeGreaterThan(0);
    for (let i = 0; i < mesh.edges.length; i += 3) {
      expect(Math.abs(mesh.edges[i + 1])).toBeLessThan(1e-4);
      expect(mesh.edges[i + 2]).toBeGreaterThan(5);
      expect(Math.abs(mesh.edges[i])).toBeLessThan(10.5);
    }
    // Across the run the two sides have different normals at a shared point; across a
    // seam between two parts with no crease they agree.
    const P = mesh.positions, N = mesh.normals;
    const normalsAt = (x, y) => {
      const out = [];
      for (let i = 0; i < P.length; i += 3)
        if (Math.abs(P[i] - x) < 1e-3 && Math.abs(P[i + 1] - y) < 1e-3 && P[i + 2] > 0) out.push([N[i], N[i + 1], N[i + 2]]);
      return out;
    };
    const spread = (list) => Math.max(...list.map((n) => Math.hypot(n[0] - list[0][0], n[1] - list[0][1], n[2] - list[0][2])));
    const onRun = normalsAt(0, 0);
    expect(onRun.length).toBeGreaterThan(2);
    expect(spread(onRun)).toBeGreaterThan(0.2);
    // x = -10 is the seam between a split-out face and the rest, with no crease: pick a
    // vertex on it away from the run.
    let seam = null;
    for (let i = 0; i < P.length && !seam; i += 3)
      if (Math.abs(P[i] + 10) < 0.6 && Math.abs(P[i + 1] - 5) < 0.6 && P[i + 2] > 0) seam = [P[i], P[i + 1]];
    expect(seam).not.toBeNull();
    expect(spread(normalsAt(seam[0], seam[1]))).toBeLessThan(1e-6);
  });

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
