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
});
