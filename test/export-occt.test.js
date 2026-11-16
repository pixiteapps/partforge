// OCCT export bytes. OCCT boots alone (never with Manifold).
import { beforeAll, describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { bootOcctKernel } from "../src/testing.js";
import { meshTo3MF } from "../src/framework/geometry/threemf.js";
import { handle } from "../src/framework/jobs.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

describe("OCCT toSTL", () => {
  it("returns an ArrayBuffer that parses as a binary STL (no Blob)", async () => {
    const s = k.box({ min: [0,0,0], max: [10,10,10] });
    const ab = await s.toSTL({ quality: "print" });
    expect(ab).toBeInstanceOf(ArrayBuffer);
    const dv = new DataView(ab);
    const n = dv.getUint32(80, true);
    expect(n).toBeGreaterThanOrEqual(12); // a box meshes to >= 12 triangles
    expect(ab.byteLength).toBe(84 + n * 50); // exact binary-STL size for n facets
  });
});

// Count undirected edges not shared by exactly two triangles, reading topology
// from the indices the way a 3MF consumer does. A closed solid must score zero —
// a slicer reports exactly this figure as "non-manifold edges". Counted per
// <object>, since vertex indices restart in each one.
function nonManifoldEdges(model) {
  return [...model.matchAll(/<object\b[\s\S]*?<\/object>/g)].map(([obj]) => {
    const edges = new Map();
    for (const m of obj.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)) {
      const t = [+m[1], +m[2], +m[3]];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    return [...edges.values()].filter((n) => n !== 2).length;
  });
}

const modelOf = (solids) =>
  strFromU8(unzipSync(new Uint8Array(meshTo3MF(
    solids.map((s, i) => ({ name: `p${i}`, ...s.toIndexedMesh() }))
  )))["3D/3dmodel.model"]);

describe("OCCT 3MF export", () => {
  // OCCT meshes each B-rep face independently, so its indexed mesh holds one copy
  // of every seam vertex per adjacent face. STL hides that (slicers re-stitch soup
  // by position); 3MF does not, so the export path has to weld.
  it("emits closed, manifold topology for a box", () => {
    const model = modelOf([k.box({ min: [0, 0, 0], max: [10, 10, 10] })]);
    expect(nonManifoldEdges(model)).toEqual([0]);
  });

  it("emits closed, manifold topology for curved and filleted solids", () => {
    const model = modelOf([
      k.cylinder(5, 5, 10),
      k.box({ min: [0, 0, 0], max: [20, 20, 10] }).fillet(2),
    ]);
    expect(nonManifoldEdges(model)).toEqual([0, 0]);
  });

  it("tessellates a 3MF at print quality, matching the STL export", () => {
    const s = k.cylinder(5, 5, 10);
    const preview = s.toIndexedMesh({ quality: "preview" }).indices.length / 3;
    const print = s.toIndexedMesh({ quality: "print" }).indices.length / 3;
    expect(print).toBeGreaterThan(preview); // print really is the denser preset
    // The default must be the print preset — a .3mf should not be coarser than the .stl.
    expect(s.toIndexedMesh().indices.length / 3).toBe(print);
  });
});

describe("OCCT toSTEP", () => {
  it("returns an ArrayBuffer of real STEP text (B-rep, not a mesh, no Blob)", async () => {
    const s = k.box({ min: [0,0,0], max: [10,10,10] });
    const ab = await k.toSTEP([{ name: "box", solid: s }]);
    expect(ab).toBeInstanceOf(ArrayBuffer);
    const text = new TextDecoder().decode(new Uint8Array(ab));
    expect(text).toMatch(/ISO-10303|STEP/); // STEP header — proves STEP, not STL/mesh
    expect(text).toMatch(/ENDSEC|DATA;/);   // STEP structure
    expect(ab.byteLength).toBeGreaterThan(500);
  });
});

// A kit asking for STEP runs as one job on OCCT (export-controller.js exportKit), so the
// laser drawings are built on OCCT too.
describe("the kit on OCCT", () => {
  it("a laser part plus a STEP 3D section returns the drawings and one .step", async () => {
    const part = {
      meta: { title: "Occt Kit" }, defaults: { t: 3 }, views: { all: { label: "All" } },
      parts: {
        panel: sheetPart({ label: "Panel", views: ["all"], material: "birch plywood", thickness: (p) => p.t,
          profile: (kk) => kk.shape2d([[0, 0], [60, 0], [60, 30], [0, 30]]) }),
        foot: { label: "Foot", views: ["all"], build: (kk) => kk.box({ size: [8, 8, 4] }) },
      },
    };
    const posts = [];
    await handle(k, part, { type: "export-kit", jobId: "export-1-1", view: "all", params: {}, name: "Occt Kit", quality: "preview",
      sections: { laser: { parts: ["panel"] }, "3d": { parts: ["foot"], options: { format: "step" } } } }, (m) => posts.push(m));
    expect(posts.find((m) => m.type === "error")?.message).toBeUndefined();
    const kit = posts.find((m) => m.type === "kit");
    expect(kit.jobId).toBe("export-1-1");
    expect(kit.name).toBe("occt-kit");
    const paths = kit.entries.map((e) => e.path);
    expect(paths.filter((x) => x.startsWith("laser/")).length).toBeGreaterThan(0);
    expect(paths.filter((x) => x.endsWith(".step"))).toEqual(["print/occt-kit.step"]);
    const step = kit.entries.find((e) => e.kind === "model-step");
    expect(new TextDecoder().decode(step.data)).toMatch(/ISO-10303/);
  }, 120000);
});
