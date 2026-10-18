// The cached-preview writer behind `partforge/gltf`: one view's POSED display
// meshes (the payloads the viewer, the worker's `meshes` reply and the oracle's
// buildView all hold) as a small GLB a viewer can show before the kernel boots.
//
// The file, which a reader may rely on:
//  - one node + mesh per sub-part, both named by the sub-part key; the mesh's
//    FIRST primitive is the surface (TRIANGLES: POSITION + NORMAL, + indices
//    when the kernel sent them); a sub-part with feature edges adds a SECOND
//    primitive, mode LINES, no material, whose POSITION is the SAME accessor as
//    the surface's (version 3) and whose indices are the segments' endpoint
//    pairs. Each endpoint is the surface vertex at its position — bit-exact
//    first, else the nearest within one 14-bit quantization step of the mesh —
//    and an endpoint on no vertex is APPENDED to that shared array, where no
//    triangle references it, so the surface's triangles are unchanged and no
//    edge is dropped.
//    A sub-part whose `edges` is empty or absent has no line primitive; a reader
//    takes that as "no feature edges" (never "derive them"). A reader must take
//    the line primitive's INDICES, not its whole vertex array.
//    Version 1 had no line primitives; version 2 gave the lines their own
//    POSITION accessor on the same mesh (both still decode). Rare fallback, also
//    in version 3: a sub-part whose lines would need either
//      (a) an appended endpoint OUTSIDE the surface's bounds — it would widen
//          the mesh's quantization volume and coarsen the surface — or
//      (b) so many appended endpoints that quantize() compacts the surface
//          (its condition: index count < vertex count / 2, the appended
//          vertices counted), dropping them,
//    writes its lines with vertices of their own (unindexed, float, added after
//    quantize() in the node's quantized frame), so the surface quantizes
//    exactly as it would with no edges at all.
//  - every sub-part node under ONE root node, "partforge", rotated −90° about X:
//    partforge models Z-up in millimetres and glTF is Y-up. Units stay mm — the
//    file is for partforge's own viewer; metres would only matter for AR.
//  - each material from cadAppearance — the CAD look the viewer itself draws —
//    and each node's extras carrying the sub-part's own `display` block, so a
//    part-less viewer (mountPreview) can rebuild the exact look, realistic too
//  - top-level extras { partforgeView, partforgeEncoder, partforgeMeta?,
//    partforgeAnimation? }
//  - an `animation` (samplePreviewAnimation's output, version 4) adds:
//      * every sampled sub-part node's rest TRS = rel(0), where
//        rel(t) = M(t) · base⁻¹ carries the mesh from the pose baked into its
//        positions to the pose at normalized time t. TRS is in the root's local
//        frame, which is the part's Z-up model frame, so no frame change.
//      * one glTF animation named anim.name, holding a LINEAR `translation` and
//        `rotation` channel (input in SECONDS, t · totalDuration) for each
//        sub-part whose rel(t) differs from rel(0) beyond 1e-6 — none at all
//        when nothing moves (a camera-only animation). Consecutive quaternions
//        share a hemisphere, so LINEAR blending never takes the long way round.
//        An animated node's mesh sits on an unnamed child node (quantize()
//        moves it there to keep the dequantization off the animated TRS).
//      * partforgeAnimation = { name, label, loop, duration (seconds), cues
//        (verbatim), steps: [{ label, start (normalized), duration (seconds) }],
//        animated (names with channels, mesh order), opacity: { <sub>: [[t, v],
//        …] } } — t normalized, one pair per sample that names the sub-part (a
//        sample that omits it contributes no pair; a reader interpolates).
//    The samples are refused unless every pose is rigid (RᵀR = I, det = +1,
//    within 1e-6), they run from t = 0 to t = 1, every sample poses the same
//    sub-parts, and each of those (and each `base` entry) has a non-empty mesh.
//    Meshopt filters the channels (translation EXPONENTIAL 12 bits, rotation
//    QUATERNION 16 bits): lossy at about 1/4096 relative.
//  - weld() → reorder() → quantize() → EXT_meshopt_compression ("medium",
//    i.e. what meshopt({ level: "medium" }) does), 5–8 bytes a triangle, the
//    recipe measured in partforge-cloud's local_glb_benchmark.md. The line
//    primitives are added AFTER quantize(): weld(), reorder() and quantize()
//    each clone a primitive's accessors (compactPrimitive / per-index-set
//    compaction / attribute.clone()), which would split a shared POSITION back
//    into two arrays. Endpoints are mapped after weld+reorder (the final vertex
//    order) and appended before quantize (so they are quantized with the rest).
// Not encoded: textures, patterns. (Feature edges since version 2, shared
// vertices since version 3.)
//
// Runs in Node, a page and a Web Worker: no three.js, no DOM, no Blob
// (test/gltf-layering.test.js). Deterministic: the same input writes the same
// bytes, and nothing here mutates the input (exportPreview passes the viewer's
// live buffers). Bump PREVIEW_ENCODER_VERSION whenever the bytes for the same
// input change — downstream caches key on it.
import { Document, Logger, Node, Primitive, WebIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { quantize, reorder, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { cadAppearance, DISPLAY_KEYS } from "../materials/resolve.js";
import { invertRigid, mulMat4 } from "../geometry/pose.js";

// 2: feature edges as a LINES primitive; 3: sharing the surface's vertices;
// 4: animation channels + partforgeAnimation extras
export const PREVIEW_ENCODER_VERSION = 4;

// −90° about X as [x, y, z, w]: model (x, y, z) → glTF (x, z, −y), the viewer's pivot.
const Z_UP_TO_Y_UP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

let encoderReady = null; // MeshoptEncoder's wasm, awaited once per process

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function baseColorFactor(hex, opacity) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => srgbToLinear(v / 255)).concat(opacity);
}

// The display block as plain data (resolve.js's own keys, primitive values only).
function displayExtras(display) {
  if (!display || typeof display !== "object") return null;
  const out = {};
  for (const key of DISPLAY_KEYS) {
    const v = display[key];
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// The two meta fields createViewer reads (background, environment).
function metaExtras(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  if (Number.isInteger(meta.background)) out.background = meta.background;
  if (typeof meta.environment === "string") out.environment = meta.environment;
  return Object.keys(out).length ? out : null;
}

// quantize()'s default POSITION precision; one step of it over the mesh's widest
// extent is the snapping tolerance — closer than that, quantization itself may
// put the two points on one grid value.
const POSITION_BITS = 14;
// quantize() compacts a primitive whose index count is under half its vertex
// count — which would drop the appended endpoints no triangle references.
const compactsAt = (indexCount, vertexCount) => indexCount < vertexCount / 2;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bitsOf = (x) => { f32[0] = x === 0 ? 0 : x; return u32[0]; }; // -0 and 0 alike

// A bit-exact position → vertex lookup (open addressing; deterministic).
function exactTable(capacity) {
  let size = 16;
  while (size < capacity * 2) size *= 2;
  const keys = new Uint32Array(size * 3);
  const values = new Int32Array(size).fill(-1);
  const slot = (a, b, c) => (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (size - 1);
  return {
    get(a, b, c) {
      for (let s = slot(a, b, c); values[s] !== -1; s = (s + 1) & (size - 1)) {
        if (keys[s * 3] === a && keys[s * 3 + 1] === b && keys[s * 3 + 2] === c) return values[s];
      }
      return -1;
    },
    set(a, b, c, v) {
      let s = slot(a, b, c);
      while (values[s] !== -1) s = (s + 1) & (size - 1);
      keys.set([a, b, c], s * 3);
      values[s] = v;
    },
  };
}

// Map every edge endpoint to a vertex of `positions` (the welded, reordered
// surface): bit-exact, else the nearest within `tol`, else a NEW vertex,
// returned in `appended` (deduplicated, so two segments meeting off the surface
// share one). Returns { pairs: Uint32Array of endpoint indices, appended: number[] }.
function mapEdges(positions, edges, tol) {
  const vertexCount = positions.length / 3;
  const endpoints = edges.length / 3;
  const exact = exactTable(vertexCount + endpoints);
  for (let v = 0; v < vertexCount; v++) { // the first vertex at a position wins
    const a = bitsOf(positions[v * 3]), b = bitsOf(positions[v * 3 + 1]), c = bitsOf(positions[v * 3 + 2]);
    if (exact.get(a, b, c) === -1) exact.set(a, b, c, v);
  }
  let grid = null; // cell → vertex indices, built on the first miss
  const cellOf = (x) => Math.floor(x / tol);
  const cellKey = (i, j, k) => `${i},${j},${k}`;
  const nearest = (x, y, z) => {
    if (!(tol > 0)) return -1;
    if (!grid) {
      grid = new Map();
      for (let v = 0; v < vertexCount; v++) {
        const key = cellKey(cellOf(positions[v * 3]), cellOf(positions[v * 3 + 1]), cellOf(positions[v * 3 + 2]));
        const list = grid.get(key);
        if (list) list.push(v); else grid.set(key, [v]);
      }
    }
    const ci = cellOf(x), cj = cellOf(y), ck = cellOf(z);
    let best = -1;
    let bestD = tol * tol;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      for (const v of grid.get(cellKey(ci + di, cj + dj, ck + dk)) ?? []) {
        const dx = positions[v * 3] - x, dy = positions[v * 3 + 1] - y, dz = positions[v * 3 + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD || (d === bestD && best !== -1 && v < best)) { bestD = d; best = v; }
      }
    }
    return best;
  };
  const pairs = new Uint32Array(endpoints);
  const appended = [];
  for (let e = 0; e < endpoints; e++) {
    const x = edges[e * 3], y = edges[e * 3 + 1], z = edges[e * 3 + 2];
    const a = bitsOf(x), b = bitsOf(y), c = bitsOf(z);
    let v = exact.get(a, b, c);
    if (v === -1) v = nearest(x, y, z);
    if (v === -1) {
      v = vertexCount + appended.length / 3;
      appended.push(x, y, z);
      exact.set(a, b, c, v);
    }
    pairs[e] = v;
  }
  return { pairs: sortSegments(pairs), appended };
}

// Segments as (low, high) pairs in ascending order: the same set of lines, but an
// index stream meshopt's delta coding compresses far better than the kernel's order.
export function sortSegments(pairs) {
  const n = pairs.length / 2;
  const keys = new BigUint64Array(n); // (low << 32) | high, exact for every Uint32 index
  for (let s = 0; s < n; s++) {
    const a = pairs[s * 2], b = pairs[s * 2 + 1];
    keys[s] = (BigInt(Math.min(a, b)) << 32n) | BigInt(Math.max(a, b));
  }
  keys.sort();
  const out = new Uint32Array(pairs.length);
  for (let s = 0; s < n; s++) {
    out[s * 2] = Number(keys[s] >> 32n);
    out[s * 2 + 1] = Number(keys[s] & 0xffffffffn);
  }
  return out;
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (positions[i + a] < min[a]) min[a] = positions[i + a];
      if (positions[i + a] > max[a]) max[a] = positions[i + a];
    }
  }
  return { min, max };
}
// Column-major 4×4 helpers (glTF's layout) for the fallback's frame change. A
// node matrix is affine, so the inverse is the 3×3 block's inverse plus the
// translation carried through it.
function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = v;
    }
  }
  return out;
}
function invertAffine(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // rows
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new Error("encodePreviewGlb: a mesh node's transform is not invertible");
  const inv = [ // rows of the 3×3 inverse
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  const t = [m[12], m[13], m[14]];
  const out = new Array(16).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) out[col * 4 + r] = inv[r * 3 + col];
    out[12 + r] = -(inv[r * 3] * t[0] + inv[r * 3 + 1] * t[1] + inv[r * 3 + 2] * t[2]);
  }
  out[15] = 1;
  return out;
}
const meshNode = (mesh) => mesh.listParents().find((p) => p instanceof Node);

const outside = (points, { min, max }) => {
  for (let i = 0; i < points.length; i += 3) {
    for (let a = 0; a < 3; a++) if (points[i + a] < min[a] || points[i + a] > max[a]) return true;
  }
  return false;
};

function checkMesh(m, seen) {
  if (!m || typeof m.name !== "string" || !m.name) throw new TypeError("encodePreviewGlb: every mesh needs a non-empty string name");
  if (seen.has(m.name)) throw new Error(`encodePreviewGlb: two meshes are named "${m.name}"`);
  seen.add(m.name);
  if (!ArrayBuffer.isView(m.positions)) throw new TypeError(`encodePreviewGlb: "${m.name}" positions must be a typed array`);
  const indexed = m.indices != null && m.indices.length > 0;
  if (m.positions.length % (indexed ? 3 : 9) !== 0) {
    throw new Error(`encodePreviewGlb: "${m.name}" positions are not whole ${indexed ? "vertices" : "triangles"}`);
  }
  if (indexed && m.indices.length % 3 !== 0) throw new Error(`encodePreviewGlb: "${m.name}" indices are not whole triangles`);
  if (m.normals != null && m.normals.length > 0 && m.normals.length !== m.positions.length) {
    throw new Error(`encodePreviewGlb: "${m.name}" normals do not match its positions`);
  }
  // Any zero-length edges (typed or plain) mean "no feature edges": nothing to check.
  if (m.edges != null && m.edges.length !== 0) {
    if (!ArrayBuffer.isView(m.edges) && !Array.isArray(m.edges)) {
      throw new TypeError(`encodePreviewGlb: "${m.name}" edges must be a typed array or an array of numbers`);
    }
    if (m.edges.length % 6 !== 0) throw new Error(`encodePreviewGlb: "${m.name}" edges are not whole segments`);
  }
  if (indexed) {
    const vertexCount = m.positions.length / 3;
    for (let i = 0; i < m.indices.length; i++) {
      if (!(m.indices[i] < vertexCount)) {
        throw new Error(`encodePreviewGlb: "${m.name}" indices reference a vertex that does not exist`);
      }
    }
  }
}

// ── The baked animation (version 4) ─────────────────────────────────────────

const RIGID_TOL = 1e-6;
const MOVES_TOL = 1e-6;

function isRigid(m) {
  if (!Array.isArray(m) && !ArrayBuffer.isView(m)) return false;
  if (m.length !== 16 || !Array.prototype.every.call(m, Number.isFinite)) return false;
  if (Math.abs(m[3]) > RIGID_TOL || Math.abs(m[7]) > RIGID_TOL || Math.abs(m[11]) > RIGID_TOL || Math.abs(m[15] - 1) > RIGID_TOL) return false;
  const col = (c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cols = [col(0), col(1), col(2)];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) if (Math.abs(dot(cols[i], cols[j]) - (i === j ? 1 : 0)) > RIGID_TOL) return false;
  }
  const [a, b, c] = cols;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
  return Math.abs(det - 1) <= RIGID_TOL;
}

// Refuse what the file could not carry faithfully; returns the sampled names
// in mesh order. `drawn` is the set of names with a non-empty mesh.
function checkAnimation(animation, meshes, drawn) {
  const { anim, samples, base } = animation;
  if (!anim || typeof anim !== "object" || typeof anim.name !== "string") throw new TypeError("encodePreviewGlb: animation.anim must be a normalized animation");
  if (!(Number.isFinite(anim.totalDuration) && anim.totalDuration > 0)) throw new Error("encodePreviewGlb: animation duration must be a positive number");
  if (!base || typeof base !== "object") throw new TypeError("encodePreviewGlb: animation.base must map sub-parts to matrices");
  if (!Array.isArray(samples) || samples.length < 2) throw new Error("encodePreviewGlb: animation samples must run from t = 0 to t = 1");
  if (samples[0].t !== 0) throw new Error("encodePreviewGlb: animation samples must start at t = 0");
  if (samples.at(-1).t !== 1) throw new Error("encodePreviewGlb: animation samples must end at t = 1");
  for (let i = 1; i < samples.length; i++) {
    if (!(samples[i].t > samples[i - 1].t)) throw new Error("encodePreviewGlb: animation sample times must increase");
  }
  const names = new Set();
  for (const s of samples) for (const name of Object.keys(s.poses ?? {})) names.add(name);
  for (const name of [...names, ...Object.keys(base)]) {
    if (!drawn.has(name)) throw new Error(`encodePreviewGlb: animation names "${name}", which has no mesh`);
  }
  for (const name of names) {
    if (!isRigid(base[name])) {
      if (base[name] == null) throw new Error(`encodePreviewGlb: animation has no base pose for "${name}"`);
      throw new Error(`encodePreviewGlb: "${name}" base pose is not a rigid motion`);
    }
    for (const s of samples) {
      const m = s.poses?.[name];
      if (m == null) throw new Error(`encodePreviewGlb: animation sample at t=${s.t} has no pose for "${name}"`);
      if (!isRigid(m)) throw new Error(`encodePreviewGlb: "${name}" pose at t=${s.t} is not a rigid motion`);
    }
  }
  return meshes.map((m) => m.name).filter((name) => names.has(name)); // names are unique (checkMesh)
}

// rel = M · base⁻¹: the motion from the baked pose to M.
const relativePose = (m, base) => mulMat4(Array.from(m), invertRigid(Array.from(base)));

// Unit quaternion [x, y, z, w] of a rigid matrix's rotation block (Shepperd).
function quaternionOf(m) {
  const at = (r, c) => m[c * 4 + r];
  const trace = at(0, 0) + at(1, 1) + at(2, 2);
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(at(2, 1) - at(1, 2)) / s, (at(0, 2) - at(2, 0)) / s, (at(1, 0) - at(0, 1)) / s, s / 4];
  } else if (at(0, 0) > at(1, 1) && at(0, 0) > at(2, 2)) {
    const s = Math.sqrt(1 + at(0, 0) - at(1, 1) - at(2, 2)) * 2;
    q = [s / 4, (at(0, 1) + at(1, 0)) / s, (at(0, 2) + at(2, 0)) / s, (at(2, 1) - at(1, 2)) / s];
  } else if (at(1, 1) > at(2, 2)) {
    const s = Math.sqrt(1 + at(1, 1) - at(0, 0) - at(2, 2)) * 2;
    q = [(at(0, 1) + at(1, 0)) / s, s / 4, (at(1, 2) + at(2, 1)) / s, (at(0, 2) - at(2, 0)) / s];
  } else {
    const s = Math.sqrt(1 + at(2, 2) - at(0, 0) - at(1, 1)) * 2;
    q = [(at(0, 2) + at(2, 0)) / s, (at(1, 2) + at(2, 1)) / s, s / 4, (at(1, 0) - at(0, 1)) / s];
  }
  const len = Math.hypot(...q);
  return q.map((v) => v / len);
}

// Per sampled sub-part: the rest TRS (rel(0)) and, when it moves, the keyframes.
function animationTracks(animation, names) {
  const { samples, base } = animation;
  const tracks = new Map();
  for (const name of names) {
    const rels = samples.map((s) => relativePose(s.poses[name], base[name]));
    const moves = rels.some((r) => r.some((v, i) => Math.abs(v - rels[0][i]) > MOVES_TOL));
    const rotations = [];
    for (const r of rels) {
      const q = quaternionOf(r);
      const prev = rotations.at(-1);
      if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) for (let k = 0; k < 4; k++) q[k] = -q[k];
      rotations.push(q);
    }
    tracks.set(name, {
      rest: { translation: [rels[0][12], rels[0][13], rels[0][14]], rotation: rotations[0] },
      keys: moves ? { translations: rels.map((r) => [r[12], r[13], r[14]]), rotations } : null,
    });
  }
  return tracks;
}

// The glTF animation: one sampler pair per moving sub-part, sharing one input.
// Returns the names that got channels.
function writeAnimation(doc, buffer, nodesByName, animation, tracks) {
  const moving = [...tracks].filter(([, track]) => track.keys);
  if (!moving.length) return [];
  const { anim, samples } = animation;
  const times = doc.createAccessor().setType("SCALAR")
    .setArray(Float32Array.from(samples, (s) => s.t * anim.totalDuration)).setBuffer(buffer);
  const gltfAnimation = doc.createAnimation(anim.name);
  for (const [name, { keys }] of moving) {
    for (const [path, type, values] of [["translation", "VEC3", keys.translations], ["rotation", "VEC4", keys.rotations]]) {
      const sampler = doc.createAnimationSampler().setInput(times).setInterpolation("LINEAR")
        .setOutput(doc.createAccessor().setType(type).setArray(Float32Array.from(values.flat())).setBuffer(buffer));
      gltfAnimation.addSampler(sampler).addChannel(doc.createAnimationChannel()
        .setTargetNode(nodesByName.get(name)).setTargetPath(path).setSampler(sampler));
    }
  }
  return moving.map(([name]) => name);
}

// The partforgeAnimation extra: everything a viewer needs beyond the channels.
function animationExtras(animation, animated) {
  const { anim, samples } = animation;
  const opacity = {};
  for (const s of samples) {
    for (const [name, v] of Object.entries(s.opacity ?? {})) {
      if (Number.isFinite(v)) (opacity[name] ??= []).push([s.t, v]);
    }
  }
  return {
    name: anim.name,
    label: anim.label ?? null,
    loop: !!anim.loop,
    duration: anim.totalDuration,
    cues: anim.cues ?? [],
    opacity,
    steps: (anim.steps ?? []).map((step, i) => ({ label: step.label ?? null, start: anim.stepStarts[i], duration: step.duration })),
    animated,
  };
}

export async function encodePreviewGlb({ meshes, part = null, view = null, animation = null } = {}) {
  if (!Array.isArray(meshes) || meshes.length === 0) throw new TypeError("encodePreviewGlb: meshes must be a non-empty array");
  const seen = new Set();
  for (const m of meshes) checkMesh(m, seen);
  const drawn = new Set(meshes.filter((m) => m.positions.length > 0).map((m) => m.name));
  const tracks = animation ? animationTracks(animation, checkAnimation(animation, meshes, drawn)) : null;
  try {
    await (encoderReady ??= MeshoptEncoder.ready);
  } catch (error) {
    encoderReady = null; // a failed wasm load must not be cached: a later call retries
    throw error;
  }

  const viewName = typeof view === "string" && view ? view : null;
  const doc = new Document();
  doc.setLogger(new Logger(Logger.Verbosity.SILENT));
  const buffer = doc.createBuffer();
  const scene = doc.createScene(viewName ?? "preview");
  const root = doc.createNode("partforge").setRotation(Z_UP_TO_Y_UP);
  scene.addChild(root);
  const meta = metaExtras(part?.meta);

  const pending = []; // { mesh, surface, edges } — line primitives to add after quantize()
  const nodesByName = new Map();
  for (const m of meshes) {
    if (m.positions.length === 0) continue; // glTF forbids a zero-count accessor
    // Copies throughout: setArray keeps the array it is handed, and the
    // transforms below rewrite it.
    const prim = doc.createPrimitive().setAttribute(
      "POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(m.positions)).setBuffer(buffer));
    if (m.normals?.length) {
      prim.setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(m.normals)).setBuffer(buffer));
    }
    if (m.indices?.length) {
      prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(m.indices)).setBuffer(buffer));
    }
    const display = part?.parts?.[m.name]?.display;
    const look = cadAppearance(display);
    prim.setMaterial(doc.createMaterial(m.name)
      .setBaseColorFactor(baseColorFactor(look.color, look.opacity))
      .setMetallicFactor(look.metalness)
      .setRoughnessFactor(look.roughness)
      .setAlphaMode(look.opacity < 1 ? "BLEND" : "OPAQUE"));
    const mesh = doc.createMesh(m.name).addPrimitive(prim);
    if (m.edges?.length) pending.push({ mesh, surface: prim, edges: Float32Array.from(m.edges) });
    const extras = displayExtras(display);
    const node = doc.createNode(m.name)
      .setMesh(mesh)
      .setExtras(extras ? { partforgeSubPart: m.name, partforgeDisplay: extras } : { partforgeSubPart: m.name });
    const rest = tracks?.get(m.name)?.rest;
    if (rest) node.setTranslation(rest.translation).setRotation(rest.rotation); // before the fallback's `before` snapshot
    nodesByName.set(m.name, node);
    root.addChild(node);
  }
  if (root.listChildren().length === 0) throw new Error("encodePreviewGlb: every mesh was empty");
  // Channels before quantize(), which then keeps the dequantization off the animated nodes.
  const animated = tracks ? writeAnimation(doc, buffer, nodesByName, animation, tracks) : null;
  doc.getRoot().setExtras({
    partforgeView: viewName,
    partforgeEncoder: PREVIEW_ENCODER_VERSION,
    ...(meta ? { partforgeMeta: meta } : {}),
    ...(tracks ? { partforgeAnimation: animationExtras(animation, animated) } : {}),
  });

  // The surfaces alone through weld + reorder: their vertex arrays are final after this.
  await doc.transform(weld(), reorder({ encoder: MeshoptEncoder, target: "size" }));

  // Map each endpoint onto those vertices; append the ones on none. Then quantize
  // with the appended vertices in place, and only then add the line primitives.
  const shared = [];
  const ownVertices = []; // { mesh, edges, before } — the fallback, added after quantize()
  for (const { mesh, surface, edges } of pending) {
    const position = surface.getAttribute("POSITION");
    const positions = position.getArray();
    const bounds = boundsOf(positions);
    const tol = Math.max(...bounds.max.map((hi, a) => hi - bounds.min[a])) / 2 ** POSITION_BITS;
    const { pairs, appended } = mapEdges(positions, edges, tol);
    const vertexCount = positions.length / 3 + appended.length / 3;
    if (outside(appended, bounds) || compactsAt(surface.getIndices().getCount(), vertexCount)) {
      // Appending would change the surface's quantization volume, or quantize()
      // would compact the surface and drop the appended endpoints: these lines
      // keep vertices of their own instead (see the file header).
      ownVertices.push({ mesh, edges, before: meshNode(mesh).getWorldMatrix() });
      continue;
    }
    if (appended.length) {
      const grown = new Float32Array(vertexCount * 3);
      grown.set(positions);
      grown.set(appended, positions.length);
      position.setArray(grown);
      const normal = surface.getAttribute("NORMAL");
      if (normal) { // unit +Z for vertices no triangle draws: a valid NORMAL, never read
        const normals = new Float32Array(vertexCount * 3);
        normals.set(normal.getArray());
        for (let i = positions.length + 2; i < normals.length; i += 3) normals[i] = 1;
        normal.setArray(normals);
      }
    }
    shared.push({ mesh, surface, pairs, vertexCount });
  }

  await doc.transform(quantize());

  // The fallback lines: float positions mapped into the frame quantize() left the
  // mesh in. quantize() folds the mesh's offset and scale into the node holding it
  // (or a new child node), so a vertex q now draws at after·q where it drew p at
  // before·p: q = after⁻¹ · before · p, whatever transform the node carried.
  for (const { mesh, edges, before } of ownVertices) {
    const m = multiply(invertAffine(meshNode(mesh).getWorldMatrix()), before);
    const local = new Float32Array(edges.length);
    for (let i = 0; i < edges.length; i += 3) {
      const [x, y, z] = [edges[i], edges[i + 1], edges[i + 2]];
      for (let a = 0; a < 3; a++) local[i + a] = m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a];
    }
    mesh.addPrimitive(doc.createPrimitive().setMode(Primitive.Mode.LINES).setAttribute(
      "POSITION", doc.createAccessor().setType("VEC3").setArray(local).setBuffer(buffer)));
  }

  for (const { mesh, surface, pairs, vertexCount } of shared) {
    // quantize() replaced the surface's accessors; the vertex order and count did not change.
    const position = surface.getAttribute("POSITION");
    if (position.getCount() !== vertexCount) throw new Error("encodePreviewGlb: quantize() changed a surface's vertex count");
    mesh.addPrimitive(doc.createPrimitive().setMode(Primitive.Mode.LINES)
      .setAttribute("POSITION", position)
      .setIndices(doc.createAccessor().setType("SCALAR")
        .setArray(vertexCount < 65535 ? new Uint16Array(pairs) : pairs).setBuffer(buffer)));
  }
  // meshopt({ level: "medium" })'s last step: compress every buffer view, attributes as quantized.
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

  const io = new WebIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  io.setLogger(new Logger(Logger.Verbosity.SILENT));
  return io.writeBinary(doc);
}
