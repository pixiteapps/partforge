// Preview-GLB fixtures shared by the gltf / preview suites: a box in each of the
// two shapes the kernels deliver — Manifold's non-indexed soup with per-corner
// normals, OCCT's indexed mesh — plus Node-side readers for the writer's output.
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { encodePreviewGlb } from "../../src/gltf.js";
import { cubeSoup } from "./cube-soup.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const corner = (corners, i, min, max) => [0, 1, 2].map((a) => min[a] + corners[i * 3 + a] * (max[a] - min[a]));

// The box [min, max] as 12 triangles of soup, each corner carrying its face normal.
export function boxSoup(name, min = [0, 0, 0], max = [1, 1, 1]) {
  const { positions: corners, indices } = cubeSoup(1);
  const positions = new Float32Array(indices.length * 3);
  const normals = new Float32Array(indices.length * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => corner(corners, indices[t + k], min, max));
    const n = unit(cross(sub(p[1], p[0]), sub(p[2], p[0])));
    for (let k = 0; k < 3; k++) {
      positions.set(p[k], (t + k) * 3);
      normals.set(n, (t + k) * 3);
    }
  }
  return { name, positions, normals, triangles: indices.length / 3, edges: new Float32Array(0) };
}

// The box [min, max] as 8 shared vertices + 36 indices (smooth corner normals).
export function indexedBox(name, min = [0, 0, 0], max = [1, 1, 1]) {
  const { positions: corners, indices } = cubeSoup(1);
  const positions = new Float32Array(corners.length);
  const normals = new Float32Array(corners.length);
  for (let i = 0; i < corners.length / 3; i++) {
    positions.set(corner(corners, i, min, max), i * 3);
    normals.set(unit([0, 1, 2].map((a) => corners[i * 3 + a] - 0.5)), i * 3);
  }
  return { name, positions, normals, indices: new Uint32Array(indices), triangles: indices.length / 3, edges: new Float32Array(0) };
}

export const previewGlbFor = (meshes, part = null, view = "main") => encodePreviewGlb({ meshes, part, view });

export function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return { min, max };
}

// Read a preview GLB back the way a third party would (no three.js).
export async function readGlb(bytes) {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  return io.readBinary(bytes);
}

// World-space bounds of every mesh node: dequantized positions through each
// node's world matrix (the root's Y-up rotation and quantize()'s node transform).
export function worldBounds(doc) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const el = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      for (let i = 0; i < pos.getCount(); i++) {
        const [x, y, z] = pos.getElement(i, el);
        const w = [
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ];
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], w[a]);
          max[a] = Math.max(max[a], w[a]);
        }
      }
    }
  }
  return { min, max };
}

// The GLB's JSON chunk, parsed (bytes 12..: chunk length, chunk type, then JSON).
export function glbJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

// The box [min, max]'s 12 feature edges as line-segment endpoint pairs (72 floats).
export function boxEdges(min = [0, 0, 0], max = [1, 1, 1]) {
  const c = (i) => [0, 1, 2].map((a) => ((i >> a) & 1 ? max[a] : min[a]));
  const out = [];
  for (let i = 0; i < 8; i++) {
    for (let a = 0; a < 3; a++) {
      if ((i >> a) & 1) continue;
      out.push(...c(i), ...c(i | (1 << a)));
    }
  }
  return new Float32Array(out);
}

// Whether two edge arrays hold the same segments (either endpoint order, any
// segment order — weld/reorder may permute them) within `tol` millimetres.
// Returns null when they match, else a description of the first mismatch.
export function segmentMismatch(got, want, tol = 1e-2) {
  if (got.length !== want.length) return `segment count ${got.length / 6} != ${want.length / 6}`;
  const near = (a, i, b, j) => Math.abs(a[i] - b[j]) <= tol && Math.abs(a[i + 1] - b[j + 1]) <= tol && Math.abs(a[i + 2] - b[j + 2]) <= tol;
  const used = new Uint8Array(got.length / 6);
  for (let w = 0; w < want.length; w += 6) {
    let hit = -1;
    for (let g = 0; g < got.length && hit < 0; g += 6) {
      if (used[g / 6]) continue;
      if ((near(got, g, want, w) && near(got, g + 3, want, w + 3)) || (near(got, g, want, w + 3) && near(got, g + 3, want, w))) hit = g;
    }
    if (hit < 0) return `no decoded segment matches [${[...want.subarray(w, w + 6)].map((v) => v.toFixed(3))}]`;
    used[hit / 6] = 1;
  }
  return null;
}

// A rigid pose for fixtures: rotate `deg` about Z, then translate.
export function poseArray(arr, deg, [tx, ty, tz] = [0, 0, 0], isNormal = false) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 3) {
    out[i] = c * arr[i] - s * arr[i + 1] + (isNormal ? 0 : tx);
    out[i + 1] = s * arr[i] + c * arr[i + 1] + (isNormal ? 0 : ty);
    out[i + 2] = arr[i + 2] + (isNormal ? 0 : tz);
  }
  return out;
}

// An edge-dense sub-part: an n×n grid of quads on a gently waved sheet (so no two
// rows share a plane), indexed, with EVERY grid line a feature edge — the shape of
// a part riddled with small holes, where edges cost as much as the surface does.
export function denseGrid(name, n = 60, size = 60) {
  const v = (i, j) => i * (n + 1) + j;
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  const normals = new Float32Array(positions.length);
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = (i / n) * size;
      const y = (j / n) * size;
      positions.set([x, y, Math.sin(x / 7) * Math.cos(y / 5) * 2], v(i, j) * 3);
      normals.set([0, 0, 1], v(i, j) * 3);
    }
  }
  const indices = [];
  const edges = [];
  const at = (k) => [...positions.subarray(k * 3, k * 3 + 3)];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      indices.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
      edges.push(...at(v(i, j)), ...at(v(i + 1, j)), ...at(v(i, j)), ...at(v(i, j + 1)));
    }
  }
  for (let k = 0; k < n; k++) {
    edges.push(...at(v(n, k)), ...at(v(n, k + 1)), ...at(v(k, n)), ...at(v(k + 1, n)));
  }
  return { name, positions, normals, indices: new Uint32Array(indices), triangles: indices.length / 3, edges: new Float32Array(edges) };
}
