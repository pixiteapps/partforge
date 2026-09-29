// The laser process's 2-D design-for-manufacture facts (process/laser/descriptor.js)
// and the oracle's use of them (oracle/measure.js). Every metric is read off a plate
// built to fire it. Widths are bisected to 0.05 mm, so an expected width is bracketed
// rather than pinned.
import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { bootManifoldKernel } from "../src/testing.js";
import { sheetPart, sheetHole, fingerBox, ringSectorProfile, slotProfile, roundedRectProfile, pieProfile } from "../src/framework/geometry/polygon.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { LASER, _meter } from "../src/framework/process/laser/descriptor.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { sheetToWorld } from "../src/framework/geometry/polygon.js";
import { lintPart } from "../src/lint.js";
import twelvePanel from "./fixtures/sheet-twelve-panel-part.js";
import perforated from "./fixtures/sheet-perforated-panel-part.js";
import screwPlate from "./fixtures/sheet-screw-plate-part.js";
import webPlate from "./fixtures/sheet-web-plate-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// An arc-exact rounded rectangle (quarter arcs as `via` segments, like sheetHole's).
const roundedRect = (x0, y0, x1, y1, r) => {
  const c = r * (1 - Math.SQRT1_2);
  return { start: [x0 + r, y0], segments: [
    { to: [x1 - r, y0] }, { to: [x1, y0 + r], via: [x1 - c, y0 + c] },
    { to: [x1, y1 - r] }, { to: [x1 - r, y1], via: [x1 - c, y1 - c] },
    { to: [x0 + r, y1] }, { to: [x0, y1 - r], via: [x0 + c, y1 - c] },
    { to: [x0, y0 + r] }, { to: [x0 + r, y0], via: [x0 + c, y0 + c] }] };
};
const PLATE = rect(0, 0, 60, 40);
// Two 10 mm square holes leaving a 0.8 mm web at x 20–20.8.
const WEB = { outer: PLATE, holes: [rect(10, 15, 20, 25), rect(20.8, 15, 30.8, 25)] };
// A 20 × 0.6 mm slot centred at (30, 20).
const SLOT = { outer: PLATE, holes: [rect(20, 19.7, 40, 20.3)] };
const P = { t: 3 };
// A 60 × 40 plate of 3 mm stock: floor 1.5 mm, search ceiling 3 mm.
const plate = (extra = {}) => sheetPart({
  views: ["v"], label: "Plate", material: "birch plywood", thickness: (p) => p.t,
  profile: (kk) => kk.shape2d(PLATE), ...extra,
});
const factsOf = (sp, opts) => LASER.facts(resolveSheet(k, sp, P, {}), opts);

describe("LASER.facts", () => {
  test("a plain plate: the always-read facts, and nothing narrower than the ceiling", () => {
    const f = factsOf(plate());
    expect(f).toMatchObject({
      process: "laser", material: "birch plywood", thickness: 3, group: "birch plywood|3.00",
      pieces: 1, customBuild: false, marksArea: null, marksOutside: 0,
      bridge: 3, bridgeCapped: true, gap: 3, gapCapped: true, solidMatchPct: null, evaluated: true,
      at2d: { bridge: null, gap: null, marks: null }, at: { bridge: null, gap: null, marks: null },
    });
    expect(f.flat[0]).toBeCloseTo(60, 6);
    expect(f.flat[1]).toBeCloseTo(40, 6);
    expect(f.area).toBeCloseTo(2400, 6);
  });

  test("a 0.8 mm web reads as a 0.8 mm bridge, located at the web", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(WEB) }));
    expect(f.bridgeCapped).toBe(false);
    expect(f.bridge).toBeGreaterThan(0.79);
    expect(f.bridge).toBeLessThanOrEqual(0.85);
    expect(f.at2d.bridge[0]).toBeCloseTo(20.4, 1);
    expect(f.at2d.bridge[1]).toBeCloseTo(20, 1);
    expect(f.gapCapped).toBe(true);          // the holes themselves are 10 mm across
  });

  test("a 0.6 mm slot reads as a 0.6 mm gap, located at the slot", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(SLOT) }));
    expect(f.gapCapped).toBe(false);
    expect(f.gap).toBeGreaterThan(0.59);
    expect(f.gap).toBeLessThanOrEqual(0.65);
    expect(f.at2d.gap[0]).toBeCloseTo(30, 1);
    expect(f.at2d.gap[1]).toBeCloseTo(20, 1);
    expect(f.bridgeCapped).toBe(true);
  });

  // Rounded corners elsewhere on the panel must not hide a real web or slot. With sharp
  // offsets a small convex fillet comes back as a square corner OUTSIDE the profile, and
  // a small hole-corner fillet comes back square INSIDE the hole — each the opposite sign
  // of what the test measures, so a net area change let the artifact cancel the finding.
  test("a filleted outline does not hide a 0.8 mm bridge elsewhere on the plate", () => {
    const holes = [rect(10, 15, 20, 25), rect(20.8, 24, 30.8, 34)];   // a 0.8 × 1 mm bridge at x 20–20.8, y 24–25
    for (const r of [1, 1.4]) {
      const f = factsOf(plate({ profile: (kk) => kk.shape2d(PLATE).fillet(r).cut(kk.shape2d(holes[0])).cut(kk.shape2d(holes[1])) }));
      expect(f.bridgeCapped, `outline fillet r=${r}`).toBe(false);
      expect(f.bridge).toBeGreaterThan(0.79);
      expect(f.bridge).toBeLessThanOrEqual(0.85);
      expect(f.at2d.bridge[0]).toBeCloseTo(20.4, 0);
      expect(f.at2d.bridge[1]).toBeCloseTo(24.5, 0);
    }
  });

  // …nor at a COINCIDENT dimension. A test that "changed nothing" used to skip its
  // one-sided difference, "nothing" read off the net area change — so a web whose loss the
  // outline's regrown square corners (4·r²·(1 − π/4)) cancelled to within a noise band hid
  // again. Every test runs its difference now. These heights are where the two cancel to
  // 0 ± 0.008 mm².
  test("a filleted outline does not hide a 0.8 mm bridge whose loss it cancels exactly", () => {
    for (const [r, h0] of [[1, 1.0719], [1.4, 2.1009]]) for (const h of [h0 - 0.004, h0, h0 + 0.004]) {
      const holes = [rect(10, 15, 20, 25), rect(20.8, 25 - h, 30.8, 35 - h)];     // a 0.8 × h bridge at x 20–20.8
      const f = factsOf(plate({ profile: (kk) => kk.shape2d(PLATE).fillet(r).cut(kk.shape2d(holes[0])).cut(kk.shape2d(holes[1])) }));
      expect(f.bridgeCapped, `r ${r}, h ${h.toFixed(4)}`).toBe(false);
      expect(f.bridge).toBeGreaterThan(0.79);
      expect(f.bridge).toBeLessThanOrEqual(0.85);
      expect(f.at2d.bridge[0]).toBeCloseTo(20.4, 0);
      expect(f.at2d.bridge[1]).toBeCloseTo(25 - h / 2, 0);
    }
  });

  // The artifact need not be a curve. A chamfer, or a fillet drawn as straight segments,
  // loses its short edges to a sharp shrink and regrows square exactly as an arc fillet
  // does. `cornered(s, segs)`: the plate with each corner cut by `segs` straight segments
  // along a quarter circle of radius s — one segment is a 45° chamfer of legs s.
  const cornered = (s, segs) => [[60, 0, -0.5], [60, 40, 0], [0, 40, 0.5], [0, 0, 1]].flatMap(([x, y, a0]) => {
    const c = [x + (x ? -s : s), y + (y ? -s : s)];
    return Array.from({ length: segs + 1 }, (_, i) => { const a = Math.PI * (a0 + i / (2 * segs)); return [c[0] + s * Math.cos(a), c[1] + s * Math.sin(a)]; });
  });
  test("a chamfered or polyline-rounded outline does not hide a 0.8 mm bridge whose loss it cancels exactly", () => {
    for (const [s, segs, h0] of [[0.5, 1, 0.625], [0.8, 1, 1.6], [1, 8, 1.09819], [1, 4, 1.17317], [1.4, 16, 2.11546]]) {
      for (const h of [h0 - 0.004, h0, h0 + 0.004]) {
        const holes = [rect(10, 15, 20, 25), rect(20.8, 25 - h, 30.8, 35 - h)];     // a 0.8 × h bridge at x 20–20.8
        const f = factsOf(plate({ profile: (kk) => kk.shape2d(cornered(s, segs)).cut(kk.shape2d(holes[0])).cut(kk.shape2d(holes[1])) }));
        expect(f.bridgeCapped, `corner ${s} × ${segs} segs, h ${h.toFixed(4)}`).toBe(false);
        expect(f.bridge).toBeGreaterThan(0.79);
        expect(f.bridge).toBeLessThanOrEqual(0.85);
        expect(f.at2d.bridge[0]).toBeCloseTo(20.4, 0);
        expect(f.at2d.bridge[1]).toBeCloseTo(25 - h / 2, 0);
      }
    }
  });

  // The closing's twin: a notch whose inner corners are rounded under half the width
  // closes back square — material LOST — and a small hole the closing fills can cancel
  // it. The hole lengths are where the two cancel to 0 ± 0.004 mm².
  test("a notch's rounded inner corners do not hide a small hole whose gain they cancel exactly", () => {
    const notch = (r) => {                                  // arc-exact, reaching past the top edge
      const c = r * (1 - Math.SQRT1_2), [x0, y0, x1, y1] = [40, 45, 60, 65];
      return { start: [x0 + r, y0], segments: [
        { to: [x1 - r, y0] }, { to: [x1, y0 + r], via: [x1 - c, y0 + c] }, { to: [x1, y1] },
        { to: [x0, y1] }, { to: [x0, y0 + r] }, { to: [x0 + r, y0], via: [x0 + c, y0 + c] }] };
    };
    for (const [r, L0, gap] of [[1.2, 0.686, 0.69], [1.4, 0.9338, 0.9]]) for (const L of [L0 - 0.004, L0, L0 + 0.004]) {
      const f = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 100, 60)).cut(kk.shape2d(notch(r))).cut(kk.shape2d(rect(70, 20, 70.9, 20 + L))) }));
      expect(f.gapCapped, `r ${r}, L ${L.toFixed(4)}`).toBe(false);
      expect(f.gap).toBeGreaterThan(gap - 0.06);
      expect(f.gap).toBeLessThanOrEqual(gap + 0.05);
      expect(f.at2d.gap[0]).toBeCloseTo(70.45, 0);
      expect(f.at2d.gap[1]).toBeCloseTo(20 + L / 2, 0);
    }
  });

  test("a notch's chamfered inner corners do not hide a small hole whose gain they cancel exactly", () => {
    const notch = (c) => [[40 + c, 45], [60 - c, 45], [60, 45 + c], [60, 65], [40, 65], [40, 45 + c]];   // reaching past the top edge
    for (const [c, L0] of [[0.6, 0.4], [0.8, 0.71111]]) for (const L of [L0 - 0.004, L0, L0 + 0.004]) {
      const f = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 100, 60)).cut(kk.shape2d(notch(c))).cut(kk.shape2d(rect(70, 20, 70.9, 20 + L))) }));
      expect(f.gapCapped, `chamfer ${c}, L ${L.toFixed(4)}`).toBe(false);
      expect(f.gap).toBeGreaterThan(L - 0.06);
      expect(f.gap).toBeLessThanOrEqual(L + 0.05);
      expect(f.at2d.gap[0]).toBeCloseTo(70.45, 0);
      expect(f.at2d.gap[1]).toBeCloseTo(20 + L / 2, 0);
    }
  });

  test("rounded-rect holes do not hide a 0.9 mm slot elsewhere on the plate", () => {
    const f = factsOf(plate({ profile: (kk) => {
      let s = kk.shape2d(rect(0, 0, 100, 60)).cut(kk.shape2d(rect(40, 30, 43, 30.9)));   // a 3 × 0.9 mm slot
      for (let i = 0; i < 2; i++) s = s.cut(kk.shape2d(roundedRect(5 + i * 11, 5, 13 + i * 11, 13, 1.4)));
      return s;
    } }));
    expect(f.gapCapped).toBe(false);
    expect(f.gap).toBeGreaterThan(0.89);
    expect(f.gap).toBeLessThanOrEqual(0.95);
    expect(f.at2d.gap[0]).toBeCloseTo(41.5, 0);
    expect(f.at2d.gap[1]).toBeCloseTo(30.45, 0);
  });

  // The offset engine approximates a cubic within OFFSET_TOL, leaving hundreds of
  // sub-tolerance slivers along filleted corners. Summed — by the net area change, or by
  // a one-sided difference's total — they crossed LOSS_TOL_MM2 and read three 8 mm
  // rounded holes as a 2.91 mm gap. A loss or gain is one region above the tolerance.
  test("approximation slivers along filleted holes are not a gap", () => {
    const f = factsOf(plate({ profile: (kk) => {
      let s = kk.shape2d(rect(0, 0, 100, 60));
      for (let i = 0; i < 3; i++) s = s.cut(kk.shape2d(rect(5 + i * 11, 5, 13 + i * 11, 13)).fillet(2.5));
      return s;
    } }));
    expect(f.gapCapped).toBe(true);          // the holes are 8 mm across; nothing narrower
  });

  // paper's boolean can refuse a difference the offsets produced ("curve-fill: resolved
  // hole has no containing outer"). There is no honest reading without it: falling back
  // to the net area change read "nothing narrower" wherever an artifact cancelled the
  // finding. The refusal ends the reading instead, and says why and at what width.
  test("a one-sided difference the engine refuses is a read error, never a net-area verdict", () => {
    const REFUSAL = "curve-fill: resolved hole has no containing outer";
    const refusing = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "cut") return () => { throw new Error(REFUSAL); };
      if (key === "offset") return (...a) => refusing(target.offset(...a));
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const s = resolveSheet(k, plate({ profile: (kk) => kk.shape2d(WEB) }), P, {});
    const f = LASER.facts({ ...s, profile: refusing(s.profile), trustedShape2d: (c) => refusing(s.trustedShape2d(c)) });
    expect(f).toMatchObject({ evaluated: true, bridge: null, bridgeCapped: false });
    expect(f.at2d.bridge).toBeNull();
    expect(f.readErrors.bridge).toBe(`${REFUSAL} (width search at 3 mm)`);
    // The closing changes nothing on these square holes, so it runs no difference to refuse.
    expect(f).toMatchObject({ gap: 3, gapCapped: true, readErrors: { gap: null } });
  });

  // A refusal INSIDE the width search is not a finding. Counted as one, a refusal between a
  // web's true width and the floor read as a sub-floor web — a false warning at the real
  // web's spot. The reading is withheld instead and says why (readErrors), exactly as a
  // refusal at the ceiling is.
  test("an engine refusal below a ceiling hit is a read error, not a narrower web", () => {
    const REFUSAL = "contour-winding: could not chain the offset arrangement";
    const refusingBelow = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "offset") return (delta, ...rest) => {
        if (Math.abs(delta) < 1.4) throw new Error(REFUSAL);          // every width under the 3 mm ceiling
        return refusingBelow(target.offset(delta, ...rest));
      };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const s = resolveSheet(k, plate({ profile: (kk) => kk.shape2d(WEB) }), P, {});
    const f = LASER.facts({ ...s, profile: refusingBelow(s.profile) });
    expect(f).toMatchObject({ evaluated: true, bridge: null, bridgeCapped: false });
    expect(f.at2d.bridge).toBeNull();
    expect(f.readErrors.bridge).toMatch(/could not chain/);
  });

  // The hole plan (which holes each width search leaves out) is reading work like the
  // searches it feeds: a failure in it costs the bridge and gap readings, with the reason,
  // never facts() — and so never measure()'s whole report. A ring the plan cannot walk
  // stands in for a bug in it.
  test("a failure planning the holes is a read error for the searches, not a lost report", () => {
    const s = resolveSheet(k, plate({ profile: (kk) => kk.shape2d(WEB) }), P, {});
    const broken = new Proxy(s.profile, { get(target, key) {
      if (key === "toContours") return () => target.toContours().map((rg, i) => (i ? rg : { ...rg, holes: [...rg.holes, { start: [1, 1], segments: [null] }] }));
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const f = LASER.facts({ ...s, profile: broken });
    expect(f).toMatchObject({ evaluated: true, bridge: null, gap: null, marksOutside: 0, pieces: 1 });
    expect(f.readErrors.bridge).toMatch(/null/);
    expect(f.readErrors.gap).toMatch(/null/);
  });

  // The one-sided difference is a boolean between the profile and a near-copy of it, and
  // paper's boolean on two curves that run a hair apart, split at other points, either
  // refuses or comes back empty. A keyhole — a round hole with a slot run out of it — is
  // the plainest case: its slot read no gap at all (a refusal), or read wider than it is
  // (the closing that filled it came back as an empty difference). The difference is taken
  // a margin clear of the searched shape, so it only meets curves where they really cross.
  test("a keyhole's slot reads its own width", () => {
    const keyhole = (d, sw) => (kk) => kk.shape2d(rect(0, 0, 100, 80)).cut(kk.shape2d(sheetHole({ d, at: [50, 40] })))
      .cut(kk.shape2d(rect(50 - sw / 2, 40, 50 + sw / 2, 55)));
    for (const [d, sw, t] of [[6, 1, 4], [6, 1.5, 4], [6, 4, 5], [6, 1.5, 3], [10, 2, 3], [10, 1, 5]]) {
      const f = LASER.facts(resolveSheet(k, plate({ profile: keyhole(d, sw) }), { t }, {}));
      const at = `d ${d}, slot ${sw}, ${t} mm`;
      expect(f.readErrors.gap, at).toBeNull();
      expect(f.gapCapped, at).toBe(false);
      expect(f.gap, at).toBeGreaterThan(sw - 0.01);
      expect(f.gap, at).toBeLessThanOrEqual(sw + 0.06);
      expect(f.at2d.gap[0], at).toBeCloseTo(50, 0);
    }
  });

  // A hole below the floor is the laser gap check's first job. Under the sharp closing a
  // small hole used to come back as a phantom (contour-offset.js), so the closing grew it
  // instead of filling it and every such hole read "nothing narrower than 3 mm".
  test("a hole below the floor reads as its own width — round, square, and round via cutAll", () => {
    const at = [30, 20];
    for (const profile of [
      (kk) => kk.shape2d({ outer: PLATE, holes: [sheetHole({ d: 1.2, at })] }),
      (kk) => kk.shape2d({ outer: PLATE, holes: [rect(29.4, 19.4, 30.6, 20.6)] }),
      (kk) => kk.shape2d(PLATE).cutAll([sheetHole({ d: 1.2, at })]),
    ]) {
      const f = factsOf(plate({ profile }));
      expect(f.gapCapped).toBe(false);
      expect(f.gap).toBeGreaterThan(1.15);
      expect(f.gap).toBeLessThanOrEqual(1.25);
      expect(f.at2d.gap[0]).toBeCloseTo(30, 0);
      expect(f.at2d.gap[1]).toBeCloseTo(20, 0);
    }
  });

  // A booleaned round hole is four cubics, and shrinking one to a near-point and regrowing
  // it is the offset engine's slowest case: one M2.5 clearance hole took 4.5 s, four took
  // 47 s. A round hole's narrowest opening is its diameter, and the closing treats each
  // hole on its own, so round holes are read directly and filled before the closing runs.
  test("booleaned screw holes read as their diameter, well inside the budget", () => {
    const holes = [10, 30, 50, 70].map((x) => sheetHole({ d: 2.7, at: [x, 20] }));
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 80, 40)).cutAll(holes) }), { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: true, gapCapped: false, gap: 2.7, bridgeCapped: true });
    expect(f.at2d.gap[0]).toBeCloseTo(10, 6);
    expect(f.at2d.gap[1]).toBeCloseTo(20, 6);
    const slot = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 80, 40)).cutAll([...holes, rect(20, 30, 40, 30.6)]) }),
      { deadline: 1500, now: () => 0 });
    expect(slot).toMatchObject({ evaluated: true, gapCapped: false });
    expect(slot.gap).toBeLessThanOrEqual(0.65);                       // the 0.6 mm slot is narrower than the holes
    expect(slot.at2d.gap[1]).toBeCloseTo(30.3, 0);
  });

  // paper hands every arc back from a boolean as cubics — a booleaned round hole as four, a
  // fillet as one — and the offset engine only approximates a cubic's offset: its slowest
  // case (a cubic a test shrinks to just past w/2 took seconds each, and ordinary mounting
  // plates took 4–73 s in one step) and the one-sided difference's (paper's boolean against
  // the near-copy, quadratic in its cubics), and a sharp join can only extend a cubic along
  // its end tangent. The width searches read every run of cubics that lies on one circle as
  // that circle's arcs — and only the searches: the area and the pieces are the profile's.
  // `shapesSearched` records, for every offset a search starts on its own shape (the
  // profile, or one rebuilt from its rings by the lift), the cubics that shape carries.
  const shapesSearched = (s) => {
    const cubics = [];
    const cubicsIn = (shape) => shape.toContours().flatMap((rg) => [rg.outer, ...rg.holes])
      .reduce((n, ring) => n + (Array.isArray(ring) ? 0 : ring.segments.filter((g) => g.c1).length), 0);
    const watched = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "offset") return (...a) => { cubics.push(cubicsIn(target)); return target.offset(...a); };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    return { sheet: { ...s, profile: watched(s.profile), trustedShape2d: (c) => watched(s.trustedShape2d(c)) }, cubics };
  };
  test("booleaned round holes and fillets are searched as their exact arcs; the area stays the profile's", () => {
    const s = resolveSheet(k, plate({ profile: (kk) => kk.shape2d(rect(0, 0, 100, 60)).fillet(3)
      .cutAll([[8, 8], [92, 8], [92, 52], [8, 52]].map((at) => sheetHole({ d: 3.4, at }))) }), P, {});
    const { sheet, cubics } = shapesSearched(s);
    const f = LASER.facts(sheet, { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true, pieces: 1 });
    expect(cubics.length).toBeGreaterThan(0);
    expect(Math.max(...cubics)).toBe(0);                  // every search ran on arcs
    expect(f.area).toBe(s.profile.area());                // the reported area is the profile's own
  });

  // #233's exact-curve profiles, booleaned the way an agent cuts them (and a few shapes
  // everyone cuts), where an arc meets a line or another arc at a real corner. Each read a
  // narrow web or gap that is not there — the 10 mm ring sector a 1.88 mm gap at every
  // stock, a thumb notch a 1.5 mm web — or could not be read, and a stadium slot on 6 mm
  // stock was priced out.
  test("booleaned arc profiles read what they are at every stock: no false web or gap", () => {
    const plate100 = (kk) => kk.shape2d(rect(0, 0, 100, 80));
    const round = (kk, r, at) => kk.shape2d(slotProfile(0, r)).translate(at);
    const cases = {
      "ring sector 10..20 × 90° hole": { profile: (kk) => plate100(kk).cut(kk.shape2d(ringSectorProfile(10, 20, 90)).translate([40, 25])) },
      "ring-sector panel 20..44 × 90° + d 8": { profile: (kk) => kk.shape2d(ringSectorProfile(20, 44, 90)).cutAll([sheetHole({ d: 8, at: [22.63, 22.63] })]) },
      "stadium slot 26 × 6": { profile: (kk) => plate100(kk).cut(kk.shape2d(slotProfile(20, 3)).translate([50, 40])), gap: 6 },
      "rounded-rect cutouts r 4 and r 1.5": { profile: (kk) => plate100(kk).cut(kk.shape2d(roundedRectProfile(30, 20, 4)).translate([25, 40]))
        .cut(kk.shape2d(roundedRectProfile(30, 20, 1.5)).translate([70, 40])) },
      "pie cutout 120°": { profile: (kk) => plate100(kk).cut(kk.shape2d(pieProfile(15, 120)).translate([50, 30])) },
      "thumb notch r 5": { profile: (kk) => plate100(kk).cut(round(kk, 5, [50, 80])) },
      "two overlapping d 10 holes": { profile: (kk) => plate100(kk).cut(round(kk, 5, [47, 40])).cut(round(kk, 5, [53, 40])) },
    };
    for (const [name, { profile, gap }] of Object.entries(cases)) for (const t of [3, 4, 6]) {
      const f = LASER.facts(resolveSheet(k, plate({ profile }), { t }, {}), { deadline: 1500, now: () => 0 });
      const at = `${name}, ${t} mm`;
      expect(f, at).toMatchObject({ evaluated: true, bridgeCapped: true, readErrors: { bridge: null, gap: null } });
      if (gap && gap < t) {
        expect(f.gapCapped, at).toBe(false);
        expect(f.gap, at).toBeGreaterThan(gap - 0.01);
        expect(f.gap, at).toBeLessThanOrEqual(gap + 0.05);
      } else expect(f.gap, at).toBeGreaterThanOrEqual(t - 0.05);       // capped, or a slot just the ceiling's width
    }
  });

  // …and a real web between an arc and a booleaned hole is read where it is: an M3 hole in
  // a 10..20 mm ring sector leaves 3.3 mm to each arc, which 4 and 6 mm stock can see.
  test("a web between an arc and a booleaned hole reads its width, at the web", () => {
    const panel = (kk) => kk.shape2d(ringSectorProfile(10, 20, 90)).cutAll([sheetHole({ d: 3.4, at: [10.6, 10.6] })]);
    for (const t of [4, 6]) {
      const f = LASER.facts(resolveSheet(k, plate({ profile: panel }), { t }, {}), { deadline: 1500, now: () => 0 });
      expect(f, `${t} mm`).toMatchObject({ evaluated: true, bridgeCapped: false, readErrors: { bridge: null } });
      expect(f.bridge).toBeGreaterThan(3.29);
      expect(f.bridge).toBeLessThanOrEqual(3.35);
      const r = Math.hypot(...f.at2d.bridge);
      expect(r < 13.4 || r > 16.6, `at radius ${r}`).toBe(true);        // on one of the two webs, not in the hole
      expect(f.gap).toBeCloseTo(3.4, 6);                                 // the hole, read directly
    }
  });

  // A test that finds nothing still runs its one-sided difference: a net area change
  // that reads "nothing changed" is exactly what an artifact elsewhere can fake. On a
  // cubic near-copy that difference is paper's worst case — 48 booleaned round holes took
  // about 14 s — and at a 10 mm pitch the 4 mm webs are inside an opening's reach, so the
  // opening keeps every hole (holePlan). Round holes are exact arcs to the searches now,
  // and those 48 are read in milliseconds; holes the arc fit leaves alone (ellipses: no
  // circle fits them) are still cubics, and their difference is priced like every step:
  // 80 of them, and the ceiling test runs, its difference does not fit, and the notice
  // stands in for it.
  test("48 booleaned round holes and nothing narrow are read: the arcs make every step cheap", () => {
    const holes = Array.from({ length: 48 }, (_, i) => sheetHole({ d: 6, at: [10 + (i % 16) * 10, 10 + Math.floor(i / 16) * 10] }));
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 200, 44)).cutAll(holes) }), { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
  });
  test("…and booleaned elliptical holes: the difference is still priced, and here withheld", () => {
    const holes = Array.from({ length: 80 }, (_, i) => (kk) => kk.shape2d(sheetHole({ d: 6, at: [0, 0] })).scale([1.2, 1])
      .translate([10 + (i % 20) * 12, 10 + Math.floor(i / 20) * 10]));
    const s = resolveSheet(k, plate({ profile: (kk) => kk.shape2d(rect(0, 0, 250, 50)).cutAll(holes.map((h) => h(kk))) }), P, {});
    let cuts = 0, offsets = 0;
    const counted = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "cut") return (...a) => { cuts++; return counted(target.cut(...a)); };
      if (key === "offset") return (...a) => { offsets++; return counted(target.offset(...a)); };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const f = LASER.facts({ ...s, profile: counted(s.profile), trustedShape2d: (c) => counted(s.trustedShape2d(c)) },
      { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: false, bridge: null, gap: null });
    expect(offsets).toBe(2);                              // the opening's ceiling test ran…
    expect(cuts).toBe(0);                                 // …and its difference was priced out, not skipped
  });

  // What no reading can bound is ONE test: the deadline is checked between them. A profile
  // whose single test would outrun the whole budget is not started under a deadline —
  // evaluated stays false (verify's notice) — and without one it is read in full. On a
  // stopped clock the budget never runs out, so `evaluated: false` is the gate's alone.
  test("a perforated panel too complex for the budget is not started", () => {
    const s = resolveSheet(k, perforated.parts.grille, P, {});
    expect(LASER.facts(s, { deadline: 1500, now: () => 0 })).toMatchObject({ evaluated: false, bridge: null, gap: null, pieces: 1 });
  });

  // Rounded-rect cutouts wider than the ceiling have nothing in them that closes, and
  // holes never meet in a closing, so the closing leaves them out. A comb whose notches
  // carry the same small rounded corners on the OUTLINE cannot be left out: every closing
  // inverts them. As cubics the offset engine subdivided each to its depth limit and the
  // comb was not started; as the exact arcs they are, it is read in milliseconds.
  const cutouts = (kk) => {
    let s = kk.shape2d(rect(0, 0, 100, 60));
    for (let i = 0; i < 8; i++) s = s.cut(kk.shape2d(rect(5 + i * 11, 5, 13 + i * 11, 13)).fillet(1.2));
    return s;
  };
  const comb = (kk) => {
    let s = kk.shape2d(rect(0, 0, 106, 30));
    for (let i = 0; i < 8; i++) s = s.cut(kk.shape2d(rect(8 + i * 12, 20, 14 + i * 12, 40)).fillet(1.2));
    return s;
  };
  test("a panel of small rounded-rect cutouts is read: the closing leaves them out", () => {
    const f = factsOf(plate({ profile: cutouts }), { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: true, gapCapped: true });
  });
  // Inverting is not the only slow case for a cubic: a closing that shrinks a cubic corner
  // to within a few w/2 of nothing subdivides it almost as deeply, superlinearly in how
  // many there are (32 r 2.5 corners closed at 3 mm: 1.8 s; 64: 29 s). An arc just shrinks.
  test("a comb whose rounded inner corners a closing shrinks near w/2 is read: they are arcs", () => {
    const shallow = (kk) => {
      let s = kk.shape2d(rect(0, 0, 234, 30));
      for (let i = 0; i < 16; i++) s = s.cut(kk.shape2d(rect(8 + i * 14, 18, 16 + i * 14, 40)).fillet(2.5));
      return s;
    };
    expect(factsOf(plate({ profile: shallow }), { deadline: 1500, now: () => 0 })).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
  });
  test("a comb of notches with small rounded inner corners is read, and a 0.6 mm slot beside it", () => {
    expect(factsOf(plate({ profile: comb }), { deadline: 1500, now: () => 0 })).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
    const f = factsOf(plate({ profile: (kk) => comb(kk).cut(kk.shape2d(rect(50, 5, 50.6, 12))) }), { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: true, gapCapped: false });
    expect(f.gap).toBeLessThanOrEqual(0.65);
    expect(f.at2d.gap[0]).toBeCloseTo(50.3, 0);
  });
  // Rounded tab corners, booleaned (a hole is cut after the fillet): as cubics an opening at
  // 3 mm (w/2 1.5) that shrank r 2.7 corners (1.8 × w/2) cost 176 ms for 12 of them and
  // 440 ms for 20, and r 2 tabs cost seconds and were not started. As arcs, r 2 and r 3
  // tabs alike are read in milliseconds. `offsets` counts the shrinks and regrows run.
  // These two run on a STOPPED clock, on which only the prices can withhold a reading: they
  // pin the prices, not what a real device reads. The third runs the meter on CPU time and
  // pins that — 12 tabs, the count a real desktop used to withhold even at r 3.
  const tabPanel = (n, r) => (kk) => {
    const pts = [[0, 0], [n * 20 + 10, 0], [n * 20 + 10, 30]];
    for (let i = n - 1; i >= 0; i--) pts.push([20 * i + 20, 30], [20 * i + 20, 40], [20 * i + 10, 40], [20 * i + 10, 30]);
    return kk.shape2d([...pts, [0, 30]]).fillet(r).cut(kk.shape2d(rect(5, 5, 15, 15)));
  };
  const offsetsRun = (sp, params = P) => {
    const s = resolveSheet(k, sp, params, {});
    let offsets = 0;
    const counted = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "offset") return (...a) => { offsets++; return counted(target.offset(...a)); };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const f = LASER.facts({ ...s, profile: counted(s.profile), trustedShape2d: (c) => counted(s.trustedShape2d(c)) }, { deadline: 1500, now: () => 0 });
    return { f, offsets };
  };
  test("rounded tabs whose corner radius matches the stock are read", () => {
    for (const n of [4, 6, 8]) {
      const { f } = offsetsRun(plate({ profile: tabPanel(n, 3) }));
      expect(f, `${n} tabs, r 3`).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
    }
  });
  test("…and so are tabs rounded well under it: their corners are exact arcs", () => {
    for (const n of [4, 6, 8, 12]) {
      const { f, offsets } = offsetsRun(plate({ profile: tabPanel(n, 2) }));
      expect(f, `${n} tabs, r 2`).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
      expect(offsets).toBeGreaterThan(0);
    }
  });
  test("…and 12 rounded tabs are read on a real clock, in under 100 ms of CPU", () => {
    for (const r of [2, 3]) {
      const { f, ms } = onCpu(plate({ profile: tabPanel(12, r) }), P);
      expect(f, `12 tabs, r ${r}`).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
      expect(ms, `12 tabs, r ${r}`).toBeLessThan(100);
    }
  });

  // Main-thread CPU time: a clock the machine's load cannot stretch. The budget tests below
  // run the meter on it, the way an unloaded desktop runs it — not on a stopped clock, on
  // which only the prices can withhold a reading and no step's real cost is ever seen.
  const cpuMs = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
  const onCpu = (sp, params) => {
    const s = resolveSheet(k, sp, params, {});
    const t0 = cpuMs();
    const f = LASER.facts(s, { deadline: cpuMs() + 1500, now: cpuMs });
    return { f, ms: cpuMs() - t0 };
  };
  // One priced step used to run 4–73 s inside the 1500 ms budget on ordinary rounded plates
  // with holes: the boolean handed their fillets back as cubics, a test that shrank a cubic
  // corner to just past w/2 took seconds per cubic, and it was priced like any other step
  // (a 100 × 60 × 3 plate, corners r 1.7, four M3 holes 8 mm in: 61.8 s for one inspect).
  // Read as the arcs they are, the whole reading takes milliseconds.
  const mount = (r, inset) => plate({ profile: (kk) => kk.shape2d(rect(0, 0, 100, 60)).fillet(r)
    .cutAll([[inset, inset], [100 - inset, inset], [100 - inset, 60 - inset], [inset, 60 - inset]].map((at) => sheetHole({ d: 3.4, at }))) });
  test("rounded mounting plates with M3 holes read in under 100 ms of CPU", () => {
    for (const [r, inset, t] of [[1.6, 5, 3], [1.6, 8, 3], [1.7, 5, 3], [1.7, 8, 3], [1.8, 5, 3], [1.8, 8, 3], [3.42, 10, 6]]) {
      const { f, ms } = onCpu(mount(r, inset), { t });
      const at = `${t} mm, r ${r}, holes ${inset} mm in`;
      expect(f, at).toMatchObject({ evaluated: true, bridgeCapped: true, readErrors: { bridge: null, gap: null } });
      expect(f.gap, at).toBeCloseTo(t > 3.4 ? 3.4 : t, 6);           // the M3 hole, read directly, where the ceiling allows
      expect(ms, at).toBeLessThan(100);
    }
  });
  // The same plate on 6 mm stock with r 3 corners and a 10 × 10 hole leaving a 5 mm web read
  // 4.31, located at the middle of the plain top edge 45 mm from the hole: its straight edges
  // came back from the cubic fillets' regrowth a hair inside the originals, one sliver over
  // the loss tolerance along 94 mm. On arcs, with the difference taken a margin clear of the
  // shape, it reads the web.
  test("a 5 mm web under a hole on a 6 mm plate with r 3 corners reads 5.02, at the web", () => {
    const { f, ms } = onCpu(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 100, 60)).fillet(3).cut(kk.shape2d(rect(45, 5, 55, 15))) }), { t: 6 });
    expect(f).toMatchObject({ evaluated: true, bridgeCapped: false, bridge: 5.02 });
    expect(f.at2d.bridge[0]).toBeCloseTo(50, 0);
    expect(f.at2d.bridge[1]).toBeCloseTo(2.5, 0);
    expect(ms).toBeLessThan(100);
  });

  // A corner the arc fit leaves alone — one that is not a circle — still meets the offset
  // engine's slowest case when a test shrinks it to just past w/2: four elliptical corners
  // whose tightest radius is 0.93–1.3 × w/2 took 0.3–2.4 s at 3 mm and 1.6–4.5 s at 6 mm in
  // ONE test priced 273 and 303, some ending in an engine refusal. No price follows it
  // there, so a test that would meet one is never started under a deadline: the notice
  // stands in. `offsets` counts the shrinks and regrows run: none.
  test("an elliptical corner a test would shrink to just past w/2 is never started", () => {
    for (const [t, q] of [[3, 0.95], [3, 1.1], [3, 1.3], [6, 1]]) {
      const sx = 1.3, r = q * (t / 2) * sx;
      const sp = plate({ profile: (kk) => kk.shape2d(rect(0, 0, 100 / sx, 60)).fillet(r).scale([sx, 1])
        .cutAll([[8, 8], [92, 8], [92, 52], [8, 52]].map((at) => sheetHole({ d: 3.4, at }))) });
      const { f, offsets } = offsetsRun(sp, { t });
      expect(f.evaluated, `${t} mm, rMin ${q} × w/2`).toBe(false);
      expect(offsets, `${t} mm, rMin ${q} × w/2`).toBe(0);
    }
  });

  // The reviewers' panel (test/fixtures/sheet-web-plate-part.js): thirty booleaned d 6
  // holes and one 1 mm web between two slots. Every test runs its one-sided difference,
  // and over the whole profile that was ONE boolean of 5.5 s against the holes' 3,840-cubic
  // near-copy. Every hole clears every other ring by more than 1.5 × the 3 mm ceiling, so
  // none can meet anything in an opening: the opening leaves them out, the closing reads
  // their diameters, and every step is priced under 100 ms.
  // `cuts` holds, for every boolean a search runs — on the profile, on a shape rebuilt
  // from its rings (the lift), or on what their offsets return — the cubics its two
  // operands carry between them.
  const cutsOn = (s) => {
    const cuts = [];
    const cubicsIn = (shape) => shape.toContours().flatMap((rg) => [rg.outer, ...rg.holes])
      .reduce((n, ring) => n + (Array.isArray(ring) ? 0 : ring.segments.filter((g) => g.c1).length), 0);
    const counted = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "cut") return (o) => { cuts.push(cubicsIn(target) + cubicsIn(o)); return target.cut(o); };
      if (key === "offset") return (...a) => counted(target.offset(...a));
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    return { sheet: { ...s, profile: counted(s.profile), trustedShape2d: (c) => counted(s.trustedShape2d(c)) }, cuts };
  };
  test("thirty booleaned holes and one narrow web: read in full, every step priced small", () => {
    const { sheet, cuts } = cutsOn(resolveSheet(k, webPlate.parts.plate, P, {}));
    const f = LASER.facts(sheet, { deadline: 100, now: () => 0 });
    expect(cuts.length).toBeGreaterThan(0);               // the tests that changed something ran their difference
    expect(cuts.length).toBeLessThan(14);                 // (2 searches × 7 widths: the rest handed back the same rings)…
    expect(Math.max(...cuts)).toBe(0);                    // …and none on a hole: all lines, both searches
    expect(f).toMatchObject({ evaluated: true, bridgeCapped: false, gapCapped: false });
    expect(f.gap).toBeGreaterThan(1.99);                  // the 2 mm slot, narrower than the 6 mm holes
    expect(f.gap).toBeLessThanOrEqual(2.05);
    expect(f.bridge).toBeGreaterThan(0.99);
    expect(f.bridge).toBeLessThanOrEqual(1.05);
    expect(f.at2d.bridge[0]).toBeCloseTo(159.5, 0);
    expect(f.at2d.bridge[1]).toBeCloseTo(50, 0);
  });

  // The same holes 3.5 mm from the edge (wider than the ceiling, so no finding, but inside
  // an opening's reach) cannot be left out. Their near-copy used to price the found web's
  // difference out; as exact arcs every boolean is small, and the web is read where it is.
  test("…and holes the opening cannot leave out: the web beside them is read, located", () => {
    const holes = Array.from({ length: 12 }, (_, i) => sheetHole({ d: 6, at: [10 + i * 12, 6.5] }));
    const edgeHoles = (kk) => kk.shape2d(rect(0, 0, 164, 60)).cutAll([...holes, rect(154, 45, 159, 55), rect(160, 45, 162, 55)]);
    const { sheet, cuts } = cutsOn(resolveSheet(k, plate({ profile: edgeHoles }), P, {}));
    const f = LASER.facts(sheet, { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: true, bridgeCapped: false, gapCapped: false });
    expect(f.bridge).toBeGreaterThan(0.99);
    expect(f.bridge).toBeLessThanOrEqual(1.05);
    expect(f.at2d.bridge[0]).toBeCloseTo(159.5, 0);
    expect(f.at2d.bridge[1]).toBeCloseTo(50, 0);
    expect(f.gap).toBeGreaterThan(1.99);                  // the 2 mm slot
    expect(f.gap).toBeLessThanOrEqual(2.05);
    expect(Math.max(...cuts)).toBe(0);                    // every boolean on arcs and lines
  });

  // A test that finds nothing on straight edges hands back the rings it was given, cut at
  // extra points where the miter joins meet the edges again. Ring for ring — collinear
  // runs merged, each ring matched cyclically in the same orientation, every vertex (and
  // every arc's centre, radius and ends) within 1e-9 mm of its twin — that is no loss, and
  // the priced difference is not run for it: the symmetric difference lies in a 1e-9 band
  // along the boundary, far under any region the difference could count. A finger panel
  // with nothing narrow runs four tests and no boolean.
  // `tests` lists every shrink-and-regrow run — its width, and whether a difference (a
  // boolean) followed it; the difference's margin shape is an offset too, by 0.01, and is
  // not a test. `cuts` counts the booleans.
  const booleansOn = (sp) => {
    const s = resolveSheet(k, sp, P, {});
    let cuts = 0, halves = 0;
    const tests = [];
    const counted = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "cut") return (...a) => { cuts++; if (tests.length) tests.at(-1).diff = true; return counted(target.cut(...a)); };
      if (key === "offset") return (d, ...a) => {
        if (Math.abs(d) > 0.02 && halves++ % 2 === 0) tests.push({ w: 2 * Math.abs(d), diff: false });
        return counted(target.offset(d, ...a));
      };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const f = LASER.facts({ ...s, profile: counted(s.profile), trustedShape2d: (c) => counted(s.trustedShape2d(c)) });
    return { f, cuts, tests };
  };
  test("a finger panel whose tests find nothing takes no difference", () => {
    const box = fingerBox({ width: 160, depth: 110, height: 80, thickness: 3, clearance: 0.1 });
    for (const panel of ["bottom", "front", "left"]) {
      const { f, cuts, tests } = booleansOn(plate({ profile: (kk) => kk.shape2d(box[panel].outline) }));
      expect(f, panel).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
      expect(tests, panel).toHaveLength(2);                // the two ceiling tests…
      expect(cuts, panel).toBe(0);                         // …and no boolean for either
    }
  });
  // Anything that is not the same rings falls through to the difference: a chamfered
  // corner whose short edge a test consumes regrows square, so every such test (the ceiling
  // among them) takes its difference — and the plate still reads the web the chamfer's
  // artifact used to hide. A test too narrow to consume the chamfer finds nothing and
  // hands back the same rings.
  test("…and a chamfered plate, whose corners regrow square, still takes the difference", () => {
    const holes = [rect(10, 15, 20, 25), rect(20.8, 25 - 0.625, 30.8, 35 - 0.625)];
    const { f, cuts, tests } = booleansOn(plate({ profile: (kk) => kk.shape2d(cornered(0.5, 1)).cut(kk.shape2d(holes[0])).cut(kk.shape2d(holes[1])) }));
    expect(f).toMatchObject({ evaluated: true, bridgeCapped: false });
    expect(f.bridge).toBeGreaterThan(0.79);
    expect(f.bridge).toBeLessThanOrEqual(0.85);
    expect(f.at2d.bridge[0]).toBeCloseTo(20.4, 0);
    const opening = tests.slice(0, tests.findIndex((tst, i) => i > 0 && tst.w === 3));   // the bridge search's tests
    expect(opening[0]).toMatchObject({ w: 3, diff: true });   // the ceiling: corners regrew square
    for (const tst of opening) if (tst.w > 1.5) expect(tst.diff, `opening at ${tst.w}`).toBe(true);
    expect(cuts).toBe(tests.filter((tst) => tst.diff).length);
  });

  // Prices are desktop milliseconds; the meter scales them by the pace this device has
  // actually run at, so a phone prices its own steps.
  test("the meter prices each step at the pace this device ran the ones before", () => {
    let t = 0;
    const clock = () => t;
    const desk = _meter(1500, clock);
    desk(100); t = 100;                                   // priced 100, took 100: pace 1
    expect(() => desk(1000)).not.toThrow();               // 100 + 1000 fits in 1500
    t = 0;
    const slow = _meter(1500, clock);
    slow(100); t = 300;                                   // priced 100, took 300: pace 3
    expect(() => slow(1000)).toThrow();                   // 300 + 3 × 1000 does not
    t = 0;
    const late = _meter(1500, clock);
    t = 1500;
    expect(() => late(0)).toThrow();                      // past the deadline nothing starts
    t = 0;
    expect(() => _meter(1e9, clock)(Infinity)).toThrow(); // a step no price follows is never started under a deadline…
    expect(() => _meter(Infinity, clock)(Infinity)).not.toThrow();   // …and runs for a caller who asked for no deadline
  });

  test("an arc-exact hole cut with cutAll reads clean — no false web or gap", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(PLATE).cutAll([sheetHole({ d: 10, at: [30, 20] })]) }));
    expect(f.bridgeCapped).toBe(true);
    expect(f.gapCapped).toBe(true);
  });

  test("marks outside the cut are counted and located", () => {
    const f = factsOf(plate({
      engrave: (kk) => kk.shape2d(rect(55, 5, 70, 15)),   // 10 × 10 of it hangs off the right edge
      score: () => [[[-10, 5], [-2, 5]]],                 // entirely off the plate
    }));
    expect(f.marksOutside).toBe(2);
    expect(f.at2d.marks[0]).toBeCloseTo(65, 1);           // the larger stray: the engrave's overhang
    expect(f.at2d.marks[1]).toBeCloseTo(10, 1);
  });

  test("marks inside the cut count zero and have no location", () => {
    const f = factsOf(plate({ engrave: (kk) => kk.shape2d(rect(10, 10, 20, 20)), score: () => [[[5, 30], [55, 30]]] }));
    expect(f.marksOutside).toBe(0);
    expect(f.at2d.marks).toBeNull();
  });

  test("a profile of two regions reads as two pieces", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 20, 20)).union(rect(30, 0, 50, 20)) }));
    expect(f.pieces).toBe(2);
  });

  test("a custom build gets marksArea: the marks inside the cut", () => {
    const sp = plate({ engrave: (kk) => kk.shape2d(rect(10, 10, 20, 20)) });
    const f = factsOf({ ...sp, build: (kk) => kk.box({ min: [0, 0, 0], max: [60, 40, 3] }) });
    expect(f.customBuild).toBe(true);
    expect(f.marksArea).toBeCloseTo(100, 6);
  });

  test("past the deadline the gated readings are withheld and the always-read ones stay", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(WEB) }), { deadline: Date.now() - 1 });
    expect(f).toMatchObject({ evaluated: false, bridge: null, gap: null, marksOutside: null, marksArea: null, pieces: 1 });
    expect(f.area).toBeCloseTo(2400 - 200, 6);
  });
});

describe("LASER.checks", () => {
  test("3 mm stock: the floor is half the thickness", () => {
    expect(LASER.checks(factsOf(plate()))).toEqual({ sheetBridge: ">=1.5", sheetGap: ">=1.5", sheetMarks: "0", sheetPieces: "1" });
  });

  test("thin stock floors at 0.5 mm; a custom build adds the solid match", () => {
    const f = { ...factsOf(plate()), thickness: 0.8, customBuild: true };
    expect(LASER.checks(f)).toEqual({ sheetBridge: ">=0.5", sheetGap: ">=0.5", sheetMarks: "0", sheetPieces: "1", sheetSolidMatch: "<=2" });
  });
});

const forge = (parts, extra = {}) => ({ meta: { title: "DFM", units: "mm" }, defaults: { t: 3 }, parts, views: { v: { label: "V" } }, ...extra });
const printed = (max, place) => ({ views: ["v"], label: "Printed", build: (kk) => kk.box({ min: [0, 0, 0], max }), ...(place ? { place } : {}) });
const row = (r, name) => r.subparts.find((s) => s.name === name);
// The 2-D budget on a stopped clock: it never runs out, so an assertion that needs the
// readings cannot flake on a slow runner, and the laser descriptor's prices still apply.
const STOPPED = { now: () => 0 };
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
// A rod printed standing up but displayed lying along X, on top of a 3 mm plate.
const rod = (h) => printed([10, 10, h], (s, { purpose }) =>
  (purpose === "export" ? s : s.rotate(90, [0, 0, 0], [0, 1, 0]).translate([0, 0, 13])));

describe("measure() on sheet parts", () => {
  test("a view with no sheet part: rows carry sheet: null and no printBbox", () => {
    const r = measure(k, forge({ block: printed([10, 10, 10]) }));
    expect(row(r, "block").sheet).toBeNull();
    expect("printBbox" in row(r, "block")).toBe(false);
  });

  test("a sheet row carries its facts; a printed row beside it gets its print-pose size for the bed", () => {
    const r = measure(k, forge({ plate: plate(), rod: rod(240) }, { verify: { process: "fdm-pla" } }), "v", {}, STOPPED);
    expect(row(r, "plate").sheet).toMatchObject({ process: "laser", thickness: 3, pieces: 1, evaluated: true });
    expect("printBbox" in row(r, "plate")).toBe(false);
    expect(row(r, "rod").sheet).toBeNull();
    expect(row(r, "rod").bbox[0]).toBeCloseTo(240, 3);       // displayed lying down
    expect(row(r, "rod").printBbox[2]).toBeCloseTo(240, 3);  // printed standing up
  });

  test("a finding's location is lifted into the assembly at mid-thickness", () => {
    const pose = { face: "-Y", up: "+Z", at: [0, 0, 0] };
    const f = row(measure(k, forge({ plate: plate({ profile: (kk) => kk.shape2d(WEB), pose }) }), "v", {}, STOPPED), "plate").sheet;
    expect(isVec3(f.at.bridge)).toBe(true);
    const want = sheetToWorld(pose, f.at2d.bridge, 1.5);
    f.at.bridge.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
    expect(f.at.gap).toBeNull();                               // capped: nothing to locate
  });

  test("a pose the probe cannot trust withholds the 3-D location, never the reading", () => {
    const sp = plate({ profile: (kk) => kk.shape2d(WEB), place: (s) => s.translate([0, 0, s.boundingBox().max[2]]) });
    const f = row(measure(k, forge({ plate: sp }), "v", {}, STOPPED), "plate").sheet;
    expect(f.bridgeCapped).toBe(false);
    expect(f.at2d.bridge).not.toBeNull();
    expect(f.at.bridge).toBeNull();
  });

  test("a custom build's volume is compared with profile area × thickness", () => {
    const sp = plate();
    const r = measure(k, forge({ plate: { ...sp, build: (kk) => kk.box({ min: [0, 0, 0], max: [60, 40, 6] }) } }), "v", {}, STOPPED);
    expect(row(r, "plate").sheet.solidMatchPct).toBeCloseTo(100, 3);   // 14400 mm³ against 7200
  });

  test("sheet rows skip the print passes: no min-wall rays, no overhang", () => {
    const part = forge({ plate: plate(), block: printed([10, 10, 10], (s) => s.translate([20, 20, 3])) },
      { verify: { process: "fdm-pla", orientation: "print" } });
    const r = measure(k, part, "v", {}, { minWall: true });
    expect(row(r, "plate")).toMatchObject({ minWall: null, minWallSamples: null, overhangArea: null });
    expect(row(r, "block").minWall).toBeGreaterThan(0);
    expect(row(r, "block").overhangArea).not.toBeNull();
  });

  test("past the 2-D budget every sheet reads evaluated: false and the report still comes back", () => {
    const r = measure(k, forge({ a: plate(), b: plate({ pose: { face: "+Z", up: "+Y", at: [100, 0, 3] } }) }),
      "v", {}, { sheetBudgetMs: 0 });
    for (const name of ["a", "b"]) expect(row(r, name).sheet).toMatchObject({ evaluated: false, bridge: null, pieces: 1 });
    expect(r.subparts).toHaveLength(2);
  });

  // The 2-D budget pays for 2-D work alone. It used to run on the wall clock from the
  // first sheet, so a printed row between two sheets (min-wall rays, a reference
  // deviation) spent it, and the second sheet read evaluated: false.
  test("a slow printed row between two sheets spends none of the 2-D budget", () => {
    let t = 0;
    const slow = new Proxy(k, { get: (target, key) => (key === "import"
      ? () => { t += 5000; return target.box({ min: [0, 0, 0], max: [10, 10, 10] }); }
      : Reflect.get(target, key)) });
    const heavy = { ...printed([10, 10, 10], (s) => s.translate([100, 0, 0])), reference: "ref" };
    const part = forge({ a: plate({ profile: (kk) => kk.shape2d(WEB) }), heavy,
      b: plate({ profile: (kk) => kk.shape2d(WEB), pose: { face: "+Z", up: "+Y", at: [0, 100, 3] } }) });
    const r = measure(slow, part, "v", {}, { now: () => t });
    expect(t).toBe(5000);
    expect(row(r, "heavy").deviation).not.toBeNull();
    for (const name of ["a", "b"]) expect(row(r, name).sheet, name).toMatchObject({ evaluated: true, bridgeCapped: false });
  });

  // Print (export) poses are built only for a bed that will read them, one printed part
  // at a time: a place() that throws for purpose "export" costs that part its print
  // size, never the whole report.
  test("export poses are built only when a process bed will read them", () => {
    let exports = 0;
    const counting = printed([10, 10, 10], (s, { purpose }) => { if (purpose === "export") exports++; return s.translate([100, 0, 0]); });
    const r = measure(k, forge({ plate: plate(), block: counting }), "v", {}, STOPPED);
    expect(exports).toBe(0);
    expect("printBbox" in row(r, "block")).toBe(false);
    const bed = forge({ plate: plate(), block: counting }, { verify: { process: "fdm-pla" } });
    expect(row(measure(k, bed, "v", {}, STOPPED), "block").printBbox).toEqual([10, 10, 10]);
    expect(exports).toBe(1);
    expect(row(measure(k, bed, "v", {}, { ...STOPPED, printBboxes: false }), "block")).not.toHaveProperty("printBbox");
    expect(exports).toBe(1);
  });

  test("a printed part whose export pose throws loses only its print size", () => {
    const part = forge({
      plate: plate(),
      block: printed([10, 10, 10], (s, { purpose }) => { if (purpose === "export") throw new Error("no export pose here"); return s.translate([100, 0, 0]); }),
      rod: rod(100),
    }, { verify: { process: "fdm-pla" } });
    const r = measure(k, part, "v", {}, STOPPED);
    expect(row(r, "block")).not.toHaveProperty("printBbox");
    expect(row(r, "block").printBboxError).toContain("no export pose here");
    expect(row(r, "rod").printBbox[2]).toBeCloseTo(100, 3);
    const v = verify(k, part, { measureFn: (kk, pt, vw, pr, o) => measure(kk, pt, vw, pr, { ...o, ...STOPPED }) });
    const bed = v.cases[0].checks.find((c) => c.subpart === "block" && c.metric === "bbox");
    expect(bed).toMatchObject({ status: "skip", pass: null, unevaluated: true, note: "measured in the print (export) pose" });
    expect(bed.message).toContain("no export pose here");
    expect(v.ok).toBeNull();
  });

  // Spec C.6: the 2-D checks are cheap, so a quick lap (no min-wall rays, no pair
  // distances — the inspect job's `checks: "quick"`) still reads them.
  test("a quick lap still reads the 2-D facts", () => {
    const r = measure(k, forge({ plate: plate({ profile: (kk) => kk.shape2d(WEB) }) }), "v", {}, { ...STOPPED, minWall: false, gaps: false });
    expect(row(r, "plate").sheet).toMatchObject({ evaluated: true, bridgeCapped: false });
    expect(row(r, "plate").sheet.bridge).toBeLessThanOrEqual(0.85);
  });
});

test("partforge measure prints a sheet line under a sheet sub-part", () => {
  const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "test/fixtures/sheet-plate-part.js", "--no-lint"], { encoding: "utf8" });
  expect(out).toContain("    sheet  birch plywood 3 mm, flat 120.0 × 80.0 mm, 1 piece\n");
});

test("the twelve-panel stress fixture: lint-clean, twelve sheet rows, no overlaps, all evaluated given time", () => {
  expect(lintPart(twelvePanel).errors).toEqual([]);
  const r = measure(k, twelvePanel, "kit", {}, STOPPED);
  const sheets = r.subparts.filter((s) => s.sheet);
  expect(sheets).toHaveLength(12);
  expect(sheets.every((s) => s.sheet.evaluated && s.sheet.pieces === 1)).toBe(true);
  expect(r.overlaps).toEqual([]);
}, 120_000);

test("the bench's plates: lint-clean; the screw plate and the web plate read in full, the grille is withheld at once", () => {
  for (const part of [screwPlate, perforated, webPlate]) expect(lintPart(part).errors).toEqual([]);
  const web = measure(k, webPlate, "panel", {}, STOPPED).subparts[0].sheet;
  expect(web).toMatchObject({ evaluated: true, pieces: 1, bridgeCapped: false });
  expect(web.bridge).toBeLessThanOrEqual(1.05);
  const plate = measure(k, screwPlate, "panel", {}, STOPPED).subparts[0].sheet;
  expect(plate).toMatchObject({ evaluated: true, pieces: 1, bridgeCapped: true, gapCapped: true });
  const grille = measure(k, perforated, "panel", {}, STOPPED).subparts[0].sheet;
  expect(grille).toMatchObject({ evaluated: false, pieces: 1 });
}, 60_000);
