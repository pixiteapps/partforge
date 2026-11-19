import { describe, it, expect } from "vitest";
import { createCage, isCage, MAX_CAGE_FACES } from "../src/framework/geometry/subdiv/index.js";

const box = (segs = [1, 1, 1]) => createCage({ box: { size: [40, 20, 20], segs } });

describe("cage: box and ids", () => {
  it("names every face by side and index", () => {
    const c = box([2, 1, 1]);
    expect(c.faces().length).toBe(10);
    expect(c.faces("+z").sort()).toEqual(["+z:0,0", "+z:1,0"]);
    expect(c.centroid("+z:1,0")).toEqual([10, 0, 10]);
    expect(c.normal("-x:0,0")).toEqual([-1, 0, 0]);
    expect(c.bounds()).toEqual({ min: [-20, -10, -10], max: [20, 10, 10] });
  });
  it("stays a closed quad mesh after every change", () => {
    const c = box([2, 2, 1]);
    const cap = c.extrude("+x:0,0", { by: 10, scale: 0.5 });
    c.extrude(cap, { by: [5, 0, 5], steps: 3 });
    c.move("+z:0,0", [0, 0, 3]);
    c.scale("-y:1,0", 0.8);
    const { points, faces } = c.snapshot();
    const edges = new Map();
    for (const f of faces) for (let k = 0; k < 4; k++) {
      const key = [f[k], f[(k + 1) % 4]].sort().join("-");
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
    expect(points.length - edges.size + faces.length).toBe(2);
  });
});

describe("cage: extrude", () => {
  it("returns the cap id, removes the face, and names four sides", () => {
    const c = box();
    expect(c.extrude("+x:0,0", { by: 10 })).toBe("+x:0,0>");
    expect(c.faces("+x:0,0").sort()).toEqual(["+x:0,0>", "+x:0,0>.s0", "+x:0,0>.s1", "+x:0,0>.s2", "+x:0,0>.s3"]);
    expect(c.centroid("+x:0,0>")).toEqual([30, 0, 0]);
    expect(() => c.extrude("+x:0,0", { by: 5 })).toThrow(/was extruded; it is now/);
  });
  it("orders the sides by the stated rule", () => {
    const c = box();
    c.extrude("+x:0,0", { by: 10, id: "arm" });
    expect(c.normal("arm.s0")).toEqual([0, -1, 0]);   // smallest Y edge first
    expect(c.normal("arm.s1")).toEqual([0, 0, -1]);   // then counter-clockwise seen from outside (+x): -y, -z, +y, +z
  });
  it("grows a connected region as one piece", () => {
    const c = box([2, 1, 1]);
    expect(c.extrude(["+z:0,0", "+z:1,0"], { by: 5, id: "top" })).toEqual(["top:0", "top:1"]);
    expect(c.faces("top.s").length).toBe(6);
  });
  it("refuses the inputs in Review Focus 1, 3 and 4", () => {
    expect(() => box().extrude("+x:0,0", { by: 10, scale: 0 })).toThrow(/^cage: .*scale/);
    expect(() => box().extrude("+x:0,0", { by: 0 })).toThrow(/^cage: .*by/);
    expect(() => box().extrude("+x:0,0", { by: NaN })).toThrow(/^cage: .*by/);
    expect(() => box().extrude("+x:0,0", { by: [1, 2] })).toThrow(/^cage: .*by/);
    expect(() => box([2.5, 1, 1])).toThrow(/^cage: .*segs/);
    expect(() => box([0, 1, 1])).toThrow(/^cage: .*segs/);
    expect(() => box([40, 40, 40])).toThrow(new RegExp(`^cage: .*${MAX_CAGE_FACES}`));
    expect(() => box([3, 1, 1]).extrude(["+z:0,0", "+z:2,0"], { by: 5 })).toThrow(/^cage: .*connected/);
    expect(() => box().centroid("+q:0,0")).toThrow(/^cage: no face "\+q:0,0"/);
  });
});

it("snapshot is a copy, and isCage tells a cage from data", () => {
  const c = box();
  const before = c.snapshot();
  c.move("+z:0,0", [0, 0, 5]);
  expect(before.points).not.toEqual(c.snapshot().points);
  expect(isCage(c)).toBe(true);
  expect(isCage(before)).toBe(false);
});
