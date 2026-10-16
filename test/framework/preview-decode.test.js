// @vitest-environment happy-dom
// The preview reader: three's GLTFLoader + MeshoptDecoder, turning the writer's
// file back into the viewer's own mesh payloads in the part's Z-up frame — so a
// preview goes through setSubGeometry exactly like a worker delivery.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { expect, test } from "vitest";
import { encodePreviewGlb } from "../../src/gltf.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxEdges, boxSoup, denseGrid, glbJson, indexedBox, boundsOf, poseArray, segmentMismatch } from "../helpers/preview-glb.js";

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
  // body's display rides the node extras, which GLTFLoader puts on the Group of a
  // two-primitive mesh (the nodeObjectOf path)
  const out = await decodePreviewGlb(await encodePreviewGlb({
    meshes: [body, lid], view: "v", part: { parts: { body: { display: { color: 0x00ff00 } } } } }));
  expect(out.meshes.map((m) => m.name)).toEqual(["body", "lid"]);
  const [b, l] = out.meshes;
  expect(b.display).toEqual({ color: 0x00ff00 });
  expect(l.display).toBeNull();
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

test("a version-2 file (separate line vertices) still decodes, with its edges", async () => {
  // Written by the 0.154.0 encoder: base (soup) and lid (indexed) each with their
  // box edges, plain with none.
  const v2 = new Uint8Array(readFileSync(fileURLToPath(new NodeURL("../fixtures/preview-v2.glb", import.meta.url))));
  const out = await decodePreviewGlb(v2);
  expect(out.view).toBe("main");
  expect(out.meshes.map((m) => m.name)).toEqual(["base", "lid", "plain"]);
  expect(out.meshes[0].display).toEqual({ color: 0xff0000 });
  for (const m of out.meshes) expect(m.triangles).toBe(12);
  expect(segmentMismatch(out.meshes[0].edges, boxEdges([0, 0, 0], [4, 2, 6]))).toBeNull();
  expect(segmentMismatch(out.meshes[1].edges, boxEdges([0, 0, 6], [4, 2, 7]))).toBeNull();
  expect(out.meshes[2].edges).toEqual(new Float32Array(0));
});

// --- edges as indices into the surface's vertices (encoder v3) ---------------------
test("an edge endpoint on no triangle vertex still round-trips, and the surface is unchanged", async () => {
  const box = boxSoup("base", [0, 0, 0], [4, 2, 6]);
  // the top face's centre to the midpoint of one of its edges: neither is a vertex
  const extra = new Float32Array([2, 1, 6, 4, 1, 6]);
  const edges = new Float32Array([...boxEdges([0, 0, 0], [4, 2, 6]), ...extra]);
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [{ ...box, edges }], view: "v" }));
  const [m] = out.meshes;
  expect(segmentMismatch(m.edges, edges)).toBeNull();
  expect(m.triangles).toBe(12);
  // the triangles reference only the surface's own corners, and the payload
  // carries exactly the vertices they reference (the appended ones stay in the file)
  const used = new Set(m.indices);
  expect(used.size).toBe(m.positions.length / 3);
  expect(m.normals.length).toBe(m.positions.length);
  const b = boundsOf(Float32Array.from([...used].flatMap((i) => [...m.positions.subarray(i * 3, i * 3 + 3)])));
  expectNear(b.min, [0, 0, 0]);
  expectNear(b.max, [4, 2, 6]);
  for (const i of used) {
    const [x, y, z] = m.positions.subarray(i * 3, i * 3 + 3);
    const onCorner = [x, y, z].every((c, a) => Math.abs(c) < 1e-2 || Math.abs(c - [4, 2, 6][a]) < 1e-2);
    expect(onCorner).toBe(true);
  }
});

test("a dense edge set decodes to exactly its segments, not every shared vertex", async () => {
  const grid = denseGrid("grid", 12, 12);
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [grid], view: "v" }));
  expect(out.meshes[0].edges.length).toBe(grid.edges.length);
  expect(segmentMismatch(out.meshes[0].edges, grid.edges)).toBeNull();
  expect(out.meshes[0].triangles).toBe(grid.triangles);
});

test("lines whose off-surface endpoints would outnumber the surface keep vertices of their own, and round-trip", async () => {
  // 30 segments floating above a 12-triangle box: 60 endpoints on no vertex.
  // Appending them would make quantize() compact the surface and drop them.
  const box = boxSoup("base", [0, 0, 0], [4, 2, 6]);
  const floating = [];
  for (let i = 0; i < 30; i++) floating.push(i * 0.1, 0.5, 7 + i * 0.01, i * 0.1 + 0.05, 1.5, 7.5);
  const edges = new Float32Array([...boxEdges([0, 0, 0], [4, 2, 6]), ...floating]);
  const glb = await encodePreviewGlb({ meshes: [{ ...box, edges }], view: "v" });
  const [tris, lines] = glbJson(glb).meshes[0].primitives;
  expect(lines.attributes.POSITION).not.toBe(tris.attributes.POSITION);
  const out = await decodePreviewGlb(glb);
  expect(segmentMismatch(out.meshes[0].edges, edges)).toBeNull();
  expect(out.meshes[0].triangles).toBe(12);
});

test("lines with an endpoint outside the surface's bounds round-trip in the model frame", async () => {
  const body = posedBox("body");
  const extra = poseArray(new Float32Array([1.5, 1, 5, 1.5, 1, 9]), 30, [12, -7, 4]); // a mast off the top
  const edges = new Float32Array([...body.edges, ...extra]);
  const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [{ ...body, edges }], view: "v" }));
  expect(segmentMismatch(out.meshes[0].edges, edges, 1e-3)).toBeNull();
  expect(out.meshes[0].triangles).toBe(12);
});
