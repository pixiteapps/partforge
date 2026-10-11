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

// Read a (possibly quantized, normalized) vec3 attribute out as Float32, transformed.
function readVec3(attr, matrix, isNormal) {
  const out = new Float32Array(attr.count * 3);
  const v = new Vector3();
  for (let i = 0; i < attr.count; i++) {
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

export async function decodePreviewGlb(bytes) {
  const data = toArrayBuffer(bytes);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, "");
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  const toModel = new Matrix4();
  const normalMatrix = new Matrix3();
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const geometry = obj.geometry;
    const position = geometry.getAttribute("position");
    if (!position || position.count === 0) return;
    toModel.multiplyMatrices(Y_UP_TO_Z_UP, obj.matrixWorld);
    normalMatrix.getNormalMatrix(toModel);
    const normal = geometry.getAttribute("normal");
    const indices = geometry.index ? Uint32Array.from(geometry.index.array) : null;
    const { partforgeSubPart, partforgeDisplay, name: originalName } = obj.userData;
    meshes.push({
      // The writer's own record of the key, then the unsanitized glTF node name.
      name: typeof partforgeSubPart === "string" ? partforgeSubPart : (originalName ?? obj.name),
      positions: readVec3(position, toModel, false),
      normals: normal ? readVec3(normal, normalMatrix, true) : null,
      indices,
      triangles: (indices ? indices.length : position.count) / 3,
      edges: new Float32Array(0), // previews carry no feature edges (v1)
      display: partforgeDisplay && typeof partforgeDisplay === "object" ? partforgeDisplay : null,
    });
    geometry.dispose();
  });
  const extras = gltf.userData ?? {};
  return {
    view: typeof extras.partforgeView === "string" ? extras.partforgeView : null,
    meta: metaOf(extras),
    meshes,
  };
}
