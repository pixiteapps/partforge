// Laser cutting — process module #1. A ProcessDescriptor is DATA: which layers a sheet
// part draws, which keys it reserves, which destinations the kit offers. Later phases
// add its lint rules, DFM metrics and 2-D checks here.
//
// Import-free apart from sheet/constants.js: lint and the oracle read the registry, so
// nothing reachable from here may touch a kernel, a Shape2D or paper
// (test/lint-purity.test.js, test/oracle-no-paper.test.js). The writers that draw this
// process's cut files live in process/laser/export.js, which only the kit loads.
import {
  widthFloor, WIDTH_RESOLUTION, LOSS_TOL_MM2, SOLID_MATCH_PCT, SHEET_DOC_ID, fmtMm,
  isSheetPart, sheetMeta, LASER_THICKNESS_RANGE,
} from "../../sheet/constants.js";
import { warn } from "../../lint/finding.js";

// ── 2-D design-for-manufacture facts ──────────────────────────────────────────
// Read from the RESOLVED sheet (sheet/resolve.js) through Shape2D methods alone —
// offset, area, cut, union, intersect, regions, boundingBox — so this file stays
// import-free and paper never enters lint's or the oracle's module graph: the
// shapes' own methods carry the booleans. 2-D only; the oracle lifts a location
// into the assembly itself (oracle/measure.js).

// Sharp corners make shrink-then-regrow exact on rectilinear joinery; round ones
// would shave every corner and report it as a lost web.
const SHARP = { corners: "sharp" };
// Shape2D.offset's refusal when a shrink removes everything (geometry/contour-offset.js).
const COLLAPSES = /collapses the shape/;
// Thrown by `spend` once the shared deadline has passed; caught only in facts().
const OUT_OF_TIME = Symbol("sheet check budget");
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Number(x.toFixed(3));

// The centre of the bounding box of `shape`'s largest region; null for an empty shape.
function centreOfLargest(shape) {
  if (shape.isEmpty()) return null;
  let best = null, bestArea = -Infinity;
  for (const region of shape.regions()) {
    const a = region.area();
    if (a > bestArea) { best = region; bestArea = a; }
  }
  if (!best) return null;
  const { min, max } = best.boundingBox();
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
}

// ── contour geometry, from the IR alone (toContours) ──────────────────────────
// A ring is a point list (all lines) or { start, segments }, a segment a line
// ({ to }), an arc ({ via, to }) or a cubic ({ c1, c2, to }).
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cubicMid = (p0, { c1, c2, to }) => [0, 1].map((i) => (p0[i] + 3 * c1[i] + 3 * c2[i] + to[i]) / 8);
// A curved segment's radius: an arc's circumradius; a cubic's from its chord and the
// turn between its end tangents (exact for a cubic that approximates a circular arc).
function curveRadius(from, seg) {
  if (seg.via) {
    const [a, b, c] = [dist(from, seg.via), dist(seg.via, seg.to), dist(seg.to, from)];
    const twiceArea = Math.abs((seg.via[0] - from[0]) * (seg.to[1] - from[1]) - (seg.via[1] - from[1]) * (seg.to[0] - from[0]));
    return twiceArea > 1e-12 ? (a * b * c) / (2 * twiceArea) : Infinity;
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const t0 = dist(from, seg.c1) > 1e-12 ? sub(seg.c1, from) : sub(seg.c2, from);
  const t1 = dist(seg.c2, seg.to) > 1e-12 ? sub(seg.to, seg.c2) : sub(seg.to, seg.c1);
  const cos = (t0[0] * t1[0] + t0[1] * t1[1]) / (Math.hypot(...t0) * Math.hypot(...t1) || 1);
  const turn = Math.acos(Math.max(-1, Math.min(1, cos)));
  return turn > 1e-6 ? dist(from, seg.to) / (2 * Math.sin(turn / 2)) : Infinity;
}

// A hole ring that is a circle — every segment curved, every endpoint, arc midpoint and
// cubic midpoint within 1 % of one radius — as { d, at }, else null.
function roundHole(ring) {
  if (Array.isArray(ring) || !ring.segments?.length) return null;
  const pts = [ring.start];
  let from = ring.start;
  for (const seg of ring.segments) {
    if (!seg.via && !seg.c1) return null;
    pts.push(seg.via ?? cubicMid(from, seg), seg.to);
    from = seg.to;
  }
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const at = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const r = pts.reduce((acc, q) => acc + dist(q, at), 0) / pts.length;
  return r > 0 && pts.every((q) => Math.abs(dist(q, at) - r) <= 0.01 * r) ? { d: 2 * r, at } : null;
}

// ── the cost pre-gate ─────────────────────────────────────────────────────────
// The deadline is checked BETWEEN tests; nothing interrupts one. So under a deadline a
// profile whose single test would plainly outrun the whole budget is not started:
// `evaluated` stays false and verify says so, exactly as if the budget had run out —
// which it would have, only seconds later, and inside partforge-cloud's one 8 s report.
// The estimate is in units of about one desktop-Node millisecond, from the profile's
// segments weighted by what the offset engine and paper make of them. Measured on 3 mm
// stock (docs/research/sheet-inspect-timing.md, "What a profile costs"):
//   line ................................ 1    1,028 of them: 0.6 s for one test
//   arc ................................. 2    800 (400 perforations): 2.5 s for one test
//   cubic of radius ≥ the ceiling, or in
//     a round hole ....................... 12   cheap with nothing to find (384: 0.8 s in
//                                                all); with a web to find every test diffs
//                                                them (64: 4.8 s in all, 128: 15.7 s)
//   cubic, radius in [ceiling/2, ceiling) 40   64 of them: 6.9 s in all
//   cubic, radius < ceiling/2 (inverts) . 100  16 of them: 3.2 s for one test
// A ring of nothing but tight cubics that is not round (a small oval) is the whole
// budget by itself: one d 3.5 mm hole took 4.3 s for one test before round holes were
// read directly (narrowestGap).
// The gate is the budget itself, SHEET_CHECK_BUDGET_MS (1500): above it a profile could
// not be read within it on a desktop, let alone a phone. With no deadline the caller
// asked for the whole reading, however long, and gets it.
const COST_UNITS = 1500;
function checkCost(contours, ceiling) {
  let units = 0;
  for (const rg of contours) {
    for (const ring of [rg.outer, ...rg.holes]) {
      if (Array.isArray(ring)) { units += ring.length; continue; }
      const round = ring !== rg.outer && roundHole(ring) !== null;
      let ringUnits = 0, tight = 0, from = ring.start;
      for (const seg of ring.segments) {
        if (!seg.via && !seg.c1) ringUnits += 1;
        else if (seg.via) ringUnits += 2;
        else {
          const r = round ? Infinity : curveRadius(from, seg);
          if (r < ceiling) tight++;
          ringUnits += r >= ceiling ? 12 : r >= ceiling / 2 ? 40 : 100;
        }
        from = seg.to;
      }
      units += !round && tight && tight === ring.segments.length ? COST_UNITS : ringUnits;
    }
  }
  return units;
}

// ── one width ─────────────────────────────────────────────────────────────────
// A test at width w asks whether material narrower than w leaves the profile (an
// OPENING: shrink by w/2, regrow) or empty space narrower than w fills in (a CLOSING:
// grow by w/2, shrink back), and returns what left (or entered) it, or null.
//
// ONE-SIDED, never a net area change. With sharp offsets a rounded corner narrower
// than w does not come back as itself: a convex fillet on the outline regrows as a
// square corner OUTSIDE the profile, and a hole's rounded corner closes back square
// INSIDE the hole. Each lands on the side opposite the one being measured, so a net
// area change let an ordinary fillet elsewhere cancel a real narrow web or slot
// (capped, "nothing narrower found"). Counting only what left the profile (opening)
// or only what entered it (closing) puts every such artifact on the uncounted side.
// And a loss is ONE region above LOSS_TOL_MM2, never a sum: the cubic offset's own
// approximation error (OFFSET_TOL) leaves hundreds of sub-tolerance slivers along
// curved edges, and summed they read three 8 mm rounded holes as a 2.91 mm gap — the
// same rule marksFacts counts stray marks by.
//
// That difference is a boolean between the profile and its near-copy — on curves
// paper's worst case (64 booleaned holes: 1.8 s, 256: 28 s, then refused) — so a test
// that changed nothing skips it: most tests, every capped panel's. "Nothing" allows for
// the offset's approximation of curves, a systematic ~1e-4 mm² per cubic, measured
// (0.022 mm² over 64 booleaned holes): the band is LOSS_TOL_MM2 plus 1e-4 per curved
// segment. Only a real loss cancelled to within it by an artifact elsewhere could hide.
// When paper refuses the difference, the test falls back to the net area change it
// replaced, so the one-sided rule is never worse than it: the reading stays, the
// finding goes unlocated (UNLOCATED).
const NOISE_PER_CURVE_MM2 = 1e-4;
const UNLOCATED = Object.freeze({ unlocated: true });
// The geometry engine refuses with a plain Error ("contour-winding: could not chain…",
// "curve-fill: …"); a TypeError, RangeError or the like is a bug, never a refusal, and
// is left to propagate so reading() can report it.
const isRefusal = (e) => e instanceof Error && e.name === "Error";

function oneSided(difference, net, noise) {
  if (Math.abs(net) <= noise) return null;
  try {
    const d = difference();
    return !d.isEmpty() && d.regions().some((r) => r.area() > LOSS_TOL_MM2) ? d : null;
  } catch (e) {
    if (!isRefusal(e)) throw e;
    return net > noise ? UNLOCATED : null;
  }
}

function openingLoss(profile, area, w, noise) {
  let opened;
  try { opened = profile.offset(-w / 2, SHARP).offset(w / 2, SHARP); }
  catch (e) { if (COLLAPSES.test(e?.message ?? "")) return profile; throw e; }
  return oneSided(() => profile.cut(opened), area - opened.area(), noise);
}

function closingGain(profile, area, w, noise) {
  const closed = profile.offset(w / 2, SHARP).offset(-w / 2, SHARP);
  return oneSided(() => closed.cut(profile), closed.area() - area, noise);
}

// LOSS_TOL_MM2 plus the curve noise band for these rings.
const noiseOf = (contours) => LOSS_TOL_MM2 + NOISE_PER_CURVE_MM2 * contours
  .flatMap((rg) => [rg.outer, ...rg.holes])
  .reduce((n, ring) => n + (Array.isArray(ring) ? 0 : ring.segments.filter((seg) => seg.c1 || seg.via).length), 0);

// The narrowest width at which `test` finds something, bisected over [0, ceiling] to
// WIDTH_RESOLUTION: the upper end of the last bracket (the first width that fails),
// rounded to 0.01 mm. The ceiling is tried first — most panels have nothing that
// narrow, and one test settles them — and then reads as the ceiling itself, `capped`.
// The finding is located by the last shape actually found.
// An engine refusal at any width ends the reading: reading() records why and the value
// is null, so verify says the check could not be taken. Counting a refusal below a
// ceiling hit as "found there" read a refusal between a web's true width and the floor
// as a sub-floor web, a false warning placed at the real web; the width it came at
// rides along in the reason.
function narrowest(test, ceiling, spend) {
  spend();
  let found = test(ceiling);
  if (!found) return { value: ceiling, capped: true, at: null };
  let lo = 0, hi = ceiling;
  while (hi - lo > WIDTH_RESOLUTION) {
    spend();
    const mid = (lo + hi) / 2;
    let hit;
    try { hit = test(mid); } catch (e) {
      if (isRefusal(e)) throw new Error(`${e.message} (width search at ${fmtMm(mid)} mm)`);
      throw e;
    }
    if (hit) { hi = mid; if (hit !== UNLOCATED) found = hit; } else lo = mid;
  }
  return { value: round2(hi), capped: false, at: found === UNLOCATED ? null : centreOfLargest(found) };
}

// The narrowest opening. The closing treats every hole on its own (it fills what is
// narrower than w in each connected piece of empty space), so a round hole's narrowest
// opening is simply its diameter: round holes are read directly and filled, and the
// closing runs on the rest. That keeps a booleaned screw hole — four cubics, which the
// offset engine shrinks to a near-point and cannot cheaply regrow (4.5 s for one M2.5
// hole) — out of the bisection. The narrower of the two readings wins.
function narrowestGap(profile, area, contours, ceiling, spend) {
  const round = contours.flatMap((rg) => rg.holes.map((h) => ({ ring: h, hole: roundHole(h) })).filter((x) => x.hole));
  let rest = profile, restArea = area;
  if (round.length) {
    spend();
    try { rest = profile.union(round.map((x) => ({ outer: x.ring, holes: [] }))); restArea = rest.area(); }
    catch (e) { if (!isRefusal(e)) throw e; rest = profile; }    // unfilled: the closing reads them itself
  }
  const noise = noiseOf(rest === profile ? contours : rest.toContours());
  const gap = narrowest((w) => closingGain(rest, restArea, w, noise), ceiling, spend);
  const smallest = rest === profile ? null : round.map((x) => x.hole).reduce((a, b) => (b.d < a.d ? b : a));
  return smallest && smallest.d < ceiling && (gap.capped || smallest.d < gap.value)
    ? { value: round2(smallest.d), capped: false, at: smallest.at }
    : gap;
}

// One budget-gated reading, or null when it could not be taken — the geometry engine
// refused this profile (an offset it could not chain), or anything else threw — a
// missing reading, never a failed report. Never a silent one either: the reason lands in
// `errors[key]` (SheetFacts.readErrors), and verify reports it (oracle/verify.js).
// Running out of time is not caught here: it ends every gated reading at once (facts()).
const READ_ERROR_CHARS = 200;
function reading(errors, key, fn) {
  try {
    return fn();
  } catch (e) {
    if (e === OUT_OF_TIME) throw e;
    errors[key] = String(e?.message || e).slice(0, READ_ERROR_CHARS);
    return null;
  }
}

// Engrave ∪ score grooves, and how many regions of it lie outside the cut.
function marksFacts(s, spend) {
  const marks = [s.engrave, ...s.grooves].filter(Boolean).reduce((acc, m) => (acc ? acc.union(m) : m), null);
  if (!marks) return { marks: null, outside: 0, at: null };
  spend();
  const off = marks.cut(s.profile);
  const outside = off.isEmpty() ? 0 : off.regions().filter((r) => r.area() > LOSS_TOL_MM2).length;
  return { marks, outside, at: outside ? centreOfLargest(off) : null };
}

// ── verify metrics ─────────────────────────────────────────────────────────────
// SUBPART_METRICS-shaped (verify-metrics.js spreads SHEET_METRICS in). All warnings.
// `doc` names the guide section a failing check points at — oracle/verify.js turns
// it into the check's `pattern`; it is deliberately not `pattern`, which must name a
// docs/ERROR-PATTERNS.md entry. `budgeted` marks the readings the 2-D deadline can
// withhold, which verify reports as not evaluated rather than unavailable; `readError`
// returns why a reading could not be taken, which verify reports instead of a bare skip.
const cappedNote = (key) => (s) => (s.sheet?.[`${key}Capped`]
  ? `nothing narrower than ${fmtMm(s.sheet[key])} mm found — the value is the search ceiling`
  : null);

const METRICS = {
  sheetBridge: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.bridge : null),
    locate: (s) => s.sheet?.at?.bridge ?? null,
    readError: (s) => s.sheet?.readErrors?.bridge ?? null,
    note: cappedNote("bridge"),
    hint: "a web or finger of this sheet part is narrower than a laser can leave standing (the floor is half the sheet thickness, at least 0.5 mm) — widen the material between cuts at the reported location, or use fewer, wider fingers" },
  sheetGap: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.gap : null),
    locate: (s) => s.sheet?.at?.gap ?? null,
    readError: (s) => s.sheet?.readErrors?.gap ?? null,
    note: cappedNote("gap"),
    hint: "a hole, slot or notch in this sheet part is narrower than a laser can reliably cut (half the sheet thickness, at least 0.5 mm) — widen it at the reported location" },
  sheetMarks: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.marksOutside : null),
    locate: (s) => s.sheet?.at?.marks ?? null,
    readError: (s) => s.sheet?.readErrors?.marks ?? null,
    hint: "an engrave or score mark lies outside the cut outline, so it would burn scrap or empty air — move it inside the profile" },
  sheetPieces: { kind: "warn", doc: SHEET_DOC_ID,
    extract: (s) => s.sheet?.pieces ?? null,
    hint: "the profile is not exactly one piece — a sheet part must cut out as one region; join the pieces or split them into separate sheetPart sub-parts" },
  sheetSolidMatch: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => s.sheet?.solidMatchPct ?? null,
    readError: (s) => s.sheet?.readErrors?.marksArea ?? null,
    hint: "this sheet part's custom build drifts from its profile (volume vs. profile area × thickness) — the cut file comes from the profile, so fix the profile or drop the custom build" },
};

// ── lint ───────────────────────────────────────────────────────────────────────
// The laser's own rule; lint/rules-sheet.js appends every process's
// (PROCESS_LINT_RULES). Kernel-free, and a warning: the part still builds. A
// thickness that is not a finite number above 0 is sheet-thickness-invalid's error,
// not also this warning — one cause, one finding.
const LASER_RULES = [{
  id: "laser-thickness-range",
  run: ({ part, p, d, deriveError }) => {
    if (deriveError || !part?.parts || typeof part.parts !== "object") return [];
    const [lo, hi] = LASER_THICKNESS_RANGE;
    return Object.entries(part.parts).flatMap(([name, sp]) => {
      if (!isSheetPart(sp) || sp.sheet.process !== "laser" || typeof sp.build !== "function") return [];
      const meta = sheetMeta(sp, p, d);
      if (!meta || typeof meta.thickness !== "number" || !Number.isFinite(meta.thickness) || meta.thickness <= 0) return [];
      if (meta.thickness >= lo && meta.thickness <= hi) return [];
      return [warn("laser-thickness-range",
        `sub-part "${name}": laser sheet thickness ${fmtMm(meta.thickness)} mm is outside ${fmtMm(lo)}–${fmtMm(hi)} mm`,
        "Hobby lasers and cutting services handle roughly 0.5–12 mm stock; check that thickness is the measured value in mm (not inches or a stock code), or make this part another way.",
        `parts.${name}.sheet.thickness`, SHEET_DOC_ID)];
    });
  },
}];

export const LASER = {
  id: "laser",
  label: "Laser cutting",
  stock: "sheet",
  docId: SHEET_DOC_ID,
  // profile = the CUT layer (filled regions: outline plus holes), score = vector lines,
  // engrave = filled regions burned into the laser face.
  layers: { profile: "region", score: "line", engrave: "region" },
  // Keys only this process reserves (sheet/constants.js RESERVED_KEYS covers the
  // global ones: folds, bends, grain).
  reservedKeys: [],
  // No preview hook: the default extrusion-plus-marks build (sheet/resolve.js
  // sheetPreview) is the laser preview.
  preview: undefined,
  destinations: [{ id: "own-laser", cutFormat: "svg" }, { id: "service", cutFormat: "dxf" }],
  // The sheet's 2-D facts (SheetFacts). Budget-gated readings — bridge, gap, marks —
  // run only until `deadline` (an absolute time in ms on `now`'s clock, Date.now by
  // default); past it `evaluated` stays false and each is null. The rest
  // is cheap and always read. `at` and `solidMatchPct` need the 3-D part and are the
  // oracle's to fill (oracle/measure.js).
  facts(s, { deadline = Infinity, now = Date.now } = {}) {
    const { profile, thickness: t } = s;
    const contours = profile.toContours();
    const pieces = contours.length;
    const area = pieces ? profile.area() : 0;
    const bb = pieces ? profile.boundingBox() : null;
    const f = {
      process: s.process, material: s.material, thickness: t, group: s.group,
      flat: bb ? [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]] : [0, 0],
      area, pieces, customBuild: s.customBuild,
      marksArea: null, bridge: null, bridgeCapped: false, gap: null, gapCapped: false,
      marksOutside: null, solidMatchPct: null,
      at2d: { bridge: null, gap: null, marks: null },
      at: { bridge: null, gap: null, marks: null },
      readErrors: { bridge: null, gap: null, marks: null, marksArea: null },
      evaluated: false,
    };
    const spend = () => { if (now() >= deadline) throw OUT_OF_TIME; };
    const ceiling = 2 * widthFloor(t);
    if (Number.isFinite(deadline) && checkCost(contours, ceiling) > COST_UNITS) return f;
    try {
      const noise = noiseOf(contours);
      const errors = { bridge: null, gap: null, marks: null, marksArea: null };
      const bridge = reading(errors, "bridge", () => narrowest((w) => openingLoss(profile, area, w, noise), ceiling, spend));
      const gap = reading(errors, "gap", () => narrowestGap(profile, area, contours, ceiling, spend));
      const m = reading(errors, "marks", () => marksFacts(s, spend));
      // A custom build is compared with profile area × thickness minus the marks'
      // removed volume (oracle/measure.js), so it needs the marks inside the cut.
      const marksArea = !s.customBuild || m === null ? null
        : reading(errors, "marksArea", () => { spend(); return m.marks ? m.marks.intersect(profile).area() : 0; });
      Object.assign(f, {
        readErrors: errors,
        bridge: bridge?.value ?? null, bridgeCapped: bridge?.capped ?? false,
        gap: gap?.value ?? null, gapCapped: gap?.capped ?? false,
        marksOutside: m?.outside ?? null, marksArea,
        at2d: { bridge: bridge?.at ?? null, gap: gap?.at ?? null, marks: m?.at ?? null },
        evaluated: true,
      });
    } catch (e) {
      if (e !== OUT_OF_TIME) throw e;
    }
    return f;
  },
  // The process's own expectations, VOLUNTEERED by verify on every sheet and never
  // counted toward declared/evaluated (oracle/verify.js). Thresholds follow thickness.
  checks(f) {
    const floor = `>=${round3(widthFloor(f.thickness))}`;
    return {
      sheetBridge: floor, sheetGap: floor, sheetMarks: "0", sheetPieces: "1",
      ...(f.customBuild ? { sheetSolidMatch: `<=${SOLID_MATCH_PCT}` } : {}),
    };
  },
  metrics: METRICS,
  lintRules: LASER_RULES,
};
