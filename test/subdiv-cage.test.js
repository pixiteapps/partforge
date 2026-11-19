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
    // Every directed edge once and its reverse once: closed and consistently wound.
    const directed = new Map();
    for (const f of faces) for (let k = 0; k < 4; k++) {
      const key = `${f[k]}>${f[(k + 1) % 4]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
    expect([...directed.values()].every((n) => n === 1)).toBe(true);
    expect([...directed.keys()].every((key) => directed.has(key.split(">").reverse().join(">")))).toBe(true);
    expect(points.length - directed.size / 2 + faces.length).toBe(2);
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
  it("names each step's sides, the last without its number", () => {
    const c = box();
    expect(c.extrude("+x:0,0", { by: 10, steps: 2, id: "cap" })).toBe("cap");
    expect(c.faces("cap.").sort()).toEqual(["cap.1.s0", "cap.1.s1", "cap.1.s2", "cap.1.s3", "cap.s0", "cap.s1", "cap.s2", "cap.s3"]);
    expect(c.centroid("cap.1.s0")[0]).toBe(22.5);
    expect(c.centroid("cap.s0")[0]).toBe(27.5);
  });
  it("orders a region's sides by the stated rule", () => {
    const c = box([2, 1, 1]);
    c.extrude(["+z:0,0", "+z:1,0"], { by: 5, id: "top" });
    // Seen from +z: the x = -20 edge first, then counter-clockwise.
    const sides = [0, 1, 2, 3, 4, 5].map((k) => [c.normal(`top.s${k}`), c.centroid(`top.s${k}`)[0]]);
    expect(sides).toEqual([[[-1, 0, 0], -20], [[0, -1, 0], -10], [[0, -1, 0], 10],
      [[1, 0, 0], 20], [[0, 1, 0], 10], [[0, 1, 0], -10]]);
  });
  it("refuses an id already in use, or one whose family is", () => {
    const c = box([2, 1, 1]);
    c.extrude("+x:0,0", { by: 5, id: "arm" });
    expect(() => c.extrude("-x:0,0", { by: 5, id: "arm" })).toThrow(/^cage: .*"arm".*in use/);
    c.extrude(["+z:0,0", "+z:1,0"], { by: 5, id: "top" });
    expect(() => c.extrude("-x:0,0", { by: 5, id: "top" })).toThrow(/^cage: .*"top".*in use/);
    expect(() => c.extrude("-x:0,0", { by: 5, id: "arm.s1" })).toThrow(/^cage: .*in use/);
    expect(() => c.extrude("-x:0,0", { by: 5, id: "a~" })).toThrow(/^cage: .*~/);
  });
  it("refuses a numeric by on a region whose normal sums to zero", () => {
    const c = box();
    c.move("+x:0,0", [-40, 0, 0]);                     // folds +z flat: its normal sums to zero
    expect(() => c.extrude("+z:0,0", { by: 5 })).toThrow(/^cage: .*by/);
  });
  it("refuses a mirror it does not know", () => {
    expect(() => createCage({ box: { size: [1, 1, 1] }, mirror: "y" })).toThrow(/^cage: mirror/);
  });
});

describe("cage: move, scale and reads", () => {
  it("scales about a given point", () => {
    const c = box();
    c.scale("+z:0,0", 2, { about: [0, 0, 0] });
    expect(c.centroid("+z:0,0")).toEqual([0, 0, 20]);
    expect(c.bounds()).toEqual({ min: [-40, -20, -10], max: [40, 20, 20] });
  });
  it("never returns -0", () => {
    const c = box([2, 2, 2]);
    c.move("-z:0,0", [0, 0, -3]);
    c.scale("-x:1,1", [1, 0.5, 0.5]);
    c.extrude("-y:0,0", { by: 4 });
    for (const id of c.faces()) for (const v of [...c.normal(id), ...c.centroid(id), ...c.size(id)])
      expect(Object.is(v, -0)).toBe(false);
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
