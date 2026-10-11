// partforge/gltf: the cached-preview writer. What a reader can rely on — one
// node per sub-part named by key, under one Y-up root, in millimetres; the
// viewer's own CAD look; exactly two required extensions; and the same bytes
// for the same input (the cloud keys its cache on them).
import { expect, test } from "vitest";
import { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "../src/gltf.js";
import { cadAppearance } from "../src/framework/materials/resolve.js";
import { boxSoup, indexedBox, readGlb, worldBounds, glbJson } from "./helpers/preview-glb.js";

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

test("PREVIEW_ENCODER_VERSION starts at 1", () => {
  expect(PREVIEW_ENCODER_VERSION).toBe(1);
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
