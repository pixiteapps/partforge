// The native core's data structures (native/README.md) differ from the JS's —
// flat hash maps, bucketed edge pairing, a vertex-major normals walk, a
// leaf-ordered BVH whose build skips or radix-sorts where that gives the same
// order — and each must still reach the JS's exact answer. The reference parts
// (core-parity.test.js) are manifold, NaN-free and have no ties to speak of;
// these meshes are built to reach the cases they don't.
import { afterEach, expect, test } from "vitest";
import { creasedNormalsJS } from "../src/framework/geometry/creased-normals.js";
import { creasedNormalsCore } from "../src/framework/core/creased-normals-core.js";
import { buildCoreBVH } from "../src/framework/core/bvh-core.js";
import { buildBVH, cachedBVH, triangleVertices } from "../src/framework/oracle/bvh.js";
import { minWall } from "../src/framework/oracle/min-wall.js";
import { core, coreStatus, setCoreForTesting } from "../src/framework/core/core.js";

afterEach(() => setCoreForTesting(undefined));

const bytes = (a) => (a ? Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("hex") : null);
const expectSameShading = (g) => {
  const c = core();
  expect(c).not.toBeNull();
  const got = creasedNormalsCore(c, g);
  expect(got).not.toBeNull(); // the core took the mesh — this is not the JS pass twice
  const want = creasedNormalsJS(g);
  for (const k of ["positions", "normals", "edges"]) expect(bytes(got[k]), k).toBe(bytes(want[k]));
  return want;
};

// MeshGL over explicit triangles, one run.
const meshGL = (verts, tris) => ({
  numProp: 3,
  vertProperties: Float32Array.from(verts.flat()),
  triVerts: Uint32Array.from(tris.flat()),
  runIndex: new Uint32Array([0, tris.length * 3]),
  runOriginalID: new Uint32Array([1]),
});

test("an edge shared by three or four triangles pairs its sightings in order, as the JS Map does", () => {
  // Pages of a book on the spine 0-1: the 2nd sighting meets the 1st and the
  // 4th the 3rd; a 3rd page alone is left unpaired. Folded at different
  // angles so each pairing yields a different (or no) feature edge.
  const page = (deg) => [Math.cos((deg * Math.PI) / 180), 0, Math.sin((deg * Math.PI) / 180)];
  const verts = [[0, 0, 0], [0, 1, 0], page(0), page(100), page(170), page(260)];
  for (const n of [3, 4]) {
    const tris = [[0, 1, 2], [1, 0, 3], [0, 1, 4], [1, 0, 5]].slice(0, n);
    const out = expectSameShading(meshGL(verts, tris));
    expect(out.edges.length).toBeGreaterThan(0);
  }
});

test("a vertex with a large fan (over the buckets' insertion-sort size) shades and pairs the same", () => {
  const n = 40, verts = [[0, 0, 0]], tris = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    verts.push([Math.cos(a), Math.sin(a), (i % 3) * 0.4]); // a crumpled cone: creases all round
  }
  for (let i = 0; i < n; i++) tris.push([0, 1 + i, 1 + ((i + 1) % n)]);
  const out = expectSameShading(meshGL(verts, tris));
  expect(out.edges.length).toBeGreaterThan(0);
});

// A soup of `count` small triangles in cells of `dup` coincident copies —
// exact centroid ties the build's stable sort must keep in order — shuffled
// (deterministically) so the build's sorts have real work, large ranges taking
// the radix path. Most cells lie flat in a row along x; every fifth instead
// stands in the plane x = 0 — stacked above the row's middle, so the root's
// sort along x meets all of them as one tie — its copies alternately at -0
// and +0: centroids `<` calls equal but whose bits differ.
const plane = (cell) => cell % 5 === 0;
function tiedSoup(count, dup, Store = Float32Array) {
  const cells = Math.floor(count / dup), half = Math.floor(cells / 2);
  const tris = [];
  for (let t = 0; t < count; t++) {
    const cell = Math.floor(t / dup) - half;
    const x = cell * 0.5, y = (cell % 7) * 0.25, Z = 5 + Math.abs(cell) * 0.2;
    if (plane(cell)) { const x0 = t % 2 ? -0 : 0; tris.push([x0, 0, Z, x0, 0.4, Z, x0, 0, Z + 0.15]); }
    else tris.push([x, y, 0, x + 0.4, y, 0, x, y + 0.4, 0]);
  }
  let seed = 7;
  for (let i = tris.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [tris[i], tris[j]] = [tris[j], tris[i]];
  }
  return { positions: Store.from(tris.flat()) };
}

// Rays straight down through every flat cell (each hits all of that cell's
// copies at one t), and a point just off every cell (equally close to all of
// its copies): which copy wins either query is decided by the leaf order —
// that is, by the build.
function probes(count, dup) {
  const cells = Math.floor(count / dup), half = Math.floor(cells / 2), out = [];
  for (let i = 0; i < cells; i++) {
    const cell = i - half, x = cell * 0.5, y = (cell % 7) * 0.25, Z = 5 + Math.abs(cell) * 0.2;
    out.push(plane(cell) ? { point: [0.05, 0.1, Z + 0.05] } : { ray: [[x + 0.1, y + 0.1, 3], [0, 0, -1]], point: [x + 0.1, y + 0.1, 0.2] });
  }
  return out;
}

function expectSameIndex(mesh, queries) {
  const c = core();
  expect(c).not.toBeNull();
  const js = buildBVH(mesh);
  const nat = buildCoreBVH(c, triangleVertices(mesh), () => buildBVH(mesh));
  expect(nat).not.toBeNull();
  try {
    expect(nat.rootBounds).toEqual(js.rootBounds);
    for (const { ray, point } of queries) {
      if (ray) expect(nat.raycast(...ray)).toEqual(js.raycast(...ray));
      expect(nat.closestPoint(point)).toEqual(js.closestPoint(point));
    }
  } finally {
    nat.dispose();
  }
}

test("BVH build: tied and signed-zero centroids sort the same as the JS (radix and merge paths)", () => {
  for (const [count, dup] of [[6000, 3], [1500, 4]]) { // over and under the radix threshold
    expectSameIndex(tiedSoup(count, dup), probes(count, dup));
    expectSameIndex(tiedSoup(count, dup, Float64Array), probes(count, dup));
  }
});

test("BVH build: a NaN centroid is refused, so the mesh gets the JS index", () => {
  // The JS sorts with the engine's own sort, which reads a NaN comparison as
  // "equal": that order is the sort algorithm's, not the data's, and no other
  // sort reproduces it. So the core declines such a mesh outright.
  const mesh = tiedSoup(5000, 2);
  mesh.positions[9 * 1234 + 7] = NaN; // the third vertex's y: its min/max pick it, so the centroid is NaN
  const c = core();
  expect(buildCoreBVH(c, triangleVertices(mesh), () => buildBVH(mesh))).toBeNull();
  const before = coreStatus().refusedMeshes;
  const index = cachedBVH(mesh);
  expect(index.core).toBeUndefined(); // the JS index
  expect(coreStatus().refusedMeshes).toBe(before + 1);
  expect(core()).not.toBeNull(); // a refusal is not a fault
  // A NaN vertex the min/max skip leaves a real centroid, and is built by both
  // the same way (bounds skip it too).
  const skipped = tiedSoup(5000, 2);
  skipped.positions[9 * 1234 + 1] = NaN;
  expectSameIndex(skipped, probes(5000, 2));
  const inf = tiedSoup(100, 2);
  inf.positions[0] = -Infinity; inf.positions[3] = Infinity; // a ±Infinity span: centroid NaN
  expect(buildCoreBVH(c, triangleVertices(inf), () => buildBVH(inf))).toBeNull();
});

test("min-wall casts its rays in leaf order but keeps the JS's first-wins ties", () => {
  // A plate of even thickness, finely split: every ray through it measures the
  // same wall, so the reported location (and the band's worst) is whichever
  // ray comes first in the stride walk — sampled and not.
  const rows = 30, cols = 40, h = 2, tris = [];
  const quad = (a, b, c, d) => tris.push(a, b, c, a, c, d);
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const x0 = i, x1 = i + 1, y0 = j, y1 = j + 1;
    quad([x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0]); // bottom, facing down
    quad([x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]); // top, facing up
  }
  const mesh = { positions: Float32Array.from(tris.flat()) };
  const c = core();
  const nat = buildCoreBVH(c, triangleVertices(mesh), () => buildBVH(mesh));
  const js = buildBVH(mesh);
  try {
    for (const maxSamples of [Infinity, 500]) {
      for (const band of [null, { min: 1.5, max: 3 }]) {
        expect(nat.minWall({ maxThickness: undefined, maxSamples, band }))
          .toEqual(minWall(mesh, { bvh: js, maxSamples, band }));
      }
    }
  } finally {
    nat.dispose();
  }
});
