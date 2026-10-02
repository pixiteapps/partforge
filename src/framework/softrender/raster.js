// Triangle rasterizer into a G-buffer: nearest view depth, perspective-correct
// interpolated normal, and which sub-part owns each sample. No culling — the
// z-buffer resolves closed meshes, and a no-normals mesh gets a two-sided face
// normal turned toward the camera. A triangle crossing the near plane is
// skipped: the framing keeps the camera well outside the part, so only
// degenerate input can produce one, and clipping it buys nothing here.
import { triangleCount, triangleOffsets } from "./triangles.js";

export const NEAR = 1e-3;

export function createGBuffer(width, height) {
  const n = width * height;
  return { width, height, depth: new Float32Array(n).fill(Infinity), normal: new Float32Array(n * 3), owner: new Int16Array(n).fill(-1) };
}

const edge = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

export function rasterizeMesh(gb, cam, mesh, owner) {
  const P = mesh.positions, N = mesh.normals?.length ? mesh.normals : null;
  const { width: W, height: H, depth, normal, owner: own } = gb;
  const n = triangleCount(mesh);
  for (let t = 0; t < n; t++) {
    const [ai, bi, ci] = triangleOffsets(mesh, t);
    const a = cam.project(P[ai], P[ai + 1], P[ai + 2]);
    const b = cam.project(P[bi], P[bi + 1], P[bi + 2]);
    const c = cam.project(P[ci], P[ci + 1], P[ci + 2]);
    if (a[2] < NEAR || b[2] < NEAR || c[2] < NEAR) continue;
    const area = edge(a[0], a[1], b[0], b[1], c[0], c[1]);
    if (Math.abs(area) < 1e-12) continue;

    let fx = 0, fy = 0, fz = 0;
    if (!N) {
      const ux = P[bi] - P[ai], uy = P[bi + 1] - P[ai + 1], uz = P[bi + 2] - P[ai + 2];
      const vx = P[ci] - P[ai], vy = P[ci + 1] - P[ai + 1], vz = P[ci + 2] - P[ai + 2];
      fx = uy * vz - uz * vy; fy = uz * vx - ux * vz; fz = ux * vy - uy * vx;
      const l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l;
      // turn toward the camera: compare with the direction to the camera
      const tx = cam.position[0] - P[ai], ty = cam.position[1] - P[ai + 1], tz = cam.position[2] - P[ai + 2];
      if (fx * tx + fy * ty + fz * tz < 0) { fx = -fx; fy = -fy; fz = -fz; }
    }

    const wa = 1 / a[2], wb = 1 / b[2], wc = 1 / c[2];
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        // dividing by the signed area makes "inside" non-negative for either winding
        const l0 = edge(b[0], b[1], c[0], c[1], px, py) / area;
        const l1 = edge(c[0], c[1], a[0], a[1], px, py) / area;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const inv = l0 * wa + l1 * wb + l2 * wc;
        const z = 1 / inv;
        const k = y * W + x;
        if (z >= depth[k]) continue;
        depth[k] = z; own[k] = owner;
        if (N) {
          const p0 = (l0 * wa) / inv, p1 = (l1 * wb) / inv, p2 = (l2 * wc) / inv;
          let nx = p0 * N[ai] + p1 * N[bi] + p2 * N[ci];
          let ny = p0 * N[ai + 1] + p1 * N[bi + 1] + p2 * N[ci + 1];
          let nz = p0 * N[ai + 2] + p1 * N[bi + 2] + p2 * N[ci + 2];
          const l = Math.hypot(nx, ny, nz) || 1;
          normal[k * 3] = nx / l; normal[k * 3 + 1] = ny / l; normal[k * 3 + 2] = nz / l;
        } else {
          normal[k * 3] = fx; normal[k * 3 + 1] = fy; normal[k * 3 + 2] = fz;
        }
      }
    }
  }
}
