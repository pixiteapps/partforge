// verify's sweepCoverage check (spec 2026-11-12-moving-fits-swept-design.md, A, decisions 2
// and 4): a motion no declared sweep covers holds verify.ok at null, on full and quick laps,
// whatever view is verified; a declared sweep satisfies it even when it ran out of time.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";
import { MOTION_HINT, uncoveredMotions } from "../src/framework/collide/motion-coverage.js";

const SLOW = 120_000;
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const ctl = (key, min, max) => ({ key, label: key, min, max, step: 1, description: key });
const box = (k) => k.box({ size: [10, 10, 10] });

/** Two boxes in one `assembly` view; `lid` and `base` are each sub-part's assembly pose. */
const twoBox = ({ controls, defaults, lid = (s) => s, base = (s) => s, baseBuild = box, verify: v }) => ({
  meta: { title: "T" },
  parameters: [{ id: "g", title: "G", description: "d", controls }],
  defaults,
  parts: {
    base: { views: { assembly: base }, build: baseBuild },
    lid: { views: { assembly: lid }, build: box },
  },
  views: { assembly: { label: "Assembly" } },
  ...(v ? { verify: v } : {}),
});

const watertight = { expect: { base: { watertight: true } } };
// The lid swings about a pin at the base's top back edge, clear of it over the whole range.
const hinge = (v = watertight) => twoBox({
  controls: [ctl("open", 0, 110)],
  defaults: { open: 0 },
  lid: (s, p) => s.translate([0, 0, 10]).rotateAbout({ axis: "X", deg: -p.open, through: [0, 10, 10] }),
  verify: v,
});
const coverage = (r) => r.cases.flatMap((c) => c.checks).filter((c) => c.metric === "sweepCoverage");
const hingeHint = () => MOTION_HINT(uncoveredMotions(hinge())[0]);

describe("verify sweepCoverage", () => {
  test("an unswept hinge holds the verdict", () => {
    const r = verify(k, hinge());
    expect(r.ok).toBe(null);
    expect(r.failures).toEqual([]);
    expect(r.unevaluated).toHaveLength(1);
    expect(r.unevaluated[0]).toMatchObject({
      scope: "view", subpart: null, metric: "sweepCoverage", expr: "open", actual: null, status: "skip",
      pass: null, unevaluated: true, message: 'no sweep declared for "open"', hint: hingeHint(),
    });
    expect(hingeHint()).toContain('"open" moves lid against base in view "assembly"');
    expect(r.evaluated).toBe(1);   // watertight still answered
    expect(coverage(r)).toHaveLength(1);   // appended once
  }, SLOW);

  test("the same on a quick lap", () => {
    const r = verify(k, hinge(), { quick: true });
    expect(r.ok).toBe(null);
    expect(r.unevaluated.filter((c) => c.metric === "sweepCoverage")).toEqual([
      expect.objectContaining({ expr: "open", hint: hingeHint() }),
    ]);
  }, SLOW);

  test("a declared sweep covers it (no sweepContacts expectation: reported, not gated)", () => {
    const r = verify(k, hinge({ ...watertight, sweeps: { open: { param: "open", clearance: 0 } } }));
    expect(coverage(r)).toEqual([]);
    expect(r.ok).toBe(true);
  }, SLOW);

  test("a declared sweep that ran out of time still covers it, with today's warning", () => {
    const r = verify(k, hinge({ ...watertight, sweeps: { open: { param: "open", clearance: 0 } } }), { deadline: -Infinity });
    expect(coverage(r)).toEqual([]);
    expect(r.warnings.filter((w) => w.metric === "sweeps")).toHaveLength(1);
    expect(r.ok).toBe(true);
  }, SLOW);

  test("a motion only in a view not being verified still withholds, naming that view", () => {
    const part = hinge();
    part.parts.base.views = { ...part.parts.base.views, front: (s) => s };
    part.views = { assembly: { label: "Assembly" }, front: { label: "Front" } };
    const r = verify(k, part, { view: "front" });
    expect(r.ok).toBe(null);
    const [c] = coverage(r);
    expect(c.expr).toBe("open");
    expect(c.hint).toContain('in view "assembly"');
  }, SLOW);

  test("a part with no verify block still gets the check", () => {
    const r = verify(k, hinge(null));
    expect(r.ok).toBe(null);
    expect(coverage(r)).toHaveLength(1);
    // and still hears that it declares nothing else
    expect(r.warnings).toEqual([expect.objectContaining({ scope: "part", message: "no expectations declared" })]);
  }, SLOW);

  describe("no motion, no check", () => {
    const size = () => twoBox({
      controls: [ctl("height", 5, 40)], defaults: { height: 10 },
      baseBuild: (k, p) => k.box({ size: [10, 10, p.height] }),
      lid: (s, p) => s.translate([0, 0, p.height]),
      verify: watertight,
    });
    const together = () => {
      const move = (s, p) => s.translate([p.shift, 0, 0]);
      return twoBox({ controls: [ctl("shift", 0, 50)], defaults: { shift: 0 }, lid: move, base: move, verify: watertight });
    };
    // every view shows one piece: the lid swings alone in `assembly`, the base sits in `other`
    const single = () => {
      const part = hinge();
      part.parts.base.views = { other: (s) => s };
      part.views.other = { label: "Other" };
      return part;
    };
    for (const [name, make, view] of [["size", size], ["together", together], ["single", single, "other"]]) {
      test(name, () => {
        const r = verify(k, make(), view ? { view } : {});
        expect(coverage(r)).toEqual([]);
        expect(r.ok).toBe(true);
      }, SLOW);
    }
  });
});
