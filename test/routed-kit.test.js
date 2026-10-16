// The cut & print kit with routed parts: the cnc-router destination, routed pieces
// written whole under every destination, the README's ROUTER OPERATIONS table.
import { beforeAll, describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { sheetPart, routedPart } from "../src/framework/geometry/polygon.js";
import { DESTINATIONS, validateKitOptions } from "../src/framework/export/formats.js";
import { README_HEADINGS } from "../src/framework/export/readme.js";
import { PROCESSES } from "../src/framework/process/registry.js";
import { parseDxf } from "./helpers/dxf-subset.js";
import plinth from "./fixtures/routed-plinth-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const fixture = {
  meta: { title: "Board" },
  parameters: [{ id: "stock", title: "Stock", controls: [{ key: "t", label: "Board thickness", unit: "mm", min: 6, max: 30, step: 1 }] }],
  defaults: { t: 18 },
  views: { all: { label: "All" } },
  parts: {
    plinth: routedPart({ views: ["all"], label: "Plinth", material: "walnut", thickness: (p) => p.t, export: { name: "plinth" },
      profile: (kk) => kk.shape2d(rect(100, 60)),
      pockets: () => [{ region: rect(30, 20).map(([x, y]) => [x + 10, y + 10]), depth: 11.43, label: "vault" }],
      drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }, { at: [60, 30], d: 3.4, depth: 10 }],
      extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([85, 15, 13]), footprint: rect(10, 10).map(([x, y]) => [x + 80, y + 10]), label: "notch", method: "chisel, 10 mm" }],
      reference: () => [[[0, 30], [100, 30]]] }),
    lid: sheetPart({ views: ["all"], label: "Lid", material: "birch plywood", thickness: 3,
      profile: (kk) => kk.shape2d(rect(40, 40)), score: () => [[[5, 5], [35, 5]]] }),
  },
};

async function kit(part, options, parts = Object.keys(part.parts)) {
  const posts = [];
  await handle(k, part, { type: "export-bundle", jobId: 7, parts, view: "all", params: {}, name: part.meta.title, quality: "preview", options }, (m) => posts.push(m));
  const download = posts.find((m) => m.type === "download");
  const files = download ? unzipSync(new Uint8Array(download.data)) : {};
  return { error: posts.find((m) => m.type === "error")?.message ?? null, names: Object.keys(files).sort(), text: (f) => strFromU8(files[f]) };
}

describe("options", () => {
  test("DESTINATIONS is the union of every process's destinations", () => {
    expect(Object.entries(DESTINATIONS)).toEqual(PROCESSES.flatMap((p) => p.destinations.map((d) => [d.id, d.cutFormat])));
    expect(DESTINATIONS["cnc-router"]).toBe("dxf");
  });
  test("kerf is refused for the router destination", () => {
    expect(() => validateKitOptions({ destination: "cnc-router", kerf: 0.2 }))
      .toThrow("cut kit options: kerf does not apply to a CNC router — the CAM applies the tool offset; set kerf to 0");
    expect(validateKitOptions({ destination: "cnc-router" })).toMatchObject({ destination: "cnc-router", cutFormat: "dxf", kerf: 0 });
  });
});

describe("the cnc-router kit", () => {
  test("one layered DXF per routed piece, laser pieces as for a service, README table and legend", async () => {
    const r = await kit(fixture, { destination: "cnc-router" });
    expect(r.error).toBeNull();
    expect(r.names).toContain("parts/plinth.dxf");
    expect(r.names).not.toContain("parts/plinth-marks.dxf");
    expect(r.names).toContain("parts/lid.dxf");
    expect(r.names).toContain("parts/lid-marks.dxf");
    const plinth = parseDxf(r.text("parts/plinth.dxf"));
    expect(plinth.layers.map((l) => l.name)).toEqual(["REFERENCE", "SECONDARY", "DRILL_D3.4_10MM", "POCKET_11.43MM", "CUT"]);
    expect(plinth.entities.filter((e) => e.type === "CIRCLE")).toHaveLength(2);
    const readme = r.text("README.txt");
    expect(README_HEADINGS).toContain("ROUTER OPERATIONS");
    expect(readme).toContain("ROUTER OPERATIONS");
    expect(readme).toContain("Plinth (walnut 18.00 mm)");
    expect(readme).toContain("pocket | near | vault | 30.00 × 20.00 mm | 11.43 mm");
    expect(readme).toContain("drill | near | — | Ø3.4 mm × 2 | 10.00 mm");
    expect(readme).toContain("extra | near | notch | 10.00 × 10.00 mm | to 5.00 mm | chisel, 10 mm");
    expect(readme).toContain("Kerf: none — a CNC router's CAM applies the tool offset.");
    expect(readme).toContain("DXF layers: CUT (colour 1) is the through cut; POCKET_<depth>MM and DRILL_D<dia>_<depth>MM / _THRU carry one depth each; SECONDARY outlines operations done with another tool (see ROUTER OPERATIONS); REFERENCE is layout only. FAR_* layers are the same operations on the far face, drawn mirrored (see the flip note under each two-sided piece). Laser pieces keep CUT/SCORE/ENGRAVE.");
  });

  test("a routed piece under the service and own-laser destinations is still written whole", async () => {
    const svc = await kit(fixture, { destination: "service" }, ["plinth"]);
    expect(svc.names).toEqual(expect.arrayContaining(["parts/plinth.dxf"]));
    expect(svc.names).not.toContain("parts/plinth-marks.dxf");
    expect(parseDxf(svc.text("parts/plinth.dxf")).layers.map((l) => l.name)).toContain("POCKET_11.43MM");
    const own = await kit(fixture, { destination: "own-laser" }, ["plinth"]);
    expect(own.names).toContain("parts/plinth.svg");
    expect(own.text("parts/plinth.svg")).toContain('stroke="#E07000"');
  });

  test("a routed piece too big for the router's stock is listed in the README, not refused", async () => {
    const r = await kit(fixture, { destination: "cnc-router", stock: [{ group: "*", size: [80, 80] }] }, ["plinth"]);
    expect(r.error).toBeNull();
    expect(r.names).toContain("parts/plinth.dxf");
    expect(r.text("README.txt")).toMatch(/\nOVERSIZED PIECES\nPlinth: 100\.0 × 60\.0 mm does not fit a 80 × 80 mm sheet/);
  });

  test("a kerf with a routed piece under a laser destination is the exporter's refusal, naming the piece", async () => {
    const r = await kit(fixture, { destination: "service", kerf: 0.2 }, ["plinth"]);
    expect(r.error).toContain('cut kit options: kerf does not apply to a CNC router — the CAM applies the tool offset; set kerf to 0 ("Plinth")');
  });

  // Two routed pieces whose drawings match but whose operations do not must stay two
  // files: an extra op's depth, method and the op labels live only in the README.
  const twin = ({ notchTop = 13, pocketDepth = 11.43, name }) => routedPart({ views: ["all"], label: name, material: "walnut", thickness: 18, export: { name: name.toLowerCase() },
    profile: (kk) => kk.shape2d(rect(100, 60)),
    pockets: () => [{ region: rect(30, 20).map(([x, y]) => [x + 10, y + 10]), depth: pocketDepth, label: "vault" }],
    extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([85, 15, notchTop]), footprint: rect(10, 10).map(([x, y]) => [x + 80, y + 10]), label: "notch", method: "chisel, 10 mm" }] });
  const pair = (a, b) => ({ meta: { title: "Twins" }, parameters: [], defaults: {}, views: { all: { label: "All" } }, parts: { a: twin({ ...a, name: "Left" }), b: twin({ ...b, name: "Right" }) } });

  test("routed pieces differing only in an extra op's depth are not merged", async () => {
    const r = await kit(pair({ notchTop: 13 }, { notchTop: 10 }), { destination: "cnc-router" });
    expect(r.error).toBeNull();
    expect(r.names).toEqual(expect.arrayContaining(["parts/left.dxf", "parts/right.dxf"]));
    expect(r.names.some((n) => /-x2\./.test(n))).toBe(false);
    const readme = r.text("README.txt");
    expect(readme).toContain("extra | near | notch | 10.00 × 10.00 mm | to 5.00 mm | chisel, 10 mm");
    expect(readme).toContain("extra | near | notch | 10.00 × 10.00 mm | to 8.00 mm | chisel, 10 mm");
  });

  test("routed pieces differing only in a pocket's depth are not merged", async () => {
    const r = await kit(pair({ pocketDepth: 11.43 }, { pocketDepth: 6 }), { destination: "cnc-router" });
    expect(r.error).toBeNull();
    expect(r.names).toEqual(expect.arrayContaining(["parts/left.dxf", "parts/right.dxf"]));
    expect(r.names.some((n) => /-x2\./.test(n))).toBe(false);
  });

  test("identical routed pieces still merge", async () => {
    const r = await kit(pair({}, {}), { destination: "cnc-router" });
    expect(r.error).toBeNull();
    expect(r.names).toContain("parts/left-x2.dxf");
  });
});

test("the docs' worked example builds a cnc-router kit with every layer family", async () => {
  const r = await kit(plinth, { destination: "cnc-router" });
  expect(r.error).toBeNull();
  const dxf = parseDxf(r.text(r.names.find((n) => /^parts\/.*\.dxf$/.test(n))));
  const names = dxf.layers.map((l) => l.name);
  expect(names).toEqual(expect.arrayContaining(["REFERENCE", "SECONDARY", "DRILL_D3.43_10MM", "POCKET_6MM", "POCKET_11.43MM", "CUT"]));
});

test("a routed part with an empty extra footprint builds a cnc-router kit with no SECONDARY layer", async () => {
  const part = { meta: { title: "Board" }, parameters: [], defaults: {}, views: { all: { label: "All" } },
    parts: { plinth: routedPart({ views: ["all"], label: "Plinth", material: "walnut", thickness: 18, export: { name: "plinth" },
      profile: (kk) => kk.shape2d(rect(100, 60)),
      extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([85, 15, 13]), footprint: kk.shape2d(rect(10, 10)).cut(rect(20, 20)), label: "notch", method: "chisel" }] }) } };
  const r = await kit(part, { destination: "cnc-router" });
  expect(r.error).toBeNull();
  const names = parseDxf(r.text("parts/plinth.dxf")).layers.map((l) => l.name);
  expect(names).not.toContain("SECONDARY");
  expect(names).toContain("CUT");
});

test("a pocket depth carries one colour across the kit, and the README legend lists every routed layer", async () => {
  const board = (label, pockets) => routedPart({ views: ["all"], label, material: "walnut", thickness: 18, export: { name: label.toLowerCase() },
    profile: (kk) => kk.shape2d(rect(100, 60)), pockets: () => pockets });
  const part = { meta: { title: "Boards" }, parameters: [], defaults: {}, views: { all: { label: "All" } }, parts: {
    a: board("A", [{ region: rect(20, 20).map(([x, y]) => [x + 10, y + 10]), depth: 6 }, { region: rect(20, 20).map(([x, y]) => [x + 50, y + 10]), depth: 11.43 }]),
    b: board("B", [{ region: rect(20, 20).map(([x, y]) => [x + 10, y + 10]), depth: 11.43 }]),
  } };
  const r = await kit(part, { destination: "cnc-router" });
  expect(r.error).toBeNull();
  const colourOf = (file) => parseDxf(r.text(file)).layers.find((l) => l.name === "POCKET_11.43MM").color;
  expect(colourOf("parts/a.dxf")).toBe(40);
  expect(colourOf("parts/b.dxf")).toBe(40);
  const sheet = r.names.find((n) => n.startsWith("sheets/"));
  expect(parseDxf(r.text(sheet)).layers.find((l) => l.name === "POCKET_11.43MM").color).toBe(40);
  const readme = r.text("README.txt");
  expect(readme).toContain("layer | face | colour | depth");
  expect(readme).toContain("POCKET_6MM | near | 30 | 6.00 mm");
  expect(readme).toContain("POCKET_11.43MM | near | 40 | 11.43 mm");
});

test("the legend lists drills (through ones as through) and SECONDARY/REFERENCE without a depth", async () => {
  const r = await kit(fixture, { destination: "cnc-router" }, ["plinth"]);
  const readme = r.text("README.txt");
  expect(readme).toContain("REFERENCE | near | 8 | —");
  expect(readme).toContain("SECONDARY | near | 6 | —");
  expect(readme).toContain("DRILL_D3.4_10MM | near | 3 | 10.00 mm");
  expect(readme).toContain("POCKET_11.43MM | near | 30 | 11.43 mm");
});

test("a routed piece with only a profile is still routed: it gets its ROUTER OPERATIONS block", async () => {
  const part = { meta: { title: "Bare" }, parameters: [], defaults: {}, views: { all: { label: "All" } },
    parts: { bare: routedPart({ views: ["all"], label: "Bare", material: "walnut", thickness: 18, profile: (kk) => kk.shape2d(rect(50, 50)) }) } };
  const r = await kit(part, { destination: "cnc-router" });
  expect(r.error).toBeNull();
  expect(r.text("README.txt")).toMatch(/\nROUTER OPERATIONS\nBare \(walnut 18\.00 mm\) — depths from each op's own face:/);
});

describe("two-sided pieces", () => {
  const lid = {
    ...fixture, meta: { title: "Lid" },
    parts: { lid: routedPart({ views: ["all"], label: "Lid", material: "walnut", thickness: (p) => p.t, export: { name: "lid" },
      profile: (kk) => kk.shape2d(rect(100, 60)),
      pockets: () => [{ region: rect(30, 20).map(([x, y]) => [x + 10, y + 10]), depth: 3, label: "inlay" }, { region: rect(30, 10).map(([x, y]) => [x + 60, y + 40]), depth: 6, label: "recess", face: "far" }],
      drills: () => [{ at: [80, 10], d: 5, depth: 8, face: "far" }] }) },
  };
  test("one-file (default): one DXF with FAR_ layers, sheets carry near layers only, README face column and flip note", async () => {
    const r = await kit(lid, { destination: "cnc-router" });
    expect(r.error).toBeNull();
    expect(r.names.filter((n) => n.startsWith("parts/"))).toEqual(["parts/lid.dxf"]);
    expect(parseDxf(r.text("parts/lid.dxf")).layers.map((l) => l.name)).toEqual(["POCKET_3MM", "FAR_DRILL_D5_8MM", "FAR_POCKET_6MM", "CUT"]);
    const sheet = r.names.find((n) => n.startsWith("sheets/"));
    expect(parseDxf(r.text(sheet)).layers.map((l) => l.name)).toEqual(["POCKET_3MM", "CUT"]);
    const readme = r.text("README.txt");
    expect(readme).toContain("Lid (walnut 18.00 mm) — depths from each op's own face:");
    expect(readme).toContain("op | face | label | size | depth | method");
    expect(readme).toContain("pocket | far | recess | 30.00 × 10.00 mm | 6.00 mm | mill");
    expect(readme).toContain("drill | far | — | Ø5 mm × 1 | 8.00 mm | drill");
    expect(readme).toContain("Far-side layers (FAR_*) are drawn as seen after flipping the board left-right, matching a VCarve two-sided job with Flip Direction = Horizontal.");
    expect(readme).toContain("On the bottom side the CUT outline is for alignment only — cut the piece out from the near side.");
    expect(readme).toContain("Two-sided pieces: machine the far side first, flip, then the near side and the through cut last");
    expect(readme).toContain("layer | face | colour | depth");
    expect(readme).toMatch(/FAR_POCKET_6MM \| far \| \d+ \| 6\.00 mm/);
  });
  test("two-files: a near file and a -far file whose outline is REFERENCE, never CUT", async () => {
    const r = await kit(lid, { destination: "cnc-router", twoSided: "two-files", flip: "end-over-end" });
    expect(r.names.filter((n) => n.startsWith("parts/"))).toEqual(["parts/lid-far.dxf", "parts/lid.dxf"]);
    expect(parseDxf(r.text("parts/lid.dxf")).layers.map((l) => l.name)).toEqual(["POCKET_3MM", "CUT"]);
    const far = parseDxf(r.text("parts/lid-far.dxf"));
    expect(far.layers.map((l) => l.name)).toEqual(["REFERENCE", "FAR_DRILL_D5_8MM", "FAR_POCKET_6MM"]);
    expect(far.entities.find((e) => e.type === "CIRCLE").center).toEqual([80, 50]);
    const readme = r.text("README.txt");
    expect(readme).toContain("flipping the board end over end, matching a VCarve two-sided job with Flip Direction = Vertical.");
    expect(readme).toContain("Far-side work is in parts/lid-far.dxf; its REFERENCE outline is for alignment, not cutting.");
    expect(r.text("parts.csv")).toContain("parts/lid-far.dxf");
    expect(r.text("parts.csv")).toMatch(/parts\/lid-far\.dxf,far,/);
  });
  test("a one-sided piece ignores twoSided and writes no -far file; its kit is byte-identical to the default", async () => {
    const a = await kit(fixture, { destination: "cnc-router" }, ["plinth"]);
    const b = await kit(fixture, { destination: "cnc-router", twoSided: "two-files", flip: "end-over-end" }, ["plinth"]);
    expect(b.names).toEqual(a.names);
    for (const n of a.names) expect(b.text(n)).toBe(a.text(n));
    expect(a.text("README.txt")).not.toContain("Two-sided pieces");
  });
  test("own-laser and service kits mirror and split the same way", async () => {
    const own = await kit(lid, { destination: "own-laser", twoSided: "two-files" }, ["lid"]);
    expect(own.names).toEqual(expect.arrayContaining(["parts/lid.svg", "parts/lid-far.svg"]));
    expect(own.text("parts/lid-far.svg")).toContain('id="far-pocket-6"');
  });
});
