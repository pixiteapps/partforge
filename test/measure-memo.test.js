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
  overhangAngle: [
    overhangOptedIn,
    { ...overhangOptedIn, verify: { ...overhangOptedIn.verify, process: { base: "fdm-pla", overhang: 30 } } },
  ],
};

for (const [label, [base, variant]] of Object.entries(memoKeyFieldVariants)) {
  test(`reuse equals recompute across a memo-key input change: ${label}`, () => {
    const t = createChangeTracker();
    run(t, base, "box", { minWall: true, gaps: true });
    const reused = run(t, variant, "box", { minWall: true, gaps: true });
    const fresh = run(null, variant, "box", { minWall: true, gaps: true });
    expect(strip(reused)).toEqual(strip(fresh));
  });
}
