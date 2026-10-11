// The cached-preview writer behind `partforge/gltf`: one view's POSED display
// meshes (the payloads the viewer, the worker's `meshes` reply and the oracle's
// buildView all hold) as a small GLB a viewer can show before the kernel boots.
//
// The file, which a reader may rely on:
//  - one node + mesh + primitive per sub-part, all three named by the sub-part
//    key; POSITION + NORMAL (+ indices when the kernel sent them)
//  - every sub-part node under ONE root node, "partforge", rotated −90° about X:
//    partforge models Z-up in millimetres and glTF is Y-up. Units stay mm — the
//    file is for partforge's own viewer; metres would only matter for AR.
//  - each material from cadAppearance — the CAD look the viewer itself draws —
//    and each node's extras carrying the sub-part's own `display` block, so a
//    part-less viewer (mountPreview) can rebuild the exact look, realistic too
//  - top-level extras { partforgeView, partforgeEncoder, partforgeMeta? }
//  - weld() → quantize() → meshopt({ level: "medium" }): 5–8 bytes a triangle,
//    the recipe measured in partforge-cloud's local_glb_benchmark.md
// Not encoded (v1): feature edges, textures, patterns.
//
// Runs in Node, a page and a Web Worker: no three.js, no DOM, no Blob
// (test/gltf-layering.test.js). Deterministic: the same input writes the same
// bytes, and nothing here mutates the input (exportPreview passes the viewer's
// live buffers). Bump PREVIEW_ENCODER_VERSION whenever the bytes for the same
// input change — downstream caches key on it.
import { Document, Logger, WebIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt, quantize, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { cadAppearance, DISPLAY_KEYS } from "../materials/resolve.js";

export const PREVIEW_ENCODER_VERSION = 1;

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
    const extras = displayExtras(display);
    root.addChild(doc.createNode(m.name)
      .setMesh(doc.createMesh(m.name).addPrimitive(prim))
      .setExtras(extras ? { partforgeSubPart: m.name, partforgeDisplay: extras } : { partforgeSubPart: m.name }));
  }
  if (root.listChildren().length === 0) throw new Error("encodePreviewGlb: every mesh was empty");

  await doc.transform(weld(), quantize(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const io = new WebIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  io.setLogger(new Logger(Logger.Verbosity.SILENT));
  return io.writeBinary(doc);
}
