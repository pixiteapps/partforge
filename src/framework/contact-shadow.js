// The product shot's soft contact shadow, as a top-down mask over the floor
// (the part's lowest world Y). Each cell is darkest where geometry sits ON the
// floor and fades to nothing `falloff·diag` above it, then the mask is blurred.
// Pure, so the viewer (as an alpha texture on a ground plane) and the CPU
// renderer (sampled per background pixel) draw the SAME shadow.
import { triangleCount, triangleOffsets } from "./softrender/triangles.js";

export function contactShadowMask(meshes, box, shadow) {
  const size = [0, 1, 2].map((k) => box.max[k] - box.min[k]);
  const diag = Math.hypot(...size);
  if (!(diag > 0)) return null;
  const falloff = shadow.falloff * diag;
  const blurW = shadow.blur * diag;
  const x0 = box.min[0] - 2 * blurW, x1 = box.max[0] + 2 * blurW;
  const z0 = box.min[2] - 2 * blurW, z1 = box.max[2] + 2 * blurW;
  const spanX = Math.max(x1 - x0, 1e-9), spanZ = Math.max(z1 - z0, 1e-9);
  const span = Math.max(spanX, spanZ);
  const W = Math.max(1, Math.round((shadow.resolution * spanX) / span));
  const H = Math.max(1, Math.round((shadow.resolution * spanZ) / span));
  const floor = box.min[1];
  const minH = new Float32Array(W * H).fill(Infinity);

  const gx = (x) => ((x - x0) / spanX) * W, gz = (z) => ((z - z0) / spanZ) * H;
  for (const m of meshes) {
    const P = m.positions;
    const n = triangleCount(m);
    for (let t = 0; t < n; t++) {
      const o = triangleOffsets(m, t);
      const ax = gx(P[o[0]]), az = gz(P[o[0] + 2]), ah = P[o[0] + 1] - floor;
      const bx = gx(P[o[1]]), bz = gz(P[o[1] + 2]), bh = P[o[1] + 1] - floor;
      const cx = gx(P[o[2]]), cz = gz(P[o[2] + 2]), ch = P[o[2] + 1] - floor;
      const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue; // a wall seen from above covers no cells
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const j0 = Math.max(0, Math.floor(Math.min(az, bz, cz))), j1 = Math.min(H - 1, Math.ceil(Math.max(az, bz, cz)));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = i + 0.5, pz = j + 0.5;
        const w0 = ((cx - bx) * (pz - bz) - (cz - bz) * (px - bx)) / area;
        const w1 = ((ax - cx) * (pz - cz) - (az - cz) * (px - cx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const h = w0 * ah + w1 * bh + w2 * ch;
        const k = j * W + i;
        if (h < minH[k]) minH[k] = h;
      }
    }
  }

  let data = new Float32Array(W * H);
  for (let k = 0; k < data.length; k++) {
    const h = minH[k];
    data[k] = Number.isFinite(h) ? Math.min(1, Math.max(0, 1 - Math.max(0, h) / falloff)) : 0;
  }
  const r = Math.max(1, Math.round((blurW / spanX) * W));
  for (let pass = 0; pass < 3; pass++) data = boxBlur(boxBlur(data, W, H, r, true), W, H, r, false);
  return { width: W, height: H, data, rect: { x0, x1, z0, z1 }, y: floor };
}

// One separable box-blur pass, edges clamped.
function boxBlur(src, W, H, r, horizontal) {
  const out = new Float32Array(src.length);
  const n = horizontal ? W : H, lines = horizontal ? H : W;
  for (let l = 0; l < lines; l++) {
    const at = (i) => (horizontal ? l * W + i : i * W + l);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[at(Math.min(n - 1, Math.max(0, i)))];
    for (let i = 0; i < n; i++) {
      out[at(i)] = sum / (2 * r + 1);
      sum += src[at(Math.min(n - 1, i + r + 1))] - src[at(Math.max(0, i - r))];
    }
  }
  return out;
}

export function sampleShadowMask(mask, x, z) {
  const { width: W, height: H, data, rect } = mask;
  if (x < rect.x0 || x > rect.x1 || z < rect.z0 || z > rect.z1) return 0;
  const u = ((x - rect.x0) / (rect.x1 - rect.x0)) * W - 0.5;
  const v = ((z - rect.z0) / (rect.z1 - rect.z0)) * H - 0.5;
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const at = (ii, jj) => data[Math.min(H - 1, Math.max(0, jj)) * W + Math.min(W - 1, Math.max(0, ii))];
  return (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
}
