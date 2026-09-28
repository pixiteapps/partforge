// Laser cutting — process module #1. A ProcessDescriptor is DATA: which layers a sheet
// part draws, which keys it reserves, which destinations the kit offers. Later phases
// add its lint rules, DFM metrics and 2-D checks here.
//
// Import-free apart from sheet/constants.js: lint and the oracle read the registry, so
// nothing reachable from here may touch a kernel, a Shape2D or paper
// (test/lint-purity.test.js, test/oracle-no-paper.test.js). The writers that draw this
// process's cut files live in process/laser/export.js, which only the kit loads.
import { widthFloor, WIDTH_RESOLUTION, LOSS_TOL_MM2, SOLID_MATCH_PCT, SHEET_DOC_ID, fmtMm } from "../../sheet/constants.js";

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

// An OPENING at width w: shrink by w/2, regrow by w/2. Material narrower than w — a
// web between holes, a thin finger — does not come back. Returns what was lost, or
// null when nothing measurable was.
function openingLoss(profile, area, w) {
  let opened;
  try { opened = profile.offset(-w / 2, SHARP).offset(w / 2, SHARP); }
  catch (e) { if (COLLAPSES.test(e?.message ?? "")) return profile; throw e; }
  return area - opened.area() > LOSS_TOL_MM2 ? profile.cut(opened) : null;
}

// A CLOSING at width w: grow by w/2, shrink back. A hole, slot or notch narrower than
// w fills in and stays filled. Returns what was gained, or null.
function closingGain(profile, area, w) {
  const closed = profile.offset(w / 2, SHARP).offset(-w / 2, SHARP);
  return closed.area() - area > LOSS_TOL_MM2 ? closed.cut(profile) : null;
}

// The narrowest width at which `test` finds something, bisected over [0, ceiling] to
// WIDTH_RESOLUTION: the upper end of the last bracket (the first width that fails),
// rounded to 0.01 mm. The ceiling is tried first — most panels have nothing that
// narrow, and one test settles them — and then reads as the ceiling itself, `capped`.
function narrowest(test, ceiling, spend) {
  spend();
  let found = test(ceiling);
  if (!found) return { value: ceiling, capped: true, at: null };
  let lo = 0, hi = ceiling;
  while (hi - lo > WIDTH_RESOLUTION) {
    spend();
    const mid = (lo + hi) / 2;
    const hit = test(mid);
    if (hit) { hi = mid; found = hit; } else lo = mid;
  }
  return { value: round2(hi), capped: false, at: centreOfLargest(found) };
}

// One budget-gated reading, or null when the geometry engine refused this profile (an
// offset it could not chain) — a missing reading, never a failed report. Running out
// of time is not caught here: it ends every gated reading at once (facts()).
function reading(fn) {
  try { return fn(); } catch (e) { if (e === OUT_OF_TIME) throw e; return null; }
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
// withhold, which verify reports as not evaluated rather than unavailable.
const cappedNote = (key) => (s) => (s.sheet?.[`${key}Capped`]
  ? `nothing narrower than ${fmtMm(s.sheet[key])} mm found — the value is the search ceiling`
  : null);

const METRICS = {
  sheetBridge: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.bridge : null),
    locate: (s) => s.sheet?.at?.bridge ?? null,
    note: cappedNote("bridge"),
    hint: "a web or finger of this sheet part is narrower than a laser can leave standing (the floor is half the sheet thickness, at least 0.5 mm) — widen the material between cuts at the reported location, or use fewer, wider fingers" },
  sheetGap: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.gap : null),
    locate: (s) => s.sheet?.at?.gap ?? null,
    note: cappedNote("gap"),
    hint: "a hole, slot or notch in this sheet part is narrower than a laser can reliably cut (half the sheet thickness, at least 0.5 mm) — widen it at the reported location" },
  sheetMarks: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.marksOutside : null),
    locate: (s) => s.sheet?.at?.marks ?? null,
    hint: "an engrave or score mark lies outside the cut outline, so it would burn scrap or empty air — move it inside the profile" },
  sheetPieces: { kind: "warn", doc: SHEET_DOC_ID,
    extract: (s) => s.sheet?.pieces ?? null,
    hint: "the profile is not exactly one piece — a sheet part must cut out as one region; join the pieces or split them into separate sheetPart sub-parts" },
  sheetSolidMatch: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => s.sheet?.solidMatchPct ?? null,
    hint: "this sheet part's custom build drifts from its profile (volume vs. profile area × thickness) — the cut file comes from the profile, so fix the profile or drop the custom build" },
};

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
  // run only until `deadline` (an absolute Date.now() in ms, shared by every sheet in
  // one measure() call); past it `evaluated` stays false and each is null. The rest
  // is cheap and always read. `at` and `solidMatchPct` need the 3-D part and are the
  // oracle's to fill (oracle/measure.js).
  facts(s, { deadline = Infinity } = {}) {
    const { profile, thickness: t } = s;
    const pieces = profile.toContours().length;
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
      evaluated: false,
    };
    const spend = () => { if (Date.now() >= deadline) throw OUT_OF_TIME; };
    const ceiling = 2 * widthFloor(t);
    try {
      const bridge = reading(() => narrowest((w) => openingLoss(profile, area, w), ceiling, spend));
      const gap = reading(() => narrowest((w) => closingGain(profile, area, w), ceiling, spend));
      const m = reading(() => marksFacts(s, spend));
      // A custom build is compared with profile area × thickness minus the marks'
      // removed volume (oracle/measure.js), so it needs the marks inside the cut.
      const marksArea = !s.customBuild || m === null ? null
        : reading(() => { spend(); return m.marks ? m.marks.intersect(profile).area() : 0; });
      Object.assign(f, {
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
};
