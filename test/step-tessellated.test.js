// spliceTessellated: turns OCCT's stand-in bodies into AP242 tessellated solids in the
// STEP text, keeping OCCT's product, name and colour chain. Checked on a two-body file
// OCCT 7.6 wrote (fixtures/step/two-bodies.step: "plate" then "organic"), read back with
// the test's own reader.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spliceTessellated } from "../src/framework/geometry/step-tessellated.js";
import { readStep, refsOf, reachable } from "./helpers/step-reader.js";
import { cpuMs } from "./helpers/cpu-pace.js";

const FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/step/two-bodies.step", import.meta.url)), "utf8");
const decode = (bytes) => new TextDecoder().decode(bytes);

// A unit tetrahedron, outward-wound.
const TET = {
  positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1),
  indices: Uint32Array.of(0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3),
};

const firstOfType = (es, type, pred = () => true) => [...es].find(([, e]) => e.type === type && pred(e));
/** The representation a named product's shape definition points at: [id, entity]. */
function repOfProduct(es, name) {
  const [prod] = firstOfType(es, "PRODUCT", (e) => e.body.startsWith(`PRODUCT('${name}'`));
  const [pdf] = firstOfType(es, "PRODUCT_DEFINITION_FORMATION", (e) => refsOf(e.body).includes(prod));
  const [pd] = firstOfType(es, "PRODUCT_DEFINITION", (e) => refsOf(e.body).includes(pdf));
  const [pds] = firstOfType(es, "PRODUCT_DEFINITION_SHAPE", (e) => refsOf(e.body).includes(pd));
  const [, sdr] = firstOfType(es, "SHAPE_DEFINITION_REPRESENTATION", (e) => refsOf(e.body)[0] === pds);
  const rep = refsOf(sdr.body)[1];
  return [rep, es.get(rep)];
}
const numbers = (s) => s.match(/-?\d+(?:\.\d*)?(?:E[-+]?\d+)?/g).map(Number);

describe("spliceTessellated", () => {
  const out = readStep(decode(spliceTessellated(FIXTURE, [{ index: 1, ...TET }])));
  const before = readStep(FIXTURE);

  it("every reference resolves", () => {
    for (const [id, e] of out) for (const r of refsOf(e.body)) expect(out.has(r), `#${id} → #${r}`).toBe(true);
  });

  it("the organic product reaches one tessellated solid over the given mesh", () => {
    const [repId, rep] = repOfProduct(out, "organic");
    expect(rep.type).toBe("TESSELLATED_SHAPE_REPRESENTATION");
    const solids = refsOf(rep.body).map((r) => out.get(r)).filter((e) => e.type === "TESSELLATED_SOLID");
    expect(solids).toHaveLength(1);
    const faces = refsOf(solids[0].body).map((r) => out.get(r));
    expect(faces.map((f) => f.type)).toEqual(["TRIANGULATED_FACE"]);
    const coords = out.get(refsOf(faces[0].body)[0]);
    expect(coords.type).toBe("COORDINATES_LIST");
    expect(numbers(coords.body.slice(coords.body.indexOf("(("))) ).toEqual([...TET.positions]);
    const tris = faces[0].body.slice(faces[0].body.lastIndexOf("(("));
    expect(numbers(tris)).toEqual([...TET.indices].map((i) => i + 1));
    expect(repId).toBe(repOfProduct(before, "organic")[0]);
  });

  it("the stand-in's colour now styles the tessellated solid", () => {
    const [, rep] = repOfProduct(out, "organic");
    const solidId = refsOf(rep.body).find((r) => out.get(r).type === "TESSELLATED_SOLID");
    const styled = [...out.values()].filter((e) => e.type === "STYLED_ITEM" && refsOf(e.body).at(-1) === solidId);
    expect(styled).toHaveLength(1);
  });

  it("no B-rep remains under the organic product, and the plate is untouched", () => {
    const [repId] = repOfProduct(out, "organic");
    const types = [...reachable(out, repId)].map((id) => out.get(id).type);
    expect(types).not.toContain("MANIFOLD_SOLID_BREP");
    expect(types).not.toContain("ADVANCED_FACE");
    const [plateRep] = repOfProduct(before, "plate");
    for (const id of reachable(before, plateRep)) expect(out.get(id), `#${id}`).toEqual(before.get(id));
    expect(out.size).toBeLessThan(before.size);
  });

  it("two bodies with the same mesh stay two tessellated solids", () => {
    const both = readStep(decode(spliceTessellated(FIXTURE, [{ index: 0, ...TET }, { index: 1, ...TET }])));
    const solids = [...both.values()].filter((e) => e.type === "TESSELLATED_SOLID");
    expect(solids).toHaveLength(2);
    expect(repOfProduct(both, "plate")[1].type).toBe("TESSELLATED_SHAPE_REPRESENTATION");
  });

  it("refuses a body index the file does not have", () => {
    expect(() => spliceTessellated(FIXTURE, [{ index: 2, ...TET }])).toThrow(/^STEP splice:/);
  });

  it("writes coordinates that round-trip float32 exactly", () => {
    const odd = { positions: Float32Array.of(0.1, -1e-7, 123456.78, 1 / 3, 2, -0.5, 7, 8, 9, 3.5e-12, 0, 1), indices: TET.indices };
    const es = readStep(decode(spliceTessellated(FIXTURE, [{ index: 1, ...odd }])));
    const coords = [...es.values()].find((e) => e.type === "COORDINATES_LIST");
    const nums = numbers(coords.body.slice(coords.body.indexOf("((")));
    expect(nums.map(Math.fround)).toEqual([...odd.positions]);
    // A STEP REAL always carries a decimal point.
    expect(coords.body.slice(coords.body.indexOf("((")).match(/[-\d.E]+/g).every((t) => t.includes("."))).toBe(true);
  });

  it("splices a 200k-triangle mesh quickly, with every index in range", () => {
    const n = 100_000, positions = new Float32Array(3 * n), indices = new Uint32Array(3 * 200_000);
    for (let i = 0; i < positions.length; i++) positions[i] = (i * 7919) % 1000 / 10;
    for (let i = 0; i < indices.length; i++) indices[i] = (i * 104729) % n;
    const t0 = cpuMs();
    const text = decode(spliceTessellated(FIXTURE, [{ index: 1, positions, indices }]));
    expect(cpuMs() - t0).toBeLessThan(3000);
    const face = readStep(text);
    const tri = [...face.values()].find((e) => e.type === "TRIANGULATED_FACE");
    const idx = numbers(tri.body.slice(tri.body.lastIndexOf("((")));
    expect(idx).toHaveLength(indices.length);
    expect(Math.min(...idx.slice(0, 1000))).toBeGreaterThanOrEqual(1);
    expect(idx.every((i) => i >= 1 && i <= n)).toBe(true);
  }, 60_000);
});
