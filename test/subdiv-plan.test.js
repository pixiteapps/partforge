import { describe, expect, it } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/cage.js";
import { subdivide, topologyKey, subdivPlan, applySubdivPlan, applySubdivPlanAt } from "../src/framework/geometry/subdiv/surface.js";

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

describe("topologyKey", () => {
  it("does not change when only the points move", () => {
    const c = box();
    const before = topologyKey(c.snapshot());
    c.move("+z:0,0", [1, 2, 3]);
    c.scale("+x:0,0", 1.5);
    c.rotate("+y:0,0", { axis: "y", deg: 30 });
    expect(topologyKey(c.snapshot())).toBe(before);
  });
  it("changes with the faces, the ids and the creases", () => {
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
  it("does not read the points", () => {
    const s = box().snapshot();
    expect(topologyKey({ ...s, points: [] })).toBe(topologyKey(s));
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
