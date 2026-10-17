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
      "BEFORE YOU CUT", "SHEETS", "PIECES", "ROUTER OPERATIONS", "PRINTED PARTS", "CLEARANCES (design fit, not kerf)",
      "SETTINGS", "CHECKS", "OVERSIZED PIECES", "RENAMED FILES", "LIMITS",
    ]);
  });
});

const routerKit = {
  title: "Board",
  destination: "cnc-router", cutFormat: "dxf", kerf: 0, flip: "left-right", twoSided: "one-file", anyTwoSided: false,
  stockNotes: [{ material: "walnut", thickness: 18, control: "Board thickness" }],
  scale: [{ label: "Plinth", nominal: [100, 60], drawn: [100, 60] }],
  sheets: [],
  pieces: [{ file: "parts/plinth.dxf", marksFile: null, farFile: null, labels: ["Plinth"], material: "walnut", thickness: 18, size: [100, 60], quantity: 1 }],
  router: [{ labels: ["Plinth"], material: "walnut", thickness: 18, twoSided: false, farFile: null,
    pockets: [{ w: 30, h: 20, depth: 11.43, label: "vault", face: "near" }],
    drills: [{ d: 3.4, count: 2, depth: 10, through: false, label: null, face: "near" }],
    extra: [{ w: 10, h: 10, maxDepth: 5, label: "notch", method: "chisel, 10 mm", face: "near" }] }],
  layers: [
    { name: "SECONDARY", face: "near", colour: "6", depth: "—" },
    { name: "POCKET_11.43MM", face: "near", colour: "30", depth: "11.43 mm" },
  ],
  printed: [], clearances: [], settings: [], checks: [], oversized: [], renamed: [],
};

describe("renderReadme — CNC router", () => {
  test("a one-sided routed kit: face columns in the operations and legend tables", () => {
    expect(renderReadme(routerKit)).toBe([
      "Board — cut & print kit",
      "",
      "BEFORE YOU CUT",
      'This kit assumes 18.00 mm walnut — if yours differs, change "Board thickness" and re-download.',
      "Kerf: none — a CNC router's CAM applies the tool offset.",
      "Scale check — measure one cut piece against its line:",
      "Plinth: nominal 100.00 × 60.00 mm; this file draws the same (no kerf applied)",
      "DXF layers: CUT (colour 1) is the through cut; POCKET_<depth>MM and DRILL_D<dia>_<depth>MM / _THRU carry one depth each; SECONDARY outlines operations done with another tool (see ROUTER OPERATIONS); REFERENCE is layout only. FAR_* layers are the same operations on the far face, drawn mirrored (see the flip note under each two-sided piece). Laser pieces keep CUT/SCORE/ENGRAVE.",
      "Test-cut one joint first.",
      "",
      "PIECES",
      "file | labels | material | thickness | size | quantity",
      "parts/plinth.dxf | Plinth | walnut | 18.00 mm | 100.00 × 60.00 mm | 1",
      "",
      "ROUTER OPERATIONS",
      "Plinth (walnut 18.00 mm) — depths from each op's own face:",
      "op | face | label | size | depth | method",
      "pocket | near | vault | 30.00 × 20.00 mm | 11.43 mm | mill",
      "drill | near | — | Ø3.4 mm × 2 | 10.00 mm | drill",
      "extra | near | notch | 10.00 × 10.00 mm | to 5.00 mm | chisel, 10 mm",
      "LAYERS (one colour per layer across the kit):",
      "layer | face | colour | depth",
      "SECONDARY | near | 6 | —",
      "POCKET_11.43MM | near | 30 | 11.43 mm",
      "",
      "CHECKS",
      "none",
      "",
      "LIMITS",
      "Layout packs bounding boxes only: no nesting into holes, and grain direction is ignored.",
      "",
    ].join("\n"));
  });

  test("a two-sided piece: the far rows, the flip and alignment notes, and the order of work", () => {
    const twoSided = {
      ...routerKit, anyTwoSided: true,
      router: [{ ...routerKit.router[0], twoSided: true, farFile: null,
        pockets: [...routerKit.router[0].pockets, { w: 30, h: 10, depth: 6, label: "recess", face: "far" }] }],
      layers: [...routerKit.layers, { name: "FAR_POCKET_6MM", face: "far", colour: "20", depth: "6.00 mm" }],
    };
    const text = renderReadme(twoSided);
    expect(text).toContain([
      "pocket | far | recess | 30.00 × 10.00 mm | 6.00 mm | mill",
      "drill | near | — | Ø3.4 mm × 2 | 10.00 mm | drill",
      "extra | near | notch | 10.00 × 10.00 mm | to 5.00 mm | chisel, 10 mm",
      "Far-side layers (FAR_*) are drawn as seen after flipping the board left-right, matching a VCarve two-sided job with Flip Direction = Horizontal.",
      "On the bottom side, move the imported far-side vectors so their outline sits on the piece's outline as the CAM shows it from that side. Shortcut: make the job's material the piece's size, then centre the imported vectors on the material (VCarve: Align Selected Objects → Centre); because the far layers are mirrored about the piece's own centre, they then land exactly.",
      "On the bottom side the CUT outline is for alignment only — cut the piece out from the near side.",
      "LAYERS (one colour per layer across the kit):",
    ].join("\n"));
    expect(text).toContain("\nFAR_POCKET_6MM | far | 20 | 6.00 mm\n");
    expect(text).toContain("\nTwo-sided pieces: machine the far side first, flip, then the near side and the through cut last, so the board holds the piece until the end. Sheet layouts in sheets/ carry near-side work only; far-side work is in the per-piece files.\nTest-cut one joint first.\n");

    const twoFiles = renderReadme({ ...twoSided, flip: "end-over-end", twoSided: "two-files",
      router: [{ ...twoSided.router[0], farFile: "parts/plinth-far.dxf" }] });
    expect(twoFiles).toContain("Far-side layers (FAR_*) are drawn as seen after flipping the board end over end, matching a VCarve two-sided job with Flip Direction = Vertical.");
    expect(twoFiles).toContain("\nFar-side work is in parts/plinth-far.dxf; its REFERENCE outline is for alignment, not cutting.\n");
    expect(twoFiles).not.toContain("the CUT outline is for alignment only");
    expect(renderReadme(routerKit)).not.toContain("Two-sided pieces");
    expect(renderReadme(routerKit)).not.toContain("Far-side layers (FAR_*) are drawn");
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

test("cleanLabel strips C0, DEL and C1 controls, line/paragraph separators and bidi overrides — and nothing else", () => {
  expect(cleanLabel("a\u0000b\u001fc\u007fd\u0085e f")).toBe("abcde f");
  // U+2028/U+2029 render as line breaks in many editors; U+202A–U+202E and U+2066–U+2069
  // reorder the text around them — none may reach a table row or a CSV cell
  expect(cleanLabel("Top\u2028Lid\u2029 \u202aa\u202bb\u202cc\u202dd\u202ee \u2066f\u2067g\u2068h\u2069")).toBe("TopLid abcde fgh");
  expect(cleanLabel("Côté 合板 — ½\u00a0in")).toBe("Côté 合板 — ½\u00a0in");
  expect(cleanLabel(42)).toBe("42");
  expect(renderPartsCsv([{ file: "parts/top.svg", kind: "sheet", labels: ["Top\u2028\u202eLid"], material: "ply", thickness: 3, width: 1, height: 1, quantity: 1 }]))
    .toBe(`${CSV_HEADER}\r\nparts/top.svg,sheet,TopLid,ply,3.00,1.00,1.00,1\r\n`);
});
