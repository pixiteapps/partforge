// The oracle's triangle BVH and min-wall pass on the native core
// (native/bvh.cpp) — the same queries and results as oracle/bvh.js and
// oracle/min-wall.js, bit for bit.
//
// A core BVH lives in WebAssembly memory, so unlike the JS one it must be FREED:
// `dispose()`. The oracle's own callers do that — measure() for the Map it owns,
// meshGaps() for BVHs it built without one — and a FinalizationRegistry is the
// backstop for anything else. Only cachedBVH() hands these out; the public
// buildBVH() export stays the JS index, so code outside partforge never holds one.
const registry = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ x, handle }) => x.bvh_destroy(handle))
  : null;

const pt = (a, i) => (Number.isNaN(a[i]) ? null : [a[i], a[i + 1], a[i + 2]]);

// `verts`: bvh.js's triangleVertices(mesh) — 9 coords per triangle, mesh order.
export function buildCoreBVH(c, verts) {
  const { x } = c;
  const ptr = x.malloc(verts.byteLength || 1);
  new Uint8Array(x.memory.buffer, ptr, verts.byteLength).set(new Uint8Array(verts.buffer, verts.byteOffset, verts.byteLength));
  // adopt = 1: the C++ index owns the vertex buffer from here (no second copy)
  const handle = x.bvh_build(ptr, verts.length / 9, verts instanceof Float64Array ? 1 : 0, 1);
  x.bvh_root_bounds(handle, c.scratch + 64);
  const rb = c.f64().slice(8, 14);
  let live = true;
  const token = {};
  registry?.register(token, { x, handle }, token);
  const self = {
    core: c,
    triangleCount: verts.length / 9,
    rootBounds: [rb[0], rb[1], rb[2], rb[3], rb[4], rb[5]],
    get handle() {
      if (!live) throw new Error("core BVH used after dispose()");
      return handle;
    },
    raycast(origin, dir, { tMin = 1e-6, tMax = Infinity, skipTri = -1 } = {}) {
      const s = c.f64();
      s[0] = origin[0]; s[1] = origin[1]; s[2] = origin[2]; s[3] = dir[0]; s[4] = dir[1]; s[5] = dir[2];
      const tri = x.bvh_raycast(self.handle, c.scratch, c.scratch + 24, tMin, tMax, skipTri, c.scratch + 64);
      return tri === -1 ? null : { t: c.f64()[8], tri };
    },
    closestPoint(p) {
      const s = c.f64();
      s[0] = p[0]; s[1] = p[1]; s[2] = p[2];
      const tri = x.bvh_closest_point(self.handle, c.scratch, c.scratch + 64);
      const o = c.f64();
      return { point: tri === -1 ? null : [o[8], o[9], o[10]], dist: o[11], tri };
    },
    // Exact minimum surface-to-surface distance to ANOTHER core BVH (cachedBVH
    // hands out one kind per call, so the two are always the same kind).
    distanceTo(other) {
      if (other?.core !== c) throw new Error("core BVH distanceTo needs another core BVH");
      const ok = x.bvh_distance_to(self.handle, other.handle, c.scratch + 64);
      if (!ok) return { distance: Infinity, at: null, pointA: null, pointB: null };
      const r = c.f64();
      return { distance: r[8], at: [r[9], r[10], r[11]], pointA: [r[12], r[13], r[14]], pointB: [r[15], r[16], r[17]] };
    },
    dispose() {
      if (!live) return;
      live = false;
      registry?.unregister(token);
      x.bvh_destroy(handle);
    },
  };
  return self;
}

// minWall over a core BVH — min-wall.js's result shape exactly. min-wall.js
// dispatches here and passes its own resolved options (maxSamples included).
export function coreMinWall(bvh, { maxThickness, maxSamples, band = null }) {
  const c = bvh.core;
  const ok = c.x.bvh_min_wall(bvh.handle, maxThickness == null ? NaN : maxThickness, maxSamples,
    band ? 1 : 0, band ? band.min : 0, band ? band.max : 0, c.scratch + 64);
  if (!ok) return null;
  const r = c.f64().slice(8, 20);
  return {
    value: Number.isNaN(r[0]) ? null : r[0], location: pt(r, 1), sampled: r[4] === 1,
    sampledTriangles: r[5], totalTriangles: r[6],
    band: band ? { value: Number.isNaN(r[7]) ? null : r[7], location: pt(r, 8), members: r[11] } : null,
  };
}
