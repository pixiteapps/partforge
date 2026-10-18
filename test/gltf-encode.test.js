// partforge/gltf: the cached-preview writer. What a reader can rely on — one
// node per sub-part named by key, under one Y-up root, in millimetres; the
// viewer's own CAD look; exactly two required extensions; and the same bytes
// for the same input (the cloud keys its cache on them).
import { expect, test } from "vitest";
import { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "../src/gltf.js";
import { sortSegments } from "../src/framework/gltf/encode-preview.js";
import { cadAppearance } from "../src/framework/materials/resolve.js";
import { boxEdges, boxSoup, denseGrid, indexedBox, poseArray, readGlb, worldBounds, glbJson } from "./helpers/preview-glb.js";

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const factorOf = (hex, alpha = 1) =>
  [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => srgbToLinear(v / 255)).concat(alpha);
const expectNear = (got, want, digits = 4) => {
  expect(got).toHaveLength(want.length);
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i], digits));
};

const part = {
  parts: {
    base: { display: { color: 0xff0000 } },
    lid: {},
    glass: { display: { opacity: 0.4 } },
    brass: { display: { material: "brass" } },
  },
};
const meshes = () => [
  boxSoup("base", [0, 0, 0], [4, 2, 6]),
  indexedBox("lid", [0, 0, 6], [4, 2, 7]),
  boxSoup("glass", [5, 0, 0], [6, 1, 1]),
  boxSoup("brass", [7, 0, 0], [8, 1, 1]),
];
const nodeNamed = (doc, name) => doc.getRoot().listNodes().find((n) => n.getName() === name);
const materialOf = (doc, name) => nodeNamed(doc, name).getMesh().listPrimitives()[0].getMaterial();

test("PREVIEW_ENCODER_VERSION is 4 (animation channels + partforgeAnimation extras)", () => {
  expect(PREVIEW_ENCODER_VERSION).toBe(4);
});

test("one node, mesh and primitive per sub-part, named by key, under one Y-up root", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  const [scene] = doc.getRoot().listScenes();
  expect(scene.getName()).toBe("assembly");
  const [root] = scene.listChildren();
  expect(root.getName()).toBe("partforge");
  expectNear(root.getRotation(), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], 6);
  const children = root.listChildren();
  expect(children.map((n) => n.getName())).toEqual(["base", "lid", "glass", "brass"]);
  for (const node of children) {
    expect(node.getMesh().getName()).toBe(node.getName());
    expect(node.getMesh().listPrimitives()).toHaveLength(1);
    expect(node.getExtras().partforgeSubPart).toBe(node.getName());
  }
  expect(doc.getRoot().getExtras()).toEqual({ partforgeView: "assembly", partforgeEncoder: PREVIEW_ENCODER_VERSION });
  expect(nodeNamed(doc, "base").getExtras().partforgeDisplay).toEqual({ color: 0xff0000 });
  expect(nodeNamed(doc, "lid").getExtras()).toEqual({ partforgeSubPart: "lid" });
});

test("triangle counts survive welding and compression, soup and indexed alike", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  for (const name of ["base", "lid", "glass", "brass"]) {
    const prim = nodeNamed(doc, name).getMesh().listPrimitives()[0];
    expect(prim.getIndices().getCount() / 3).toBe(12);
    expect(prim.getAttribute("NORMAL")).toBeTruthy();
  }
});

test("bounds come out Y-up in millimetres: model (x, y, z) is glTF (x, z, -y)", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("base", [0, 0, 0], [4, 2, 6])], part, view: "v" }));
  const { min, max } = worldBounds(doc);
  expectNear(min, [0, 0, -2], 2);
  expectNear(max, [4, 6, 0], 2);
});

test("materials come from the viewer's CAD resolver", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  for (const name of ["base", "lid", "glass", "brass"]) {
    const look = cadAppearance(part.parts[name].display);
    expectNear(materialOf(doc, name).getBaseColorFactor(), factorOf(look.color, look.opacity), 6);
    expect(materialOf(doc, name).getRoughnessFactor()).toBeCloseTo(look.roughness, 6);
    expect(materialOf(doc, name).getMetallicFactor()).toBeCloseTo(look.metalness, 6);
  }
  expectNear(materialOf(doc, "base").getBaseColorFactor(), [1, 0, 0, 1], 6);
  expectNear(materialOf(doc, "lid").getBaseColorFactor(), factorOf(0x9fb4cc), 6);
  expect(materialOf(doc, "lid").getMetallicFactor()).toBeCloseTo(0.25, 6);
  expect(materialOf(doc, "lid").getRoughnessFactor()).toBeCloseTo(0.55, 6);
  expect(materialOf(doc, "glass").getAlphaMode()).toBe("BLEND");
  expect(materialOf(doc, "glass").getBaseColorFactor()[3]).toBeCloseTo(0.4, 6);
  expect(materialOf(doc, "base").getAlphaMode()).toBe("OPAQUE");
});

test("with no part every sub-part takes the drafting default", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("x")], view: "v" }));
  expectNear(materialOf(doc, "x").getBaseColorFactor(), factorOf(0x9fb4cc), 6);
});

test("the part's background and environment ride along for a part-less viewer", async () => {
  const withMeta = { ...part, meta: { title: "T", background: 0x101010, environment: "workshop" } };
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("base")], part: withMeta, view: "v" }));
  expect(doc.getRoot().getExtras().partforgeMeta).toEqual({ background: 0x101010, environment: "workshop" });
});

test("required and used extensions are exactly quantization and meshopt", async () => {
  const json = glbJson(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  expect([...json.extensionsRequired].sort()).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
  expect([...json.extensionsUsed].sort()).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
});

test("identical input encodes to identical bytes, and the input is left untouched", async () => {
  const input = meshes();
  const before = input.map((m) => [m.positions.slice(), m.normals.slice()]);
  const a = await encodePreviewGlb({ meshes: input, part, view: "assembly" });
  const b = await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" });
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  input.forEach((m, i) => {
    expect(m.positions).toEqual(before[i][0]);
    expect(m.normals).toEqual(before[i][1]);
  });
});

test("an empty sub-part gets no node; all-empty and malformed input is refused", async () => {
  const empty = { name: "ghost", positions: new Float32Array(0), normals: new Float32Array(0), triangles: 0 };
  const doc = await readGlb(await encodePreviewGlb({ meshes: [boxSoup("base"), empty], view: "v" }));
  expect(doc.getRoot().listNodes().map((n) => n.getName())).toEqual(["partforge", "base"]);
  await expect(encodePreviewGlb({ meshes: [empty], view: "v" })).rejects.toThrow(/every mesh was empty/);
  await expect(encodePreviewGlb({ meshes: [] })).rejects.toThrow(TypeError);
  await expect(encodePreviewGlb({ meshes: [boxSoup("a"), boxSoup("a")] })).rejects.toThrow(/two meshes are named "a"/);
  await expect(encodePreviewGlb({ meshes: [{ name: "a", positions: [0, 0, 0] }] })).rejects.toThrow(TypeError);
  await expect(encodePreviewGlb({ meshes: [{ name: "a", positions: new Float32Array(6) }] })).rejects.toThrow(/whole triangles/);
  await expect(encodePreviewGlb({ meshes: [{ ...boxSoup("a"), normals: new Float32Array(3) }] })).rejects.toThrow(/normals do not match/);
});

test("an index past the last vertex is refused up front, naming the mesh", async () => {
  const bad = indexedBox("lid", [0, 0, 6], [4, 2, 7]);
  const indices = new Uint32Array(bad.indices);
  indices[0] = bad.positions.length / 3;
  await expect(encodePreviewGlb({ meshes: [{ ...bad, indices }] })).rejects.toThrow(
    'encodePreviewGlb: "lid" indices reference a vertex that does not exist');
});

test("a sub-part's feature edges ride as a second, indexed LINES primitive sharing the surface's POSITION", async () => {
  const edges = boxEdges([0, 0, 0], [4, 2, 6]);
  const before = edges.slice();
  const input = [{ ...boxSoup("base", [0, 0, 0], [4, 2, 6]), edges }, indexedBox("lid", [0, 0, 6], [4, 2, 7])];
  const doc = await readGlb(await encodePreviewGlb({ meshes: input, part, view: "assembly" }));
  const prims = nodeNamed(doc, "base").getMesh().listPrimitives();
  expect(prims.map((p) => p.getMode())).toEqual([4, 1]); // TRIANGLES, then LINES
  const [surface, lines] = prims;
  expect(lines.listSemantics()).toEqual(["POSITION"]);
  expect(lines.getMaterial()).toBeNull();
  expect(lines.getAttribute("POSITION")).toBe(surface.getAttribute("POSITION")); // ONE vertex array
  expect(lines.getIndices().getCount()).toBe(24); // 12 segments survive the pipeline
  expect(surface.getAttribute("POSITION").getCount()).toBe(24); // a soup box welds to 24 (corner x normal); nothing appended
  expect(nodeNamed(doc, "lid").getMesh().listPrimitives()).toHaveLength(1); // empty edges write nothing
  expect(edges).toEqual(before); // the input is not rewritten
  const b = worldBounds(doc);
  expectNear(b.min, [0, 0, -2], 2);
  expectNear(b.max, [4, 7, 0], 2);
});

test("an endpoint within one quantization step of a vertex snaps to it; one beyond is appended", async () => {
  // The box is 6 mm at its widest: one 14-bit step is 6 / 16384 ≈ 3.7e-4 mm.
  const edges = boxEdges([0, 0, 0], [4, 2, 6]).map((c, i) => c + (i % 2 ? 1e-4 : -1e-4));
  const near = await readGlb(await encodePreviewGlb({ meshes: [{ ...boxSoup("base", [0, 0, 0], [4, 2, 6]), edges }], view: "v" }));
  expect(near.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION").getCount()).toBe(24);
  const far = new Float32Array([...boxEdges([0, 0, 0], [4, 2, 6]), 0, 0, 0.01, 4, 0, 0.01]);
  const off = await readGlb(await encodePreviewGlb({ meshes: [{ ...boxSoup("base", [0, 0, 0], [4, 2, 6]), edges: far }], view: "v" }));
  const [surface, lines] = off.getRoot().listMeshes()[0].listPrimitives();
  expect(surface.getAttribute("POSITION").getCount()).toBe(26); // two endpoints appended
  expect(lines.getAttribute("POSITION")).toBe(surface.getAttribute("POSITION"));
  expect(surface.getIndices().getCount()).toBe(36); // and no triangle uses them
  expect(Math.max(...surface.getIndices().getArray())).toBe(23);
});

test("in the written JSON every LINES primitive names its mesh's TRIANGLES POSITION accessor", async () => {
  const posed = (box, edges) => ({ ...box, positions: poseArray(box.positions, 30, [12, -7, 4]),
    normals: poseArray(box.normals, 30, [0, 0, 0], true), edges: poseArray(edges, 30, [12, -7, 4]) });
  const json = glbJson(await encodePreviewGlb({ meshes: [
    posed(boxSoup("soup", [0, 0, 0], [3, 2, 5]), boxEdges([0, 0, 0], [3, 2, 5])),
    { ...indexedBox("indexed", [0, 0, 6], [4, 2, 7]), edges: boxEdges([0, 0, 6], [4, 2, 7]) },
    denseGrid("grid", 12, 12),
    boxSoup("bare", [9, 0, 0], [10, 1, 1]),
  ], view: "v" }));
  // (the one exception, lines with more off-surface endpoints than the surface has
  // room for, is pinned in preview-decode.test.js; none of these is that case)
  const withLines = json.meshes.filter((m) => m.primitives.length === 2);
  expect(withLines.map((m) => m.name)).toEqual(["soup", "indexed", "grid"]);
  for (const mesh of withLines) {
    const [tris, lines] = mesh.primitives;
    expect(tris.mode ?? 4).toBe(4);
    expect(lines.mode).toBe(1);
    expect(Object.keys(lines.attributes)).toEqual(["POSITION"]);
    expect(lines.attributes.POSITION).toBe(tris.attributes.POSITION);
    expect(lines.indices).toBeTypeOf("number");
    expect(lines.indices).not.toBe(tris.indices);
  }
});

test("edge-dense parts get meaningfully smaller than encoder v2 wrote them", async () => {
  // denseGrid(): 7,200 triangles, 7,320 feature edges. Encoder v2 (0.154.0) wrote
  // 49,216 bytes with the edges and 21,684 without — the edges cost more than the
  // surface. As indices into the surface's vertices they must cost far less.
  const grid = denseGrid("grid");
  const withEdges = (await encodePreviewGlb({ meshes: [grid], view: "v" })).length;
  const without = (await encodePreviewGlb({ meshes: [{ ...grid, edges: new Float32Array(0) }], view: "v" })).length;
  expect(withEdges).toBeLessThan(49216 * 0.8);
  expect((withEdges - without) / (grid.edges.length / 6)).toBeLessThan(2.5); // bytes a segment (v2: ~3.8)
});

test("malformed edges are refused, naming the mesh", async () => {
  await expect(encodePreviewGlb({ meshes: [{ ...boxSoup("a"), edges: "000111" }] })).rejects.toThrow(
    'encodePreviewGlb: "a" edges must be a typed array or an array of numbers');
  await expect(encodePreviewGlb({ meshes: [{ ...boxSoup("a"), edges: [0, 0, 0, 1, 1, 1, 2] }] })).rejects.toThrow(
    'encodePreviewGlb: "a" edges are not whole segments');
  await expect(encodePreviewGlb({ meshes: [{ ...boxSoup("a"), edges: new Float32Array(9) }] })).rejects.toThrow(
    'encodePreviewGlb: "a" edges are not whole segments');
});

test("plain-array edges: empty writes nothing, non-empty encodes like a Float32Array", async () => {
  const doc = await readGlb(await encodePreviewGlb({ meshes: [
    { ...boxSoup("none", [0, 0, 0], [1, 1, 1]), edges: [] },
    { ...boxSoup("plain", [2, 0, 0], [3, 1, 1]), edges: [...boxEdges([2, 0, 0], [3, 1, 1])] },
  ], view: "v" }));
  expect(nodeNamed(doc, "none").getMesh().listPrimitives()).toHaveLength(1);
  expect(nodeNamed(doc, "plain").getMesh().listPrimitives().map((p) => p.getMode())).toEqual([4, 1]);
});

test("segments sort exactly as (low, high) pairs, indices above 2^21 included", () => {
  // A float64 key a * 2^32 + b loses the low index's bits from 2^21 up; the sort must not.
  const big = 2 ** 21;
  const pairs = new Uint32Array([big + 7, big + 5, 2 ** 22 + 3, big + 9, 5, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32 - 2, big + 5, big + 8]);
  expect([...sortSegments(pairs)]).toEqual([
    5, 2 ** 31 + 1,
    big + 5, big + 7,
    big + 5, big + 8,
    big + 9, 2 ** 22 + 3,
    2 ** 32 - 2, 2 ** 32 - 1,
  ]);
});

test("an appended endpoint outside the surface's bounds keeps its own vertices; the surface quantizes as with no edges", async () => {
  const box = boxSoup("base", [0, 0, 0], [4, 2, 6]);
  const edges = new Float32Array([...boxEdges([0, 0, 0], [4, 2, 6]), 2, 1, 6, 2, 1, 9]); // a mast 3 mm above the lid
  const withEdges = await encodePreviewGlb({ meshes: [{ ...box, edges }], view: "v" });
  const bare = await readGlb(await encodePreviewGlb({ meshes: [box], view: "v" }));
  const doc = await readGlb(withEdges);
  const [surface, lines] = doc.getRoot().listMeshes()[0].listPrimitives();
  const [bareSurface] = bare.getRoot().listMeshes()[0].listPrimitives();
  expect(lines.getAttribute("POSITION")).not.toBe(surface.getAttribute("POSITION"));
  expect(lines.getIndices()).toBeNull();
  expect(lines.getAttribute("POSITION").getCount()).toBe(edges.length / 3);
  // the surface's quantized vertices and its node's quantization transform are untouched
  expect([...surface.getAttribute("POSITION").getArray()]).toEqual([...bareSurface.getAttribute("POSITION").getArray()]);
  const nodeOf = (d) => d.getRoot().listNodes().find((n) => n.getName() === "base").getMatrix();
  expect(nodeOf(doc)).toEqual(nodeOf(bare));
  // and the lines land where they were written (world Y-up: model z 9 → glTF y 9)
  const b = worldBounds(doc);
  expectNear(b.max, [4, 9, 0], 2);
});
