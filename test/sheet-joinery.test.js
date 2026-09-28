// The joinery helpers: plain data in and out, mates that are exact complements, and
// errors that name the fix. The 3-D corner proof for fingerBox lives in
// sheet-corners.test.js; this file covers the helpers one by one.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { validateProfile, profileArea } from "../src/framework/geometry/contour-ops.js";
import {
  fingers, tabs, tSlots, sheetPanel, matchingSlots, printedTab, sheetHole, JOINERY_SCREWS,
} from "../src/framework/sheet/joinery.js";
import { poseSteps } from "../src/framework/sheet/pose.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const posed = (outline, pose, t, holes = []) => {
  const flat = k.shape2d(outline).cutAll(holes).extrude({ h: t });
  return pose ? poseSteps(pose, t).reduce(
    (s, st) => (st.t === "translate" ? s.translate(st.v) : s.rotate(st.deg, st.center, st.axis)), flat) : flat;
};

describe("joints are plain, JSON-safe data", () => {
  test("defaults", () => {
    expect(fingers({ thickness: 3 })).toEqual({ joint: "fingers", thickness: 3, clearance: 0.1, finger: 6, side: "outer" });
    expect(tabs({ thickness: 3 })).toEqual({ joint: "tabs", thickness: 3, count: 2, width: 9 });
    expect(tSlots({ thickness: 3 })).toEqual({ joint: "tslots", thickness: 3, screw: "M3", screwLength: 12, at: [0.5], clearance: 0.2 });
    const j = fingers({ thickness: 2.7, clearance: 0.15, finger: 8, side: "inner" });
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });

  test("the screw table (ISO 273 medium clearance holes; ISO 4032 nuts: across flats, height)", () => {
    expect(JOINERY_SCREWS).toEqual({
      "M2.5": { hole: 2.9, nut: { flats: 5.0, height: 2.0 } },
      "M3": { hole: 3.4, nut: { flats: 5.5, height: 2.4 } },
      "M4": { hole: 4.5, nut: { flats: 7.0, height: 3.2 } },
    });
    expect(Object.isFrozen(JOINERY_SCREWS)).toBe(true);
  });
});

describe("fingers mate as exact complements", () => {
  // Panel A: outer fingers on its bottom edge (a band BELOW its box, y ∈ [−t, 0]).
  // Panel B: inner fingers on its top edge (notches INSIDE its box), shifted so its
  // band lands on A's. Within the band, A's fingers and B's notches differ only by the
  // clearance: c/4 per side per interior cell boundary on each panel.
  const W = 100, t = 3;
  const band = rect(0, -t, W, 0);
  const fingersIn = (outline) => k.shape2d(outline).intersect(band);
  const notchesIn = (outline) => k.shape2d(band).cut(k.shape2d(outline));
  const xorArea = (a, b) => a.union(b).area() - a.intersect(b).area();

  test.each([0, 0.1, 0.25])("clearance %s: XOR area = c · thickness · (n − 1)/2", (c) => {
    const A = sheetPanel({ width: W, height: 40, edges: { bottom: fingers({ thickness: t, clearance: c }) } });
    const B = sheetPanel({ width: W, height: 30, edges: { top: fingers({ thickness: t, clearance: c, side: "inner" }) } });
    const bShifted = B.outline.map(([x, y]) => [x, y - 30]);
    const n = 15;                                     // largest odd ≤ 100 / 6
    expect(xorArea(fingersIn(A.outline), notchesIn(bShifted))).toBeCloseTo(c * t * (n - 1) / 2, 6);
    // …and A's fingers never overlap B's material
    expect(fingersIn(A.outline).intersect(k.shape2d(bShifted)).area()).toBeCloseTo(0, 9);
  });

  test("the pattern is symmetric: an edge reads the same from either end", () => {
    const { outline } = sheetPanel({ width: W, height: 40, edges: { bottom: fingers({ thickness: t, clearance: 0.2 }) } });
    const mirrored = outline.map(([x, y]) => [W - x, y]);
    expect(xorArea(k.shape2d(outline), k.shape2d(mirrored))).toBeCloseTo(0, 9);
  });

  test("n is the largest odd count of cells no narrower than `finger`", () => {
    const cells = (w, finger) => {
      const { outline } = sheetPanel({ width: w, height: 40, edges: { bottom: fingers({ thickness: 3, clearance: 0, finger }) } });
      return outline.filter(([, y]) => y === -3).length / 2;    // two points per finger
    };
    expect(cells(100, 6)).toBe(8);     // 15 cells → 8 fingers
    expect(cells(100, 10)).toBe(5);    // 10 cells → 9 → 5 fingers
    expect(cells(18, 6)).toBe(2);      // 3 cells (the minimum) → 2 fingers
  });
});

describe("sheetPanel", () => {
  test("a plain panel is its nominal box; size includes protrusions", () => {
    expect(sheetPanel({ width: 50, height: 20 })).toEqual({ outline: rect(0, 0, 50, 20), size: [50, 20] });
    const tabbed = sheetPanel({ width: 50, height: 20, edges: { bottom: tabs({ thickness: 3 }) } });
    expect(tabbed.size).toEqual([50, 23]);
  });

  test("positions along an edge are measured from its start in CCW order (asymmetric at)", () => {
    const W = 120, H = 80;
    const slot = tSlots({ thickness: 3, at: [0.25] });
    const shankX = (outline, yEdge) => {
      // the shank's two walls leave the edge line at x = centre ± hole/2
      const xs = outline.filter(([, y]) => y === yEdge).map(([x]) => x).filter((x) => x > 0 && x < W);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const bottom = sheetPanel({ width: W, height: H, edges: { bottom: slot } });
    const top = sheetPanel({ width: W, height: H, edges: { top: slot } });
    expect(shankX(bottom.outline, 0)).toBeCloseTo(0.25 * W, 9);   // bottom runs left → right
    expect(shankX(top.outline, H)).toBeCloseTo(0.75 * W, 9);      // top runs right → left
  });

  test("the T-slot is a shank crossed by a nut trap, sized from the screw table", () => {
    const { outline } = sheetPanel({ width: 60, height: 40, edges: { bottom: tSlots({ thickness: 3, clearance: 0.2 }) } });
    const ys = [...new Set(outline.map(([, y]) => y))].sort((a, b) => a - b);
    const reach = 12 - 3;
    expect(ys).toEqual([0, reach - 2.4 - 0.5 - 0.1, reach - 0.5 + 0.1, reach + 1, 40].map((v) => +v.toFixed(12)));
    const area = profileArea(outline);
    const trap = (5.5 + 0.2) * (2.4 + 0.2), shank = 3.4 * (reach + 1);
    expect(area).toBeCloseTo(60 * 40 - shank - trap + 3.4 * (2.4 + 0.2), 9);
  });

  // Seeded LCG: the fuzz is deterministic, so a failure reproduces.
  const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  test("fuzz: every outline is a valid CCW profile", () => {
    const rand = rng(7);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    let built = 0;
    for (let i = 0; i < 300; i++) {
      const t = 1.5 + rand() * 4.5;
      const joint = () => pick([
        undefined,
        fingers({ thickness: t, clearance: rand() * Math.min(0.3, t / 2), side: pick(["outer", "inner"]) }),
        tabs({ thickness: t, count: 1 + Math.floor(rand() * 3) }),
        tSlots({ thickness: t, at: [0.3 + rand() * 0.4], screwLength: 16 }),
      ]);
      const edges = { bottom: joint(), right: joint(), top: joint(), left: joint() };
      let panel;
      try {
        panel = sheetPanel({ width: 60 + rand() * 140, height: 60 + rand() * 140, edges });
      } catch (e) {
        // the only acceptable refusals are the ones that name the fix
        expect(e.message).toMatch(/do not fit|is too short|joints collide|does not fit/);
        continue;
      }
      built++;
      const report = validateProfile(panel.outline);
      expect(report.ok, JSON.stringify({ edges, issues: report.issues })).toBe(true);
      expect(profileArea(panel.outline)).toBeGreaterThan(0);                 // CCW
      expect(panel.outline.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    }
    expect(built).toBeGreaterThan(250);
  });

  test("joints that crowd each other are refused, never drawn crossed", () => {
    expect(() => sheetPanel({ width: 40, height: 12, edges: { bottom: tSlots({ thickness: 3 }), top: tSlots({ thickness: 3 }) } }))
      .toThrow("sheetPanel: the joints collide — the outline crosses itself near");
  });
});

describe("tabs key into matchingSlots", () => {
  // A 3 mm shelf A stands on a 3 mm base B; A's two tongues pass through B's slots.
  // line = A's MID-PLANE line drawn in B's frame, from the end matching A's edge start.
  const t = 3;
  const shelf = (c) => {
    const joint = tabs({ thickness: t, count: 2, width: 12 });
    const A = sheetPanel({ width: 80, height: 40, edges: { bottom: joint } });
    const slots = matchingSlots(joint, { line: [[10, 30], [90, 30]], clearance: c });
    return { A, slots };
  };
  const shelfPose = { face: "-Y", up: "+Z", at: [10, 30 - t / 2, t] };   // mid-plane at y = 30, standing on B's face

  test.each([0, 0.2])("clearance %s: the tongues pass through the slots without touching B", (c) => {
    const { A, slots } = shelf(c);
    expect(slots).toHaveLength(2);
    const a = posed(A.outline, shelfPose, t);
    const b = posed(rect(0, 0, 100, 60), null, t, slots);
    expect(a.intersect(b).volume()).toBeLessThan(1e-6);
    // B lost exactly two (12 + c) × (t + c) slots, and A's tongues fill them but for the play
    expect(100 * 60 * t - b.volume()).toBeCloseTo(2 * (12 + c) * (t + c) * t, 6);
    const slotPrisms = k.union(slots.map((r) => k.shape2d(r).extrude({ h: t })));
    expect(a.intersect(slotPrisms).volume()).toBeCloseTo(2 * 12 * t * t, 6);
  });

  test("tongue centres sit at (i + 0.5)/count along the line", () => {
    const { slots } = shelf(0.1);
    const centre = (r) => [r.reduce((s, p) => s + p[0], 0) / 4, r.reduce((s, p) => s + p[1], 0) / 4];
    expect(centre(slots[0])).toEqual([30, 30]);
    expect(centre(slots[1])).toEqual([70, 30]);
    for (const r of slots) expect(profileArea(r)).toBeGreaterThan(0);        // CCW
  });

  test("T-slots mate with arc-exact holes at the same fractions", () => {
    const joint = tSlots({ thickness: 3, screw: "M4", screwLength: 16, at: [0.25, 0.75] });
    const holes = matchingSlots(joint, { line: [[0, 10], [100, 10]] });
    expect(holes).toEqual([sheetHole({ d: 4.5, at: [25, 10] }), sheetHole({ d: 4.5, at: [75, 10] })]);
  });
});

describe("printedTab and sheetHole", () => {
  test("one spec gives the slot (all the play) and the printed tongue", () => {
    expect(printedTab({ size: [8, 3], thickness: 3 })).toEqual({
      slot: rect(-4.15, -1.65, 4.15, 1.65),
      tongue: [8, 3, 3],
    });
  });

  test("sheetHole is a CCW circle of two exact arcs", () => {
    const hole = sheetHole({ d: 6, at: [10, 5] });
    expect(hole).toEqual({ start: [13, 5], segments: [{ to: [7, 5], via: [10, 8] }, { to: [13, 5], via: [10, 2] }] });
    expect(profileArea(hole)).toBeGreaterThan(0);                            // CCW
    expect(Math.abs(profileArea(hole) / (Math.PI * 9) - 1)).toBeLessThan(1e-3);
  });
});

describe("errors name the fix", () => {
  test.each([
    [() => fingers({ thickness: 3, kerf: 0.1 }), "fingers: kerf is not a joinery option — joinery is drawn nominal and kerf is chosen when you download the kit"],
    [() => tabs({ thickness: 3, gap: 1 }), 'tabs: unknown option "gap" — the options are thickness, count, width'],
    [() => fingers({ thickness: -1 }), "fingers: thickness must be a number > 0 (mm), got -1"],
    [() => fingers({ thickness: 3, clearance: 3 }), "fingers: clearance must be a number from 0 to less than the thickness (mm), got 3"],
    [() => fingers({ thickness: 3, side: "left" }), 'fingers: side must be "outer" or "inner", got "left"'],
    [() => fingers({ thickness: 3, finger: 5 }), "fingers: finger must be at least 2 × thickness (6 mm), got 5"],
    [() => sheetPanel({ width: 15, height: 40, edges: { bottom: fingers({ thickness: 3 }) } }),
      "fingers: a 15.00 mm edge is too short — 3 fingers of at least 6.00 mm (2 × thickness) need 18.00 mm"],
    [() => sheetPanel({ width: 17, height: 40, edges: { bottom: tabs({ thickness: 3, count: 2 }) } }),
      "tabs: 2 tabs of 9 mm do not fit a 17.00 mm edge"],
    [() => tabs({ thickness: 3, count: 1.5 }), "tabs: count must be a whole number from 1 to 50, got 1.5"],
    [() => tSlots({ thickness: 3, screw: "M5" }), 'tSlots: screw must be one of M2.5, M3, M4, got "M5"'],
    [() => tSlots({ thickness: 3, at: [0, 0.5] }), "tSlots: at must be an array of fractions between 0 and 1, got [0,0.5]"],
    [() => tSlots({ thickness: 3, screwLength: 6 }),
      "tSlots: an M3 × 6 mm screw reaches 3.00 mm past a 3.00 mm panel — the nut trap needs at least 4.00 mm; use a longer screw"],
    [() => sheetPanel({ width: 10, height: 10, edges: { front: fingers({ thickness: 1 }) } }),
      'sheetPanel: unknown edge "front" — the edges are bottom, right, top, left'],
    [() => sheetPanel({ width: 10, height: 10, edges: { top: { joint: "dovetail" } } }),
      "sheetPanel: edges.top is not a joint — build it with fingers(), tabs() or tSlots()"],
    [() => matchingSlots(fingers({ thickness: 3 }), { line: [[0, 0], [1, 0]] }),
      'matchingSlots: fingers mate edge to edge and need no slots — give the other panel\'s edge fingers({ …, side: "inner" }) (or "outer")'],
    [() => matchingSlots(tabs({ thickness: 3 }), { line: [[0, 0]] }), "matchingSlots: line must be two finite [x, y] points"],
    [() => sheetHole({ d: 0, at: [0, 0] }), "sheetHole: d must be a number > 0 (mm), got 0"],
    [() => sheetHole({ d: 3, at: [0, "1"] }), "sheetHole: at must be a finite [x, y]"],
    [() => printedTab({ size: [8], thickness: 3 }), "printedTab: size must be two numbers > 0 (mm), got [8]"],
    [() => fingers(3), "fingers: expected an options object — fingers({ thickness, clearance, finger, side })"],
  ])("%#", (fn, message) => {
    expect(fn).toThrow(message);
  });
});
