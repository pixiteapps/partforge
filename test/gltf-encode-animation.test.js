// The preview GLB's baked animation (encoder version 4): glTF channels for the
// sub-parts that move, rest transforms for every sampled sub-part, and the
// partforgeAnimation extra a kernel-free viewer drives the timeline from.
import { expect, test } from "vitest";
import { encodePreviewGlb } from "../src/framework/gltf/encode-preview.js";
import { readGlb } from "./helpers/preview-glb.js";
import { box, input, R, readJson, T } from "./helpers/preview-animation-fixture.js";

const meshes = () => [box("base"), box("lid", 24)];

test("a moving sub-part gets translation + rotation channels; a still one gets none", async () => {
  const json = readJson(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() }));
  expect(json.animations).toHaveLength(1);
  expect(json.animations[0].name).toBe("cycle");
  const targets = json.animations[0].channels.map((c) => [json.nodes[c.target.node].name, c.target.path].join(":")).sort();
  expect(targets).toEqual(["lid:rotation", "lid:translation"]);
  expect(json.animations[0].samplers.every((s) => s.interpolation === "LINEAR")).toBe(true);
  expect(json.extras.partforgeAnimation).toMatchObject({
    name: "cycle", label: "Open / close", loop: true, duration: 2, animated: ["lid"],
    cues: [{ t: 0, view: "front", sweep: null }],
    steps: [{ label: null, start: 0, duration: 2 }],
  });
  expect(json.extras.partforgeEncoder).toBe(4);
});

test("input times are seconds spanning the whole duration", async () => {
  const json = readJson(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() }));
  const inputAcc = json.accessors[json.animations[0].samplers[0].input];
  expect(inputAcc.min).toEqual([0]);
  expect(inputAcc.max).toEqual([2]);
  expect(inputAcc.count).toBe(3);
});

test("the rest transform is the opening pose relative to the baked pose (identity here)", async () => {
  const json = readJson(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() }));
  const lid = json.nodes.find((n) => n.name === "lid");
  expect(lid.translation ?? [0, 0, 0]).toEqual([0, 0, 0]); // rel(0) = T(24)·T(24)⁻¹
  expect(lid.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
});

test("a constant non-identity pose writes a rest transform and no channel", async () => {
  const a = input();
  for (const s of a.samples) s.poses.lid = T(40); // held 16mm above its baked pose the whole time
  const bytes = await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a });
  const json = readJson(bytes);
  expect(json.animations ?? []).toHaveLength(0);
  expect(json.extras.partforgeAnimation.animated).toEqual([]);
  // The lid draws at z 40 (glTF −Z after the root's −90° about X): the rest
  // transform survived quantize()'s composition onto the node.
  const doc = await readGlb(bytes);
  const node = doc.getRoot().listNodes().find((n) => n.getName() === "lid");
  const m = node.getWorldMatrix();
  const p = node.getMesh().listPrimitives()[0].getAttribute("POSITION").getElement(0, []);
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]; // glTF Y = model Z
  expect(y).toBeCloseTo(40, 2);
});

test("a camera-only animation writes the extra and no glTF animation", async () => {
  const a = input();
  for (const s of a.samples) s.poses.lid = T(24);
  const json = readJson(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a }));
  expect(json.animations ?? []).toHaveLength(0);
  expect(json.extras.partforgeAnimation.cues).toHaveLength(1);
  expect(json.extras.partforgeAnimation.animated).toEqual([]);
});

test("consecutive quaternions keep the same hemisphere", async () => {
  const a = input();
  a.samples = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, poses: { base: T(0), lid: R(-350 * t) }, opacity: {} }));
  const doc = await readGlb(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a }));
  const [animation] = doc.getRoot().listAnimations();
  const channel = animation.listChannels().find((c) => c.getTargetPath() === "rotation");
  const out = channel.getSampler().getOutput();
  expect(out.getCount()).toBe(5);
  const qs = [];
  for (let i = 0; i < out.getCount(); i++) qs.push(out.getElement(i, []));
  for (let i = 1; i < qs.length; i++) {
    const dot = qs[i].reduce((s, v, k) => s + v * qs[i - 1][k], 0);
    expect(dot, `samples ${i - 1}→${i}`).toBeGreaterThanOrEqual(0);
  }
});

test("opacity rides the extra, sampled at the sample times", async () => {
  const a = input();
  a.samples[0].opacity = { lid: 0 };
  a.samples[1].opacity = { lid: 0.5 };
  a.samples[2].opacity = { lid: 1 };
  const json = readJson(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a }));
  expect(json.extras.partforgeAnimation.opacity).toEqual({ lid: [[0, 0], [0.5, 0.5], [1, 1]] });
});

test("a sample that omits a sub-part's opacity contributes no key for it", async () => {
  const a = input();
  a.samples[0].opacity = { lid: 0 };
  a.samples[2].opacity = { lid: 1, base: 0.5 };
  const json = readJson(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a }));
  expect(json.extras.partforgeAnimation.opacity).toEqual({ lid: [[0, 0], [1, 1]], base: [[1, 0.5]] });
});

test("required and used extensions are unchanged by an animation", async () => {
  const json = readJson(await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() }));
  expect(json.extensionsRequired.sort()).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
});

test("identical animated input encodes to identical bytes", async () => {
  const a = await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() });
  const b = await encodePreviewGlb({ meshes: meshes(), view: "box", animation: input() });
  expect(Buffer.compare(a, b)).toBe(0);
});

test("the animation input is not mutated", async () => {
  const a = input();
  const snapshot = JSON.stringify(a);
  await encodePreviewGlb({ meshes: meshes(), view: "box", animation: a });
  expect(JSON.stringify(a)).toBe(snapshot);
});

test("a non-rigid pose is refused, naming the sub-part", async () => {
  const a = input();
  a.samples[1].poses.lid = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  await expect(encodePreviewGlb({ meshes: meshes(), view: "box", animation: a })).rejects.toThrow(/"lid" pose at t=0.5 is not a rigid motion/);
});

test("a mirroring pose is refused (det −1)", async () => {
  const a = input();
  a.samples[1].poses.lid = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  await expect(encodePreviewGlb({ meshes: meshes(), view: "box", animation: a })).rejects.toThrow(/"lid".*rigid/);
});

test("a sampled sub-part with no mesh is refused", async () => {
  await expect(encodePreviewGlb({ meshes: [box("base")], view: "box", animation: input() }))
    .rejects.toThrow('encodePreviewGlb: animation names "lid", which has no mesh');
});

test("a sample missing a sub-part another sample has is refused", async () => {
  const a = input();
  delete a.samples[1].poses.lid;
  await expect(encodePreviewGlb({ meshes: meshes(), view: "box", animation: a })).rejects.toThrow(/"lid"/);
});

test("samples must start at t=0 and end at t=1", async () => {
  const a = input();
  a.samples = a.samples.slice(1);
  await expect(encodePreviewGlb({ meshes: meshes(), view: "box", animation: a })).rejects.toThrow(/t = 0/);
  const b = input();
  b.samples = b.samples.slice(0, 2);
  await expect(encodePreviewGlb({ meshes: meshes(), view: "box", animation: b })).rejects.toThrow(/t = 1/);
});

test("without an animation the file carries no animations and no partforgeAnimation extra", async () => {
  const json = readJson(await encodePreviewGlb({ meshes: [box("base")], view: "box" }));
  expect(json.animations).toBeUndefined();
  expect(json.extras.partforgeAnimation).toBeUndefined();
  expect(json.extras.partforgeEncoder).toBe(4);
});
