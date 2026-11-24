import { describe, expect, it } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/cage.js";
import { resolveParams } from "../src/framework/part-model.js";
import { cage } from "../src/framework/domains/organic/index.js";
import handPart, { cageHand } from "../src/parts/cage-hand.js";
import { subdivide, topologyKey, sameTopology, subdivPlan, applySubdivPlan, applySubdivPlanAt } from "../src/framework/geometry/subdiv/surface.js";

const box = (opts = {}) => createCage({ box: { size: [20, 20, 20], ...opts.box }, mirror: opts.mirror });

// Each builder takes a pose angle so the same topology can be built at two poses.
const cages = {
  box: (deg = 0) => { const c = box(); if (deg) c.rotate("+z:0,0", { axis: "x", deg }); return c; },
  "extruded and rotated": (deg = 25) => {
    const c = box();
    const arm = c.extrude("+x:0,0", { by: 15, steps: 2 });
    c.rotate(arm, { axis: "z", deg });
    return c;
  },
  mirrored: (deg = 20) => {
    const c = createCage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
    const fin = c.extrude("+y:0,0", { by: 10 });
    c.rotate(fin, { axis: "x", deg });
    return c;
  },
  creased: (deg = 0) => {
    const c = box({ box: { segs: [2, 2, 2] } });
    c.crease("+z:0,0");
    const top = c.extrude("+z:1,1", { by: 5 });
    if (deg) c.rotate(top, { axis: "y", deg });
    return c;
  },
};

const handAt = (params) => {
  const { p, d } = resolveParams(handPart, params);
  const bends = Object.fromEntries(["index", "middle", "ring", "pinky", "thumb"].map((n) => [n, d[n].values]));
  return cageHand(cage, p, bends).snapshot();
};

describe("topologyKey", () => {
  it("does not change when only the points move", () => {
    const c = box();
    const before = topologyKey(c.snapshot());
    c.move("+z:0,0", [1, 2, 3]);
    c.scale("+x:0,0", 1.5);
    c.rotate("+y:0,0", { axis: "y", deg: 30 });
    expect(topologyKey(c.snapshot())).toBe(before);
  });
  it("changes with the faces and the creases", () => {
    const base = topologyKey(box().snapshot());
    const extruded = box(); extruded.extrude("+z:0,0", { by: 5 });
    expect(topologyKey(extruded.snapshot())).not.toBe(base);

    const one = box(), two = box();
    one.extrude("+z:0,0", { by: 5, steps: 1 });
    two.extrude("+z:0,0", { by: 5, steps: 2 });
    expect(topologyKey(one.snapshot())).not.toBe(topologyKey(two.snapshot()));

    const creased = box(); creased.crease("+z:0,0");
    expect(topologyKey(creased.snapshot())).not.toBe(base);

    const ab = box(), ba = box();
    ab.extrude("+z:0,0", { by: 5 }); ab.extrude("+x:0,0", { by: 5 });
    ba.extrude("+x:0,0", { by: 5 }); ba.extrude("+z:0,0", { by: 5 });
    expect(topologyKey(ab.snapshot())).not.toBe(topologyKey(ba.snapshot()));
  });
  it("does not read the ids", () => {
    const s = box().snapshot();
    const renamed = { ...s, ids: s.ids.map((id) => `x${id}`) };
    expect(topologyKey(renamed)).toBe(topologyKey(s));
  });
  it("is the same for the cage hand at two thumb bends", () => {
    expect(topologyKey(handAt({ thumbCurl: 45 }))).toBe(topologyKey(handAt({ thumbCurl: 10 })));
  });
  it("does not read the point values", () => {
    const s = box().snapshot();
    expect(topologyKey({ ...s, points: s.points.map(() => [0, 0, 0]) })).toBe(topologyKey(s));
  });
  it("ignores face order and each quad's start corner, not its winding or indices", () => {
    const s = box().snapshot();
    const rot = (f) => [...f.slice(1), f[0]];
    expect(topologyKey({ ...s, faces: [...s.faces].reverse().map(rot) })).toBe(topologyKey(s));
    const flipped = s.faces.map((f, i) => (i === 0 ? [f[0], f[3], f[2], f[1]] : f));
    expect(topologyKey({ ...s, faces: flipped })).not.toBe(topologyKey(s));
    const moved = s.faces.map((f, i) => (i === 0 ? [f[0], f[1], f[2], (f[3] + 1) % s.points.length] : f));
    expect(topologyKey({ ...s, faces: moved })).not.toBe(topologyKey(s));
  });
  it("is the same for the cage hand across every parameter's min and max", () => {
    const controls = handPart.parameters.flatMap((g) => g.controls);
    const base = topologyKey(handAt({}));
    for (const c of controls) {
      expect(topologyKey(handAt({ [c.key]: c.min })), `${c.key} min`).toBe(base);
      expect(topologyKey(handAt({ [c.key]: c.max })), `${c.key} max`).toBe(base);
    }
  });
  it("applies a plan from one thumb pose to another pose's points as the same surface", () => {
    const a = handAt({ thumbCurl: 10 }), b = handAt({ thumbCurl: 45 });
    for (const L of [1, 2]) {
      const got = applySubdivPlan(subdivPlan(a, L), b.points).positions;
      const want = subdivide(b, L).positions;
      expect(got.length).toBe(want.length);
      const rows = (pos) => Array.from({ length: pos.length / 3 }, (_, i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]])
        .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      const g = rows(got), w = rows(want);
      g.forEach((r, i) => r.forEach((v, j) => expect(Math.abs(v - w[i][j])).toBeLessThan(1e-9)));
    }
  });
});

describe("sameTopology", () => {
  it("is true for a moved cage and false after an extra extrude", () => {
    const c = box();
    const before = c.snapshot();
    c.move("+z:0,0", [1, 2, 3]);
    expect(sameTopology(before, c.snapshot())).toBe(true);
    c.extrude("+z:0,0", { by: 5 });
    expect(sameTopology(before, c.snapshot())).toBe(false);
  });
  it("compares creases, and the quads up to rotation in any order", () => {
    const s = box().snapshot();
    const creased = box(); creased.crease("+z:0,0");
    expect(sameTopology(s, creased.snapshot())).toBe(false);
    const rot = (f) => [...f.slice(1), f[0]];
    expect(sameTopology(s, { ...s, faces: [...s.faces].reverse().map(rot) })).toBe(true);
    expect(sameTopology(handAt({ thumbCurl: 10 }), handAt({ thumbCurl: 45 }))).toBe(true);
  });
});

describe("subdivPlan", () => {
  for (const [name, build] of Object.entries(cages)) {
    for (const L of [1, 2, 3]) {
      it(`gives subdivide's mesh for the ${name} cage at level ${L}`, () => {
        const s = build().snapshot();
        const want = subdivide(s, L);
        const plan = subdivPlan(s, L);
        expect(plan.key).toBe(topologyKey(s));
        expect(plan.level).toBe(L);
        expect(plan.pointCount).toBe(s.points.length);
        const got = applySubdivPlan(plan, s.points);
        expect(got.positions).toEqual(want.positions);
        expect(got.indices).toEqual(want.indices);
        expect(got.triFace).toEqual(want.triFace);
        expect(got.triRegion).toEqual(want.triRegion);
        expect(got.regions).toEqual(want.regions);
        expect(got.creasePairs).toEqual(want.creasePairs);
        expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
        expect(got.indices).toBe(plan.indices);
        expect(got.triFace).toBe(plan.triFace);
      });
      it(`moves the ${name} cage's surface with its points at level ${L}`, () => {
        const a = build(0).snapshot(), b = build(40).snapshot();
        expect(topologyKey(b)).toBe(topologyKey(a));
        expect(b.points).not.toEqual(a.points);
        const got = applySubdivPlan(subdivPlan(a, L), b.points);
        expect(got.positions).toEqual(subdivide(b, L).positions);
      });
    }
  }
  it("gives each lower level's limit positions and triangles", () => {
    const a = cages["extruded and rotated"](0).snapshot(), b = cages["extruded and rotated"](40).snapshot();
    const plan = subdivPlan(a, 3);
    for (const L of [1, 2, 3]) {
      const at = subdivide(a, L);
      expect(plan.levels[L].indices).toEqual(at.indices);
      expect(plan.levels[L].triFace).toEqual(at.triFace);
      expect(applySubdivPlanAt(plan, b.points, L)).toEqual(subdivide(b, L).positions);
    }
    expect(plan.levels[3].indices).toBe(plan.indices);
    expect(() => applySubdivPlanAt(plan, b.points, 4)).toThrow(/^subdiv: level must be/);
    expect(() => applySubdivPlanAt(plan, b.points, 0)).toThrow(/^subdiv: level must be/);
  });
  it("refuses points of a different cage", () => {
    const s = box().snapshot();
    const plan = subdivPlan(s, 2);
    expect(() => applySubdivPlan(plan, s.points.slice(1))).toThrow("subdiv: plan does not match the cage");
    expect(() => applySubdivPlanAt(plan, [...s.points, [0, 0, 0]], 1)).toThrow("subdiv: plan does not match the cage");
  });
});
