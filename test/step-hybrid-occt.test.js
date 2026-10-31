// A STEP export with organic sub-parts on the OCCT worker: the job is handed their meshes
// (Manifold built them), builds only the ordinary sub-parts, and writes one file with the
// organic ones as tessellated solids. OCCT boots alone in this file.
import { beforeAll, describe, expect, it } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { readStep, refsOf } from "./helpers/step-reader.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

const decode = (bytes) => new TextDecoder().decode(bytes);

// A 10 mm tetrahedron at the origin, as Manifold would hand it over.
const tet = () => ({
  positions: Float32Array.of(0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10),
  indices: Uint32Array.of(0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3),
});
// The organic sub-part calls k.implicit, which OCCT throws on: building it here fails the test.
const organic = (extra = {}) => ({ build: (kk) => kk.implicit({ root: { kind: "sphere", r: 5 } }), ...extra });

async function exportStep(part, msg) {
  const posts = [];
  await handle(k, part, { type: "export-step", params: {}, jobId: 1, ...msg }, (m) => posts.push(m));
  const dl = posts.find((m) => m.type === "download");
  expect(dl, JSON.stringify(posts.find((m) => m.type === "error"))).toBeTruthy();
  return decode(dl.data);
}
const productTypes = (es) => {
  // product name → the type of its shape representation
  const out = {};
  for (const [, sdr] of [...es].filter(([, e]) => e.type === "SHAPE_DEFINITION_REPRESENTATION")) {
    const [pds, rep] = refsOf(sdr.body);
    const pd = refsOf(es.get(pds).body)[0];
    const pdf = refsOf(es.get(pd).body)[0];
    const prod = refsOf(es.get(pdf).body)[0];
    out[es.get(prod).body.match(/^PRODUCT\('([^']*)'/)[1]] = es.get(rep).type;
  }
  return out;
};
const coordsOf = (es) => {
  const c = [...es.values()].find((e) => e.type === "COORDINATES_LIST");
  return c.body.slice(c.body.indexOf("((")).match(/-?[\d.]+(?:E[-+]?\d+)?/g).map(Number);
};

describe("export-step with meshes", () => {
  const hybrid = {
    meta: { title: "Hybrid" }, defaults: {},
    parts: { plate: { views: ["all"], build: (kk) => kk.box({ size: [10, 10, 2] }) }, grip: organic({ views: ["all"] }) },
    views: { all: { label: "All" } },
  };

  it("writes the ordinary sub-part as B-rep and the organic one as a tessellated solid", async () => {
    const es = readStep(await exportStep(hybrid, { view: "all", meshes: { grip: tet() } }));
    expect(productTypes(es)).toEqual({ plate: "ADVANCED_BREP_SHAPE_REPRESENTATION", grip: "TESSELLATED_SHAPE_REPRESENTATION" });
    expect(coordsOf(es)).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
  });

  it("exports a view whose only sub-part is organic", async () => {
    const only = { ...hybrid, parts: { grip: organic({ views: ["all"] }) } };
    const es = readStep(await exportStep(only, { view: "all", meshes: { grip: tet() } }));
    expect(productTypes(es)).toEqual({ grip: "TESSELLATED_SHAPE_REPRESENTATION" });
  });

  it("lays a printed piece's mesh out by the offset its bounds earn", async () => {
    // Two views-map pieces export as built and are laid out apart on the bed; the plate
    // sorts first (taller in y), so the tetrahedron moves right by the plate's width plus
    // the bed spacing.
    const laid = {
      meta: { title: "Laid" }, defaults: {},
      parts: {
        plate: { build: (kk) => kk.box({ min: [0, 0, 0], max: [20, 20, 2] }), views: { bed: (s) => s } },
        grip: organic({ views: { bed: (s) => s } }),
      },
      views: { bed: { label: "Bed" } },
    };
    const es = readStep(await exportStep(laid, { view: "bed", meshes: { grip: tet() } }));
    expect(coordsOf(es)).toEqual([30, 0, 0, 40, 0, 0, 30, 10, 0, 30, 0, 10]);
  });
});
