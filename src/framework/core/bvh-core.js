// The oracle's triangle BVH and min-wall pass on the native core
// (native/bvh.cpp) — the same queries and results as oracle/bvh.js and
// oracle/min-wall.js, bit for bit.
//
// A core BVH lives in WebAssembly memory, so unlike the JS one it must be FREED:
// `dispose()`. The oracle's own callers do that — measure() for the Map it owns,
// meshGaps() for BVHs it built without one — and a FinalizationRegistry is the
// backstop for anything else. Only partforge's own call paths get these (see
// cachedBVH); the public buildBVH() and a caller-supplied bvhCache stay JS.
//
// Every query has a JS twin to fall back on — `jsIndex()`, the JS BVH of the
// same mesh, built on first need. A fault inside the module poisons the instance
// (core.js) and the query is answered by that twin instead, as is a distanceTo
// whose other side is not a core BVH of the same instance.
import { poisonCore, releaseIfIdle } from "./core.js";

const registry = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ c, handle }) => {
    c.live--;
    if (!c.poisoned) c.x.bvh_destroy(handle);
    releaseIfIdle(c);
  })
  : null;

const pt = (a, i) => (Number.isNaN(a[i]) ? null : [a[i], a[i + 1], a[i + 2]]);

// `verts`: bvh.js's triangleVertices(mesh) — 9 coords per triangle, mesh order.
// `makeJsIndex`: builds the JS BVH of the same mesh (the fallback), on demand.
// Throws if the module faults while building; the caller falls back.
export function buildCoreBVH(c, verts, makeJsIndex) {
  const { x } = c;
  const ptr = c.alloc(verts.byteLength);
  new Uint8Array(x.memory.buffer, ptr, verts.byteLength).set(new Uint8Array(verts.buffer, verts.byteOffset, verts.byteLength));
  // adopt = 1: the C++ index owns the vertex buffer from here (no second copy)
  const handle = x.bvh_build(ptr, verts.length / 9, verts instanceof Float64Array ? 1 : 0, 1);
  x.bvh_root_bounds(handle, c.scratch + 64);
  const rb = c.f64().slice(8, 14);
  c.live++;
  let live = true, js = null;
  const token = {};
  registry?.register(token, { c, handle }, token);
  const jsIndex = () => (js ??= makeJsIndex());
  // Run `fn` on the core, or answer with `fallback` if the instance is (or
  // becomes) unusable.
  const guarded = (fn, fallback) => {
    if (!live) throw new Error("core BVH used after dispose()");
    if (c.poisoned) return fallback();
    try {
      return fn();
    } catch (err) {
      poisonCore(c, err);
      return fallback();
    }
  };
  const self = {
    core: c,
    triangleCount: verts.length / 9,
    rootBounds: [rb[0], rb[1], rb[2], rb[3], rb[4], rb[5]],
    get handle() { return handle; },
    jsIndex,
    raycast(origin, dir, opts = {}) {
      const { tMin = 1e-6, tMax = Infinity, skipTri = -1 } = opts;
      return guarded(() => {
        const s = c.f64();
        s[0] = origin[0]; s[1] = origin[1]; s[2] = origin[2]; s[3] = dir[0]; s[4] = dir[1]; s[5] = dir[2];
        const tri = x.bvh_raycast(handle, c.scratch, c.scratch + 24, tMin, tMax, skipTri, c.scratch + 64);
        return tri === -1 ? null : { t: c.f64()[8], tri };
      }, () => jsIndex().raycast(origin, dir, opts));
    },
    closestPoint(p) {
      return guarded(() => {
        const s = c.f64();
        s[0] = p[0]; s[1] = p[1]; s[2] = p[2];
        const tri = x.bvh_closest_point(handle, c.scratch, c.scratch + 64);
        const o = c.f64();
        return { point: tri === -1 ? null : [o[8], o[9], o[10]], dist: o[11], tri };
      }, () => jsIndex().closestPoint(p));
    },
    // Exact minimum surface-to-surface distance. Two core BVHs of the same live
    // instance meet in C++; anything else (a JS index, another instance) meets
    // through the JS twins.
    distanceTo(other) {
      const viaJs = () => jsIndex().distanceTo(other?.jsIndex ? other.jsIndex() : other);
      if (other?.core !== c || other.core.poisoned) return viaJs();
      return guarded(() => {
        const ok = x.bvh_distance_to(handle, other.handle, c.scratch + 64);
        if (!ok) return { distance: Infinity, at: null, pointA: null, pointB: null };
        const r = c.f64();
        return { distance: r[8], at: [r[9], r[10], r[11]], pointA: [r[12], r[13], r[14]], pointB: [r[15], r[16], r[17]] };
      }, viaJs);
    },
    // minWall over this index, min-wall.js's result shape exactly. min-wall.js
    // dispatches here with its own resolved options; `undefined` means "the core
    // could not answer — run the JS pass" (null is a real answer: empty mesh).
    minWall({ maxThickness, maxSamples, band = null }) {
      return guarded(() => {
        const ok = x.bvh_min_wall(handle, maxThickness == null ? 0 : 1, maxThickness == null ? 0 : maxThickness,
          maxSamples, band ? 1 : 0, band ? band.min : 0, band ? band.max : 0, c.scratch + 64);
        if (!ok) return null;
        const r = c.f64().slice(8, 20);
        return {
          value: Number.isNaN(r[0]) ? null : r[0], location: pt(r, 1), sampled: r[4] === 1,
          sampledTriangles: r[5], totalTriangles: r[6],
          band: band ? { value: Number.isNaN(r[7]) ? null : r[7], location: pt(r, 8), members: r[11] } : null,
        };
      }, () => undefined);
    },
    dispose() {
      if (!live) return;
      live = false;
      registry?.unregister(token);
      c.live--;
      if (!c.poisoned) x.bvh_destroy(handle);
      releaseIfIdle(c);
    },
  };
  return self;
}
