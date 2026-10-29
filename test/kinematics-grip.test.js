import { describe, it, expect } from "vitest";
import { resolveFrames } from "../src/framework/geometry/xform.js";
import { SpecError } from "../src/framework/geometry/errors.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { distanceFor } from "../src/framework/domains/kinematics/shapes.js";
import { cpuMs } from "./helpers/cpu-pace.js";

const ROD = { kind: "cylinder", r: 12, h: 120, at: [0, 60, -25], axis: "x" };
const FRONT_ROD = { kind: "cylinder", r: 8, h: 40, at: [-30, 130, -22], axis: "x" };
const PALM = { palm: {} };
// The fixture hand's index finger, as literals.
const INDEX_AT = [-30, 96, 2];
const INDEX_LEN = [42, 25, 22];
const INDEX_R = [9.5, 8.5, 7.4, 6.4];

/** `around` two ways: the shape node itself, or a distance function made from it. */
const MODES = {
  node: (node) => node,
  function: (node) => { const d = distanceFor(node); return (x, y, z) => d(x, y, z); },
};

/** The minimum of distance − r − clearance over a posed limb, at `samples` points per segment. */
function contactMin(posed, frames, around, r, clearance, samples = 200) {
  const W = resolveFrames({ ...frames, ...posed.frames });
  const names = [...posed.joints, posed.tip];
  const d = distanceFor(around);
  let m = Infinity;
  for (let k = 0; k + 1 < names.length; k++) {
    const A = W.get(names[k]).world, B = W.get(names[k + 1]).world;
    for (let s = 0; s < samples; s++) {
      const t = s / (samples - 1);
      const p = [0, 1, 2].map((i) => A[9 + i] + (B[9 + i] - A[9 + i]) * t);
      m = Math.min(m, d(...p) - (r[k] + (r[k + 1] - r[k]) * t) - clearance);
    }
  }
  return m;
}

/** The fixture's index finger at curl 0, as the old four-finger tests built it (wide ranges). */
const wideIndex = () => limb("index", {
  parent: "palm", at: INDEX_AT, rotate: [{ axis: "z", deg: 8 }],
  joints: ["mcp", "pip", "dip"].map((n) => ({ name: n, range: [-180, 180] })),
  lengths: INDEX_LEN,
});

/** A plain index finger aimed with toward/bendToward (mirrorable). */
const index = (extra = {}) => limb("index", {
  parent: "palm", at: INDEX_AT, toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
  lengths: INDEX_LEN, r: INDEX_R, ...extra,
});

for (const [mode, as] of Object.entries(MODES)) {
  describe(`grip (around as a ${mode})`, () => {
    for (const clearance of [0, 1.5, -1]) {
      it(`the index finger closes on a rod (clearance ${clearance})`, () => {
        const L = wideIndex();
        const posed = L.pose({ curl: 0, grip: { around: as(ROD), clearance, r: INDEX_R } }, PALM);
        expect(posed.report.grip.joints.map((j) => j.joint)).toEqual(["mcp", "pip", "dip"]);
        for (const j of posed.report.grip.joints) expect(j.touched, j.joint).toBe(true);
        expect(posed.report.grip.touching).toBe(true);
        const m = contactMin(posed, PALM, ROD, INDEX_R, clearance);
        expect(Math.abs(posed.report.grip.gap - m)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(m), `min ${m}`).toBeLessThanOrEqual(0.05);
      });
    }

    it("a press (clearance −1) sinks 1 mm into the rod", () => {
      const posed = wideIndex().pose({ curl: 0, grip: { around: as(ROD), clearance: -1, r: INDEX_R } }, PALM);
      expect(Math.abs(contactMin(posed, PALM, ROD, INDEX_R, 0) + 1)).toBeLessThanOrEqual(0.05);
    });

    it("a missed rod reports touched: false on every joint, each at its range end", () => {
      const far = { ...ROD, at: [0, 300, -25] };
      const posed = wideIndex().pose({ curl: 0, grip: { around: as(far), r: INDEX_R } }, PALM);
      expect(posed.report.grip.joints).toEqual([
        { joint: "mcp", bend: 180, touched: false, skipped: false },
        { joint: "pip", bend: 180, touched: false, skipped: false },
        { joint: "dip", bend: 180, touched: false, skipped: false },
      ]);
      expect(posed.values).toEqual([180, 180, 180]);
    });

    it("a shape already overlapping the limb touches at the start values", () => {
      const L = index();
      const start = L.pose({ bend: { mcp: 10, pip: 20 } }, PALM);
      const W = resolveFrames({ ...PALM, ...start.frames });
      const a = W.get("index.mcp").world, b = W.get("index.pip").world;
      const mid = [0, 1, 2].map((i) => (a[9 + i] + b[9 + i]) / 2);
      const rod = { kind: "cylinder", r: 3, h: 60, at: mid, axis: "x" };
      const posed = L.pose({ bend: { mcp: 10, pip: 20 }, grip: { around: as(rod) } }, PALM);
      expect(posed.values).toEqual(start.values);
      expect(posed.report.grip.joints).toEqual([
        { joint: "mcp", bend: 10, touched: true, skipped: false },
        { joint: "pip", bend: 20, touched: false, skipped: true },
      ]);
      for (const { world } of resolveFrames({ ...PALM, ...posed.frames }).values()) for (const v of world) expect(Number.isFinite(v)).toBe(true);
    });

    it("closes on a rod in front of the knuckle, carrying followers", () => {
      const posed = index().pose({ grip: { around: as(FRONT_ROD) } }, PALM);
      expect(posed.report.grip.joints.every((j) => j.touched)).toBe(true);
      expect(posed.values[2]).toBe(Math.min(80, 0.75 * posed.values[1]) + 0);
      expect(Math.abs(contactMin(posed, PALM, FRONT_ROD, INDEX_R, 0))).toBeLessThanOrEqual(0.05);
    });

    it("stops once the tip segment touches: later joints keep their start values", () => {
      // Only the distal segment reaches the rod's radius from the base, so mcp's close
      // ends on the tip segment and pip/dip are never moved.
      const L = limb("f", {
        toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["mcp", "pip", "dip"], lengths: INDEX_LEN, r: [5, 5, 5, 5],
      });
      const rod = { kind: "cylinder", r: 5, h: 20, at: [0, 80, -25], axis: "x" };
      const posed = L.pose({ bend: [0, 3, 4], grip: { around: as(rod) } });
      // Only mcp closed and made contact; pip and dip were skipped, not touched (review #318 finding 4).
      expect(posed.report.grip.joints.map(({ touched, skipped }) => ({ touched, skipped }))).toEqual([
        { touched: true, skipped: false },
        { touched: false, skipped: true },
        { touched: false, skipped: true },
      ]);
      expect(posed.report.grip.touching).toBe(true);
      expect(posed.values[0]).toBeGreaterThan(0);
      expect(posed.values.slice(1)).toEqual([3, 4]);
    });

    describe("verdicts on the final pose (review fix 1)", () => {
      // An index finger at the origin, pip started at 80. mcp touches the rod during its own
      // close, then pip (at 80, closing on to 110) swings the limb beyond mcp off it.
      const L = limb("index", {
        toward: [0, 1, 0], bendToward: [0, 0, -1],
        joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
        lengths: INDEX_LEN, r: INDEX_R,
      });
      const rodAt = (z) => ({ kind: "cylinder", r: 2, h: 400, at: [0, 35, z], axis: "x" });

      it("a joint whose contact a later joint swung away reads touched: false", () => {
        const rod = rodAt(-50);
        const posed = L.pose({ bend: { pip: 80 }, grip: { around: as(rod) } });
        const m = contactMin(posed, {}, rod, INDEX_R, 0);
        expect(m).toBeGreaterThan(5);
        expect(posed.report.grip.touching).toBe(false);
        expect(posed.report.grip.joints.map((j) => j.touched)).toEqual([false, false]);
        expect(Math.abs(posed.report.grip.gap - m)).toBeLessThanOrEqual(0.05);
      });

      it("never reports a touched joint when the limb is not touching (small sweep)", () => {
        for (let z = -46; z >= -54; z -= 0.5) {
          const rod = rodAt(z);
          const posed = L.pose({ bend: { pip: 80 }, grip: { around: as(rod) } });
          const m = contactMin(posed, {}, rod, INDEX_R, 0);
          expect(Math.abs(posed.report.grip.gap - m), `z ${z}`).toBeLessThanOrEqual(0.05);
          if (!posed.report.grip.touching) expect(posed.report.grip.joints.some((j) => j.touched), `z ${z}`).toBe(false);
        }
      });

      for (const clearance of [0, 1.5]) {
        it(`realistic ranges on the rod give the honest partial report (clearance ${clearance})`, () => {
          // mcp alone (pip, dip straight) never reaches a rod 36 mm behind the knuckle; pip does.
          const F = limb("index", {
            parent: "palm", at: INDEX_AT, toward: [0, 1, 0], bendToward: [0, 0, -1],
            joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
            lengths: INDEX_LEN,
          });
          const posed = F.pose({ grip: { around: as(ROD), clearance, r: INDEX_R } }, PALM);
          const [mcp, pip] = posed.report.grip.joints;
          expect(mcp).toEqual({ joint: "mcp", bend: 90, touched: false, skipped: false });
          expect(pip.joint).toBe("pip");
          expect(pip.touched).toBe(true);
          expect(posed.report.grip.touching).toBe(true);
          const m = contactMin(posed, PALM, ROD, INDEX_R, clearance);
          expect(Math.abs(m)).toBeLessThanOrEqual(0.05);
          expect(Math.abs(posed.report.grip.gap - m)).toBeLessThanOrEqual(0.05);
        });
      }
    });

    it("keeps clamped for a requested value grip does not drive (review fix 3)", () => {
      const L = limb("index", {
        toward: [0, 1, 0], bendToward: [0, 0, -1],
        joints: [{ name: "spr", axis: "spread", length: 0, range: [-20, 20] }, { name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }],
        lengths: [0, 42, 25], r: [9.5, 9.5, 8.5, 7.4],
      });
      const posed = L.pose({ bend: { spr: 30 }, grip: { around: as(FRONT_ROD) } });
      expect(posed.values[0]).toBe(20);
      expect(posed.report.clamped[0]).toBe(true);
    });

    it("keeps clamped for an out-of-range start value on a driven bend joint (review #318 finding 3)", () => {
      const farRod = { ...FRONT_ROD, at: [-30, 400, -22] };
      const plain = index().pose({ bend: { mcp: 150 } }, PALM);
      expect(plain.report.clamped[0]).toBe(true);
      const posed = index().pose({ bend: { mcp: 150 }, grip: { around: as(farRod) } }, PALM);
      expect(posed.report.grip.touching).toBe(false);
      expect(posed.report.clamped[0]).toBe(true);
      expect(posed.report.clamped[1]).toBe(false); // pip started in range (dip may clamp following it)
    });

    it("a thin shape between two coarse scan steps is still found (review #318 finding 5)", () => {
      // One 89 mm joint with zero radius: a 48-step scan of [0, 100]° moves the tip ~3.2 mm a
      // step, over a 1.5 mm sphere at 51°. The scan count now follows the tip's travel.
      const L = limb("thin", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "j", range: [0, 100] }], lengths: [89], r: [0, 0] });
      const a = (51 * Math.PI) / 180;
      const ball = { kind: "sphere", r: 1.5, at: [0, 89 * Math.cos(a), -89 * Math.sin(a)] };
      const posed = L.pose({ grip: { around: as(ball) } });
      expect(posed.report.grip.touching).toBe(true);
      expect(posed.report.grip.joints).toEqual([{ joint: "j", bend: posed.report.grip.joints[0].bend, touched: true, skipped: false }]);
      expect(posed.values[0]).toBeGreaterThan(48);
      expect(posed.values[0]).toBeLessThan(51);
    });

    it("a mirrored finger on the mirrored rod touches at the mirrored tip", () => {
      const a = index().pose({ grip: { around: as(FRONT_ROD) } }, PALM);
      const mirrorRod = { ...FRONT_ROD, at: [-FRONT_ROD.at[0], FRONT_ROD.at[1], FRONT_ROD.at[2]] };
      const b = index({ mirror: "YZ" }).pose({ grip: { around: as(mirrorRod) } }, PALM);
      expect(b.report.grip.joints.every((j) => j.touched)).toBe(true);
      const ta = resolveFrames({ ...PALM, ...a.frames }).get(a.tip).world;
      const tb = resolveFrames({ ...PALM, ...b.frames }).get(b.tip).world;
      expect(Math.abs(tb[9] + ta[9])).toBeLessThanOrEqual(0.01);
      expect(Math.abs(tb[10] - ta[10])).toBeLessThanOrEqual(0.01);
      expect(Math.abs(tb[11] - ta[11])).toBeLessThanOrEqual(0.01);
    });

    it("is deterministic", () => {
      const run = () => { const p = index().pose({ grip: { around: as(FRONT_ROD) } }, PALM); return JSON.stringify([p.frames, p.report]); };
      expect(run()).toBe(run());
    });

    it("one 3-joint grip costs at most 15 ms of cpuMs", () => {
      const L = wideIndex();
      const around = as(ROD);
      for (let i = 0; i < 5; i++) L.pose({ curl: 0, grip: { around, r: INDEX_R } }, PALM);  // warm up
      const times = [];
      for (let i = 0; i < 5; i++) {
        const t0 = cpuMs();
        L.pose({ curl: 0, grip: { around, r: INDEX_R } }, PALM);
        times.push(cpuMs() - t0);
      }
      times.sort((x, y) => x - y);
      expect(times[2]).toBeLessThanOrEqual(15);
    });

    it("asymmetric ranges: grip on the bendToward side closes with positive bends", () => {
      const L = limb("a", {
        toward: [0, 1, 0], bendToward: [0, 0, -1],
        joints: [{ name: "m", range: [-90, 80] }, { name: "p", range: [-90, 80] }, { name: "d", range: [-90, 80] }],
        lengths: [40, 30, 20], r: [5, 4, 3, 2],
      });
      const posed = L.pose({ grip: { around: as(ROD) } });
      expect(posed.report.grip.touching).toBe(true);
      expect(posed.values.every((v) => v >= 0)).toBe(true);
      expect(posed.values.some((v) => v > 0)).toBe(true);
    });
  });
}

describe("grip: the node and the function give identical reports", () => {
  const cases = [
    () => [wideIndex(), { curl: 0, grip: { around: ROD, r: INDEX_R } }, PALM],
    () => [wideIndex(), { curl: 0, grip: { around: ROD, clearance: 1.5, r: INDEX_R } }, PALM],
    () => [index(), { grip: { around: FRONT_ROD } }, PALM],
    () => [index(), { bend: { pip: 30 }, grip: { around: { kind: "union", children: [FRONT_ROD, { kind: "sphere", r: 4, at: [-30, 150, -5] }] } } }, PALM],
  ];
  cases.forEach((make, n) => it(`case ${n}`, () => {
    const [L, opts, frames] = make();
    const a = L.pose(opts, frames);
    const b = L.pose({ ...opts, grip: { ...opts.grip, around: MODES.function(opts.grip.around) } }, frames);
    expect(JSON.stringify([b.values, b.frames, b.report])).toBe(JSON.stringify([a.values, a.frames, a.report]));
  }));
});

describe("grip errors", () => {
  it("needs the parent frames", () => {
    expect(() => index().pose({ grip: { around: FRONT_ROD } })).toThrow('limb "index": grip needs the frames declared so far — pass them as pose(…, frames)');
  });
  it("needs r", () => {
    const L = limb("bare", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [10, 10] });
    expect(() => L.pose({ grip: { around: FRONT_ROD } })).toThrow('limb "bare": grip needs r (radius per joint, then the tip)');
    expect(() => L.pose({ grip: { around: FRONT_ROD, r: [1, 2] } })).toThrow('limb "bare".grip.r: expected 3 entries (one per joint, then the tip), got 2');
  });
  it("refuses frames inside around", () => {
    expect(() => index().pose({ grip: { around: { ...FRONT_ROD, frame: "palm" } } }, PALM)).toThrow('limb "index".grip.around: shapes are in part coordinates; drop "frame"');
    const nested = { kind: "union", children: [FRONT_ROD, { kind: "sphere", r: 2, frame: "palm" }] };
    expect(() => index().pose({ grip: { around: nested } }, PALM)).toThrow('limb "index".grip.around.children[1]: shapes are in part coordinates; drop "frame"');
  });
  it("validates grip and clearance", () => {
    expect(() => index().pose({ grip: { clearance: 1 } }, PALM)).toThrow('limb "index".grip.around: must be a shape node');
    expect(() => index().pose({ grip: { around: FRONT_ROD, clearance: NaN } }, PALM)).toThrow('limb "index".grip.clearance: must be a finite number');
    expect(() => index().pose({ grip: { around: { kind: "cylinder", r: -1, h: 4 } } }, PALM)).toThrow('limb "index".grip.around.r: must be a number > 0');
    expect(() => index().pose({ grip: { around: FRONT_ROD, extra: 1 } }, PALM)).toThrow('limb "index".grip.extra: unknown grip option "extra"');
  });
  it("a shape the implicit engine owns is refused, naming the distance-function fix", () => {
    expect(() => index().pose({ grip: { around: { kind: "round", r: 1, child: FRONT_ROD } } }, PALM))
      .toThrow('limb "index".grip.around: node kind "round" needs the implicit engine — pass a distance function (x, y, z) => mm instead — implicitDistance(node) from partforge/geometry makes one');
  });
  it("accepts around as a function or an object, and refuses a string, an array or a number", () => {
    expect(index().pose({ grip: { around: FRONT_ROD } }, PALM).report.grip.touching).toBe(true);
    expect(index().pose({ grip: { around: MODES.function(FRONT_ROD) } }, PALM).report.grip.touching).toBe(true);
    for (const around of ["cylinder", [FRONT_ROD], 4]) {
      expect(() => index().pose({ grip: { around } }, PALM)).toThrow('limb "index".grip.around: must be a shape node');
    }
  });

  describe("a distance function's failures", () => {
    it("a non-finite return near the finger throws, naming the point", () => {
      const d = distanceFor(FRONT_ROD);
      const around = (x, y, z) => (y > 120 ? NaN : d(x, y, z));
      let caught;
      try { index().pose({ grip: { around } }, PALM); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(SpecError);
      expect(caught.message).toMatch(/^limb "index"\.grip\.around: distance function returned a non-finite value at \[-?[\d.]+, [\d.]+, -?[\d.]+\]$/);
      expect(() => index().pose({ grip: { around: () => Infinity } }, PALM)).toThrow("grip.around: distance function returned a non-finite value at [");
      expect(() => index().pose({ grip: { around: () => "3" } }, PALM)).toThrow("grip.around: distance function returned a non-finite value at [");
    });
    it("a throw is wrapped in a SpecError naming grip.around, keeping the cause", () => {
      const boom = new Error("boom");
      let caught;
      try { index().pose({ grip: { around: () => { throw boom; } } }, PALM); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(SpecError);
      expect(caught.message).toBe('limb "index".grip.around: distance function threw — boom');
      expect(caught.cause).toBe(boom);
    });
  });
});
