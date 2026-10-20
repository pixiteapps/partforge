// @vitest-environment happy-dom
// The preview GLB's baked animation, decoded (encoder version 4): channels read
// back as model-frame keyframes, the rest pose baked into the positions, and the
// sub-part's name / display found above the child node quantize() puts the mesh on.
import { Matrix4, Quaternion } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { expect, test } from "vitest";
import { encodePreviewGlb } from "../../src/framework/gltf/encode-preview.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { composePose, invertRigid, mulMat4 } from "../../src/framework/geometry/pose.js";
import { samplePreviewAnimation } from "../../src/framework/preview-animation.js";
import { createPreviewPlayer } from "../../src/framework/preview-player.js";
import { evaluate } from "../../src/framework/animation.js";
import { probePoses } from "../../src/framework/pose-probe.js";
import hingedBox from "../../src/parts/hinged-box.js";
import { box, input, R, T } from "../helpers/preview-animation-fixture.js";

const meshes = () => [box("base"), box("lid", 24)];
const zs = (positions) => Array.from(positions).filter((_, i) => i % 3 === 2);

test("an encoder-3-style file (no animation) decodes with animation: null", async () => {
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: [box("base")], view: "box" }));
  expect(d.animation).toBeNull();
});

test("channels come back as model-frame keyframes; rest is the t=0 matrix", async () => {
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() }));
  expect(d.animation).toMatchObject({ name: "cycle", label: "Open / close", loop: true, duration: 2 });
  expect(d.animation.animated).toEqual(["lid"]);
  expect(Array.from(d.animation.tracks.lid.times)).toEqual([0, 1, 2]);
  expect(d.animation.tracks.lid.translations).toBeInstanceOf(Float32Array);
  expect(d.animation.tracks.lid.translations).toHaveLength(9);
  expect(d.animation.tracks.lid.rotations).toHaveLength(12);
  expect(d.animation.tracks.base).toBeUndefined();
  expect(d.animation.rest.lid.map((v) => +v.toFixed(5) + 0)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

test("the mid keyframe decodes to M(t)·base⁻¹", async () => {
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() }));
  const rel = mulMat4(R(-110), invertRigid(T(24)));
  const { translations, rotations } = d.animation.tracks.lid;
  const got = Array.from(translations.subarray(3, 6));
  const want = [rel[12], rel[13], rel[14]];
  // R(−110°)·(0, 0, −24): a real lever arm, so the order of the product shows
  expect(Math.hypot(want[1], want[2])).toBeGreaterThan(20);
  for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k]), `translation[${k}]`).toBeLessThan(0.1);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().fromArray(rel));
  const gotQ = Array.from(rotations.subarray(4, 8));
  const wantQ = [q.x, q.y, q.z, q.w];
  const sign = gotQ.reduce((s, v, k) => s + v * wantQ[k], 0) < 0 ? -1 : 1;
  for (let k = 0; k < 4; k++) expect(Math.abs(sign * gotQ[k] - wantQ[k]), `rotation[${k}]`).toBeLessThan(1e-3);
});

test("the meshes decode at the opening pose (rest baked into positions)", async () => {
  const a = input();
  for (const s of a.samples) s.poses.lid = T(40); // constant, held 16 mm above its baked pose
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a }));
  const lid = d.meshes.find((m) => m.name === "lid");
  expect(Math.min(...zs(lid.positions))).toBeCloseTo(40, 1);
});

test("an animated sub-part's name and display are found above quantize's child node", async () => {
  const part = { parts: { lid: { display: { material: "walnut" } } } };
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "box", animation: input() }));
  const lid = d.meshes.find((m) => m.name === "lid");
  expect(lid.display).toEqual({ material: "walnut" });
  expect(d.meshes.map((m) => m.name).sort()).toEqual(["base", "lid"]);
});

test("a camera-only file decodes with empty tracks and its cues", async () => {
  const a = input();
  for (const s of a.samples) s.poses.lid = T(24);
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a }));
  expect(d.animation.tracks).toEqual({});
  expect(d.animation.rest).toEqual({}); // a still sub-part's rest pose is already in its positions
  expect(d.animation.cues).toEqual([{ t: 0, view: "front", sweep: null }]);
});

test("feature edges of an animated sub-part decode beside its surface", async () => {
  const lid = { ...box("lid", 24), edges: new Float32Array([0, 0, 24, 10, 0, 24]) };
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: [box("base"), lid], view: "box", animation: input() }));
  const out = d.meshes.find((m) => m.name === "lid");
  expect(out.edges).toHaveLength(6);
  expect(Array.from(out.edges).map((v) => +v.toFixed(2) + 0)).toEqual([0, 0, 24, 10, 0, 24]);
});

test("feature edges of an ANIMATED sub-part that take the own-vertices fallback decode beside its surface", async () => {
  // A mast 6 mm above the flat lid: an endpoint outside the surface's bounds, so
  // the encoder writes the lines with their own vertices. The opening pose holds
  // the lid 16 mm above its baked pose; surface and lines must move together.
  const edges = new Float32Array([0, 0, 24, 10, 0, 24, 5, 5, 24, 5, 5, 30]);
  const lid = { ...box("lid", 24), edges };
  const a = input();
  a.samples[0].poses.lid = T(40);
  a.samples[2].poses.lid = T(40);
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes: [box("base"), lid], view: "box", animation: a }));
  expect(d.animation.animated).toEqual(["lid"]);
  const out = d.meshes.find((m) => m.name === "lid");
  expect(Math.min(...zs(out.positions))).toBeCloseTo(40, 1);
  const want = Array.from(edges).map((v, i) => (i % 3 === 2 ? v + 16 : v));
  expect(out.edges).toHaveLength(want.length);
  for (let i = 0; i < want.length; i++) expect(Math.abs(out.edges[i] - want[i]), `edges[${i}]`).toBeLessThan(0.01);
});

// --- Older readers --------------------------------------------------------------
// partforge 0.157's decoder walked ONE level up from a mesh to find its node
// (verbatim from `git show 1d00202b:src/framework/gltf/decode-preview.js`). The
// cloud serves the newest preview row whatever partforge version wrote it, so a
// 0.157 page can meet a version-4 file: the lid must keep its name, its look and
// its edges, drawn at the opening pose.
function nodeObjectOf157(obj) {
  const own = obj.userData ?? {};
  if ("partforgeSubPart" in own || "name" in own) return obj;
  const parent = obj.parent;
  return parent?.isGroup && parent.userData && ("partforgeSubPart" in parent.userData || "name" in parent.userData) ? parent : obj;
}
const Y_UP_TO_Z_UP = new Matrix4().makeRotationX(Math.PI / 2);
async function decodeLike157(bytes) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  gltf.scene.updateMatrixWorld(true);
  const out = new Map(); // node object → { name, display, zs, edges }
  const at = (node) => {
    if (!out.has(node)) {
      const { partforgeSubPart, partforgeDisplay, name } = node.userData;
      out.set(node, { name: typeof partforgeSubPart === "string" ? partforgeSubPart : (name ?? node.name), display: partforgeDisplay ?? null, zs: [], edges: 0 });
    }
    return out.get(node);
  };
  const m = new Matrix4();
  gltf.scene.traverse((obj) => {
    if (obj.isLineSegments) { at(nodeObjectOf157(obj)).edges += obj.geometry.index?.count ?? obj.geometry.getAttribute("position").count; return; }
    if (!obj.isMesh) return;
    m.multiplyMatrices(Y_UP_TO_Z_UP, obj.matrixWorld);
    const entry = at(nodeObjectOf157(obj));
    const p = obj.geometry.getAttribute("position");
    for (let i = 0; i < p.count; i++) entry.zs.push(p.getX(i) * m.elements[2] + p.getY(i) * m.elements[6] + p.getZ(i) * m.elements[10] + m.elements[14]);
  });
  return [...out.values()];
}

test("a 0.157 reader (one-level node walk) still names, styles and edges an animated sub-part, at the opening pose", async () => {
  const part = { parts: { lid: { display: { material: "walnut" } } } };
  const lid = { ...box("lid", 24), edges: new Float32Array([0, 0, 24, 10, 0, 24]) };
  const a = input();
  a.samples[0].poses.lid = T(40); // the opening pose: 16 mm above the baked one
  a.samples[2].poses.lid = T(40);
  const bytes = await encodePreviewGlb({ meshes: [box("base"), lid], part, view: "box", animation: a });
  const nodes = await decodeLike157(bytes);
  expect(nodes.map((n) => n.name).sort()).toEqual(["base", "lid"]);
  const got = nodes.find((n) => n.name === "lid");
  expect(got.display).toEqual({ material: "walnut" });
  expect(got.edges).toBe(2); // one segment, two endpoints
  expect(Math.min(...got.zs)).toBeCloseTo(40, 1);
  // The current decoder agrees, and its channels still resolve to "lid".
  const d = await decodePreviewGlb(bytes);
  expect(Object.keys(d.animation.tracks)).toEqual(["lid"]);
  expect(d.meshes.filter((m) => m.name === "lid")).toHaveLength(1);
});

// --- The `base` contract, round trip -----------------------------------------------
// The file's positions are base · (what build() returned). A build() that ends in
// its own translate() must not leak that translate into `base` (the sampler reads
// the PLACE-scope probe, never the full scope): after encode → decode → play,
// every vertex lands where place(t) · build puts it.
const xf = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const placeOf = (part, p, name) => composePose(probePoses(part, "box", p, { scope: "place" }).get(name).pose);

test("a build() ending in translate() round-trips: opening pose and mid keyframe land at place(t) · build", async () => {
  const OFFSET = [5, 3, 0];
  const part = { ...hingedBox, parts: { ...hingedBox.parts, lid: { ...hingedBox.parts.lid,
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.width, p.depth, p.wall] }).translate(OFFSET) } } };
  const out = samplePreviewAnimation(part, "box", {}, { buildReads: () => new Set(["width", "depth", "height", "wall"]) });
  expect(out).not.toBeNull();
  // base is place() alone: the build's own translate is not in it.
  const want = composePose([{ t: "translate", v: [0, 0, 24] }]);
  out.base.lid.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
  // What build() returned, a few distinct points of the 60×40×2 plate, offset.
  const built = [[0, 0, 0], [60, 0, 0], [0, 40, 0], [60, 40, 2], [0, 0, 2], [60, 40, 0]].map((c) => c.map((v, i) => v + OFFSET[i]));
  const soup = (pts) => Float32Array.from([0, 1, 2, 3, 4, 5].flatMap((i) => pts[i]));
  const meshes = ["base", "lid"].map((n) => ({ name: n, positions: soup(built.map((c) => xf(out.base[n], c))) }));
  const d = await decodePreviewGlb(await encodePreviewGlb({ meshes, part, view: "box", animation: out }));
  const decoded = d.meshes.find((m) => m.name === "lid").positions;
  const poses = {};
  let frame = null;
  const viewer = { setSubPose: (n, m) => { poses[n] = m; }, setSubPartOpacity() {}, tweenCameraTo() {}, holdGround() {},
    onFrame: (cb) => { frame = cb; return () => {}; }, onCameraStart: () => () => {} };
  const player = createPreviewPlayer(viewer, { ...d.animation, cues: [] });
  player.start();
  let checkedMid = false;
  for (let k = 0; k <= 12; k++) {
    if (k) frame(0.1);
    const { t } = player.state();
    const M = placeOf(part, { ...part.defaults, ...evaluate(out.anim, t).values }, "lid");
    const expected = built.map((c) => xf(M, c));
    for (let i = 0; i < decoded.length; i += 3) {
      const g = xf(poses.lid, [decoded[i], decoded[i + 1], decoded[i + 2]]);
      const err = Math.min(...expected.map((e) => Math.hypot(g[0] - e[0], g[1] - e[1], g[2] - e[2])));
      expect(err, `t=${t} vertex ${i / 3}`).toBeLessThan(0.05);
    }
    if (Math.abs(t - 0.5) < 0.05) checkedMid = true;
  }
  expect(checkedMid).toBe(true); // the 110° keyframe region was checked, not only the ends
});
