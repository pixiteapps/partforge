// The native core's failure handling and edge cases (src/framework/core/), each a
// finding from the PR #262 review: the core must never change an answer, never
// corrupt itself, and never hand a caller something it has to free.
import { afterEach, expect, test } from "vitest";
import { creasedNormals, creasedNormalsJS } from "../src/framework/geometry/creased-normals.js";
import { buildBVH, cachedBVH, disposeBVHs } from "../src/framework/oracle/bvh.js";
import { meshGaps } from "../src/framework/oracle/gaps.js";
import { minWall } from "../src/framework/oracle/min-wall.js";
import { core, setCoreEnabled, setCoreForTesting } from "../src/framework/core/core.js";

afterEach(() => {
  setCoreEnabled(true);
  setCoreForTesting(undefined); // re-boot a clean instance for the next test
  delete globalThis.PARTFORGE_CORE;
});

// A minimal MeshGL: a three-triangle fan around vertex 0, one run.
const fan = (z0 = 0) => ({
  numProp: 3,
  vertProperties: new Float32Array([0, 0, z0, 1, 0, 0, 0, 1, 0, -1, 0, 0]),
  triVerts: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1]),
  runIndex: new Uint32Array([0, 9]),
  runOriginalID: new Uint32Array([1]),
});
const same = (a, b) => expect(JSON.stringify([...a.normals, ...a.positions, ...a.edges]))
  .toBe(JSON.stringify([...b.normals, ...b.positions, ...b.edges]));

test("a NaN vertex shades the same with the core on (Math.max propagates NaN; fmax would not)", () => {
  const g = fan(NaN);
  expect(core()).not.toBeNull();
  same(creasedNormals(g), creasedNormalsJS(g));
});

test("a malformed mesh goes to the JS pass instead of the core", () => {
  const badMerge = { ...fan(0.2), mergeFromVert: new Uint32Array([1]) }; // no mergeToVert
  same(creasedNormals(badMerge), creasedNormalsJS(badMerge));
  const badIndex = { ...fan(0.2), triVerts: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 9]) }; // vertex 9 does not exist
  same(creasedNormals(badIndex), creasedNormalsJS(badIndex));
  const f64 = { ...fan(0.2), vertProperties: new Float64Array(fan(0.2).vertProperties) };
  same(creasedNormals(f64), creasedNormalsJS(f64));
  expect(core()).not.toBeNull(); // refusing a mesh is not a fault
});

test("a fault inside the core falls back to the JS pass and retires that instance", () => {
  const broken = { x: {}, live: 0, poisoned: false, alloc() { throw new Error("out of memory"); }, copyIn() { throw new Error("out of memory"); } };
  setCoreForTesting(broken);
  const g = fan(0.2);
  same(creasedNormals(g), creasedNormalsJS(g));
  expect(broken.poisoned).toBe(true);
  expect(core()).toBeNull(); // nothing touches a faulted instance again
});

test("globalThis.PARTFORGE_CORE is honoured whenever it is set, not only at import", () => {
  expect(core()).not.toBeNull();
  globalThis.PARTFORGE_CORE = false;
  expect(core()).toBeNull();
  delete globalThis.PARTFORGE_CORE;
  expect(core()).not.toBeNull();
});

test("minWall honours an explicit NaN cap on a core index, as the JS does", () => {
  const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0]) };
  const coreIndex = cachedBVH(mesh);
  expect(coreIndex.core).toBeTruthy();
  for (const maxThickness of [NaN, undefined, 5]) {
    expect(minWall(mesh, { bvh: coreIndex, maxThickness })).toEqual(minWall(mesh, { bvh: buildBVH(mesh), maxThickness }));
  }
  disposeBVHs([coreIndex]);
});

test("a caller's own bvhCache keeps getting JS indexes (nothing for it to free)", () => {
  const tri = (dz) => ({ name: `t${dz}`, mesh: { positions: new Float32Array([0, 0, dz, 1, 0, dz, 0, 1, dz]) } });
  const bvhCache = new Map();
  const gaps = meshGaps([tri(0), tri(2)], { bvhCache });
  expect(gaps[0].distance).toBe(2);
  for (const b of bvhCache.values()) {
    expect(b.core).toBeUndefined();
    expect(b.vertices).toBeTruthy(); // the JS index's public shape
  }
  // ...and a cache pre-seeded with buildBVH() results still works alongside new entries.
  const seeded = new Map();
  const a = tri(0), b = tri(3);
  seeded.set(a.mesh, buildBVH(a.mesh));
  expect(meshGaps([a, b], { bvhCache: seeded })[0].distance).toBe(3);
});

test("a JS index and a core index can still measure the distance between them", () => {
  const m1 = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) };
  const m2 = { positions: new Float32Array([0, 0, 4, 1, 0, 4, 0, 1, 4]) };
  const c = cachedBVH(m1), j = buildBVH(m2);
  expect(c.distanceTo(j)).toEqual(buildBVH(m1).distanceTo(j));
  expect(j.distanceTo(c)).toEqual(j.distanceTo(buildBVH(m1)));
  disposeBVHs([c]);
});
