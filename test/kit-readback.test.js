// The kit's cut files read back PHYSICALLY: a real export-bundle job through
// partforge/testing's handle(), unzipped, and every SVG and DXF parsed with the readers
// for exactly the writers' subsets (test/helpers/svg-subset.js follows SVG 1.1 F.6.5 —
// what LightBurn, Inkscape and browsers do with an `A` command — and dxf-subset.js reads
// R12). The string-level kit tests (kit-bundle.test.js) cannot see a circle drawn out of
// round or a piece drawn at the wrong size; these can.
import { beforeAll, describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { bootManifoldKernel, handle } from "../src/testing.js";
import {
  sheetPart, circlePolygon, roundedRectProfile, slotProfile, ringSectorProfile, pieProfile,
} from "../src/framework/geometry/polygon.js";
import { sheetHole } from "../src/framework/sheet/joinery.js";
import { arcCenterAndSweep } from "../src/framework/geometry/arc-math.js";
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

// ── #233's exact-curve helpers, through the real kit ─────────────────────────────
//
// roundedRectProfile, slotProfile, ringSectorProfile, pieProfile and sheetHole draw
// EXACT arcs (three-point {to, via} segments), and they are what the guide tells an
// author to reach for. Through the kit each must reach every cut file as arcs on its
// own circles — never faceted into lines, never left as cubics — whether a boolean
// turned its arcs into cubics on the way (the plate's cutouts, and its outline once
// cut) or it went straight through (the outlines of the other three pieces). Truth is
// the authored contours for the arcs and each piece's own Shape2D for its size.

// A contour moved by [dx, dy]; the kit receives it through k.shape2d, as an author would write it.
const moved = (c, [dx, dy]) => ({
  start: [c.start[0] + dx, c.start[1] + dy],
  segments: c.segments.map((g) => (g.via ? { to: [g.to[0] + dx, g.to[1] + dy], via: [g.via[0] + dx, g.via[1] + dy] } : { to: [g.to[0] + dx, g.to[1] + dy] })),
});
const PLATE_CUTS = {
  slot: moved(slotProfile(20, 3), [-30, 20]),
  sector: moved(ringSectorProfile(10, 20, 90), [10, -35]),
  pie: moved(pieProfile(15, 90), [-50, -30]),
  hole: sheetHole({ d: 10, at: [35, 25] }),
};
// Each piece: its authored outline, its authored (CCW) cutouts, and how many sharp
// convex corners the outline has — kerf rounds each of those with an r = kerf/2 arc.
const CURVE_PIECES = {
  plate: { outline: roundedRectProfile(120, 80, 8), holes: Object.values(PLATE_CUTS), corners: 0 },
  sector: { outline: ringSectorProfile(10, 20, 120), holes: [], corners: 4 },
  pie: { outline: pieProfile(15, 120), holes: [], corners: 3 },
  slot: { outline: slotProfile(30, 5), holes: [], corners: 0 },
};
const curveForge = {
  meta: { title: "Curves" }, defaults: {}, views: { all: { label: "All" } },
  parts: Object.fromEntries(Object.entries(CURVE_PIECES).map(([key, piece]) => [key, sheetPart({
    ...ply, label: key,
    // no boolean at all for a piece with no cutouts: its arcs must survive untouched
    profile: (kk) => (piece.holes.length ? kk.shape2d(piece.outline).cutAll(piece.holes) : kk.shape2d(piece.outline)),
  })])),
};

// Every CUT ring of one file as primitives in the y-up frame: its line count, its arcs
// ({ center, r, dA }), its cubic count, its exact box and signed area (CCW positive).
function cutPrims(name, text) {
  if (name.endsWith(".svg")) {
    const svg = parseSvg(text), H = svg.height, up = ([x, y]) => [x, H - y];
    return svg.groups.filter((g) => g.attrs.id.startsWith("cut-")).flatMap((g) => g.paths).flatMap((p) => p.subpaths).map((sub) => {
      const ring = { lines: 0, cubics: 0, arcs: [], pts: [up(sub.start)] };
      let from = sub.start;
      for (const seg of sub.segs) {
        if (seg.cmd === "L") ring.lines++;
        else if (seg.cmd === "C") ring.cubics++;
        else { const g = arcGeometry(from, seg, H); ring.arcs.push(g); ring.pts.push(...arcExtremes(up(from), g)); }
        ring.pts.push(up(seg.to));
        from = seg.to;
      }
      return { ...ring, box: boxOf(ring.pts), area: ringArea(sub, H) };
    });
  }
  return parseDxf(text).entities.filter((e) => e.layer === "CUT").map((e) => {
    if (e.type === "CIRCLE") {
      const pts = [[e.center[0] - e.r, e.center[1] - e.r], [e.center[0] + e.r, e.center[1] + e.r]];
      return { lines: 0, cubics: 0, arcs: [{ center: e.center, r: e.r, dA: -TAU }], box: boxOf(pts), area: -Math.PI * e.r * e.r };
    }
    expect(e.type).toBe("POLYLINE");
    expect(e.closed).toBe(true);
    const ring = { lines: 0, cubics: 0, arcs: [], pts: [] };
    e.vertices.forEach((v, i) => {
      const b = e.vertices[(i + 1) % e.vertices.length].at;
      ring.pts.push(v.at);
      if (!v.bulge) { ring.lines++; return; }
      const { center, r, theta } = bulgeArc(v.at, b, v.bulge);
      ring.arcs.push({ center, r, dA: theta });
      ring.pts.push(...arcExtremes(v.at, { center, r, dA: theta }));
    });
    return { ...ring, box: boxOf(ring.pts), area: polylineArea(e) };
  });
}

// Arcs grouped by circle, each group's total |sweep|: a writer may split one IR arc
// into pieces (the SVG's quarter rule), which is not faceting.
function circlesOf(arcs, tol) {
  const groups = [];
  for (const { center, r, dA } of arcs) {
    const g = groups.find((x) => Math.hypot(x.center[0] - center[0], x.center[1] - center[1]) <= tol && Math.abs(x.r - r) <= tol);
    if (g) g.sweep += Math.abs(dA); else groups.push({ center, r, sweep: Math.abs(dA) });
  }
  return groups;
}

// What an authored CCW contour must become in a piece file whose frame starts at
// `origin`: its line count, its circles and its box. Kerf moves each arc's radius by
// kerf/2 — an outline's convex arc grows and its concave one shrinks, a hole's the
// other way round. An outline keeps every arc's sweep (its sharp corners gain arcs
// instead); a hole's arc that meets a straight edge at a corner loses asin(d / r′) at
// that end, where the edge, moved in by d, now crosses the circle. The pieces here
// only ever meet a RADIAL edge there — the one case that formula is exact for.
function expectedRing(contour, { origin, h, hole }) {
  const at = ([x, y]) => [x - origin[0], y - origin[1]];
  const segs = contour.segments, n = segs.length;
  const fromOf = (i) => (i === 0 ? contour.start : segs[i - 1].to);
  const arcs = [], pts = [at(contour.start)];
  let lines = 0;
  segs.forEach((seg, i) => {
    const from = fromOf(i);
    if (!seg.via) { lines++; pts.push(at(seg.to)); return; }
    const g = arcCenterAndSweep(from, seg.via, seg.to);
    const r = g.r + Math.sign(g.dA) * (hole ? -h : h);
    let sweep = Math.abs(g.dA);
    if (hole && h > 0) {
      // the straight neighbour at each end: [its far point, the shared point]
      for (const [far, P] of [[fromOf((i - 1 + n) % n), from], [segs[(i + 1) % n].to, seg.to]]) {
        const nb = P === from ? segs[(i - 1 + n) % n] : segs[(i + 1) % n];
        if (nb.via) continue;
        const u = [far[0] - P[0], far[1] - P[1]], v = [P[0] - g.center[0], P[1] - g.center[1]];
        const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v));
        if (Math.abs(cos) < 1e-9) continue;                  // tangent: the edge and arc move together
        if (Math.abs(Math.abs(cos) - 1) > 1e-9) throw new Error("expectedRing: a hole's corner edge that is not radial");
        sweep -= Math.asin(h / r);
      }
    }
    arcs.push({ center: at(g.center), r, dA: sweep });
    pts.push(...arcExtremes(at(from), { center: at(g.center), r: g.r, dA: g.dA }), at(seg.to));
  });
  return { lines, circles: circlesOf(arcs, 1e-9), box: boxOf(pts) };
}

describe("#233's exact-curve helpers read back as arcs, at their Shape2D's size", () => {
  const truth = () => Object.fromEntries(Object.entries(curveForge.parts).map(([key, sp]) => {
    const profile = resolveSheet(k, sp, {}, {}).profile;
    return [key, { box: profile.boundingBox(), holes: profile.toContours().flatMap((rg) => rg.holes).map((c) => k.shape2d(c).boundingBox()) }];
  }));

  test.each([["own-laser", 0], ["own-laser", 0.15], ["service", 0], ["service", 0.15]])("%s, kerf %s", async (destination, kerf) => {
    const h = kerf / 2, ext = destination === "own-laser" ? "svg" : "dxf";
    const want = truth();
    const r = await kit(curveForge, { destination, kerf });
    // every cut file parses with the subset readers (a service's marks file too, if any)
    const files = r.names.filter((n) => n.endsWith(".svg") || n.endsWith(".dxf"));
    for (const f of files) expect(() => (f.endsWith(".svg") ? parseSvg(r.text(f)) : parseDxf(r.text(f))), f).not.toThrow();

    const placed = [];
    for (const [key, piece] of Object.entries(CURVE_PIECES)) {
      const file = `parts/${key}.${ext}`;
      expect(r.names, file).toContain(file);
      const t = want[key];
      const size = sizeOf(t.box).map((x) => x + kerf);
      // the piece file's frame: the Shape2D's min corner, less the kerf's growth
      const origin = [t.box.min[0] - h, t.box.min[1] - h];
      const rings = cutPrims(file, r.text(file));
      for (const ring of rings) expect(ring.cubics, `${file}: a cut is lines and arcs`).toBe(0);

      // Piece bounds: the Shape2D's, grown by the kerf, at the origin.
      const outlines = rings.filter((x) => x.area > 0);
      expect(outlines, `${file} outlines`).toHaveLength(1);
      const [outline] = outlines;
      expectClose(outline.box.min, [0, 0], `${file} outline min`);
      expectClose(sizeOf(outline.box), size, `${file} outline size`);
      if (ext === "svg") {
        const svg = parseSvg(r.text(file));
        expectClose([Number(svg.rootAttrs.viewBox.split(" ")[2]), svg.height], size, `${file} viewBox`);
      }
      placed.push(size);

      // Arcs are arcs: exactly the authored lines, and every arc on one of the authored
      // circles with its whole sweep — plus, under kerf, one r = kerf/2 arc per convex corner.
      const check = (ring, exp, label, corners) => {
        expect(ring.lines, `${label}: lines`).toBe(exp.lines);
        const small = h > 0 ? ring.arcs.filter((g) => Math.abs(g.r - h) <= 1e-3) : [];
        expect(small.length, `${label}: kerf corner arcs`).toBe(h > 0 ? corners : 0);
        const got = circlesOf(ring.arcs.filter((g) => !small.includes(g)), 1e-3);
        expect(got.length, `${label}: circles ${JSON.stringify(got)}`).toBe(exp.circles.length);
        for (const c of exp.circles) {
          const m = got.find((g) => Math.hypot(g.center[0] - c.center[0], g.center[1] - c.center[1]) <= 1e-3 && Math.abs(g.r - c.r) <= 1e-3);
          expect(m, `${label}: no arc on the r ${c.r} circle at ${c.center}`).toBeDefined();
          expect(Math.abs(m.sweep - Math.abs(c.sweep)), `${label}: sweep on r ${c.r}`).toBeLessThanOrEqual(1e-3);
        }
      };
      check(outline, expectedRing(piece.outline, { origin, h, hole: false }), `${file} outline`, piece.corners);

      const holes = rings.filter((x) => x.area < 0);
      expect(holes, `${file} holes`).toHaveLength(piece.holes.length);
      expect(t.holes).toHaveLength(piece.holes.length);
      for (const [i, contour] of piece.holes.entries()) {
        const exp = expectedRing(contour, { origin, h, hole: true });
        const c0 = centreOf(exp.box);
        const hole = holes.reduce((a, b) => (Math.hypot(...centreOf(a.box).map((v, j) => v - c0[j])) <= Math.hypot(...centreOf(b.box).map((v, j) => v - c0[j])) ? a : b));
        check(hole, exp, `${file} hole ${i}`, 0);
        // Its box: the Shape2D's hole, eroded by kerf/2. Exact for the slot and the circle;
        // a sector's eroded rim meets its eroded edge d²/2(R−d) short of R − d, ≤ 3e-4 mm here.
        const sb = t.holes.find((b) => Math.hypot(...centreOf(b).map((v, j) => v - origin[j] - c0[j])) < 1);
        expect(sb, `${file} hole ${i}: no Shape2D hole there`).toBeDefined();
        expectClose(hole.box.min, [sb.min[0] - origin[0] + h, sb.min[1] - origin[1] + h], `${file} hole ${i} min`);
        expectClose(hole.box.max, [sb.max[0] - origin[0] - h, sb.max[1] - origin[1] - h], `${file} hole ${i} max`);
      }
    }

    // The sheet(s): every placed outline one of the pieces, turned or not, and nothing faceted.
    const sheets = r.names.filter((n) => n.startsWith("sheets/") && n.endsWith(`.${ext}`));
    expect(sheets.length).toBeGreaterThan(0);
    const left = [...placed];
    for (const file of sheets) {
      const rings = cutPrims(file, r.text(file));
      for (const ring of rings) expect(ring.cubics, `${file}: a cut is lines and arcs`).toBe(0);
      for (const ring of rings.filter((x) => x.area > 0)) {
        const [w, hh] = sizeOf(ring.box);
        const i = left.findIndex(([a, b]) => (Math.abs(a - w) <= 1e-3 && Math.abs(b - hh) <= 1e-3) || (Math.abs(a - hh) <= 1e-3 && Math.abs(b - w) <= 1e-3));
        expect(i, `${file}: a placed ${w} × ${hh} outline is none of the pieces`).toBeGreaterThanOrEqual(0);
        left.splice(i, 1);
      }
    }
    expect(left).toEqual([]);
    const lineCount = (names) => names.flatMap((f) => cutPrims(f, r.text(f))).reduce((n, x) => n + x.lines, 0);
    expect(lineCount(sheets), "the sheets carry the pieces' lines, no more").toBe(lineCount(Object.keys(CURVE_PIECES).map((key) => `parts/${key}.${ext}`)));
  });
});
