// The generic-handle reference parts (spec 2026-11-02 section 6): gearbox.js (rotary
// handles on a mechanisms-domain gear train) and drawer-box.js (a plane handle for shape,
// axis handles for motion). Both lint clean, measure lists their handles, and the
// solver drives them the way a drag would.
import { describe, it, expect, beforeAll } from "vitest";
import { lintPart } from "../src/lint.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { solveHandle } from "../src/framework/pose/param-solve.js";
import { angleAbout, wrapTo180 } from "../src/framework/solve/axis-angle.js";
import { resolveParams } from "../src/framework/part-model.js";
import { locateHandle, handleAxis } from "../src/framework/pose/handle-source.js";
import { probePoses } from "../src/framework/pose-probe.js";
import gearbox from "../src/parts/gearbox.js";
import drawerBox from "../src/parts/drawer-box.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const at = (part, params, id) => {
  const { p, d } = resolveParams(part, params);
  return locateHandle(part, p, d, part.handles[id]);
};
const axisOf = (part, params, id) => {
  const { p, d } = resolveParams(part, params);
  return handleAxis(part.handles[id], p, d);
};

describe("both parts lint clean", () => {
  for (const [name, part] of [["gearbox", gearbox], ["drawer-box", drawerBox]]) {
    it(name, () => {
      const r = lintPart(part);
      expect([...r.errors, ...r.warnings]).toEqual([]);
    });
  }
});

describe("measure reports their handles", () => {
  it("gearbox: a rotary handle on every gear and the crank, all driving driveAngle", () => {
    const r = measure(k, gearbox, "gearbox");
    expect(r.handles.map((h) => [h.id, h.kind, h.params])).toEqual([
      ["gear1", "rotary", ["driveAngle"]], ["gear2", "rotary", ["driveAngle"]],
      ["gear3", "rotary", ["driveAngle"]], ["crank", "rotary", ["driveAngle"]],
    ]);
    expect(r.handles.every((h) => Array.isArray(h.point) && h.direction && h.origin)).toBe(true);
    expect(r.overlaps).toEqual([]);
  });

  it("gearbox: the teeth stay in mesh at another input angle", () => {
    expect(measure(k, gearbox, "gearbox", { driveAngle: 137.3 }).overlaps).toEqual([]);
  });

  it("drawer-box: a plane handle on the corner and an axis handle per drawer", () => {
    const r = measure(k, drawerBox, "cabinet");
    expect(r.handles.map((h) => [h.id, h.kind, h.params])).toEqual([
      ["corner", "plane", ["width", "depth"]],
      ["drawer1", "axis", ["drawer1Open"]], ["drawer2", "axis", ["drawer2Open"]], ["drawer3", "axis", ["drawer3Open"]],
    ]);
    expect(r.handles[0].point).toEqual([80, 60, 150]);
  });
});

describe("the solver drives them as a drag would", () => {
  it("turning gear 3 by +90 degrees moves driveAngle by +180", () => {
    const params = { driveAngle: 12 };
    const axis = axisOf(gearbox, params, "gear3");
    const now = angleAbout(at(gearbox, params, "gear3"), axis);
    const r = solveHandle({ part: gearbox, params, handle: gearbox.handles.gear3, target: { angleDeg: wrapTo180(now + 90), axis, radius: 40 } });
    expect(r.values.driveAngle).toBeCloseTo(192, 2);
  });

  it("the crank turns the input one for one", () => {
    const params = { driveAngle: 0 };
    const axis = axisOf(gearbox, params, "crank");
    const now = angleAbout(at(gearbox, params, "crank"), axis);
    const r = solveHandle({ part: gearbox, params, handle: gearbox.handles.crank, target: { angleDeg: wrapTo180(now + 30), axis, radius: 15 } });
    expect(r.values.driveAngle).toBeCloseTo(30, 2);
  });

  it("a corner plane drag to [60, 40, h] gives width 120 and depth 80", () => {
    const h = drawerBox.defaults.height;
    const r = solveHandle({ part: drawerBox, params: {}, handle: drawerBox.handles.corner, target: { point: [60, 40, h] } });
    expect(r.values.width).toBeCloseTo(120, 2);
    expect(r.values.depth).toBeCloseTo(80, 2);
  });

  it("a drawer pull dragged 55 mm out opens that drawer alone, to half its 110 mm travel", () => {
    const start = at(drawerBox, {}, "drawer1");
    const r = solveHandle({ part: drawerBox, params: {}, handle: drawerBox.handles.drawer1, target: { point: [start[0], start[1] - 55, start[2]] } });
    expect(Object.keys(r.values)).toEqual(["drawer1Open"]);
    expect(r.values.drawer1Open).toBeCloseTo(50, 2); // percent of depth - 10
  });
});

// Motion drags re-place sub-parts by matrix: the build-scope hash (what a rebuild keys
// on) is unchanged and the live place() is trusted, so the pose fast path takes them.
describe("motion params only re-place sub-parts", () => {
  const cases = [
    ["gearbox", gearbox, "gearbox", { driveAngle: 90 }, ["plate", "gear1", "gear2", "gear3", "crank"]],
    ["drawer-box", drawerBox, "cabinet", { drawer1Open: 30, drawer3Open: 55 }, ["carcass", "drawer1", "drawer2", "drawer3"]],
  ];
  for (const [name, part, view, moved, subs] of cases) {
    it(name, () => {
      const before = probePoses(part, view, { ...part.defaults }, { scope: "build" });
      const after = probePoses(part, view, { ...part.defaults, ...moved }, { scope: "build" });
      const place = probePoses(part, view, { ...part.defaults, ...moved }, { scope: "place" });
      expect([...before.keys()]).toEqual(subs);
      for (const n of subs) {
        expect(before.get(n).trusted, n).toBe(true);
        expect(after.get(n).baseHash, n).toBe(before.get(n).baseHash);
        expect(place.get(n).trusted, n).toBe(true);
      }
    });
  }
  it("the drawer-box corner is a shape drag: width rebuilds the cabinet", () => {
    const a = probePoses(drawerBox, "cabinet", { ...drawerBox.defaults }, { scope: "build" });
    const b = probePoses(drawerBox, "cabinet", { ...drawerBox.defaults, width: 120 }, { scope: "build" });
    expect(b.get("carcass").baseHash).not.toBe(a.get("carcass").baseHash);
  });
});
