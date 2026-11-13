// The cut & print kit end to end (spec D, H "Bundle"): a real export-bundle job through
// partforge/testing's handle(), unzipped and read back — entry names, merged pieces,
// disambiguated names, per-destination file sets, README and CSV, the options errors,
// the caps, and the worked example laser-box.js. The job is the old one-call kit, which
// now maps its options onto the per-section kit (export/kit/build.js): cut files sit
// under laser/, and every printed part is its own model file.
import { beforeAll, describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";
import { SHEET_METRICS } from "../src/framework/process/registry.js";
import { KIT_KINDS } from "../src/framework/export/kit/entries.js";
import laserBox from "../src/parts/laser-box.js";
import { laserFixture as fixture } from "./fixtures/kit-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const ply = { views: ["all"], material: "Birch Plywood", thickness: (p) => p.t };
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A plate with one slot `slot` mm wide.
const slotted = (slot) => ({
  meta: { title: "Slotted" }, defaults: { t: 3 }, views: { all: { label: "All" } },
  parts: { plate: sheetPart({ ...ply, label: "Slotted",
    profile: (kk) => kk.shape2d(rect(40, 40)).cut([[20, 10], [20 + slot, 10], [20 + slot, 30], [20, 30]]) }) },
});

async function kit(part, { parts = Object.keys(part.parts), options, view = "all" } = {}) {
  const posts = [];
  const msg = { type: "export-bundle", jobId: 42, parts, view, params: {}, name: part.meta.title, quality: "preview",
    ...(options !== undefined ? { options } : {}) };
  await handle(k, part, msg, (m) => posts.push(m));
  const download = posts.find((m) => m.type === "download");
  const files = download ? unzipSync(new Uint8Array(download.data)) : {};
  return {
    error: posts.find((m) => m.type === "error")?.message ?? null,
    download, files,
    names: Object.keys(files).sort(),
    text: (file) => strFromU8(files[file]),
    phases: posts.filter((m) => m.type === "progress").map((m) => m.phase),
  };
}

function expectSaneEntries(names) {
  for (const name of names) {
    expect(Object.values(KIT_KINDS).some((kind) => kind.pattern.test(name)), `entry ${name}`).toBe(true);
    expect(name.includes(".."), `entry ${name}`).toBe(false);
  }
}

// The layer (group code 8) of every entity in a DXF's ENTITIES section. DXF is pairs
// of lines, code then value; codes may be space-padded, so both are trimmed.
function entityLayers(dxf) {
  const lines = dxf.split(/\r?\n/);
  const layers = new Set();
  let inEntities = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (code === "2" && value === "ENTITIES") inEntities = true;
    else if (code === "0" && value === "ENDSEC") inEntities = false;
    else if (inEntities && code === "8") layers.add(value);
  }
  return layers;
}

describe("own laser (the defaults)", () => {
  let own;
  beforeAll(async () => { own = await kit(fixture); });

  test("names every file once: a sheet, merged pieces, a disambiguated name, one STL per print", () => {
    expect(own.error).toBeNull();
    expect(own.download).toMatchObject({ filename: "kit-fixture-kit.zip", mime: "application/zip", jobId: 42 });
    expect(own.names).toEqual([
      "README.txt",
      "laser/parts/front-2.svg", "laser/parts/front.svg", "laser/parts/left-x2.svg",
      "laser/sheets/birch-plywood-3mm/sheet-1-of-1.svg",
      "parts.csv",
      "print/spacer.stl", "print/spacer2.stl",
    ]);
    expectSaneEntries(own.names);
  });

  test("each piece file carries exactly the layers the piece has", () => {
    const front = own.text("laser/parts/front.svg");
    for (const id of ["engrave", "score", "cut-outer"]) expect(front).toContain(`<g id="${id}">`);
    expect(front).not.toContain('<g id="cut-inner">');
    expect(own.text("laser/parts/left-x2.svg")).toContain('<g id="cut-inner">');
    expect(own.text("laser/sheets/birch-plywood-3mm/sheet-1-of-1.svg")).toContain('width="300mm" height="300mm"');
  });

  test("the README states the stock, the kerf, the scale and the tables", () => {
    const readme = own.text("README.txt");
    const lines = readme.split("\n");
    expect(lines[0]).toBe("Kit Fixture — cut & print kit");
    for (const line of [
      'This kit assumes 3.00 mm Birch Plywood — if yours differs, change "Sheet thickness" and re-download.',
      "Kerf: none applied — your laser software or cutting service must compensate.",
      "Side (L), Side (R): nominal 80.00 × 50.00 mm; this file draws the same (no kerf applied)",
      "Colours: engrave = filled black #000000, score = blue #0000FF, cut = red #FF0000 (inner cuts come before outer cuts).",
      "Test-cut one joint first.",
      "file | material | thickness | size | pieces | used",
      "laser/parts/left-x2.svg | Side (L), Side (R) | Birch Plywood | 3.00 mm | 80.00 × 50.00 mm | 2",
      "laser/parts/front.svg | Front | Birch Plywood | 3.00 mm | 120.00 × 50.00 mm | 1",
      "laser/parts/front-2.svg | =Lower front | Birch Plywood | 3.00 mm | 60.00 × 40.00 mm | 1",
      "print/spacer.stl | Spacer | 1",
      "print/spacer2.stl | Spacer copy | 1",
      "Finger clearance: 0.1 mm",
      "t = 3",
      "laser/parts/front-2.svg: =Lower front (renamed: laser/parts/front.svg is Front)",
      "Layout packs bounding boxes only: no nesting into holes, and grain direction is ignored.",
    ]) expect(lines).toContain(line);
    expect(readme).toContain("\nCHECKS\nnone\n");
    expect(readme).not.toContain("OVERSIZED PIECES");
    expect(readme).not.toContain("ROUTER OPERATIONS");
    expect(readme).not.toContain("\u0007");
  });

  test("parts.csv lists every piece and print, escaped", () => {
    expect(own.text("parts.csv")).toBe([
      "file,kind,labels,material,thickness_mm,width_mm,height_mm,quantity",
      "laser/parts/left-x2.svg,sheet,Side (L); Side (R),Birch Plywood,3.00,80.00,50.00,2",
      "laser/parts/front.svg,sheet,Front,Birch Plywood,3.00,120.00,50.00,1",
      "laser/parts/front-2.svg,sheet,'=Lower front,Birch Plywood,3.00,60.00,40.00,1",
      "print/spacer.stl,print,Spacer,pla-print,,10.00,12.00,1",
      "print/spacer2.stl,print,Spacer copy,pla-print,,10.00,12.00,1",
    ].map((l) => `${l}\r\n`).join(""));
  });

  test("reports each phase, in order, none longer than 120 characters", () => {
    expect(own.phases.filter((ph) => /^(building|laying out|writing|zipping)/.test(ph))).toEqual([
      "building Side (L)", "building Side (R)", "building Front", "building =Lower front",
      "laying out Birch Plywood 3 mm (4 pieces)",
      "writing cut files",
      "building Spacer", "building Spacer copy",
      "zipping kit",
    ]);
    expect(own.phases.every((ph) => ph.length <= 120)).toBe(true);
  });

  test("a label too long for a progress phase is clipped to exactly 120 characters, with an ellipsis", async () => {
    const long = `Panel ${"x".repeat(200)}`;
    const r = await kit({ ...fixture, parts: { ...fixture.parts, long: sheetPart({ ...ply, label: long, profile: (kk) => kk.shape2d(rect(20, 20)) }) } },
      { parts: ["long"] });
    const phase = r.phases.find((ph) => ph.startsWith("building Panel"));
    expect(phase).toHaveLength(120);
    expect(phase).toBe(`building ${long}`.slice(0, 119) + "…");
    expect(r.phases.every((ph) => ph.length <= 120)).toBe(true);
  });

  test("the same forge builds the same kit", async () => {
    const again = await kit(fixture);
    expect(again.names).toEqual(own.names);
    // every file, byte for byte — the cut files and prints included
    for (const name of own.names) expect(Buffer.from(again.files[name]).equals(Buffer.from(own.files[name])), name).toBe(true);
  });
});

describe("a cutting service", () => {
  test("cut-only DXF per piece, a -marks.dxf where there are marks, reference sheets", async () => {
    const r = await kit(fixture, { options: { destination: "service" } });
    expect(r.error).toBeNull();
    expect(r.names).toEqual([
      "README.txt",
      "laser/parts/front-2.dxf", "laser/parts/front-marks.dxf", "laser/parts/front.dxf", "laser/parts/left-x2.dxf",
      "laser/sheets/birch-plywood-3mm/sheet-1-of-1.dxf",
      "parts.csv",
      "print/spacer.stl", "print/spacer2.stl",
    ]);
    expectSaneEntries(r.names);
    expect([...entityLayers(r.text("laser/parts/front.dxf"))]).toEqual(["CUT"]);
    expect([...entityLayers(r.text("laser/parts/front-marks.dxf"))].sort()).toEqual(["ENGRAVE", "SCORE"]);
    expect([...entityLayers(r.text("laser/parts/left-x2.dxf"))]).toEqual(["CUT"]);
    expect([...entityLayers(r.text("laser/sheets/birch-plywood-3mm/sheet-1-of-1.dxf"))].sort()).toEqual(["CUT", "ENGRAVE", "SCORE"]);
    const readme = r.text("README.txt");
    expect(readme).toContain("DXF layers: CUT (colour 1), SCORE (colour 5), ENGRAVE (colour 7) — set ENGRAVE to fill; R12 has no hatch.");
    expect(readme).toContain("The sheets in laser/sheets/ are for reference only — a cutting service lays out the pieces itself.");
    expect(readme).toContain("Score and engrave marks are in their own files, not in the cut files — send them with the cut files if you want the marks made: laser/parts/front-marks.dxf.");
  });

  test("a kit whose every piece is oversized writes no sheets, and its README does not point at sheets/", async () => {
    const r = await kit(fixture, { parts: ["front"], options: { destination: "service", stock: [{ group: "*", size: [100, 100] }] } });
    expect(r.error).toBeNull();
    expect(r.names.some((n) => n.startsWith("laser/sheets/"))).toBe(false);
    expect(r.text("README.txt")).not.toContain("sheets/");
  });

  test("a piece too big for the stock is listed in the README, not refused", async () => {
    const r = await kit(fixture, { options: { destination: "service", stock: [{ group: "*", size: [100, 100] }] } });
    expect(r.error).toBeNull();
    expect(r.names).toContain("laser/parts/front.dxf");
    expect(r.text("README.txt")).toContain(
      "OVERSIZED PIECES\nFront: 120.0 × 50.0 mm does not fit a 100 × 100 mm sheet after its 5 mm margin (Birch Plywood 3 mm) — cut it from laser/parts/front.dxf\n");
  });
});

describe("author names that start with a separator", () => {
  test("a sheet keyed `_left`, a printed part keyed `_clip` and an `_ply` material still download", async () => {
    const r = await kit({
      meta: { title: "Underscores" }, defaults: { t: 3 }, views: { all: { label: "All" } },
      parts: {
        _left: sheetPart({ ...ply, material: "_ply", label: "Left", profile: (kk) => kk.shape2d(rect(40, 30)) }),
        right: sheetPart({ ...ply, label: "Right", export: { name: "_Right panel" }, profile: (kk) => kk.shape2d(rect(40, 20)) }),
        _clip: { label: "Clip", views: ["all"], build: (kk) => kk.box({ size: [10, 10, 5] }) },
      },
    });
    expect(r.error).toBeNull();
    expect(r.names).toEqual([
      "README.txt", "laser/parts/left.svg", "laser/parts/right-panel.svg",
      "laser/sheets/birch-plywood-3mm/sheet-1-of-1.svg", "laser/sheets/ply-3mm/sheet-1-of-1.svg",
      "parts.csv", "print/clip.stl",
    ]);
    expectSaneEntries(r.names);
  });
});

describe("two different pieces with one name", () => {
  test("a quantity suffix never stands in for a rename: the second is name-2, and the README says why", async () => {
    // a1 and a2 are identical and merge into Panel ×2; b shares their export name but
    // not their shape — it must not become parts/panel.svg beside parts/panel-x2.svg,
    // which reads as one piece at two quantities. Prints never merge: each is a file,
    // and one that shares a name is name-2, name-3.
    const panel = (w) => sheetPart({ ...ply, export: { name: "Panel" }, profile: (kk) => kk.shape2d(rect(w, 30)) });
    const clip = (h) => ({ views: ["all"], export: { name: "Clip" }, build: (kk) => kk.box({ size: [10, 10, h] }) });
    const r = await kit({
      meta: { title: "Panels" }, defaults: { t: 3 }, views: { all: { label: "All" } },
      parts: {
        a1: { ...panel(40), label: "A1" }, a2: { ...panel(40), label: "A2" }, b: { ...panel(50), label: "B" },
        c1: { ...clip(5), label: "C1" }, c2: { ...clip(5), label: "C2" }, d: { ...clip(8), label: "D" },
      },
    });
    expect(r.error).toBeNull();
    expect(r.names.filter((n) => /^(laser\/parts|print)\//.test(n))).toEqual([
      "laser/parts/panel-2.svg", "laser/parts/panel-x2.svg", "print/clip-2.stl", "print/clip-3.stl", "print/clip.stl",
    ]);
    const readme = r.text("README.txt");
    expect(readme).toContain("RENAMED FILES\n"
      + "laser/parts/panel-2.svg: B (renamed: laser/parts/panel-x2.svg is A1, A2)\n"
      + "print/clip-2.stl: C2 (renamed: print/clip.stl is C1)\n"
      + "print/clip-3.stl: D (renamed: print/clip.stl is C1)\n");
  });
});

describe("the README names the right settings", () => {
  const forge = (controls, defaults, thickness) => ({
    meta: { title: "Settings" }, parameters: [{ id: "s", title: "S", controls }], defaults, views: { all: { label: "All" } },
    parts: { a: sheetPart({ views: ["all"], material: (p) => p.material ?? "ply", thickness, label: "A", profile: (kk) => kk.shape2d(rect(40, 30)) }) },
  });
  const MATERIAL = { key: "material", label: "Material", type: "select", options: ["ply", "acrylic"] };
  const assumes = (readme) => readme.split("\n").find((l) => l.startsWith("This kit assumes"));

  test("the thickness line names the control whose value IS the thickness, not the first one read", async () => {
    const r = await kit(forge(
      [MATERIAL, { key: "plyT", label: "Plywood thickness", unit: "mm" }, { key: "acrylicT", label: "Acrylic thickness", unit: "mm" }],
      { material: "ply", plyT: 3, acrylicT: 2.7 },
      (p) => (p.material === "acrylic" ? p.acrylicT : p.plyT)));
    expect(assumes(r.text("README.txt"))).toBe('This kit assumes 3.00 mm ply — if yours differs, change "Plywood thickness" and re-download.');
  });

  test("a thickness no control holds falls back to the generic wording", async () => {
    const r = await kit(forge([MATERIAL], { material: "ply" }, (p) => (p.material === "acrylic" ? 2.7 : 3)));
    expect(assumes(r.text("README.txt"))).toBe('This kit assumes 3.00 mm ply — if yours differs, change "the sheet thickness setting" and re-download.');
  });

  test("CLEARANCES lists fit, clearance and play settings — not every key that contains the letters", async () => {
    const r = await kit(forge([
      { key: "display", label: "Display", type: "toggle" }, { key: "displayMode", label: "Display mode", type: "select", options: ["a"] },
      { key: "outfit", label: "Outfit" }, { key: "profit", label: "Margin" },
      { key: "fingerClearance", label: "Finger clearance", unit: "mm" }, { key: "tab_play", label: "Tab slack", unit: "mm" },
      { key: "pf", label: "Press fit", unit: "mm" },
    ], { display: true, displayMode: "a", outfit: 1, profit: 2, fingerClearance: 0.1, tab_play: 0.05, pf: 0.02 }, 3));
    const readme = r.text("README.txt");
    const block = readme.slice(readme.indexOf("CLEARANCES (design fit, not kerf)\n"), readme.indexOf("\nSETTINGS\n"));
    expect(block.split("\n").slice(1).filter(Boolean)).toEqual(["Finger clearance: 0.1 mm", "Tab slack: 0.05 mm", "Press fit: 0.02 mm"]);
  });
});

describe("download options", () => {
  test("own laser refuses a piece its stock cannot hold, naming it", async () => {
    const r = await kit(fixture, { options: { stock: [{ group: "*", size: [100, 100] }] } });
    expect(r.error).toBe('cut kit options: Laser-cut parts: stock too small — "Front" is 120.0 × 50.0 mm; a 100 × 100 mm sheet leaves 90 × 90 after its 5 mm margin (Birch Plywood 3 mm)');
    expect(r.download).toBeUndefined();
  });

  test("a bad option fails before anything is built", async () => {
    const r = await kit(fixture, { options: { kerf: 2 } });
    expect(r.error).toBe("cut kit options: kerf must be a number from 0 to 0.5 mm, got 2");
    expect(r.phases.some((ph) => ph.startsWith("building"))).toBe(false);
  });

  test("a margin that leaves no room fails before anything is built", async () => {
    const r = await kit(fixture, { options: { margin: 50, stock: [{ group: "*", size: [10, 10] }] } });
    expect(r.error).toBe(
      "cut kit options: Laser-cut parts: a 10 × 10 mm sheet has no room inside a 50 mm margin on every side (Birch Plywood 3 mm) — lower margin or use larger stock");
    expect(r.phases.some((ph) => ph.startsWith("building"))).toBe(false);
  });

  test("a kit needs a sheet part", async () => {
    const r = await kit(fixture, { parts: ["spacer"] });
    expect(r.error).toBe("cut kit options: none of the checked parts is a sheet part — check a sheet part or export STL/3MF instead");
  });

  test("a stock entry naming no group in the kit is refused, never ignored", async () => {
    const r = await kit(fixture, { options: { stock: [{ group: "acrylic|3.00", size: [300, 300] }] } });
    expect(r.error).toBe('cut kit options: Laser-cut parts: stock names "acrylic|3.00", which no checked sheet part uses — the kit\'s groups are "birch plywood|3.00"');
  });

  test("sets multiply every cut quantity; a printed file keeps its name and lists the count", async () => {
    const r = await kit(fixture, { options: { sets: 2 } });
    expect(r.names.filter((n) => /^(laser\/parts|print)\//.test(n))).toEqual([
      "laser/parts/front-2-x2.svg", "laser/parts/front-x2.svg", "laser/parts/left-x4.svg", "print/spacer.stl", "print/spacer2.stl",
    ]);
    expect(r.text("parts.csv")).toContain("laser/parts/left-x4.svg,sheet,Side (L); Side (R),Birch Plywood,3.00,80.00,50.00,4\r\n");
    expect(r.text("parts.csv")).toContain("print/spacer.stl,print,Spacer,pla-print,,10.00,12.00,2\r\n");
  });

  test("kerf grows the cut lines and the README says by how much", async () => {
    const readme = (await kit(fixture, { options: { kerf: 0.2 } })).text("README.txt");
    expect(readme).toContain("Kerf: 0.20 mm applied to the cut lines only. Set kerf in ONE place — these download options, or your laser software / cutting service — never both.");
    expect(readme).toContain("Side (L), Side (R): nominal 80.00 × 50.00 mm; this file draws 80.20 × 50.20 with 0.20 mm kerf");
  });

  test("a kerf that closes a slot names the piece", async () => {
    const r = await kit(slotted(0.4), { options: { kerf: 0.5 } });
    expect(r.error).toMatch(/^cut kit options: Laser-cut parts: kerf 0\.50 mm closes a (?:[0-9.]+ mm )?slot in "Slotted" — widen it or lower kerf$/);
  });

  test("3MF prints are one real 3MF package", async () => {
    const r = await kit(fixture, { options: { printFormat: "3mf" } });
    expect(r.names.filter((n) => n.startsWith("print/"))).toEqual(["print/kit-fixture.3mf"]);
    expect(Object.keys(unzipSync(r.files["print/kit-fixture.3mf"]))).toContain("3D/3dmodel.model");
  });
});

describe("the 2-D checks", () => {
  test("a check that warns is in the README, word for word", async () => {
    const readme = (await kit(slotted(1))).text("README.txt");
    expect(readme).toMatch(new RegExp(`^Slotted: [0-9.]+ not >= 1\\.5 — ${reEscape(SHEET_METRICS.sheetGap.hint)}$`, "m"));
  });
});

describe("caps", () => {
  test("more than 200 cut pieces is an options error", async () => {
    const many = {
      meta: { title: "Many" }, defaults: { t: 3 }, views: { all: { label: "All" } },
      parts: Object.fromEntries(Array.from({ length: 11 }, (_, i) =>
        [`p${i}`, sheetPart({ ...ply, label: `P${i}`, profile: (kk) => kk.shape2d(rect(10, 10 + i)) })])),
    };
    const r = await kit(many, { options: { sets: 20 } });
    expect(r.error).toBe("cut kit options: Laser-cut parts: 220 pieces — at most 200 in one section; lower sets");
  });

  test("more than 200 checked sheet parts at one set asks for fewer parts, not fewer sets", async () => {
    const lots = {
      meta: { title: "Lots" }, defaults: { t: 3 }, views: { all: { label: "All" } },
      parts: Object.fromEntries(Array.from({ length: 201 }, (_, i) =>
        [`p${i}`, sheetPart({ ...ply, label: `P${i}`, profile: (kk) => kk.shape2d(rect(10, 10)) })])),
    };
    const r = await kit(lots);
    expect(r.error).toBe("cut kit options: Laser-cut parts: 201 pieces — at most 200 in one section; check fewer sheet parts");
    expect(r.phases.some((ph) => ph.startsWith("building"))).toBe(false);
  });

  test("more than 50 sheets of one material is an options error", async () => {
    const tiles = {
      meta: { title: "Tiles" }, defaults: { t: 3 }, views: { all: { label: "All" } },
      parts: Object.fromEntries(["a", "b", "c"].map((n) =>
        [n, sheetPart({ ...ply, material: "birch plywood", label: n, profile: (kk) => kk.shape2d(rect(14, 14)) })])),
    };
    const r = await kit(tiles, { options: { sets: 17, margin: 2.5, spacing: 1, stock: [{ group: "*", size: [20, 20] }] } });
    expect(r.error).toBe("cut kit options: Laser-cut parts: birch plywood 3 mm needs 51 sheets — at most 50 per material; use larger stock or fewer sets");
  });
});

describe("more than one stock group", () => {
  // The same 50 × 50 square cut from two materials.
  const two = {
    meta: { title: "Two" }, defaults: { t: 3 }, views: { all: { label: "All" } },
    parts: {
      a: sheetPart({ ...ply, label: "A", profile: (kk) => kk.shape2d(rect(50, 50)) }),
      b: sheetPart({ ...ply, material: "Acrylic", label: "B", profile: (kk) => kk.shape2d(rect(50, 50)) }),
    },
  };

  test("a group with neither its own stock entry nor a \"*\" default is refused, never defaulted", async () => {
    const r = await kit(two, { options: { stock: [{ group: "birch plywood|3.00", size: [200, 200] }] } });
    expect(r.error).toBe('cut kit options: Laser-cut parts: no stock size for "acrylic|3.00" (Acrylic 3 mm) — add a stock entry for it or a "*" default');
    expect(r.phases.some((ph) => ph.startsWith("building"))).toBe(false);
  });

  test("identical pieces of different stock never merge, and each group gets its own sheet size", async () => {
    const r = await kit(two, { options: { stock: [{ group: "*", size: [200, 200] }, { group: "acrylic|3.00", size: [100, 100] }] } });
    expect(r.error).toBeNull();
    expect(r.names).toEqual([
      "README.txt", "laser/parts/a.svg", "laser/parts/b.svg",
      "laser/sheets/acrylic-3mm/sheet-1-of-1.svg", "laser/sheets/birch-plywood-3mm/sheet-1-of-1.svg", "parts.csv",
    ]);
    const readme = r.text("README.txt");
    expect(readme).toContain("laser/sheets/birch-plywood-3mm/sheet-1-of-1.svg | Birch Plywood | 3.00 mm | 200 × 200 mm | 1 |");
    expect(readme).toContain("laser/sheets/acrylic-3mm/sheet-1-of-1.svg | Acrylic | 3.00 mm | 100 × 100 mm | 1 |");
    expect(readme).not.toContain("PRINTED PARTS");
  });
});

describe("laser-box.js", () => {
  test("the worked example downloads as a kit: six cut panels, a file per hinge", async () => {
    const r = await kit(laserBox, { view: "box" });
    expect(r.error).toBeNull();
    expect(r.download.filename).toBe("plywood-box-with-printed-hinges-kit.zip");
    expectSaneEntries(r.names);
    expect(r.names.filter((n) => n.startsWith("print/"))).toEqual(["print/hinge.stl", "print/hinger.stl"]);
    expect(r.names.some((n) => n.startsWith("laser/sheets/birch-plywood-3mm/sheet-1-of-"))).toBe(true);
    const rows = r.text("parts.csv").trim().split("\r\n").slice(1).map((line) => line.split(","));
    expect(rows.filter((c) => c[1] === "sheet").reduce((n, c) => n + Number(c.at(-1)), 0)).toBe(6);
  });
});
