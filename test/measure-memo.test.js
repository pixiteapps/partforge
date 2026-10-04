import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { buildView } from "../src/framework/oracle/build.js";
import { measure } from "../src/framework/oracle/measure.js";
import { createChangeTracker } from "../src/framework/oracle/changes.js";
import hinged from "../src/parts/hinged-box.js";
import demo from "../src/parts/demo.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const run = (tracker, part, view, opts) => {
  tracker?.begin("key", view);
  const built = buildView(k, part, view, {});
  tracker?.endBuild(built);
  const m = measure(k, part, view, {}, { built, ...opts, ...(tracker ? { memo: tracker.memo } : {}) });
  tracker?.finish(k, view, built, m);
  k.cleanup();
  return m;
};
const strip = (m) => JSON.parse(JSON.stringify(m)); // drop typed-array identity

const variants = {
  same: hinged,
  movedLid: { ...hinged, parts: { ...hinged.parts, lid: { ...hinged.parts.lid,
    build: (kk, p, d) => hinged.parts.lid.build(kk, p, d).translate([0, 0, 3]) } } },
  addedKnob: { ...hinged, parts: { ...hinged.parts, lid: { ...hinged.parts.lid,
    build: (kk, p, d) => hinged.parts.lid.build(kk, p, d).union(kk.cylinder({ d: 6, h: 6 })) } } },
};

for (const opts of [{ minWall: true, gaps: true }, { minWall: false, gaps: false }]) {
  for (const [label, next] of Object.entries(variants)) {
    test(`reuse equals recompute: ${label}, minWall=${opts.minWall}`, () => {
      const t = createChangeTracker();
      run(t, hinged, "box", opts);
      const reused = run(t, next, "box", opts);
      const fresh = run(null, next, "box", opts);
      expect(strip(reused)).toEqual(strip(fresh));
    });
  }
}

test("a quick lap's facts are never reused by a full lap", () => {
  const t = createChangeTracker();
  run(t, hinged, "box", { minWall: false, gaps: false });
  const full = run(t, hinged, "box", { minWall: true, gaps: true });
  expect(full.measuredMinWall).toBe(true);
  expect(full.subparts.some((s) => s.minWall !== null || s.minWallSamples !== null)).toBe(true);
});

test("memo hits actually skip work", () => {
  const t = createChangeTracker();
  run(t, demo, "spacer", { minWall: true });
  let gets = 0;
  const realGet = t.memo.get;
  t.memo.get = (...a) => { const v = realGet(...a); if (v) gets++; return v; };
  run(t, demo, "spacer", { minWall: true });
  expect(gets).toBe(1);
});

test("identical geometry under two names carries the current name", () => {
  const twin = { ...hinged, parts: { ...hinged.parts, base2: { ...hinged.parts.base } },
    views: { ...hinged.views } };
  // Only meaningful if the view lists sub-parts explicitly; otherwise skip.
  const t = createChangeTracker();
  const m1 = run(t, twin, "box", { minWall: false });
  const m2 = run(t, twin, "box", { minWall: false });
  expect(m2.subparts.map((s) => s.name)).toEqual(m1.subparts.map((s) => s.name));
  // The copy actually joins the view (each sub-part's own `views: ["box"]`),
  // so the twin pair is really exercised here, not silently skipped.
  expect(m1.subparts.map((s) => s.name)).toContain("base2");
});

test("a hit is re-stored, so an unchanged sub-part is reused every round, not every other round", () => {
  const t = createChangeTracker();
  run(t, hinged, "box", { minWall: true, gaps: true });
  let gets = 0;
  const realGet = t.memo.get;
  t.memo.get = (...a) => { const v = realGet(...a); if (v) gets++; return v; };
  run(t, hinged, "box", { minWall: true, gaps: true }); // lap 2: reads from lap 1's write
  expect(gets).toBeGreaterThan(0);
  gets = 0;
  run(t, hinged, "box", { minWall: true, gaps: true }); // lap 3: must still hit — not every OTHER lap
  expect(gets).toBeGreaterThan(0);
});

// Reuse-equals-recompute must hold for every field the memo key itself names,
// not only for a changed solid hash: each pair below keeps the lid's SOLID
// HASH identical (same build function, same params that feed geometry) and
// varies only one of the OTHER inputs measure's per-sub-part facts depend on.
// `exportable` is the one this suite caught missing from the key before the
// fix (CRITICAL, task review): a non-exportable sub-part gets no overhang
// facts (measure.js's `printed`), so a stale hit from before the toggle
// returned non-null overhangArea/overhangAngle/overhangAt where a fresh
// measurement reads null — these tests FAIL on the pre-fix memoKey (no `ex`
// field) for the "exportable" case.
const overhangOptedIn = { ...hinged, verify: { ...hinged.verify, orientation: "print" } };
const tiltedLid = (printTilt) => ({ ...overhangOptedIn,
  defaults: { ...overhangOptedIn.defaults, printTilt },
  parts: { ...overhangOptedIn.parts, lid: { ...overhangOptedIn.parts.lid,
    place: (s, ctx) => ctx.purpose === "export"
      ? overhangOptedIn.parts.lid.place(s, ctx).rotate(ctx.p.printTilt, [0, 0, 0], [1, 0, 0])
      : overhangOptedIn.parts.lid.place(s, ctx) } } });
// A lid carrying an upside-down cone: its 45° side wall is an overhang at a 30°
// threshold and not at 60°, so the angle variant below moves the lid's own
// overhang facts, not only the report-level `measuredOverhang`.
const conedLid = { ...overhangOptedIn, parts: { ...overhangOptedIn.parts, lid: { ...overhangOptedIn.parts.lid,
  build: (kk, p, d) => {
    const s = hinged.parts.lid.build(kk, p, d);
    const b = s.boundingBox();
    return s.union(kk.cylinder({ d1: 4, d2: 20, h: 8 })
      .translate([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]));
  } } } };
const withOverhang = (deg) => ({ ...conedLid, verify: { ...conedLid.verify, process: { base: "fdm-pla", overhang: deg } } });
const memoKeyFieldVariants = {
  // The lid stops being judged for overhang at all — `printed` flips false.
  exportable: [
    overhangOptedIn,
    { ...overhangOptedIn, parts: { ...overhangOptedIn.parts,
      lid: { ...overhangOptedIn.parts.lid, exportable: false } } },
  ],
  // A param the BUILD never reads, but that `verify.expect`'s wall band is a
  // function of (partWallBands) — geometry is unchanged, the declared band
  // the min-wall pass is scored against is not.
  wallBand: [
    { ...hinged, defaults: { ...hinged.defaults, bandHint: 0 },
      verify: { ...hinged.verify, expect: (p) => ({ ...hinged.verify.expect,
        lid: { wall: p.bandHint > 5 ? "0.5..5" : "1..3" } }) } },
    { ...hinged, defaults: { ...hinged.defaults, bandHint: 10 },
      verify: { ...hinged.verify, expect: (p) => ({ ...hinged.verify.expect,
        lid: { wall: p.bandHint > 5 ? "0.5..5" : "1..3" } }) } },
  ],
  // The overhang angle a part is judged against changes (process override),
  // orientation stays opted in — geometry is unchanged, the threshold is not.
  overhangAngle: [withOverhang(60), withOverhang(30)],
  // A param only the lid's EXPORT pose reads (place(), purpose "export"): the
  // display geometry — and so the solid hash — is unchanged, but the overhang
  // reading poses the mesh for print (measure.js printPoseOverhang), so the
  // display→print matrix is a memo-key input. Added on the rebase onto 0.142.0,
  // which introduced print-pose overhang.
  printPose: [
    tiltedLid(0),
    tiltedLid(30),
  ],
};

for (const [label, [base, variant]] of Object.entries(memoKeyFieldVariants)) {
  test(`reuse equals recompute across a memo-key input change: ${label}`, () => {
    const t = createChangeTracker();
    run(t, base, "box", { minWall: true, gaps: true });
    const reused = run(t, variant, "box", { minWall: true, gaps: true });
    const fresh = run(null, variant, "box", { minWall: true, gaps: true });
    expect(strip(reused)).toEqual(strip(fresh));
    // Non-vacuous: the input change really moves a fresh reading, so a stale
    // memo hit would have been caught above.
    expect(strip(run(null, base, "box", { minWall: true, gaps: true }))).not.toEqual(strip(fresh));
  });
}

test("the overhangAngle variant's two fresh readings differ in the overhang facts", () => {
  const [base, variant] = memoKeyFieldVariants.overhangAngle;
  const lidOf = (m) => m.subparts.find((s) => s.name === "lid");
  const a = lidOf(run(null, base, "box", { minWall: true, gaps: true }));
  const b = lidOf(run(null, variant, "box", { minWall: true, gaps: true }));
  expect(a.overhangArea).toBe(0);
  expect(b.overhangArea).toBeGreaterThan(100);
});

test("a fact structuredClone refuses is measured, not thrown", () => {
  const t = createChangeTracker();
  const realSet = t.memo.set;
  t.memo.set = (name, hash, k2, facts) => realSet(name, hash, k2, { ...facts, poison: () => {} });
  run(t, hinged, "box", { minWall: false, gaps: false });
  const second = run(t, hinged, "box", { minWall: false, gaps: false });
  expect(strip(second)).toEqual(strip(run(null, hinged, "box", { minWall: false, gaps: false })));
});

test("a memo hit is a deep copy: mutating a reported fact cannot poison the next hit", () => {
  const t = createChangeTracker();
  run(t, hinged, "box", { minWall: false, gaps: false });
  const second = run(t, hinged, "box", { minWall: false, gaps: false });
  for (const s of second.subparts) if (s.bounds) s.bounds.min[0] = 1e9;
  const third = run(t, hinged, "box", { minWall: false, gaps: false });
  expect(strip(third)).toEqual(strip(run(null, hinged, "box", { minWall: false, gaps: false })));
});
