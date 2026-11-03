import { afterAll, expect, test } from "vitest";
import { buildBVH, cachedBVH, coreBVHCache, disposeBVHs } from "../src/framework/oracle/bvh.js";
import { composePose, invertRigid, mulMat4, transformPositions } from "../src/framework/geometry/pose.js";
import { setCoreEnabled } from "../src/testing.js";

afterAll(() => setCoreEnabled(true));

function boxMesh(sx, sy, sz, o = [0, 0, 0]) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
    .map((p) => [p[0] + o[0], p[1] + o[1], p[2] + o[2]]);
  const quads = [[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]];
  const pos = [];
  for (const [a, b, c, d] of quads) for (const i of [a, b, c, a, c, d]) pos.push(...v[i]);
  return { positions: pos };
}

function sphereMesh(r, nu = 16, nv = 10) {
  const P = (i, j) => {
    const th = (i / nu) * 2 * Math.PI, ph = (j / nv) * Math.PI;
    return [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)];
  };
  const pos = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return { positions: pos };
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const randPose = (spread) => composePose([
  { t: "rotate", axis: [rnd() - 0.5, rnd() - 0.5, rnd() + 0.1], deg: rnd() * 360, center: [0, 0, 0] },
  { t: "translate", v: [(rnd() - 0.5) * spread, (rnd() - 0.5) * spread, (rnd() - 0.5) * spread] },
]);
const moved = (mesh, m) => {
  const p = Float64Array.from(mesh.positions);
  transformPositions(p, m);
  return { positions: Array.from(p) };
};

test("identity matches distanceTo", () => {
  const a = buildBVH(boxMesh(10, 10, 10)), b = buildBVH(boxMesh(4, 4, 4, [14, 3, 2]));
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const want = a.distanceTo(b), got = a.distanceToPosed(b, I, I);
  expect(got.distance).toBe(want.distance);
  expect(got.at).toEqual(want.at);
  expect(got.pointA).toEqual(want.pointA);
  expect(got.pointB).toEqual(want.pointB);
});

test("matches pre-transformed meshes", () => {
  const A = sphereMesh(6), B = boxMesh(5, 7, 3);
  const a = buildBVH(A), b = buildBVH(B);
  for (let n = 0; n < 20; n++) {
    const mA = randPose(10), mB = randPose(30);
    const want = buildBVH(moved(A, mA)).distanceTo(buildBVH(moved(B, mB)));
    const got = a.distanceToPosed(b, mA, mB);
    expect(Math.abs(got.distance - want.distance)).toBeLessThan(1e-6);
    if (want.distance > 1e-6) for (let k = 0; k < 3; k++) {
      // the closest pair can tie; the gap must at least be realized by the points
      expect(Math.abs(Math.hypot(...got.pointA.map((v, i) => v - got.pointB[i])) - want.distance)).toBeLessThan(1e-6);
      expect(Math.abs(got.at[k] - (got.pointA[k] + got.pointB[k]) / 2)).toBeLessThan(1e-9);
    }
  }
});

test("at, pointA and pointB agree with the pre-transformed query on a unique closest pair", () => {
  // corner-to-corner gap along the diagonal: one closest pair, so the points are comparable
  const A = boxMesh(10, 10, 10), B = boxMesh(4, 4, 4, [30, 30, 30]);
  const a = buildBVH(A), b = buildBVH(B);
  for (let n = 0; n < 5; n++) {
    const mA = randPose(20), mB = randPose(20);
    const want = buildBVH(moved(A, mA)).distanceTo(buildBVH(moved(B, mB)));
    const got = a.distanceToPosed(b, mA, mB);
    expect(Math.abs(got.distance - want.distance)).toBeLessThan(1e-6);
    for (const key of ["at", "pointA", "pointB"]) for (let k = 0; k < 3; k++) {
      expect(Math.abs(got[key][k] - want[key][k])).toBeLessThan(1e-6);
    }
  }
});

test("touching reads 0", () => {
  const a = buildBVH(boxMesh(10, 10, 10)), b = buildBVH(boxMesh(10, 10, 10));
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const T = composePose([{ t: "translate", v: [10, 0, 0] }]);
  expect(a.distanceToPosed(b, I, T).distance).toBe(0);
  const R = randPose(0);
  expect(a.distanceToPosed(b, R, mulMat4(R, T)).distance).toBeLessThan(1e-9);
});

test("core index on one side gives the same result", () => {
  setCoreEnabled(true);
  const cache = coreBVHCache();
  const A = sphereMesh(6), B = boxMesh(5, 7, 3);
  const coreA = cachedBVH(A, cache), jsB = buildBVH(B), coreB = cachedBVH(B, cache);
  const mA = randPose(10), mB = randPose(30);
  const want = buildBVH(A).distanceToPosed(jsB, mA, mB);
  for (const [x, y] of [[coreA, jsB], [buildBVH(A), coreB], [coreA, coreB]]) {
    const got = x.distanceToPosed(y, mA, mB);
    expect(got.distance).toBeCloseTo(want.distance, 9);
    expect(got.at[0]).toBeCloseTo(want.at[0], 9);
  }
  expect(coreA.insideOf(jsB, mA, mB)).toBe(buildBVH(A).insideOf(jsB, mA, mB));
  disposeBVHs(cache.values());
});

test("insideOf: small cube inside a large one, outside when offset, invariant under a shared rotation", () => {
  const big = buildBVH(boxMesh(20, 20, 20)), small = buildBVH(boxMesh(2, 2, 2));
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const mid = composePose([{ t: "translate", v: [9, 9, 9] }]);
  const far = composePose([{ t: "translate", v: [30, 9, 9] }]);
  expect(small.insideOf(big, mid, I)).toBe(true);
  expect(small.insideOf(big, far, I)).toBe(false);
  expect(big.insideOf(small, I, mid)).toBe(false);
  const R = randPose(7);
  expect(small.insideOf(big, mulMat4(R, mid), R)).toBe(true);
  expect(small.insideOf(big, mulMat4(R, far), R)).toBe(false);
});

test("insideOf survives a ray that grazes an edge", () => {
  const big = buildBVH(boxMesh(20, 20, 20)), small = buildBVH(boxMesh(2, 2, 2));
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  // the +X ray from small's first vertex runs exactly along big's y=10,z=10 line: through the
  // diagonal seam of the x=20 face (quad split a-c)
  const at = composePose([{ t: "translate", v: [10, 10, 10] }]);
  expect(small.insideOf(big, at, I)).toBe(true);
});

test("maxDistance: a pair within it reads the uncut answer exactly; one past it reads Infinity", () => {
  const A = sphereMesh(6), B = boxMesh(5, 7, 3);
  const a = buildBVH(A), b = buildBVH(B);
  for (let n = 0; n < 20; n++) {
    const mA = randPose(10), mB = randPose(30);
    const want = a.distanceToPosed(b, mA, mB);
    const within = a.distanceToPosed(b, mA, mB, want.distance + 0.5);
    expect(Object.is(within.distance, want.distance)).toBe(true);
    expect(within.pointA).toEqual(want.pointA);
    expect(within.pointB).toEqual(want.pointB);
    const exact = a.distanceToPosed(b, mA, mB, want.distance);
    expect(exact.distance).toBe(want.distance);
    if (want.distance > 0.1) {
      const past = a.distanceToPosed(b, mA, mB, want.distance - 0.05);
      expect(past.distance).toBe(Infinity);
      expect(past.pointA).toBeNull();
    }
  }
  // a cutoff of 0 still finds a touch
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const T = [1,0,0,0, 0,1,0,0, 0,0,1,0, 5,0,0,1];
  expect(buildBVH(boxMesh(5, 5, 5)).distanceToPosed(buildBVH(boxMesh(5, 5, 5)), I, T, 0).distance).toBe(0);
});
