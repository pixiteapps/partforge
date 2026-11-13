// The kit built section by section (export/kit/build.js): `3d`, `laser` and
// `cnc-router` each contribute entries, and the README and parts list are written from
// what they returned. A one-process laser kit is held byte-identical to the kit the old
// buildBundle wrote (test/fixtures/kit-laser-snapshot.json, captured from it before the
// restructure), apart from the folder its cut files now sit in.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { strFromU8 } from "fflate";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";
import { buildKit } from "../src/framework/export/kit/build.js";
import { laserFixture, boardFixture } from "./fixtures/kit-fixtures.js";
import { kitCtx } from "./helpers/kit-ctx.js";

const snapshot = JSON.parse(readFileSync(new URL("./fixtures/kit-laser-snapshot.json", import.meta.url), "utf8"));

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SHEETS = ["left", "right", "front", "lower"];
const PRINTS = ["spacer", "spacer2"];

async function kit(part, request) {
  const phases = [];
  const entries = await buildKit(kitCtx(k, part, { phases }), request);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return {
    entries, phases,
    paths: entries.map((e) => e.path).sort(),
    text: (path) => strFromU8(byPath.get(path).data),
    bytes: (path) => Buffer.from(byPath.get(path).data),
  };
}

async function refusal(part, request) {
  const phases = [];
  try {
    await buildKit(kitCtx(k, part, { phases }), request);
  } catch (err) {
    return { message: err.message, phases };
  }
  throw new Error("the kit was built");
}

// A plain single-format export through the worker job, for comparison.
async function plainExport(part, type, parts) {
  const posts = [];
  await handle(k, part, { type, jobId: 1, parts, view: "all", params: {}, name: part.meta.title, quality: "preview" }, (m) => posts.push(m));
  const error = posts.find((m) => m.type === "error");
  if (error) throw new Error(error.message);
  return posts.find((m) => m.type === "download" || m.type === "download-parts");
}

describe("3D files", () => {
  test("a printed-only forge: one STL per part, a README and a parts list", async () => {
    const r = await kit(laserFixture, { sections: { "3d": { parts: PRINTS, options: { format: "stl" } } } });
    expect(r.paths).toEqual(["README.txt", "parts.csv", "print/spacer.stl", "print/spacer2.stl"]);
    expect(r.entries.map((e) => e.kind).sort()).toEqual(["model-stl", "model-stl", "table", "text"]);
    const plain = await plainExport(laserFixture, "export-stl", PRINTS);
    expect(r.bytes("print/spacer.stl").equals(Buffer.from(plain.parts[0].data))).toBe(true);
    expect(r.bytes("print/spacer2.stl").equals(Buffer.from(plain.parts[1].data))).toBe(true);
    // no cut section, so one of each
    expect(r.text("parts.csv")).toBe([
      "file,kind,labels,material,thickness_mm,width_mm,height_mm,quantity",
      "print/spacer.stl,print,Spacer,pla-print,,10.00,12.00,1",
      "print/spacer2.stl,print,Spacer copy,pla-print,,10.00,12.00,1",
    ].map((l) => `${l}\r\n`).join(""));
    const readme = r.text("README.txt");
    expect(readme).toContain("PRINTED PARTS\nfile | labels | quantity\nprint/spacer.stl | Spacer | 1\nprint/spacer2.stl | Spacer copy | 1\n");
    expect(readme).not.toContain("BEFORE YOU CUT");
  });

  test("names that clash are made unique in definition order", async () => {
    const box = (label) => ({ label, views: ["all"], build: (kk) => kk.box({ size: [10, 10, 4] }) });
    const part = { meta: { title: "Lids" }, defaults: {}, views: { all: { label: "All" } }, parts: { Lid: box("Lid"), lid: box("lid") } };
    const r = await kit(part, { sections: { "3d": { parts: ["Lid", "lid"] } } });
    expect(r.paths.filter((p) => p.startsWith("print/"))).toEqual(["print/lid-2.stl", "print/lid.stl"]);
    expect(r.text("README.txt")).toContain("RENAMED FILES\nprint/lid-2.stl: lid (renamed: print/lid.stl is Lid)\n");
  });

  test("3MF is one file laid out on the bed, the plain 3MF export's bytes", async () => {
    const r = await kit(laserFixture, { sections: { "3d": { parts: PRINTS, options: { format: "3mf" } } } });
    expect(r.paths).toEqual(["README.txt", "parts.csv", "print/kit-fixture.3mf"]);
    expect(r.entries.find((e) => e.path === "print/kit-fixture.3mf").kind).toBe("model-3mf");
    const plain = await plainExport(laserFixture, "export-3mf", PRINTS);
    expect(plain.filename).toBe("kit-fixture.3mf");
    expect(r.bytes("print/kit-fixture.3mf").equals(Buffer.from(plain.data))).toBe(true);
    expect(r.text("parts.csv")).toContain("print/kit-fixture.3mf,print,Spacer,pla-print,,10.00,12.00,1\r\n");
  });
});

describe("one laser section is today's kit, in laser/", () => {
  const toLaser = (text) => text.replace(/\b(parts|sheets)\//g, "laser/$1/");
  for (const [id, { options, files }] of Object.entries(snapshot)) {
    test(id, async () => {
      const { sets, ...laser } = options;
      const r = await kit(laserFixture, { sections: { laser: { parts: SHEETS, options: laser } }, ...(sets ? { sets } : {}) });
      const drawings = Object.keys(files).filter((f) => /^(parts|sheets)\//.test(f));
      expect(r.paths).toEqual(["README.txt", "parts.csv", ...drawings.map(toLaser)].sort());
      for (const f of drawings) expect(r.text(toLaser(f)), f).toBe(files[f]);
      expect(r.text("README.txt")).toBe(toLaser(files["README.txt"]));
      expect(r.text("parts.csv")).toBe(toLaser(files["parts.csv"]));
    });
  }
});

describe("laser and routed parts in one kit", () => {
  // The lid shares the plinth's material and thickness, so each section has a walnut 18
  // mm group of its own.
  const shared = { ...boardFixture, parts: { ...boardFixture.parts,
    lid: sheetPart({ views: ["all"], label: "Lid", material: "walnut", thickness: (p) => p.t,
      profile: (kk) => kk.shape2d([[0, 0], [40, 0], [40, 40], [0, 40]]), score: () => [[[5, 5], [35, 5]]] }) } };
  const both = ["plinth", "lid"];

  test("each section takes its own parts and lays them out on its own", async () => {
    const r = await kit(shared, { sections: { laser: { parts: both }, "cnc-router": { parts: both } } });
    expect(r.paths).toEqual([
      "README.txt", "cnc/parts/plinth.dxf", "cnc/sheets/walnut-18mm/sheet-1-of-1.dxf",
      "laser/parts/lid.svg", "laser/sheets/walnut-18mm/sheet-1-of-1.svg", "parts.csv",
    ]);
    const readme = r.text("README.txt");
    const laser = readme.indexOf("\nLaser-cut parts:\n");
    const cnc = readme.indexOf("\nCNC-routed parts:\n");
    expect(laser).toBeGreaterThan(0);
    expect(cnc).toBeGreaterThan(laser);
    expect(readme.slice(laser, cnc)).toContain("Kerf: none applied — your laser software or cutting service must compensate.");
    expect(readme.slice(cnc)).toContain("Kerf: none — a CNC router's CAM applies the tool offset.");
    expect(readme).toContain("ROUTER OPERATIONS\nPlinth (walnut 18.00 mm)");
    expect(readme).toContain("cnc/sheets/walnut-18mm/sheet-1-of-1.dxf | walnut | 18.00 mm | 300 × 300 mm | 1 |");
    expect(readme).toContain("laser/sheets/walnut-18mm/sheet-1-of-1.svg | walnut | 18.00 mm | 300 × 300 mm | 1 |");
  });

  test("two sections on the same stock print its stock note once", async () => {
    const r = await kit(shared, { sections: { laser: { parts: both }, "cnc-router": { parts: both } } });
    expect(r.text("README.txt").match(/This kit assumes 18\.00 mm walnut/g)).toHaveLength(1);
  });

  test("a section naming none of its own parts is refused", async () => {
    const r = await refusal(shared, { sections: { laser: { parts: ["plinth"] } } });
    expect(r.message).toBe("cut kit options: none of the checked parts is a laser-cut part");
  });
});

describe("sets", () => {
  test("multiply cut pieces only: printed files keep their names and list the count", async () => {
    const r = await kit(laserFixture, { sections: { laser: { parts: SHEETS }, "3d": { parts: PRINTS } }, sets: 3 });
    expect(r.paths).toEqual([
      "README.txt", "laser/parts/front-2-x3.svg", "laser/parts/front-x3.svg", "laser/parts/left-x6.svg",
      "laser/sheets/birch-plywood-3mm/sheet-1-of-1.svg", "parts.csv", "print/spacer.stl", "print/spacer2.stl",
    ]);
    const csv = r.text("parts.csv");
    expect(csv).toContain("laser/parts/left-x6.svg,sheet,Side (L); Side (R),Birch Plywood,3.00,80.00,50.00,6\r\n");
    expect(csv).toContain("print/spacer.stl,print,Spacer,pla-print,,10.00,12.00,3\r\n");
    expect(csv).toContain("print/spacer2.stl,print,Spacer copy,pla-print,,10.00,12.00,3\r\n");
    expect(r.text("README.txt")).toContain("print/spacer.stl | Spacer | 3\n");
  });
});

describe("everything is checked before anything is built", () => {
  test("a bad option in any section", async () => {
    const r = await refusal(laserFixture, { sections: { laser: { parts: SHEETS }, "3d": { parts: PRINTS, options: { format: "obj" } } } });
    expect(r.message).toBe('cut kit options: 3D files: format must be "stl", "3mf" or "step", got "obj"');
    expect(r.phases).toEqual([]);
  });

  test("sets, and an unknown section", async () => {
    expect((await refusal(laserFixture, { sections: { "3d": { parts: PRINTS } }, sets: 0 })).message)
      .toBe("cut kit options: sets must be a whole number from 1 to 20, got 0");
    expect((await refusal(laserFixture, { sections: { pdf: { parts: PRINTS } } })).message)
      .toBe('cut kit options: unknown section "pdf" — the sections are 3d, laser, cnc-router');
  });

  test("a 3D section naming no exportable part is an options error", async () => {
    const r = await refusal(laserFixture, { sections: { "3d": { parts: ["nope"] } } });
    expect(r.message).toBe("cut kit options: 3D files: none of the checked parts can be exported");
  });

  test("a request with no sections is an options error", async () => {
    const r = await refusal(laserFixture, { sections: {} });
    expect(r.message).toBe("cut kit options: no exportable parts selected");
  });

  test("a later section's missing parts stop an earlier section's build", async () => {
    const r = await refusal(boardFixture, { sections: { laser: { parts: ["lid"] }, "cnc-router": { parts: ["lid"] } } });
    expect(r.message).toBe("cut kit options: none of the checked parts is a CNC-routed part");
    expect(r.phases).toEqual([]);
  });
});
