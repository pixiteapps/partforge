// The kit's two plain-text files (spec D.9): README.txt for the person at the laser and
// parts.csv for a spreadsheet. Goldens pin the whole README for both destinations, so
// a wording change is a visible diff here rather than a surprise in someone's workshop.
import { describe, expect, test } from "vitest";
import {
  README_HEADINGS, CSV_HEADER, cleanLabel, csvCell, renderReadme, renderPartsCsv,
} from "../src/framework/export/readme.js";

const ownLaser = {
  title: "Box\u0007 kit",
  destination: "own-laser", cutFormat: "svg", kerf: 0.15,
  stockNotes: [
    { material: "Birch plywood", thickness: 3, control: "Sheet thickness" },
    { material: "Acrylic", thickness: 2.7, control: null },
  ],
  scale: [{ label: "Front", nominal: [160, 80], drawn: [160.15, 80.15] }],
  sheets: [{ file: "sheets/birch-plywood-3mm/sheet-1-of-1.svg", material: "Birch plywood", thickness: 3, size: [300, 300], pieces: 3, used: 41.6 }],
  pieces: [
    { file: "parts/front.svg", labels: ["Front"], material: "Birch plywood", thickness: 3, size: [160, 80], quantity: 1 },
    { file: "parts/left-x2.svg", labels: ["Left", "Right"], material: "Birch plywood", thickness: 3, size: [110, 80], quantity: 2 },
  ],
  printed: [{ file: "print/hinge-x2.stl", labels: ["Hinge (left)", "Hinge (right)"], quantity: 2 }],
  clearances: [{ label: "Finger clearance", value: 0.1, unit: "mm" }],
  settings: [
    { key: "width", value: 160 }, { key: "label", value: "TOOLS" },
    { key: "logo", value: new Uint8Array(12) }, { key: "on", value: true },
  ],
  checks: [],
  oversized: ["never printed for an own laser"],
  renamed: [],
};

const service = {
  title: "Tray",
  destination: "service", cutFormat: "dxf", kerf: 0,
  stockNotes: [{ material: "MDF", thickness: 6, control: "Thickness" }],
  scale: [{ label: "Base", nominal: [400, 250], drawn: [400, 250] }],
  sheets: [],
  pieces: [
    { file: "parts/base.dxf", marksFile: "parts/base-marks.dxf", labels: ["Base"], material: "MDF", thickness: 6, size: [400, 250], quantity: 1 },
    { file: "parts/lid.dxf", marksFile: null, labels: ["Lid"], material: "MDF", thickness: 6, size: [100, 50], quantity: 1 },
  ],
  printed: [], clearances: [], settings: [],
  checks: ["Base: 2 != 1 — the profile is not exactly one piece"],
  oversized: ["Base: 400.0 × 250.0 mm does not fit a 300 × 300 mm sheet after its 5 mm margin (MDF 6 mm) — cut it from parts/base.dxf"],
  renamed: ["parts/base-2.dxf: base (renamed: parts/base.dxf is Base)"],
};

describe("renderReadme", () => {
  test("own laser, with kerf: every section in order, empty ones dropped", () => {
    expect(renderReadme(ownLaser)).toBe([
      "Box kit — cut & print kit",
      "",
      "BEFORE YOU CUT",
      'This kit assumes 3.00 mm Birch plywood — if yours differs, change "Sheet thickness" and re-download.',
      'This kit assumes 2.70 mm Acrylic — if yours differs, change "the sheet thickness setting" and re-download.',
      "Kerf: 0.15 mm applied to the cut lines only. Set kerf in ONE place — these download options, or your laser software / cutting service — never both.",
      "Scale check — measure one cut piece against its line:",
      "Front: nominal 160.00 × 80.00 mm; this file draws 160.15 × 80.15 with 0.15 mm kerf",
      "Colours: engrave = filled black #000000, score = blue #0000FF, cut = red #FF0000 (inner cuts come before outer cuts).",
      "Test-cut one joint first.",
      "",
      "SHEETS",
      "file | material | thickness | size | pieces | used",
      "sheets/birch-plywood-3mm/sheet-1-of-1.svg | Birch plywood | 3.00 mm | 300 × 300 mm | 3 | 42%",
      "",
      "PIECES",
      "file | labels | material | thickness | size | quantity",
      "parts/front.svg | Front | Birch plywood | 3.00 mm | 160.00 × 80.00 mm | 1",
      "parts/left-x2.svg | Left, Right | Birch plywood | 3.00 mm | 110.00 × 80.00 mm | 2",
      "",
      "PRINTED PARTS",
      "file | labels | quantity",
      "print/hinge-x2.stl | Hinge (left), Hinge (right) | 2",
      "",
      "CLEARANCES (design fit, not kerf)",
      "Finger clearance: 0.1 mm",
      "",
      "SETTINGS",
      "width = 160",
      'label = "TOOLS"',
      "logo = <12 bytes>",
      "on = true",
      "",
      "CHECKS",
      "none",
      "",
      "LIMITS",
      "Layout packs bounding boxes only: no nesting into holes, and grain direction is ignored.",
      "",
    ].join("\n"));
  });

  test("a cutting service, no kerf: DXF legend, the marks files, oversized and renamed lists — and no sheets/ to mention", () => {
    expect(renderReadme(service)).toBe([
      "Tray — cut & print kit",
      "",
      "BEFORE YOU CUT",
      'This kit assumes 6.00 mm MDF — if yours differs, change "Thickness" and re-download.',
      "Kerf: none applied — your laser software or cutting service must compensate.",
      "To have the files adjusted instead, download again with a kerf set, and turn compensation off in your laser software or service.",
      "Scale check — measure one cut piece against its line:",
      "Base: nominal 400.00 × 250.00 mm; this file draws the same (no kerf applied)",
      "DXF layers: CUT (colour 1), SCORE (colour 5), ENGRAVE (colour 7) — set ENGRAVE to fill; R12 has no hatch.",
      "Score and engrave marks are in their own files, not in the cut files — send them with the cut files if you want the marks made: parts/base-marks.dxf.",
      "Test-cut one joint first.",
      "",
      "PIECES",
      "file | labels | material | thickness | size | quantity",
      "parts/base.dxf | Base | MDF | 6.00 mm | 400.00 × 250.00 mm | 1",
      "parts/lid.dxf | Lid | MDF | 6.00 mm | 100.00 × 50.00 mm | 1",
      "",
      "CHECKS",
      "Base: 2 != 1 — the profile is not exactly one piece",
      "",
      "OVERSIZED PIECES",
      "Base: 400.0 × 250.0 mm does not fit a 300 × 300 mm sheet after its 5 mm margin (MDF 6 mm) — cut it from parts/base.dxf",
      "",
      "RENAMED FILES",
      "parts/base-2.dxf: base (renamed: parts/base.dxf is Base)",
      "",
      "LIMITS",
      "Layout packs bounding boxes only: no nesting into holes, and grain direction is ignored.",
      "",
    ].join("\n"));
  });

  test("a service kit with sheets says they are for reference; one with no marks names no marks file", () => {
    const sheets = [{ file: "sheets/mdf-6mm/sheet-1-of-1.dxf", material: "MDF", thickness: 6, size: [600, 400], pieces: 2, used: 50 }];
    const text = renderReadme({ ...service, sheets, pieces: service.pieces.map((pc) => ({ ...pc, marksFile: null })) });
    expect(text).toContain("\nThe sheets in sheets/ are for reference only — a cutting service lays out the pieces itself.\n");
    expect(text).not.toContain("marks");
    expect(renderReadme(ownLaser)).not.toContain("sheets/ are for reference");
  });

  test("plain text with no timestamp and no carriage return", () => {
    for (const text of [renderReadme(ownLaser), renderReadme(service)]) {
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).not.toContain("\r");
      expect(text.endsWith("Layout packs bounding boxes only: no nesting into holes, and grain direction is ignored.\n")).toBe(true);
    }
  });

  test("a setting value is shown whole when short and clipped when not", () => {
    const text = renderReadme({ ...service, settings: [
      { key: "note", value: "a\u0007b" },
      { key: "blob", value: "x".repeat(300) },
      { key: "pos", value: [1, 2] },
      { key: "none", value: null },
    ] });
    expect(text).toContain('SETTINGS\nnote = "ab"\n');
    expect(text).toContain(`blob = "${"x".repeat(199)}…"\n`);
    expect(text).toContain("pos = [1,2]\n");
    expect(text).toContain("none = null\n");
  });

  test("the heading list is the contract's", () => {
    expect(README_HEADINGS).toEqual([
      "BEFORE YOU CUT", "SHEETS", "PIECES", "PRINTED PARTS", "CLEARANCES (design fit, not kerf)",
      "SETTINGS", "CHECKS", "OVERSIZED PIECES", "RENAMED FILES", "LIMITS",
    ]);
  });
});

describe("parts.csv", () => {
  test("CRLF, RFC 4180 quoting, and a quote mark ahead of anything a spreadsheet would run", () => {
    expect(renderPartsCsv([
      { file: "parts/front.svg", kind: "sheet", labels: ["=cmd|' /C calc'!A0"], material: "Birch plywood", thickness: 3, width: 160, height: 80, quantity: 1 },
      { file: "print/hinge-x2.stl", kind: "print", labels: ["Hinge, left", "@SUM(1)"], material: "pla-print", thickness: null, width: 42, height: 24.5, quantity: 2 },
      { file: "parts/tab.svg", kind: "sheet", labels: ["-tab\u0000"], material: "+ply", thickness: 2.7, width: 10, height: 5, quantity: 1 },
      { file: "parts/say.svg", kind: "sheet", labels: ['Say "hi"'], material: "MDF", thickness: 6, width: 1, height: 1, quantity: 1 },
    ])).toBe([
      CSV_HEADER,
      "parts/front.svg,sheet,'=cmd|' /C calc'!A0,Birch plywood,3.00,160.00,80.00,1",
      'print/hinge-x2.stl,print,"Hinge, left; @SUM(1)",pla-print,,42.00,24.50,2',
      "parts/tab.svg,sheet,'-tab,'+ply,2.70,10.00,5.00,1",
      'parts/say.svg,sheet,"Say ""hi""",MDF,6.00,1.00,1.00,1',
    ].map((l) => `${l}\r\n`).join(""));
  });

  test("csvCell", () => {
    expect(csvCell("=1")).toBe("'=1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@x,y")).toBe("\"'@x,y\"");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "x"')).toBe('"say ""x"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
  });

  test("the header is the contract's", () => {
    expect(CSV_HEADER).toBe("file,kind,labels,material,thickness_mm,width_mm,height_mm,quantity");
  });
});

test("cleanLabel strips C0, DEL and C1 controls and nothing else", () => {
  expect(cleanLabel("a\u0000b\u001fc\u007fd\u0085e f")).toBe("abcde f");
  expect(cleanLabel(42)).toBe("42");
});
