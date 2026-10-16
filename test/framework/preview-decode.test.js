// @vitest-environment happy-dom
// The preview reader: three's GLTFLoader + MeshoptDecoder, turning the writer's
// file back into the viewer's own mesh payloads in the part's Z-up frame — so a
// preview goes through setSubGeometry exactly like a worker delivery.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { expect, test } from "vitest";
import { encodePreviewGlb } from "../../src/gltf.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxEdges, boxSoup, indexedBox, boundsOf, poseArray, segmentMismatch } from "../helpers/preview-glb.js";

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

// --- feature edges (encoder v2) ---------------------------------------------------
const withEdges = (mesh, min, max) => ({ ...mesh, edges: boxEdges(min, max) });
// A sub-part posed 30° about Z and moved: positions, normals and edges together.
function posedBox(name) {
  const box = withEdges(boxSoup(name, [0, 0, 0], [3, 2, 5]), [0, 0, 0], [3, 2, 5]);
  const t = [12, -7, 4];
  return { ...box, positions: poseArray(box.positions, 30, t), normals: poseArray(box.normals, 30, t, true), edges: poseArray(box.edges, 30, t) };
}

test("feature edges round-trip in the model frame, for a posed sub-part and two at once", async () => {
  const lid = withEdges(indexedBox("lid", [0, 0, 6], [4, 2, 7]), [0, 0, 6], [4, 2, 7]);
  const body = posedBox("body");
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [body, lid], view: "v" }));
  expect(out.meshes.map((m) => m.name)).toEqual(["body", "lid"]);
  const [b, l] = out.meshes;
  expect(b.edges).toBeInstanceOf(Float32Array);
  expect(segmentMismatch(b.edges, body.edges)).toBeNull();
  expect(segmentMismatch(l.edges, lid.edges)).toBeNull();
  // the triangles came through alongside the lines, unchanged
  expect(b.triangles).toBe(12);
  expect(l.triangles).toBe(12);
  expect(l.indices).toBeInstanceOf(Uint32Array);
});

test("every decoded edge endpoint sits on a decoded triangle vertex (one quantization volume)", async () => {
  const body = posedBox("body");
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [body], view: "v" }));
  const { positions, edges } = out.meshes[0];
  expect(edges.length).toBe(72);
  for (let e = 0; e < edges.length; e += 3) {
    let best = Infinity;
    for (let v = 0; v < positions.length; v += 3) {
      best = Math.min(best, Math.hypot(edges[e] - positions[v], edges[e + 1] - positions[v + 1], edges[e + 2] - positions[v + 2]));
    }
    expect(best).toBeLessThan(1e-4);
  }
});

test("empty edges come back empty, and so do absent ones", async () => {
  const sphereLike = { ...boxSoup("ball", [0, 0, 0], [1, 1, 1]), edges: new Float32Array(0) };
  const bare = { ...boxSoup("bare", [2, 0, 0], [3, 1, 1]) };
  delete bare.edges;
  const nulled = { ...boxSoup("nulled", [4, 0, 0], [5, 1, 1]), edges: null };
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [sphereLike, bare, nulled], view: "v" }));
  expect(out.meshes.map((m) => m.name)).toEqual(["ball", "bare", "nulled"]);
  for (const m of out.meshes) {
    expect(m.edges).toBeInstanceOf(Float32Array);
    expect(m.edges.length).toBe(0);
  }
});

test("a version-1 file (no line primitives) still decodes, with empty edges", async () => {
  const v1 = new Uint8Array(readFileSync(fileURLToPath(new NodeURL("../fixtures/preview-v1.glb", import.meta.url))));
  const out = await decodePreviewGlb(v1);
  expect(out.view).toBe("main");
  expect(out.meshes.map((m) => m.name)).toEqual(["base", "lid"]);
  expect(out.meshes[0].display).toEqual({ color: 0xff0000 });
  for (const m of out.meshes) {
    expect(m.triangles).toBe(12);
    expect(m.edges).toEqual(new Float32Array(0));
  }
  const b = boundsOf(out.meshes[0].positions);
  expectNear(b.min, [0, 0, 0]);
  expectNear(b.max, [4, 2, 6]);
});
