// The native core's data structures (native/README.md) differ from the JS's —
// flat hash maps, bucketed edge pairing, a vertex-major normals walk, a
// leaf-ordered BVH — and the BVH build (a binned surface-area heuristic) has a
// JS twin it must match node for node. Each must still reach the JS's exact
// answer. The reference parts
// (core-parity.test.js) are manifold, NaN-free and have no ties to speak of;
// these meshes are built to reach the cases they don't.
import { afterEach, expect, test } from "vitest";
import { creasedNormalsJS } from "../src/framework/geometry/creased-normals.js";
import { creasedNormalsCore } from "../src/framework/core/creased-normals-core.js";
import { buildCoreBVH } from "../src/framework/core/bvh-core.js";
import { buildBVH, triangleVertices } from "../src/framework/oracle/bvh.js";
import { minWall } from "../src/framework/oracle/min-wall.js";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { NativeSession } from "../src/framework/core/implicit-core.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";

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
// exact centroid ties the build's stable partition must keep in order —
// shuffled (deterministically) so the build has real work. Most cells lie flat in a row along x; every fifth instead
// stands in the plane x = 0 — stacked above the row's middle, so a split along
// x meets all of them as one tie — its copies alternately at -0 and +0:
// centroids that compare equal but whose bits differ.
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

// native/bvh.cpp's bvh_fingerprint, over the JS BVH's arrays.
function fingerprint(js) {
  let h = 2166136261;
  const word = (w) => { for (let i = 0; i < 4; i++) { h ^= (w >>> (8 * i)) & 255; h = Math.imul(h, 16777619) >>> 0; } };
  const bits = new Uint32Array(js._bounds.buffer, js._bounds.byteOffset, js._bounds.length * 2);
  for (let n = 0; n < js._meta.length / 2; n++) {
    for (let k = 0; k < 12; k++) word(bits[n * 12 + k]);
    word(js._meta[n * 2]); word(js._meta[n * 2 + 1]);
  }
  for (const id of js._order) word(id);
  return h >>> 0;
}

function expectSameIndex(mesh, queries) {
  const c = core();
  expect(c).not.toBeNull();
  const js = buildBVH(mesh);
  const nat = buildCoreBVH(c, triangleVertices(mesh), () => buildBVH(mesh));
  try {
    // The same tree, node for node — then the same answers.
    expect(c.x.bvh_fingerprint(nat.handle) >>> 0).toBe(fingerprint(js));
    expect(nat.rootBounds).toEqual(js.rootBounds);
    for (const { ray, point } of queries) {
      if (ray) expect(nat.raycast(...ray)).toEqual(js.raycast(...ray));
      expect(nat.closestPoint(point)).toEqual(js.closestPoint(point));
    }
  } finally {
    nat.dispose();
  }
}

test("BVH build: tied and signed-zero centroids build the same tree as the JS", () => {
  // dup 20: piles of coincident triangles over MAX_LEAF, which no plane can
  // separate — the build halves them as they stand.
  for (const [count, dup] of [[6000, 3], [1500, 4], [2000, 20]]) {
    expectSameIndex(tiedSoup(count, dup), probes(count, dup));
    expectSameIndex(tiedSoup(count, dup, Float64Array), probes(count, dup));
  }
});

test("BVH build: NaN and infinite coordinates build the same tree as the JS", () => {
  // No sort is involved, so a NaN is handled by the same expressions on both
  // sides. A triangle's box skips a NaN coordinate, so one NaN vertex leaves
  // its centroid real; a ±Infinity span makes every cost infinite (that node
  // is halved); a triangle whose x coordinates are ALL NaN has a NaN centroid
  // that reaches the bin formula, and an empty box whose negative extent wins
  // the cost comparison.
  const row = Array.from({ length: 200 }, (_, i) => [i, 0, 0, i + 0.5, 0, 0, i, 0.5, 0.1]);
  for (const k of [0, 3, 6]) row[77][k] = NaN; // x all NaN, in a row split along x
  expectSameIndex({ positions: Float64Array.from(row.flat()) }, []);
  const nanMid = tiedSoup(5000, 2);
  nanMid.positions[9 * 1234 + 7] = NaN;
  expectSameIndex(nanMid, probes(5000, 2));
  const nanFirst = tiedSoup(5000, 2);
  nanFirst.positions[9 * 77 + 1] = NaN;
  expectSameIndex(nanFirst, probes(5000, 2));
  const inf = tiedSoup(3000, 3);
  inf.positions[0] = -Infinity; inf.positions[3] = Infinity;
  expectSameIndex(inf, probes(3000, 3));
});

test("BVH build: a mesh that drives the build past its depth limit matches the JS", () => {
  // Triangles at doubling distances, each sized to its distance: the area
  // heuristic peels a few off per level, so the tree passes DEPTH_LIMIT (48;
  // this one reaches 52) and halves its ranges below it.
  const n = 300, tris = [];
  for (let i = 0; i < n; i++) { const x = 2 ** i, s = x / 1000; tris.push([x, 0, 0, x + s, 0, 0, x, s, 0]); }
  const mesh = { positions: Float64Array.from(tris.flat()) };
  const queries = tris.map(([x]) => ({ ray: [[x * 1.0002, x * 0.0002, x], [0, 0, -1]], point: [x * 1.0002, x * 0.0002, x * 0.001] }));
  expectSameIndex(mesh, queries);
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

test("BVH build: every reference part's tree is the JS's, node for node", async () => {
  const { bootManifoldKernel, buildView } = await import("../src/testing.js");
  const kernel = await bootManifoldKernel();
  for (const name of ["filleted-box", "lattice-box", "propeller", "gasket"]) {
    const part = (await import(`../src/parts/${name}.js`)).default;
    for (const { mesh } of buildView(kernel, part, Object.keys(part.views)[0])) {
      if (mesh.positions?.length) expectSameIndex(mesh, []);
    }
  }
  kernel.cleanup?.();
}, 120_000);

// A UV sphere of radius 3 whose vertices are jittered ALONG the surface (an LCG, so
// fixed): two poles of valence `seg`, far past what the mesher makes, and thin,
// skewed triangles all round, so the collapse's flip test has triangles to refuse.
function jitteredSphere(seg, rings, noise, seed) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const verts = [[0, 0, 3], [0, 0, -3]], tris = [];
  for (let r = 1; r < rings; r++) for (let i = 0; i < seg; i++) {
    const th = (Math.PI * (r + 0.9 * noise * rnd())) / rings, ph = (2 * Math.PI * (i + 1.8 * noise * rnd())) / seg;
    verts.push([3 * Math.sin(th) * Math.cos(ph), 3 * Math.sin(th) * Math.sin(ph), 3 * Math.cos(th)]);
  }
  const id = (r, i) => 2 + (r - 1) * seg + (i % seg);
  for (let i = 0; i < seg; i++) tris.push([0, id(1, i), id(1, i + 1)], [1, id(rings - 1, i + 1), id(rings - 1, i)]);
  for (let r = 1; r < rings - 1; r++) for (let i = 0; i < seg; i++) {
    tris.push([id(r, i), id(r + 1, i), id(r + 1, i + 1)], [id(r, i), id(r + 1, i + 1), id(r, i + 1)]);
  }
  return { positions: Float64Array.from(verts.flat()), indices: Uint32Array.from(tris.flat()), vertLeaf: new Int32Array(verts.length) };
}

test("implicit cleanup: the collapse's CSR incident lists see every triangle the JS's vt lists do", () => {
  // The ring test counts common neighbours through the incident lists, and the flip
  // test walks every surviving triangle around both ends of an edge: a list that
  // loses, repeats or misplaces a triangle lets through (or refuses) a collapse the
  // JS does not, and the bytes differ. Checked by breaking the lists: dropping each
  // list's last triangle breaks the first four meshes; dropping its first (usually
  // the triangle being walked, which the flip test skips anyway) breaks the fifth.
  const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
  const store = evaluateLeaves(plan);
  const s = new NativeSession(core());
  try {
    for (const t of plan.textures) s.addTexture(t);
    for (const p of plan.programs) s.addProgram(p);
    s.sample(plan, { readBack: false });
    for (const [noise, collapseFrac, seed] of [[0.6, 0.5, 1], [0.6, 0.5, 3], [0.6, 0.6, 2], [0.7, 0.6, 1], [0.8, 0.5, 4]]) {
      const mesh = jitteredSphere(40, 8, noise, seed);
      for (const relaxPasses of [0, 2]) {
        const opts = { ...CLEANUP, collapseFrac, relaxPasses };
        const js = cleanupMesh(store, mesh, opts);
        expect(js.indices.length).toBeLessThan(mesh.indices.length);   // collapses happened
        s.loadMesh(mesh);
        const nat = s.cleanup(opts);
        for (const k of ["positions", "indices", "vertLeaf", "normals"]) expect(bytes(nat[k]), `${k} (seed ${seed}, ${collapseFrac})`).toBe(bytes(js[k]));
      }
    }
  } finally {
    s.destroy();
  }
});
test("implicit cleanup: decimation's repeated passes and angle guard decide what the JS's do", () => {
  // The preview tier's passes rebuild the incident lists from each compacted mesh, and
  // the guard reads every corner around an edge twice (after the move, then — only
  // when that is too sharp — as it stands). A jittered sphere makes collapses the
  // guard refuses, ones it lets through because a sliver was already there, and
  // passes that stop early; each guard angle and pass count must match byte for byte.
  const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
  const store = evaluateLeaves(plan);
  const s = new NativeSession(core());
  try {
    for (const t of plan.textures) s.addTexture(t);
    for (const p of plan.programs) s.addProgram(p);
    s.sample(plan, { readBack: false });
    for (const [noise, seed] of [[0.6, 1], [0.7, 2], [0.8, 4]]) {
      const mesh = jitteredSphere(40, 8, noise, seed);
      const plain = cleanupMesh(store, mesh, CLEANUP);
      for (const [decimateMinAngle, decimatePasses, decimateFrac] of [[15, 4, 1.5], [30, 4, 1.5], [0, 2, 2], [15, 1, 3]]) {
        const opts = { ...PREVIEW_CLEANUP, decimateMinAngle, decimatePasses, decimateFrac };
        const js = cleanupMesh(store, mesh, opts);
        expect(js.indices.length).toBeLessThan(plain.indices.length);   // decimation happened
        s.loadMesh(mesh);
        const nat = s.cleanup(opts);
        for (const k of ["positions", "indices", "vertLeaf", "normals"]) expect(bytes(nat[k]), `${k} (seed ${seed}, ${decimateMinAngle}°, ${decimatePasses} passes)`).toBe(bytes(js[k]));
      }
    }
  } finally {
    s.destroy();
  }
});

