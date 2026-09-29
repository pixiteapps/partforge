// The kit's cut files read back PHYSICALLY: a real export-bundle job through
// partforge/testing's handle(), unzipped, and every SVG and DXF parsed with the readers
// for exactly the writers' subsets (test/helpers/svg-subset.js follows SVG 1.1 F.6.5 —
// what LightBurn, Inkscape and browsers do with an `A` command — and dxf-subset.js reads
// R12). The string-level kit tests (kit-bundle.test.js) cannot see a circle drawn out of
// round or a piece drawn at the wrong size; these can.
import { beforeAll, describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { sheetPart, circlePolygon } from "../src/framework/geometry/polygon.js";
import { resolveParams } from "../src/framework/part-model.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { parseSvg, arcGeometry, ringArea } from "./helpers/svg-subset.js";
import { parseDxf, bulgeArc, polylineArea } from "./helpers/dxf-subset.js";
import laserBox from "../src/parts/laser-box.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const ply = { views: ["all"], material: "Birch Plywood", thickness: 3 };
const MARGIN = 5;   // KIT_DEFAULTS.margin: a sheet's one piece lands at [5, 5]

async function kit(part, options = {}, view = "all") {
  const posts = [];
  await handle(k, part, { type: "export-bundle", jobId: 1, parts: Object.keys(part.parts), view, params: {},
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

// An EXACT circle: two three-point arcs, sheetHole's shape and the one circleProfile
// returns from partforge 0.132 (today circleProfile is still circlePolygon's 48 points).
const arcCircle = (r, [x, y]) => ({ start: [x + r, y], segments: [{ to: [x - r, y], via: [x, y + r] }, { to: [x + r, y], via: [x, y - r] }] });

describe("an off-grid circle stays round in the SVG", () => {
  // circlePolygon draws a 48-gon; the refit turns it back into arcs about the exact
  // centre. Cut through a boolean, the ring comes back re-seated at an arbitrary vertex,
  // so its arcs' ends land off the 1e-4 number grid — which is what a 180° arc cannot
  // survive: its centre sits ON the chord, and F.6.5 rebuilds it from sqrt(r² − c²).
  // An exact circle takes the other roads — its arcs straight through, or, once a
  // boolean has touched it, cubics that recoverArcs rebuilds — and must come out just
  // as round.
  const cases = [
    { name: "a r 10 hole at (60, 60) in a 120 mm plate", layer: "cut-inner", center: [60, 60], r: 10, min: [0, 0],
      profile: (kk) => kk.shape2d(rect(120, 120)).cut(circlePolygon(10, [60, 60])) },
    { name: "a r 110/3 hole off centre in a 150 × 100 plate", layer: "cut-inner", center: [61.2345, 47.891], r: 110 / 3, min: [0, 0],
      profile: (kk) => kk.shape2d(rect(150, 100)).cut(circlePolygon(110 / 3, [61.2345, 47.891])) },
    { name: "a r 110/3 disc off the origin", layer: "cut-outer", center: [41.2345, 17.891], r: 110 / 3,
      min: [41.2345 - 110 / 3, 17.891 - 110 / 3], grows: true,
      profile: (kk) => kk.shape2d(circlePolygon(110 / 3, [41.2345, 17.891])) },
    { name: "an exact r 110/3 hole off centre in a 150 × 100 plate", layer: "cut-inner", center: [61.2345, 47.891], r: 110 / 3, min: [0, 0],
      profile: (kk) => kk.shape2d(rect(150, 100)).cut(arcCircle(110 / 3, [61.2345, 47.891])) },
    { name: "an exact r 110/3 disc off the origin", layer: "cut-outer", center: [41.2345, 17.891], r: 110 / 3,
      min: [41.2345 - 110 / 3, 17.891 - 110 / 3], grows: true,
      profile: (kk) => kk.shape2d(arcCircle(110 / 3, [41.2345, 17.891])) },
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

// ── laser-box.js, every cut file read back ────────────────────────────────────

const TAU = 2 * Math.PI;
const wrap = (a) => ((a % TAU) + TAU) % TAU;
const boxOf = (pts) => ({
  min: [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))],
  max: [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))],
});
const sizeOf = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1]];
const centreOf = (b) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
// An arc's axis extremes inside its sweep: an exact bounding box, not a sampled one.
const arcExtremes = (from, { center: [cx, cy], r, dA }) => {
  const a0 = Math.atan2(from[1] - cy, from[0] - cx);
  return [0, 1, 2, 3].map((q) => (q * Math.PI) / 2)
    .filter((t) => (dA >= 0 ? wrap(t - a0) : wrap(a0 - t)) <= Math.abs(dA))
    .map((t) => [cx + r * Math.cos(t), cy + r * Math.sin(t)]);
};

// Every closed ring of one SVG layer, y-up: { box, area } (area signed: CCW positive).
function svgRings(svg, id) {
  const H = svg.height, up = ([x, y]) => [x, H - y];
  const group = svg.groups.find((g) => g.attrs.id === id);
  return (group?.paths ?? []).flatMap((p) => p.subpaths).map((sub) => {
    const pts = [up(sub.start)];
    let from = sub.start;
    for (const seg of sub.segs) {
      expect(seg.cmd, "a laser-box cut is lines and arcs").not.toBe("C");
      if (seg.cmd === "A") pts.push(...arcExtremes(up(from), arcGeometry(from, seg, H)));
      pts.push(up(seg.to));
      from = seg.to;
    }
    return { box: boxOf(pts), area: ringArea(sub, H) };
  });
}

// Every CUT ring of a DXF: POLYLINEs (area signed, CCW positive) and CIRCLEs (holes).
function dxfCutRings(dxf) {
  return dxf.entities.filter((e) => e.layer === "CUT").map((e) => {
    if (e.type === "CIRCLE") return { box: { min: [e.center[0] - e.r, e.center[1] - e.r], max: [e.center[0] + e.r, e.center[1] + e.r] }, area: -Math.PI * e.r * e.r };
    expect(e.type).toBe("POLYLINE");
    expect(e.closed).toBe(true);
    const v = e.vertices, pts = [];
    v.forEach((x, i) => {
      const b = v[(i + 1) % v.length].at;
      pts.push(x.at);
      if (x.bulge) pts.push(...arcExtremes(x.at, (({ center, r, theta }) => ({ center, r, dA: theta }))(bulgeArc(x.at, b, x.bulge))));
    });
    return { box: boxOf(pts), area: polylineArea(e) };
  });
}

const expectClose = (got, want, msg) => want.forEach((w, i) => expect(Math.abs(got[i] - w), `${msg} [${i}]: ${got} vs ${want}`).toBeLessThanOrEqual(1e-3));

describe("laser-box.js: every cut file reads back at its piece's size, never mirrored", () => {
  // The truth is each piece's own Shape2D (paper.js bounds), not anything the kit computed.
  const truth = () => {
    const { p, d } = resolveParams(laserBox, {});
    const byLabel = {};
    for (const sp of Object.values(laserBox.parts)) {
      if (!sp.sheet) continue;
      const profile = resolveSheet(k, sp, p, d).profile;
      const b = profile.boundingBox();
      const holes = profile.toContours().flatMap((rg) => rg.holes).map((h) => centreOf(k.shape2d(h).boundingBox()))
        .map((c) => [c[0] - b.min[0], c[1] - b.min[1]]);
      byLabel[sp.label] = { size: sizeOf(b), holes };
    }
    return byLabel;
  };
  const sortPts = (pts) => [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // A 130 mm wide sheet leaves 120 mm inside: every 160 mm panel has to be turned 90°,
  // which is where a turn written as a reflection would show.
  const NARROW = [{ group: "*", size: [130, 400] }];
  test.each([
    ["own-laser", 0, null], ["own-laser", 0.15, null], ["service", 0, null], ["service", 0.15, null],
    ["own-laser", 0.15, NARROW], ["service", 0, NARROW],
  ])("%s, kerf %s, stock %j", async (destination, kerf, stock) => {
    const want = truth();
    const r = await kit(laserBox, { destination, kerf, stock }, "box");
    const rows = r.text("parts.csv").trim().split("\r\n").slice(1).map((l) => l.split(",")).filter((c) => c[1] === "sheet");
    expect(rows).toHaveLength(5);                                   // left and right merge
    const expected = [];                                            // one [w, h] per cut piece, quantities expanded
    for (const [file, , labels, , , w, h, qty] of rows) {
      const t = want[labels.split("; ")[0]];
      expectClose([Number(w), Number(h)], t.size, `${file} nominal`);
      const size = t.size.map((x) => x + kerf);                    // the kerf grows the outline by kerf/2 a side
      for (let i = 0; i < Number(qty); i++) expected.push(size);

      // The piece file: its outline at the origin at exactly that size, CCW (a mirror
      // would turn it CW), its holes CW and each where the Shape2D has it.
      let outline, holes;
      if (destination === "own-laser") {
        const svg = parseSvg(r.text(file));
        expectClose([Number(svg.rootAttrs.viewBox.split(" ")[2]), svg.height], size, `${file} viewBox`);
        [outline, ...holes] = [...svgRings(svg, "cut-outer"), ...svgRings(svg, "cut-inner")];
        expect(svgRings(svg, "cut-outer")).toHaveLength(1);
      } else {
        const rings = dxfCutRings(parseDxf(r.text(file)));
        outline = rings.find((x) => x.area > 0);
        holes = rings.filter((x) => x !== outline);
        expect(rings.filter((x) => x.area > 0)).toHaveLength(1);
      }
      expectClose(outline.box.min, [0, 0], `${file} outline min`);
      expectClose(sizeOf(outline.box), size, `${file} outline size`);
      expect(outline.area, `${file} outline winding`).toBeGreaterThan(0);
      for (const hole of holes) expect(hole.area, `${file} hole winding`).toBeLessThan(0);
      const got = sortPts(holes.map((x) => centreOf(x.box)));
      const exp = sortPts(t.holes.map(([x, y]) => [x + kerf / 2, y + kerf / 2]));
      expect(got).toHaveLength(exp.length);
      got.forEach((c, i) => expectClose(c, exp[i], `${file} hole ${i}`));
    }

    // The sheets: every placed outline is one of the pieces, turned or not, CCW.
    const placed = [];
    for (const file of r.names.filter((n) => n.startsWith("sheets/"))) {
      const rings = destination === "own-laser"
        ? svgRings(parseSvg(r.text(file)), "cut-outer")
        : dxfCutRings(parseDxf(r.text(file))).filter((x) => x.area > 0);
      for (const ring of rings) { expect(ring.area, `${file} outline winding`).toBeGreaterThan(0); placed.push(sizeOf(ring.box)); }
    }
    expect(placed).toHaveLength(expected.length);
    const left = [...expected];
    for (const [w, h] of placed) {
      const i = left.findIndex(([a, b]) => (Math.abs(a - w) <= 1e-3 && Math.abs(b - h) <= 1e-3) || (Math.abs(a - h) <= 1e-3 && Math.abs(b - w) <= 1e-3));
      expect(i, `a placed ${w} × ${h} outline is none of the pieces`).toBeGreaterThanOrEqual(0);
      left.splice(i, 1);
    }
  });
});
