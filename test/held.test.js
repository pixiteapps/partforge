import { expect, test } from "vitest";
import { heldCheck, HELD_HINT } from "../src/framework/oracle/held.js";

// Three 10 mm cubes in a row on z=0: base, mid touching base, top floating 0.2 above mid.
const row = (name, x, z = 0) => ({
  name, bounds: { min: [x, 0, z], max: [x + 10, 10, z + 10] }, centerOfMass: [x + 5, 5, z + 5],
});
const facts = (over = {}) => ({
  subparts: [row("base", 0), row("mid", 10), row("top", 10, 10.2)],
  overlaps: [],
  gaps: [
    { a: "base", b: "mid", distance: 0, at: [10, 5, 5] },
    { a: "mid", b: "top", distance: 0.2, at: [15, 5, 10.1] },
    { a: "base", b: "top", distance: 10.2, at: [10, 5, 10] },
  ],
  nearMisses: [],
  ...over,
});

test("returns null when held is not declared", () => {
  expect(heldCheck(facts(), undefined, {})).toBeNull();
  expect(heldCheck(facts(), null, {})).toBeNull();
});

test("fails naming the floating sub-part, located at its centre of mass", () => {
  const c = heldCheck(facts(), true, {});
  expect(c.metric).toBe("held");
  expect(c.status).toBe("fail");
  expect(c.actual).toBe(1);
  expect(c.message).toBe("top not connected to base");
  expect(c.hint).toBe(HELD_HINT);
  expect(c.pattern).toBe("floating-subpart");
  expect(c.location).toEqual([15, 5, 15.2]);
});

test("passes when every sub-part reaches the base through contact or overlap", () => {
  const c = heldCheck(facts({ gaps: [
    { a: "base", b: "mid", distance: 0, at: [10, 5, 5] },
    { a: "mid", b: "top", distance: 0.0005, at: [15, 5, 10] }, // within CONTACT_EPS
    { a: "base", b: "top", distance: 10, at: [10, 5, 10] },
  ] }), true, {});
  expect(c.status).toBe("pass");
  expect(c.actual).toBe(0);
  expect(c.message).toBe("3 sub-parts connected to base");
});

test("an overlap joins a pair whatever its gap reads", () => {
  const c = heldCheck(facts({ overlaps: [{ a: "mid", b: "top", volume: 5, location: [15, 5, 10] }] }), true, {});
  expect(c.status).toBe("pass");
});

test("the base is the lowest sub-part by bounds.min z, else the first in view order", () => {
  // mid is raised to z 0.5 so base is strictly lowest: a tie would root at the first tied sub-part.
  const f = facts({ subparts: [row("top", 10, 10.2), row("mid", 10, 0.5), row("base", 0)] });
  expect(heldCheck(f, true, {}).message).toBe("top not connected to base");
  const legacy = facts({ subparts: [{ name: "base" }, { name: "mid" }, { name: "top" }] });
  expect(heldCheck(legacy, true, {}).message).toBe("top not connected to base");
});

test("a named base roots the graph there", () => {
  const c = heldCheck(facts(), "top", {});
  expect(c.expr).toBe("connected to top");
  expect(c.status).toBe("fail");
  expect(c.message).toBe("base, mid not connected to top");
  expect(c.location).toEqual([5, 5, 5]);
});

test("exportable names bound the graph: a ghost neither counts nor holds", () => {
  // `top` is held only by `ghost`; ghost is not exportable, so top floats
  const f = facts({
    subparts: [row("base", 0), row("top", 10, 10.2), row("ghost", 10)],
    gaps: [
      { a: "base", b: "top", distance: 10.2, at: [10, 5, 10] },
      { a: "ghost", b: "top", distance: 0, at: [15, 5, 10] },
      { a: "base", b: "ghost", distance: 0, at: [10, 5, 5] },
    ],
  });
  const c = heldCheck(f, true, { exportableNames: ["base", "top"] });
  expect(c.status).toBe("fail");
  expect(c.message).toBe("top not connected to base");
  // one exportable sub-part plus a ghost: nothing to hold
  const one = heldCheck(f, true, { exportableNames: ["base"] });
  expect(one.status).toBe("pass");
  expect(one.message).toBe("1 sub-part, nothing to hold");
});

test("a quick lap skips as unevaluated; legacy facts with no gap table skip as unavailable", () => {
  const quick = heldCheck(facts({ gaps: undefined, measuredGaps: false }), true, {});
  expect(quick.status).toBe("skip");
  expect(quick.unevaluated).toBe(true);
  const legacy = heldCheck(facts({ gaps: undefined }), true, {});
  expect(legacy.status).toBe("skip");
  expect(legacy.unevaluated).toBeUndefined();
  expect(legacy.message).toBe("unavailable");
});

test("a base disabled in this case skips; a base in no case throws; a bad value throws", () => {
  const f = facts({ subparts: [row("base", 0), row("mid", 10)], gaps: [{ a: "base", b: "mid", distance: 0, at: [10, 5, 5] }] });
  const c = heldCheck(f, "top", { subPartNames: ["base", "mid", "top"] });
  expect(c.status).toBe("skip");
  expect(c.message).toBe("sub-part disabled in this case");
  expect(() => heldCheck(f, "lid", { subPartNames: ["base", "mid", "top"] })).toThrow(/unknown sub-part "lid"/);
  expect(() => heldCheck(f, "lid", {})).toThrow(/unknown sub-part "lid"/);
  expect(() => heldCheck(f, 1, {})).toThrow(/held: must be true or a sub-part name/);
  expect(() => heldCheck(f, false, {})).toThrow(/held: must be true or a sub-part name/);
});
