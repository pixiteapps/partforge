import { it, expect } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/index.js";

const fish = () => createCage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
const reflectY = (pts) => pts.map(([x, y, z]) => [x, -y, z].join()).sort();

it("keeps the cage symmetric through every change", () => {
  const c = fish();
  const fin = c.extrude("+y:0,0", { by: 12, scale: 0.7 });
  const tip = c.extrude(fin, { by: [-6, 10, 0], scale: 0.4, steps: 2 });
  c.move("+z:1,1", [0, 2, 4]);
  const pts = c.snapshot().points;
  expect(reflectY(pts)).toEqual(pts.map((p) => p.join()).sort());
  expect(c.centroid(`${tip}~`)[1]).toBeCloseTo(-c.centroid(tip)[1], 9);   // brief read `fin`, which the second extrude removed
});
it("moves a point on the plane only within the plane", () => {
  const c = fish();
  c.move("+z:1,1", [0, 5, 0]);                       // this face touches y = 0
  expect(c.snapshot().points.filter((p) => Math.abs(p[1]) < 1e-9).length).toBeGreaterThan(0);
  expect(reflectY(c.snapshot().points)).toEqual(c.snapshot().points.map((p) => p.join()).sort());
});
it("grows a region that touches the plane across it, leaving no wall", () => {
  const c = fish();
  c.extrude("+z:1,1", { by: 6, id: "hump" });
  expect(c.faces("hump").some((id) => Math.abs(c.centroid(id)[1]) < 1e-9 && Math.abs(c.normal(id)[1]) > 0.9)).toBe(false);
});
it("refuses an odd count across the plane and a change to the far side", () => {
  expect(() => createCage({ box: { size: [60, 30, 20], segs: [4, 3, 1] }, mirror: "xz" })).toThrow(/^cage: .*mirror.*even/);
  expect(() => fish().move("+y:0,0~", [1, 0, 0])).toThrow(/^cage: .*reflected/);
  expect(fish().centroid("+y:0,0~")[1]).toBeLessThan(0);
});

// Beyond the brief: the naming, the scale path and a refused call.
it("names far-side and cut-side faces after their positive twin", () => {
  const c = fish();
  expect(c.faces("-y")).toEqual([]);
  expect(c.faces("+x").sort()).toEqual(["+x:1,0", "+x:1,0~"]);
  expect(c.centroid("+x:1,0")[1]).toBe(7.5);
  expect(c.centroid("+x:1,0~")[1]).toBe(-7.5);
});
it("names a joined region's sides from the plane, and the far ones with ~", () => {
  const c = fish();
  expect(c.extrude("+z:1,1", { by: 6, id: "hump" })).toBe("hump");
  expect(c.faces("hump").sort()).toEqual(
    ["hump", "hump.s0", "hump.s0~", "hump.s1", "hump.s1~", "hump.s2", "hump.s2~", "hump~"]);
  expect(c.normal("hump.s0")).toEqual([1, 0, 0]);    // leaves the plane at x = 0
  expect(c.normal("hump.s1")).toEqual([0, 1, 0]);
  expect(c.normal("hump.s1~")).toEqual([0, -1, 0]);
  expect(c.normal("hump.s2")).toEqual([-1, 0, 0]);
  expect(() => c.extrude("+z:1,1~", { by: 1 })).toThrow(/^cage: .*reflected/);
});
it("scales a face touching the plane about the joined region, symmetrically", () => {
  const c = fish();
  c.scale("+z:1,1", 0.5);
  const pts = c.snapshot().points;
  expect(reflectY(pts)).toEqual(pts.map((p) => p.join()).sort());
  expect(c.centroid("+z:1,1")[1]).toBeCloseTo(3.75, 9);
});
it("reads about: null as the default about point", () => {
  const a = fish(), b = fish();
  a.scale("+z:1,1", 0.5);
  b.scale("+z:1,1", 0.5, { about: null });
  expect(b.snapshot()).toEqual(a.snapshot());
});
it("leaves the cage untouched when a mirrored change is refused", () => {
  const c = fish();
  const before = c.snapshot();
  expect(() => c.extrude("+z:1,1", { by: 5, scale: 0 })).toThrow(/^cage: .*scale/);
  expect(() => c.scale("+y:0,0", 0)).toThrow(/^cage: /);
  expect(c.snapshot()).toEqual(before);
});
it("stays a closed, consistently wound mesh through mirrored changes", () => {
  const c = fish();
  const hump = c.extrude(["+z:1,1", "+z:2,1"], { by: 6, scale: 0.8, steps: 2 });
  c.extrude(hump[0], { by: [2, 3, 4] });
  c.extrude("+x:1,0", { by: 5, steps: 3 });
  c.scale("+y:1,0", [1.2, 1, 1.2]);
  const { points, faces } = c.snapshot();
  const directed = new Map();
  for (const f of faces) for (let k = 0; k < 4; k++) {
    const key = `${f[k]}>${f[(k + 1) % 4]}`;
    directed.set(key, (directed.get(key) ?? 0) + 1);
  }
  expect([...directed.values()].every((n) => n === 1)).toBe(true);
  expect([...directed.keys()].every((key) => directed.has(key.split(">").reverse().join(">")))).toBe(true);
  expect(points.length - directed.size / 2 + faces.length).toBe(2);
  expect(reflectY(points)).toEqual(points.map((p) => p.join()).sort());
});

it("rotates a side face and its reflection the opposite way; a point on the plane stays on it", () => {
  const c = createCage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
  const fin = c.extrude("+y:0,0", { by: 10 });
  c.rotate(fin, { axis: "x", deg: 30 });
  const n = c.normal(fin), t = c.normal(`${fin}~`);
  expect(n[2]).toBeCloseTo(0.5, 9);
  expect(t).toEqual([n[0], -n[1], n[2]]);
  c.rotate("+z:1,1", { axis: "x", deg: 20 });             // has an edge on the plane
  const pts = c.snapshot().points;
  // The face's plane edge did not leave the plane, so it stretched rather than turned rigidly.
  expect(c.snapshot().faces[c.snapshot().ids.indexOf("+z:1,1")].filter((p) => pts[p][1] === 0).length).toBe(2);
  expect(reflectY(pts)).toEqual(pts.map((p) => p.join()).sort());
});
it("needs mirrored widths to read the same from both ends", () => {
  expect(() => createCage({ mirror: "yz", box: { size: [10, 2, 4], segs: [[1, 4, 3, 2], 1, 1] } }))
    .toThrow('cage: mirror "yz" needs box.segs[0] widths that read the same from both ends');
  expect(() => createCage({ mirror: "yz", box: { size: [10, 2, 4], segs: [[2, 3, 3, 2], 1, 1] } })).not.toThrow();
});
it("keeps a steps list symmetric, joined across the plane and copied across it", () => {
  const c = fish();
  c.extrude(["+z:1,1", "+z:2,1"], { by: 6, steps: [1.2, [0.8, 1, 1.1], 0.9], id: "ridge" });   // touches y = 0: joined
  c.extrude("+y:0,0", { by: 8, steps: [0.9, [1, 1, 1.2]], id: "fin" });                        // copied across
  const pts = c.snapshot().points;
  expect(reflectY(pts)).toEqual(pts.map((p) => p.join()).sort());
  expect(c.faces("ridge.1.").length).toBeGreaterThan(0);
  expect(c.centroid("fin~")[1]).toBeCloseTo(-c.centroid("fin")[1], 9);
});
it("lists reflected faces by direction, and moves a number along the normal on both sides", () => {
  const c = createCage({ box: { size: [40, 20, 20], segs: [2, 1, 1] }, mirror: "yz" });
  const far = c.faces("", { facing: "-x" });
  expect(far.length).toBeGreaterThan(0);
  expect(far.every((id) => id.endsWith("~"))).toBe(true);
  c.move("+y:1,0", 3);
  expect(c.centroid("+y:1,0")[1]).toBeCloseTo(13, 9);
  expect(c.centroid("+y:1,0~")[1]).toBeCloseTo(13, 9);
  const pts = c.snapshot().points;
  const reflectX = (ps) => ps.map(([x, y, z]) => [-x + 0, y, z].join()).sort();
  expect(reflectX(pts)).toEqual(pts.map((p) => p.join()).sort());
});
