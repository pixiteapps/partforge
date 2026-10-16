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
//    triangle references it, so the surface is unchanged and no edge is dropped.
//    A sub-part whose `edges` is empty or absent has no line primitive; a reader
//    takes that as "no feature edges" (never "derive them"). A reader must take
//    the line primitive's INDICES, not its whole vertex array.
//    Version 1 had no line primitives; version 2 gave the lines their own
//    POSITION accessor on the same mesh (both still decode). Rare fallback, also
//    in version 3: a sub-part whose off-vertex endpoints would outnumber its
//    surface (quantize() would then compact the shared array and drop them)
//    writes its lines version-2 style, with their own vertices.
//  - every sub-part node under ONE root node, "partforge", rotated −90° about X:
//    partforge models Z-up in millimetres and glTF is Y-up. Units stay mm — the
//    file is for partforge's own viewer; metres would only matter for AR.
//  - each material from cadAppearance — the CAD look the viewer itself draws —
//    and each node's extras carrying the sub-part's own `display` block, so a
//    part-less viewer (mountPreview) can rebuild the exact look, realistic too
//  - top-level extras { partforgeView, partforgeEncoder, partforgeMeta? }
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
import { Document, Logger, Primitive, WebIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { quantize, reorder, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { cadAppearance, DISPLAY_KEYS } from "../materials/resolve.js";

export const PREVIEW_ENCODER_VERSION = 3; // 2: feature edges as a LINES primitive; 3: sharing the surface's vertices

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
function sortSegments(pairs) {
  const n = pairs.length / 2;
  const keys = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const a = pairs[s * 2], b = pairs[s * 2 + 1];
    keys[s] = Math.min(a, b) * 2 ** 32 + Math.max(a, b);
  }
  keys.sort();
  const out = new Uint32Array(pairs.length);
  for (let s = 0; s < n; s++) {
    out[s * 2] = Math.floor(keys[s] / 2 ** 32);
    out[s * 2 + 1] = keys[s] % 2 ** 32;
  }
  return out;
}

function widestExtent(positions) {
  let w = 0;
  for (let a = 0; a < 3; a++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < positions.length; i += 3) { if (positions[i] < lo) lo = positions[i]; if (positions[i] > hi) hi = positions[i]; }
    if (hi - lo > w) w = hi - lo;
  }
  return w;
}

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

export async function encodePreviewGlb({ meshes, part = null, view = null } = {}) {
  if (!Array.isArray(meshes) || meshes.length === 0) throw new TypeError("encodePreviewGlb: meshes must be a non-empty array");
  const seen = new Set();
  for (const m of meshes) checkMesh(m, seen);
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
  doc.getRoot().setExtras({
    partforgeView: viewName,
    partforgeEncoder: PREVIEW_ENCODER_VERSION,
    ...(meta ? { partforgeMeta: meta } : {}),
  });

  const pending = []; // { mesh, surface, edges } — line primitives to add after quantize()
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
    root.addChild(doc.createNode(m.name)
      .setMesh(mesh)
      .setExtras(extras ? { partforgeSubPart: m.name, partforgeDisplay: extras } : { partforgeSubPart: m.name }));
  }
  if (root.listChildren().length === 0) throw new Error("encodePreviewGlb: every mesh was empty");

  // The surfaces alone through weld + reorder: their vertex arrays are final after this.
  await doc.transform(weld(), reorder({ encoder: MeshoptEncoder, target: "size" }));

  // Map each endpoint onto those vertices; append the ones on none. Then quantize
  // with the appended vertices in place, and only then add the line primitives.
  const shared = [];
  for (const { mesh, surface, edges } of pending) {
    const position = surface.getAttribute("POSITION");
    const positions = position.getArray();
    const tol = widestExtent(positions) / 2 ** POSITION_BITS;
    const { pairs, appended } = mapEdges(positions, edges, tol);
    const vertexCount = positions.length / 3 + appended.length / 3;
    if (compactsAt(surface.getIndices().getCount(), vertexCount)) {
      // quantize() would compact the surface and drop the appended endpoints:
      // write these lines with their own vertices instead (version-2 shape).
      mesh.addPrimitive(doc.createPrimitive().setMode(Primitive.Mode.LINES).setAttribute(
        "POSITION", doc.createAccessor().setType("VEC3").setArray(edges).setBuffer(buffer)));
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
