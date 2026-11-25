// SPIKE (throwaway): a k.implicit leaf whose distance is a solid's own mesh.
// solidField(solid) → { kind: "field", fn, box, label } for a k.implicit tree.
// Distance: exact nearest-surface distance from the oracle BVH. Sign: the nearest
// triangle's normal when the nearest point is inside a face, else ray parity.
import { buildBVH, insideShared } from "../../src/framework/oracle/bvh.js";

const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
let serial = 0;
export const stats = { calls: 0, rays: 0, buildMs: 0, tris: 0 };

export function solidField(solid, { shift = 0 } = {}) {
  const t0 = performance.now();
  const mesh = solid.toMesh();
  const bvh = buildBVH(mesh);
  const V = bvh.vertices;
  const tris = V.length / 9;
  const N = new Float64Array(tris * 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ux = V[o + 3] - V[o], uy = V[o + 4] - V[o + 1], uz = V[o + 5] - V[o + 2];
    const vx = V[o + 6] - V[o], vy = V[o + 7] - V[o + 1], vz = V[o + 8] - V[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    N[t * 3] = nx / l; N[t * 3 + 1] = ny / l; N[t * 3 + 2] = nz / l;
    for (let j = 0; j < 9; j++) { const a = j % 3, c = V[o + j]; if (c < min[a]) min[a] = c; if (c > max[a]) max[a] = c; }
  }
  stats.buildMs += performance.now() - t0; stats.tris += tris;
  const p = [0, 0, 0];
  const fn = (x, y, z) => {
    stats.calls++;
    p[0] = x; p[1] = y; p[2] = z;
    const r = bvh.closestPoint(p);
    const d = r.dist;
    if (!(d > 1e-9)) return shift;
    const q = r.point, t = r.tri * 3;
    const c = ((x - q[0]) * N[t] + (y - q[1]) * N[t + 1] + (z - q[2]) * N[t + 2]) / d;
    let inside;
    if (c > 0.999) inside = false; else if (c < -0.999) inside = true;
    else { stats.rays++; inside = insideShared(bvh, [x, y, z], I4); }
    return (inside ? -d : d) + shift;
  };
  const pad = Math.max(0, -shift);
  return { kind: "field", fn, label: `solid-field-${serial++}-${tris}-${shift}`,
    box: [min.map((v) => v - 1e-3 - pad), max.map((v) => v + 1e-3 + pad)] };
}
