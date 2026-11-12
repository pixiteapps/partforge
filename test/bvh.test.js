import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { buildBVH, cachedBVH, meshTriangles, readTriangleInto } from "../src/framework/oracle/bvh.js";

// a unit-ish box [0,0,0]..[10,20,5] as a non-indexed triangle soup (12 tris)
function boxMesh(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const quads = [[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]];
  const pos = [];
  for (const [a,b,c,d] of quads) { for (const i of [a,b,c, a,c,d]) pos.push(...v[i]); }
  return { positions: pos };
}

test("raycast hits the near face and returns its distance", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const hit = bvh.raycast([5, 10, -3], [0, 0, 1]); // from below, up through z
  expect(hit).not.toBeNull();
  expect(hit.t).toBeCloseTo(3, 5);                  // z=0 face is 3 away
});

test("raycast returns the NEAREST hit, not a far one", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const hit = bvh.raycast([5, 10, -3], [0, 0, 1]);
  expect(hit.t).toBeCloseTo(3, 5);                  // not 8 (the z=5 face)
});

test("skipTri ignores the source triangle (nearest becomes the far face)", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const first = bvh.raycast([4.9, 10, -3], [0, 0, 1]);
  const second = bvh.raycast([4.9, 10, -3], [0, 0, 1], { skipTri: first.tri });
  expect(second.t).toBeCloseTo(8, 5);               // z=5 face
});

test("a ray that misses returns null", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  expect(bvh.raycast([100, 100, -3], [0, 0, 1])).toBeNull();
});

test("closestPoint on a box face returns the perpendicular foot + distance", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const r = bvh.closestPoint([5, 10, 9]);   // 4 above the z=5 top face
  expect(r.dist).toBeCloseTo(4, 5);
  expect(r.point[2]).toBeCloseTo(5, 5);
});

test("closestPoint with maxDistance finds only a point strictly nearer than it", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const p = [5, 10, 9]; // 4 above the z=5 top face
  expect(bvh.closestPoint(p, 4.5)).toEqual(bvh.closestPoint(p));
  expect(bvh.closestPoint(p, 4)).toEqual({ point: null, dist: Infinity, tri: -1 });
  expect(bvh.closestPoint(p, 1)).toEqual({ point: null, dist: Infinity, tri: -1 });
});

test("closestPoint matches a brute-force reference on the box", () => {
  const mesh = boxMesh(10, 20, 5);
  const bvh = buildBVH(mesh);
  const pts = [[-3, -3, -3], [5, 25, 2], [12, 10, 8], [5, 10, 2.5]];
  const brute = (p) => {
    let best = Infinity;
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      const o = t * 9;
      const A = [mesh.positions[o], mesh.positions[o+1], mesh.positions[o+2]];
      const B = [mesh.positions[o+3], mesh.positions[o+4], mesh.positions[o+5]];
      const C = [mesh.positions[o+6], mesh.positions[o+7], mesh.positions[o+8]];
      best = Math.min(best, Math.sqrt(distSqPointTriRef(p, A, B, C)));
    }
    return best;
  };
  for (const p of pts) expect(bvh.closestPoint(p).dist).toBeCloseTo(brute(p), 4);
});

// ── INDEXED mesh tests ─────────────────────────────────────────────────────────────────────

// Hand-written INDEXED box: 8 unique verts (24 floats), 12 tris (36 ints)
function indexedBoxMesh(sx, sy, sz) {
  const positions = [
    0, 0, 0,   sx, 0, 0,   sx, sy, 0,   0, sy, 0,
    0, 0, sz,  sx, 0, sz,  sx, sy, sz,  0, sy, sz,
  ];
  const indices = new Uint32Array([
    0,2,1, 0,3,2,
    4,5,6, 4,6,7,
    0,1,5, 0,5,4,
    1,2,6, 1,6,5,
    2,3,7, 2,7,6,
    3,0,4, 3,4,7,
  ]);
  return { positions, indices };
}

test("meshTriangles handles non-indexed soup (9-float / triangle)", () => {
  const mesh = boxMesh(10, 20, 5);
  const tris = meshTriangles(mesh);
  expect(tris).toHaveLength(12);
  // first triangle's first vertex should be [0,0,0]
  expect(tris[0][0]).toEqual([0, 0, 0]);
});

test("meshTriangles handles indexed mesh (8 unique verts, 12 tris)", () => {
  const mesh = indexedBoxMesh(10, 20, 5);
  const tris = meshTriangles(mesh);
  expect(tris).toHaveLength(12);
  // every triangle should produce 3 distinct coordinate triples
  for (const [v0, v1, v2] of tris) {
    expect(v0).toHaveLength(3);
    expect(v1).toHaveLength(3);
    expect(v2).toHaveLength(3);
  }
});

test("INDEXED mesh — raycast hits the near face", () => {
  const bvh = buildBVH(indexedBoxMesh(10, 20, 5));
  const hit = bvh.raycast([5, 10, -3], [0, 0, 1]);
  expect(hit).not.toBeNull();
  expect(hit.t).toBeCloseTo(3, 5); // z=0 face is 3 away
});

test("INDEXED mesh — closestPoint above top face returns correct distance", () => {
  const bvh = buildBVH(indexedBoxMesh(10, 20, 5));
  const r = bvh.closestPoint([5, 10, 9]); // 4 above the z=5 top face
  expect(r.dist).toBeCloseTo(4, 5);
  expect(r.point[2]).toBeCloseTo(5, 5);
});

// ── distanceTo (mesh-to-mesh) ──────────────────────────────────────────────────────────────
const translated = (mesh, [dx, dy, dz]) =>
  ({ ...mesh, positions: Array.from(mesh.positions).map((v, i) => v + [dx, dy, dz][i % 3]) });

test("distanceTo: parallel faces 0.2 apart → 0.2, at between the faces", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [10.2, 0, 0]));
  const r = a.distanceTo(b);
  expect(r.distance).toBeCloseTo(0.2, 6);
  expect(r.at[0]).toBeCloseTo(10.1, 6);
});

test("distanceTo: diagonal corner-to-corner separation is exact", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(8, 6, 4), [13, 22, 6])); // gaps x:3 y:2 z:1
  const r = a.distanceTo(b);
  expect(r.distance).toBeCloseTo(Math.sqrt(14), 6);
  expect(r.at[0]).toBeCloseTo(11.5, 6);  // midpoint of (10,20,5)–(13,22,6)
  expect(r.at[1]).toBeCloseTo(21, 6);
  expect(r.at[2]).toBeCloseTo(5.5, 6);
});

test("distanceTo: crossed-edge configuration is exact (edge–edge closest)", () => {
  const a = buildBVH({ positions: [-5, 0, 0, 5, 0, 0, 0, 0.01, 0] });   // edge along x at z=0
  const b = buildBVH({ positions: [0, -5, 1, 0, 5, 1, 0.01, 0, 1] });   // edge along y at z=1
  expect(a.distanceTo(b).distance).toBeCloseTo(1, 6);
});

test("distanceTo: touching faces read 0", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [10, 0, 0]));
  expect(a.distanceTo(b).distance).toBe(0);
});

test("distanceTo: interpenetrating boxes read 0", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [9, 0, 0]));
  expect(a.distanceTo(b).distance).toBe(0);
});

test("distanceTo: a triangle piercing another's interior reads 0", () => {
  // no vertex-face or edge-edge feature pair is near — only the piercing test sees it
  const a = buildBVH({ positions: [-10, -10, 0, 10, -10, 0, 0, 10, 0] });
  const b = buildBVH({ positions: [0, 0, -1, 0.5, 0, 1, -0.5, 0, 1] });
  expect(a.distanceTo(b).distance).toBe(0);
});

test("distanceTo is symmetric", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(8, 6, 4), [13, 22, 6]));
  expect(b.distanceTo(a).distance).toBeCloseTo(a.distanceTo(b).distance, 9);
});

test("distanceTo works across indexed and soup meshes", () => {
  const a = buildBVH(indexedBoxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [10.2, 0, 0]));
  expect(a.distanceTo(b).distance).toBeCloseTo(0.2, 6);
});

// ── memory footprint ───────────────────────────────────────────────────────────────────────

// A thick-walled tube as a non-indexed Float32 soup — exactly the shape Manifold's
// toMesh() hands back, and the dense-mesh case the footprint has to survive.
// Serialized into the child process below, so it must stay self-contained.
function tubeSoup(targetTris) {
  const segs = 116;
  const rings = Math.max(2, Math.round(targetTris / (segs * 4)));
  const pos = [];
  const pt = (r, i, j) => { const a = (2 * Math.PI * i) / segs; return [r * Math.cos(a), r * Math.sin(a), (j / rings) * 50]; };
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % segs;
    for (const r of [10, 8]) {
      const a = pt(r, i, j), b = pt(r, i2, j), c = pt(r, i2, j + 1), d = pt(r, i, j + 1);
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  return { positions: new Float32Array(pos) };
}

test("the BVH keeps its triangles in flat typed arrays and accounts for its own bytes", () => {
  const mesh = tubeSoup(20_000);
  const bvh = buildBVH(mesh);
  expect(bvh.triangleCount).toBe(mesh.positions.length / 9);
  expect(ArrayBuffer.isView(bvh.vertices)).toBe(true);
  expect(bvh.vertices.length).toBe(bvh.triangleCount * 9);
  // The self-report, not a memory measurement (the child-process test below is
  // that). Its job is the index's COMPOSITION: at ~74 B/triangle for a Float32
  // soup, widening `vertices` to Float64 alone would breach this — and would slip
  // clean through the 300-byte retention bound below.
  expect(bvh.bytesAllocated / bvh.triangleCount).toBeLessThan(120);
});

// The self-reported `bytesAllocated` above only counts what the BVH knows it
// allocated, so
// it cannot catch a regression that reintroduces per-triangle JS objects. This one
// weighs the real thing: a child process with --expose-gc, a full collection either
// side of the build, and heapUsed + external so typed-array backing stores (which
// live off the JS heap) are counted too. Measuring only what survives a collection
// while the BVH is still reachable makes it a retention number, not a peak — stable
// to a few bytes per triangle run to run, which is why a 300-byte bound is safe.
test("buildBVH retains ~100 bytes/triangle, not ~1 KB (measured with --expose-gc)", () => {
  const bvhUrl = new URL("../src/framework/oracle/bvh.js", import.meta.url).href;
  const src = `
    ${tubeSoup.toString()}
    const { buildBVH } = await import(${JSON.stringify(bvhUrl)});
    const mesh = tubeSoup(100000);
    const settle = () => { for (let i = 0; i < 4; i++) global.gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
    const before = settle();
    const bvh = buildBVH(mesh);
    const after = settle();
    console.log(JSON.stringify({ bytesPerTri: (after - before) / bvh.triangleCount }));
  `;
  // Assumes process.execPath is the node binary running this suite, so it accepts
  // --expose-gc; a runner that shells out to something else would fail here loudly.
  const out = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", src],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1 << 20 });
  const { bytesPerTri } = JSON.parse(out.trim().split("\n").pop());
  expect(bytesPerTri).toBeGreaterThan(0);    // sanity: the measurement saw the build at all
  expect(bytesPerTri).toBeLessThan(300);     // the nested-array representation cost ~950
});

// ── reference closest-point-on-triangle (Ericson) for the brute-force check ────────────────
function distSqPointTriRef(P, A, B, C) {
  const sub = (p, q) => [p[0]-q[0], p[1]-q[1], p[2]-q[2]];
  const dot = (p, q) => p[0]*q[0] + p[1]*q[1] + p[2]*q[2];
  const add = (p, q) => [p[0]+q[0], p[1]+q[1], p[2]+q[2]];
  const mul = (p, s) => [p[0]*s, p[1]*s, p[2]*s];
  const ab = sub(B,A), ac = sub(C,A), ap = sub(P,A);
  const d1 = dot(ab,ap), d2 = dot(ac,ap); if (d1<=0&&d2<=0) return dot(ap,ap);
  const bp = sub(P,B), d3 = dot(ab,bp), d4 = dot(ac,bp); if (d3>=0&&d4<=d3) return dot(bp,bp);
  const vc = d1*d4 - d3*d2; if (vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);const q=add(A,mul(ab,v));const pq=sub(P,q);return dot(pq,pq);}
  const cp = sub(P,C), d5 = dot(ab,cp), d6 = dot(ac,cp); if (d6>=0&&d5<=d6) return dot(cp,cp);
  const vb = d5*d2 - d1*d6; if (vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);const q=add(A,mul(ac,w));const pq=sub(P,q);return dot(pq,pq);}
  const va = d3*d6 - d5*d4; if (va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const w=(d4-d3)/((d4-d3)+(d5-d6));const q=add(B,mul(sub(C,B),w));const pq=sub(P,q);return dot(pq,pq);}
  const denom=1/(va+vb+vc); const v=vb*denom, w=vc*denom; const q=add(add(A,mul(ab,v)),mul(ac,w)); const pq=sub(P,q); return dot(pq,pq);
}

// ── the vertex store's public reading contract ────────────────────────────────

test("readTriangleInto decodes triangle t of a vertex store into a reusable buffer", () => {
  // The one decode of the 9-float v0v1v2 layout outside bvh.js's own queries, so
  // min-wall never hand-rolls the stride: triangle t must be mesh triangle t.
  const mesh = boxMesh(10, 20, 5);
  const bvh = buildBVH(mesh);
  const out = new Float64Array(9);
  const tris = meshTriangles(mesh);
  for (const t of [0, 5, 11]) {
    expect(readTriangleInto(bvh.vertices, t, out)).toBe(out);      // fills in place
    expect([...out]).toEqual(tris[t].flat());                      // …with mesh triangle t
  }
});

test("rootBounds is the mesh's own AABB, and a copy of it", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  expect(bvh.rootBounds).toEqual([0, 0, 0, 10, 20, 5]);
  bvh.rootBounds[0] = 99;
  expect(buildBVH(boxMesh(10, 20, 5)).rootBounds[0]).toBe(0);      // nothing shared
  expect(bvh.raycast([5, 10, -3], [0, 0, 1]).t).toBeCloseTo(3, 5); // tree undisturbed
});

test("an indexed mesh's rootBounds ignores vertices no triangle references", () => {
  const mesh = indexedBoxMesh(10, 20, 5);
  mesh.positions = [...mesh.positions, 500, 500, 500];             // an orphan vertex
  expect(buildBVH(mesh).rootBounds).toEqual([0, 0, 0, 10, 20, 5]);
});

// ── cachedBVH: caller-owned, caller-scoped memoization ───────────────────────

test("cachedBVH memoizes per mesh in a caller-owned cache, and builds fresh without one", () => {
  const mesh = boxMesh(10, 20, 5);
  const cache = new Map();
  const a = cachedBVH(mesh, cache);
  expect(cachedBVH(mesh, cache)).toBe(a);              // same mesh object → same index
  expect(cache.size).toBe(1);
  expect(cachedBVH(mesh)).not.toBe(a);                 // no cache → build fresh, exactly as before
  const other = boxMesh(4, 4, 4);
  expect(cachedBVH(other, cache)).not.toBe(a);
  expect(cache.size).toBe(2);
});
