// @vitest-environment happy-dom
// The preview reader: three's GLTFLoader + MeshoptDecoder, turning the writer's
// file back into the viewer's own mesh payloads in the part's Z-up frame — so a
// preview goes through setSubGeometry exactly like a worker delivery.
import { expect, test } from "vitest";
import { encodePreviewGlb } from "../../src/gltf.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxSoup, indexedBox, boundsOf } from "../helpers/preview-glb.js";

const expectNear = (got, want, digits = 2) => got.forEach((g, i) => expect(g).toBeCloseTo(want[i], digits));
const part = { meta: { environment: "workshop" }, parts: { base: { display: { color: 0xff0000 } }, lid: {} } };
const encode = () => encodePreviewGlb({
  meshes: [boxSoup("base", [0, 0, 0], [4, 2, 6]), indexedBox("lid", [0, 0, 6], [4, 2, 7])], part, view: "assembly",
});

test("decodes back to model-frame (Z-up) payloads named by sub-part key", async () => {
  const out = await decodePreviewGlb(await encode());
  expect(out.view).toBe("assembly");
  expect(out.meta).toEqual({ environment: "workshop" });
  expect(out.meshes.map((m) => m.name)).toEqual(["base", "lid"]);
  const [base, lid] = out.meshes;
  expect(base.triangles).toBe(12);
  expect(lid.triangles).toBe(12);
  expect(base.display).toEqual({ color: 0xff0000 });
  expect(lid.display).toBeNull();
  expect(base.edges).toEqual(new Float32Array(0));
  expect(base.indices).toBeInstanceOf(Uint32Array);
  const b = boundsOf(base.positions);
  expectNear(b.min, [0, 0, 0]);
  expectNear(b.max, [4, 2, 6]);
  const l = boundsOf(lid.positions);
  expectNear(l.min, [0, 0, 6]);
  expectNear(l.max, [4, 2, 7]);
  for (let i = 0; i < base.normals.length; i += 3) {
    expect(Math.hypot(base.normals[i], base.normals[i + 1], base.normals[i + 2])).toBeCloseTo(1, 3);
  }
});

test("a face normal comes back pointing the way it was written (+Z stays +Z)", async () => {
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [boxSoup("top", [0, 0, 0], [1, 1, 1])], view: "v" }));
  const { positions, normals } = out.meshes[0];
  // a vertex on the top face (z = 1) whose normal is the face's
  let found = false;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2] - 1) < 1e-3 && normals[i + 2] > 0.99) found = true;
  }
  expect(found).toBe(true);
});

test("accepts an ArrayBuffer and an offset Uint8Array view alike", async () => {
  const glb = await encode();
  const padded = new Uint8Array(glb.length + 8);
  padded.set(glb, 8);
  expect((await decodePreviewGlb(padded.subarray(8))).meshes).toHaveLength(2);
  const exact = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  expect((await decodePreviewGlb(exact)).meshes).toHaveLength(2);
});

test("anything that is not a decodable GLB rejects", async () => {
  await expect(decodePreviewGlb(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  await expect(decodePreviewGlb((await encode()).subarray(0, 40))).rejects.toThrow();
  await expect(decodePreviewGlb("glTF")).rejects.toThrow(TypeError);
});
