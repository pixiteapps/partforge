// The native core's failure handling and edge cases (src/framework/core/), each a
// finding from the PR #262 review: the core must never change an answer, never
// corrupt itself, and never hand a caller something it has to free.
import { afterEach, expect, test } from "vitest";
import { creasedNormals, creasedNormalsJS } from "../src/framework/geometry/creased-normals.js";
import { buildBVH, cachedBVH, disposeBVHs } from "../src/framework/oracle/bvh.js";
import { meshGaps } from "../src/framework/oracle/gaps.js";
import { minWall } from "../src/framework/oracle/min-wall.js";
import { core, RECYCLE_BYTES, releaseIfIdle, setCoreEnabled, setCoreForTesting } from "../src/framework/core/core.js";

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

test("an idle instance that grew past RECYCLE_BYTES is dropped, and the next pass boots a small one", () => {
  const c = core();
  const grow = Math.ceil((RECYCLE_BYTES + 1 - c.x.memory.buffer.byteLength) / 65536);
  c.x.memory.grow(grow); // stand-in for a big preview mesh's peak
  const bvh = cachedBVH({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  releaseIfIdle(c);
  expect(core()).toBe(c); // a live core BVH pins it
  disposeBVHs([bvh]); // ...and disposing the last one releases it
  const next = core();
  expect(next).not.toBe(c);
  expect(next.x.memory.buffer.byteLength).toBeLessThan(RECYCLE_BYTES);
  const g = fan(0.2);
  same(creasedNormals(g), creasedNormalsJS(g)); // and the fresh instance still answers
});

test("a big creasedNormals pass recycles its instance once it returns", () => {
  const side = 400; // 320k triangles: ~46 MB at ~145 B/tri, then pushed over by growing
  const nv = (side + 1) ** 2, vp = new Float32Array(nv * 3), tv = new Uint32Array(side * side * 6);
  for (let y = 0; y <= side; y++) for (let x = 0; x <= side; x++) { const i = (y * (side + 1) + x) * 3; vp[i] = x; vp[i + 1] = y; vp[i + 2] = Math.sin(x * 0.1) * Math.cos(y * 0.1); }
  let t = 0;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) { const a = y * (side + 1) + x, b = a + 1, c = a + side + 1, d = c + 1; tv.set([a, b, d, a, d, c], t); t += 6; }
  const g = { numProp: 3, vertProperties: vp, triVerts: tv, runIndex: new Uint32Array([0, tv.length]), runOriginalID: new Uint32Array([1]) };
  const c = core();
  c.x.memory.grow(Math.ceil(RECYCLE_BYTES / 65536)); // already large before the pass
  creasedNormals(g);
  expect(core()).not.toBe(c);
});
