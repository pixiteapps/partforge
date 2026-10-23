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
// The baked animation (encoder version 4) comes back as `animation`, null for a
// file without the partforgeAnimation extra (every version 1–3 file):
// { ...the extra (name, label, loop, duration, cues, opacity, steps, animated),
//   tracks: { <sub>: { times, translations, rotations } }, rest: { <sub>: mat16 } }.
// `times` are seconds; `translations` xyz triples and `rotations` xyzw quads are
// the node's TRS keyframes, which the writer expresses in the root's LOCAL frame
// — the part's Z-up MODEL frame — so they need no conversion (positions do: they
// go through the node's world matrix, root rotation included). Only sub-parts
// that move have a track; `rest[name]` is the column-major mat4 of a track's
// first keyframe (t = 0), the pose already baked into that sub-part's
// positions — meshes decode at the OPENING pose. Channels are read off the raw
// glTF JSON and resolved through the parser, never by AnimationClip track name
// (three sanitizes node names). An animated sub-part's mesh sits on an unnamed
// child of its node (quantize() moves it there), so a mesh's sub-part is found
// by walking up to the nearest node carrying partforgeSubPart.
//
// Rejects on anything that is not a decodable GLB; the callers (mount's
// `preview`, mountPreview) decide what a failure means for them.
import { Matrix3, Matrix4, Quaternion, Vector3 } from "three";
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

// The object standing for a glTF node: the nearest of the object and its
// ancestors (below the scene root) carrying the writer's partforgeSubPart — an
// animated sub-part's mesh sits one or two levels under it (quantize()'s unnamed
// child, then GLTFLoader's Group for a multi-primitive mesh). Failing that, the
// object itself when its node had one primitive, else the Group GLTFLoader made
// for a multi-primitive mesh — the one carrying the node's extras / name (a
// primitive's own Mesh has neither).
function nodeObjectOf(obj) {
  for (let o = obj; o && o.parent; o = o.parent) {
    if (typeof o.userData?.partforgeSubPart === "string") return o;
  }
  const own = obj.userData ?? {};
  if ("partforgeSubPart" in own || "name" in own) return obj;
  const parent = obj.parent;
  return parent?.isGroup && parent.userData && ("partforgeSubPart" in parent.userData || "name" in parent.userData) ? parent : obj;
}

// The sub-part key a node object stands for: the writer's own record of the key,
// then the unsanitized glTF node name.
function subPartNameOf(node) {
  const { partforgeSubPart, name } = node.userData ?? {};
  return typeof partforgeSubPart === "string" ? partforgeSubPart : (name ?? node.name);
}

// An accessor's elements as a Float32Array of `size` components each, through
// getX/getY/getZ/getW so a normalized output would be denormalized (this writer
// stores the channels as plain float32; the guard is for any other writer).
function readComponents(attr, size) {
  const out = new Float32Array(attr.count * size);
  const get = [attr.getX, attr.getY, attr.getZ, attr.getW].slice(0, size);
  for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = get[k].call(attr, i);
  return out;
}

// The baked animation (see the header): the partforgeAnimation extra plus the
// first glTF animation's channels as model-frame keyframes per sub-part.
async function readAnimation(gltf) {
  const extra = gltf.userData?.partforgeAnimation;
  if (!extra || typeof extra !== "object") return null;
  const tracks = {};
  const rest = {};
  const def = gltf.parser.json.animations?.[0];
  for (const channel of def?.channels ?? []) {
    const path = channel.target?.path;
    if ((path !== "translation" && path !== "rotation") || channel.target.node === undefined) continue;
    const sampler = def.samplers[channel.sampler];
    const node = await gltf.parser.getDependency("node", channel.target.node);
    const [input, output] = await Promise.all([
      gltf.parser.getDependency("accessor", sampler.input),
      gltf.parser.getDependency("accessor", sampler.output),
    ]);
    const track = (tracks[subPartNameOf(nodeObjectOf(node))] ??= { times: null, translations: null, rotations: null });
    track.times ??= readComponents(input, 1);
    if (path === "translation") track.translations = readComponents(output, 3);
    else track.rotations = readComponents(output, 4);
  }
  for (const [name, track] of Object.entries(tracks)) {
    const t = track.translations ?? new Float32Array(3);
    const r = track.rotations ?? Float32Array.of(0, 0, 0, 1);
    rest[name] = new Matrix4()
      .compose(new Vector3(t[0], t[1], t[2]), new Quaternion(r[0], r[1], r[2], r[3]).normalize(), new Vector3(1, 1, 1))
      .toArray();
  }
  return { ...extra, tracks, rest };
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
    const { partforgeDisplay } = node.userData;
    const payload = {
      name: subPartNameOf(node),
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
    animation: await readAnimation(gltf),
  };
}
