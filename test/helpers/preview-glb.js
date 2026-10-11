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
