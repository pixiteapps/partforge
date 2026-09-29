// The kit's cut files read back PHYSICALLY: a real export-bundle job through
// partforge/testing's handle(), unzipped, and every SVG and DXF parsed with the readers
// for exactly the writers' subsets (test/helpers/svg-subset.js follows SVG 1.1 F.6.5 —
// what LightBurn, Inkscape and browsers do with an `A` command — and dxf-subset.js reads
// R12). The string-level kit tests (kit-bundle.test.js) cannot see a circle drawn out of
// round or a piece drawn at the wrong size; these can.
import { beforeAll, describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { sheetPart, circleProfile } from "../src/framework/geometry/polygon.js";
import { parseSvg, arcGeometry } from "./helpers/svg-subset.js";
import { parseDxf } from "./helpers/dxf-subset.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const ply = { views: ["all"], material: "Birch Plywood", thickness: 3 };
const MARGIN = 5;   // KIT_DEFAULTS.margin: a sheet's one piece lands at [5, 5]

async function kit(part, options = {}) {
  const posts = [];
  await handle(k, part, { type: "export-bundle", jobId: 1, parts: Object.keys(part.parts), view: "all", params: {},
    name: part.meta.title, quality: "preview", options }, (m) => posts.push(m));
  const error = posts.find((m) => m.type === "error");
  if (error) throw new Error(error.message);
  const files = unzipSync(new Uint8Array(posts.find((m) => m.type === "download").data));
  return { names: Object.keys(files).sort(), text: (f) => strFromU8(files[f]) };
}

// The farthest the arcs of one SVG subpath stray from the circle (c, r), in the file's
// y-up frame: every `A` is turned back into centre form the way F.6.5 says a reader
// must, and sampled along its sweep.
function svgRadialDeviation(sub, height, c, r) {
  let worst = 0, from = sub.start;
  for (const s of sub.segs) {
    expect(s.cmd).toBe("A");
    const g = arcGeometry(from, s, height);
    const a0 = Math.atan2(height - from[1] - g.center[1], from[0] - g.center[0]);
    for (let i = 0; i <= 32; i++) {
      const t = a0 + (g.dA * i) / 32;
      worst = Math.max(worst, Math.abs(Math.hypot(g.center[0] + g.r * Math.cos(t) - c[0], g.center[1] + g.r * Math.sin(t) - c[1]) - r));
    }
    from = s.to;
  }
  return worst;
}

describe("an off-grid circle stays round in the SVG", () => {
  // circleProfile draws a 48-gon; the refit turns it back into arcs about the exact
  // centre. Cut through a boolean, the ring comes back re-seated at an arbitrary vertex,
  // so its arcs' ends land off the 1e-4 number grid — which is what a 180° arc cannot
  // survive: its centre sits ON the chord, and F.6.5 rebuilds it from sqrt(r² − c²).
  const cases = [
    { name: "a r 10 hole at (60, 60) in a 120 mm plate", layer: "cut-inner", center: [60, 60], r: 10, min: [0, 0],
      profile: (kk) => kk.shape2d(rect(120, 120)).cut(circleProfile(10, [60, 60])) },
    { name: "a r 110/3 hole off centre in a 150 × 100 plate", layer: "cut-inner", center: [61.2345, 47.891], r: 110 / 3, min: [0, 0],
      profile: (kk) => kk.shape2d(rect(150, 100)).cut(circleProfile(110 / 3, [61.2345, 47.891])) },
    { name: "a r 110/3 disc off the origin", layer: "cut-outer", center: [41.2345, 17.891], r: 110 / 3,
      min: [41.2345 - 110 / 3, 17.891 - 110 / 3], grows: true,
      profile: (kk) => kk.shape2d(circleProfile(110 / 3, [41.2345, 17.891])) },
  ];
  const forge = (c) => ({ meta: { title: "Round" }, defaults: {}, views: { all: { label: "All" } },
    parts: { p: sheetPart({ ...ply, label: "P", profile: c.profile }) } });

  describe.each(cases)("$name", (c) => {
    test.each([0, 0.15])("kerf %s: within 0.001 mm of its circle in the piece file and on the sheet", async (kerf) => {
      const h = kerf / 2;
      // The kerf grows an outline and shrinks a hole by kerf/2; the piece file puts the
      // drawing's bounds.min (the outline's, grown by kerf/2) at the origin.
      const r = c.r + (c.grows ? h : -h);
      const local = [c.center[0] - c.min[0] + h, c.center[1] - c.min[1] + h];
      const kitFiles = await kit(forge(c), { kerf });
      for (const [file, at] of [["parts/p.svg", [0, 0]], ["sheets/birch-plywood-3mm/sheet-1-of-1.svg", [MARGIN, MARGIN]]]) {
        const svg = parseSvg(kitFiles.text(file));
        const [sub] = svg.groups.find((g) => g.attrs.id === c.layer).paths[0].subpaths;
        const dev = svgRadialDeviation(sub, svg.height, [local[0] + at[0], local[1] + at[1]], r);
        expect(dev, `${file}`).toBeLessThanOrEqual(1e-3);
      }
    });

    test.each([0, 0.15])("kerf %s: the service DXF writes it as an exact CIRCLE", async (kerf) => {
      const h = kerf / 2;
      const r = c.r + (c.grows ? h : -h);
      const dxf = parseDxf((await kit(forge(c), { kerf, destination: "service" })).text("parts/p.dxf"));
      const circles = dxf.entities.filter((e) => e.type === "CIRCLE");
      expect(circles).toHaveLength(1);
      expect(circles[0].center[0]).toBeCloseTo(c.center[0] - c.min[0] + h, 5);
      expect(circles[0].center[1]).toBeCloseTo(c.center[1] - c.min[1] + h, 5);
      expect(circles[0].r).toBeCloseTo(r, 5);
    });
  });
});
