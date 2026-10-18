// @vitest-environment happy-dom
// The preview GLB's baked animation, decoded (encoder version 4): channels read
// back as model-frame keyframes, the rest pose baked into the positions, and the
// sub-part's name / display found above the child node quantize() puts the mesh on.
import { Matrix4, Quaternion } from "three";
import { expect, test } from "vitest";
import { encodePreviewGlb } from "../../src/framework/gltf/encode-preview.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { invertRigid, mulMat4 } from "../../src/framework/geometry/pose.js";
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
