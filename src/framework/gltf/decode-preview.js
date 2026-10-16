// The cached-preview reader (main thread): a GLB written by encode-preview.js,
// decoded with three's GLTFLoader + MeshoptDecoder and turned back into the
// viewer's own mesh payloads — { name, positions, normals, indices, triangles,
// edges } in the part's Z-up MODEL frame — so a preview is drawn through
// viewer.setSubGeometry exactly like a worker delivery. Everything after that
// (the pivot, the per-sub-part CAD material, framing, the cutaway, captures)
// is the viewer's existing code.
//
// Why payloads and not the loaded scene graph: the file's root node carries the
// −90° about X that stands Z-up on end, and the viewer's pivot carries the same
// rotation; parenting the glTF root under the pivot would turn the part twice.
// Undoing the root here hands the viewer geometry in the frame it already owns.
//
// Feature edges (encoder version 2+): a sub-part's mesh may carry a second
// primitive, mode LINES, holding the kernel's edge segments — with its own
// vertices in version 2, as indices into the surface's vertex array in version 3
// (which may also carry, past the surface's own vertices, endpoints that lie on
// none of them: the payload's positions stop before those). GLTFLoader then
// makes the node a Group of a Mesh and a LineSegments (the node's extras and
// name on the Group, not the Mesh), so each surface and its lines are matched
// through the glTF NODE they belong to. Lines go back to model frame through
// the same matrix as the positions; a node with no line primitive — version 1,
// or a sub-part whose edges were empty — decodes to an EMPTY Float32Array,
// which the viewer reads as "no feature edges" (never undefined, which would
// make it derive lines by angle).
//
// Rejects on anything that is not a decodable GLB; the callers (mount's
// `preview`, mountPreview) decide what a failure means for them.
import { Matrix3, Matrix4, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

// The writer's root rotation (−90° about X), inverted: glTF Y-up → model Z-up.
const Y_UP_TO_Z_UP = new Matrix4().makeRotationX(Math.PI / 2);

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  throw new TypeError("decodePreviewGlb: the preview must be a Uint8Array or an ArrayBuffer");
}

// Read a (possibly quantized, normalized) vec3 attribute out as Float32,
// transformed — its first `count` elements (all of them by default).
function readVec3(attr, matrix, isNormal, count = attr.count) {
  const out = new Float32Array(count * 3);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(attr, i); // denormalizes a KHR_mesh_quantization attribute
    if (isNormal) v.applyMatrix3(matrix).normalize();
    else v.applyMatrix4(matrix);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

function metaOf(extras) {
  const m = extras?.partforgeMeta;
  if (!m || typeof m !== "object") return null;
  const out = {};
  if (Number.isInteger(m.background)) out.background = m.background;
  if (typeof m.environment === "string") out.environment = m.environment;
  return Object.keys(out).length ? out : null;
}

// The object standing for a glTF node: the object itself when its node had one
// primitive, else the Group GLTFLoader made for a multi-primitive mesh — the
// one carrying the node's extras / name (a primitive's own Mesh has neither).
function nodeObjectOf(obj) {
  const own = obj.userData ?? {};
  if ("partforgeSubPart" in own || "name" in own) return obj;
  const parent = obj.parent;
  return parent?.isGroup && parent.userData && ("partforgeSubPart" in parent.userData || "name" in parent.userData) ? parent : obj;
}

// Line segments as endpoint pairs in model frame: an indexed LINES primitive
// expanded back to pairs. Version 3's position attribute is the SURFACE's
// (GLTFLoader hands both objects the same BufferAttribute), so only the
// vertices the line indices name are read — never the whole array.
function readSegments(geometry, matrix) {
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) return null;
  if (!geometry.index) return readVec3(position, matrix, false);
  const index = geometry.index.array;
  const out = new Float32Array(index.length * 3);
  const v = new Vector3();
  for (let i = 0; i < index.length; i++) {
    v.fromBufferAttribute(position, index[i]).applyMatrix4(matrix);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

// How many leading vertices the surface's triangles use. Version 3 appends edge
// endpoints that lie on no surface vertex AFTER the surface's own (which weld +
// reorder leave all referenced, in first-use order); they belong to the lines,
// so the payload stops before them. For versions 1–2 this is every vertex.
function surfaceVertexCount(position, index) {
  if (!index) return position.count;
  let max = -1;
  const a = index.array;
  for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
  return max + 1;
}

export async function decodePreviewGlb(bytes) {
  const data = toArrayBuffer(bytes);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, "");
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  const edgesByNode = new Map(); // node object → model-frame segment arrays
  const meshByNode = new Map(); // node object → its surface payload
  const toModel = new Matrix4();
  const normalMatrix = new Matrix3();
  gltf.scene.traverse((obj) => {
    if (obj.isLineSegments) {
      toModel.multiplyMatrices(Y_UP_TO_Z_UP, obj.matrixWorld);
      const segments = readSegments(obj.geometry, toModel);
      if (segments) {
        const node = nodeObjectOf(obj);
        edgesByNode.set(node, [...(edgesByNode.get(node) ?? []), segments]);
      }
      obj.geometry.dispose();
      return;
    }
    if (!obj.isMesh) return;
    const geometry = obj.geometry;
    const position = geometry.getAttribute("position");
    if (!position || position.count === 0) return;
    toModel.multiplyMatrices(Y_UP_TO_Z_UP, obj.matrixWorld);
    normalMatrix.getNormalMatrix(toModel);
    const normal = geometry.getAttribute("normal");
    const indices = geometry.index ? Uint32Array.from(geometry.index.array) : null;
    const count = surfaceVertexCount(position, geometry.index);
    const node = nodeObjectOf(obj);
    const { partforgeSubPart, partforgeDisplay, name: originalName } = node.userData;
    const payload = {
      // The writer's own record of the key, then the unsanitized glTF node name.
      name: typeof partforgeSubPart === "string" ? partforgeSubPart : (originalName ?? node.name),
      positions: readVec3(position, toModel, false, count),
      normals: normal ? readVec3(normal, normalMatrix, true, count) : null,
      indices,
      triangles: (indices ? indices.length : count) / 3,
      edges: new Float32Array(0), // filled below from the node's LINES primitive, if any
      display: partforgeDisplay && typeof partforgeDisplay === "object" ? partforgeDisplay : null,
    };
    meshes.push(payload);
    if (!meshByNode.has(node)) meshByNode.set(node, payload);
    geometry.dispose();
  });
  for (const [node, parts] of edgesByNode) {
    const payload = meshByNode.get(node);
    if (!payload) continue; // lines with no surface: nothing to draw them on
    const total = parts.reduce((n, p) => n + p.length, 0);
    const edges = new Float32Array(total);
    let at = 0;
    for (const p of parts) { edges.set(p, at); at += p.length; }
    payload.edges = edges;
  }
  const extras = gltf.userData ?? {};
  return {
    view: typeof extras.partforgeView === "string" ? extras.partforgeView : null,
    meta: metaOf(extras),
    meshes,
  };
}
