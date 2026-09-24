import { expect, test } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { meshTo3MF } from "../../src/framework/geometry/threemf.js";

test("meshTo3MF packages each part's mesh into a valid 3MF (OPC zip)", () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]); // 4 verts
  const indices = new Uint32Array([0, 1, 2, 0, 1, 3]); // 2 triangles
  const buf = meshTo3MF([{ name: "thing", positions, indices }]);

  const files = unzipSync(new Uint8Array(buf));
  expect(Object.keys(files)).toEqual(
    expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"])
  );
  const model = strFromU8(files["3D/3dmodel.model"]);
  expect(model).toContain('unit="millimeter"');
  expect(model).toContain('name="thing"');
  expect((model.match(/<vertex /g) || []).length).toBe(4);
  expect((model.match(/<triangle /g) || []).length).toBe(2);
  expect((model.match(/<item /g) || []).length).toBe(1);
});

// Parse the emitted model back into vertices + triangles, then count how many
// undirected edges are NOT shared by exactly two triangles. A closed solid has
// zero; this is the check a slicer performs when it reports "non-manifold edges".
function auditModel(model) {
  const verts = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)]
    .map((m) => `${m[1]},${m[2]},${m[3]}`);
  const tris = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)]
    .map((m) => [+m[1], +m[2], +m[3]]);
  const edges = new Map();
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  return {
    verts: verts.length,
    uniquePositions: new Set(verts).size,
    tris: tris.length,
    nonManifoldEdges: [...edges.values()].filter((n) => n !== 2).length,
  };
}

test("meshTo3MF welds coincident vertices so shared edges are manifold", () => {
  // Two triangles forming a square, meshed the way the OCCT backend meshes two
  // adjacent B-rep faces: each triangle carries its OWN copy of the shared edge's
  // vertices, so nothing is shared by index even though the positions coincide.
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, // tri A
    0, 0, 0, 1, 1, 0, 0, 1, 0, // tri B — verts 0 and 1 duplicate A's 0 and 2
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const model = strFromU8(unzipSync(new Uint8Array(meshTo3MF([{ name: "square", positions, indices }])))["3D/3dmodel.model"]);

  const audit = auditModel(model);
  expect(audit.verts).toBe(4); // 6 written verts weld down to 4 distinct corners
  expect(audit.tris).toBe(2); // both triangles survive
  // The diagonal is now shared by both triangles; only the 4 outer edges are
  // boundary edges (this is an open square, not a solid).
  expect(audit.nonManifoldEdges).toBe(4);
});

test("meshTo3MF drops triangles that weld to zero area", () => {
  // Third vertex coincides with the first once rounded to the writer's precision,
  // so this triangle carries no surface and must not reach the file.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0.000001, 0, 0]);
  const model = strFromU8(unzipSync(new Uint8Array(
    meshTo3MF([{ name: "sliver", positions, indices: new Uint32Array([0, 1, 2]) }])
  ))["3D/3dmodel.model"]);
  expect((model.match(/<triangle /g) || []).length).toBe(0);
  expect((model.match(/<vertex /g) || []).length).toBe(0); // and no orphan vertices
});

test("meshTo3MF bundles multiple parts as separate objects in one file", () => {
  const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const buf = meshTo3MF([{ name: "a", ...tri }, { name: "b", ...tri }]);
  const model = strFromU8(unzipSync(new Uint8Array(buf))["3D/3dmodel.model"]);
  expect((model.match(/<object /g) || []).length).toBe(2);
  expect((model.match(/<item /g) || []).length).toBe(2);
  expect(model).toContain('name="a"');
  expect(model).toContain('name="b"');
});

const tri = () => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]) });
const modelOf = (buf) => strFromU8(unzipSync(new Uint8Array(buf))["3D/3dmodel.model"]);

test("meshTo3MF without colours is byte-for-byte unchanged", () => {
  const a = meshTo3MF([{ name: "a", ...tri() }]);
  const b = meshTo3MF([{ name: "a", ...tri(), color: null }]);
  expect(modelOf(b)).toBe(modelOf(a));
  expect(modelOf(a)).not.toContain("basematerials");
});

test("meshTo3MF writes one base material per distinct colour and points each object at it", () => {
  const model = modelOf(meshTo3MF([
    { name: "body", ...tri(), color: 0xb3261e },
    { name: "lid", ...tri(), color: 0xffffff },
    { name: "pin", ...tri(), color: 0xb3261e },
  ]));
  expect(model).toContain('<basematerials id="1000">');
  expect((model.match(/<base /g) || []).length).toBe(2);
  expect(model).toContain('displaycolor="#B3261EFF"');
  expect(model).toContain('displaycolor="#FFFFFFFF"');
  expect(model).toMatch(/<object id="1" type="model" name="body" pid="1000" pindex="0">/);
  expect(model).toMatch(/<object id="2" type="model" name="lid" pid="1000" pindex="1">/);
  expect(model).toMatch(/<object id="3" type="model" name="pin" pid="1000" pindex="0">/);
});

test("in a mixed export, an uncoloured object gets the viewer's default colour", () => {
  const model = modelOf(meshTo3MF([{ name: "a", ...tri(), color: 0x123456 }, { name: "b", ...tri() }]));
  expect(model).toContain('displaycolor="#9FB4CCFF"');
  expect(model).toMatch(/name="b" pid="1000" pindex="1"/);
});
