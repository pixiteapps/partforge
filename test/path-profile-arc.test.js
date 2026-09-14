// Pure tests for pathProfile().arcTo(to, { r, sweep, large }) — the radius arc
// form that computes `via` inside the builder, so the emitted segment
// { to, via } is byte-for-byte what the three-point form emits. No kernel
// boot here (see test/curve-profile-manifold.test.js for the Manifold check).
import { describe, expect, test } from "vitest";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { validateProfile } from "../src/framework/geometry/contour-ops.js";

const viaOf = (contour, i = 0) => contour.segments[i].via;

describe("pathProfile arcTo radius form — sanity values", () => {
  test("r = 5 (semicircle, ccw): via = [5, -5]", () => {
    const c = pathProfile([0, 0]).arcTo([10, 0], { r: 5 }).close();
    const [x, y] = viaOf(c);
    expect(x).toBeCloseTo(5, 4);
    expect(y).toBeCloseTo(-5, 4);
  });

  test("r = 5, large: true (semicircle): both sides coincide at h = 0", () => {
    const c = pathProfile([0, 0]).arcTo([10, 0], { r: 5, large: true }).close();
    const [x, y] = viaOf(c);
    expect(x).toBeCloseTo(5, 4);
    expect(y).toBeCloseTo(-5, 4);
  });

  test('r = 5, sweep: "cw": via = [5, 5]', () => {
    const c = pathProfile([0, 0]).arcTo([10, 0], { r: 5, sweep: "cw" }).close();
    const [x, y] = viaOf(c);
    expect(x).toBeCloseTo(5, 4);
    expect(y).toBeCloseTo(5, 4);
  });

  test("r = 10 (short ccw arc): via = [5, -1.3397]", () => {
    const c = pathProfile([0, 0]).arcTo([10, 0], { r: 10 }).close();
    const [x, y] = viaOf(c);
    expect(x).toBeCloseTo(5, 4);
    expect(y).toBeCloseTo(-1.3397, 4);
  });

  test("r = 10, large: true: via = [5, -18.6603]", () => {
    const c = pathProfile([0, 0]).arcTo([10, 0], { r: 10, large: true }).close();
    const [x, y] = viaOf(c);
    expect(x).toBeCloseTo(5, 4);
    expect(y).toBeCloseTo(-18.6603, 4);
  });

  test('r = 10, sweep: "cw", large: true: via = [5, 18.6603]', () => {
    const c = pathProfile([0, 0]).arcTo([10, 0], { r: 10, sweep: "cw", large: true }).close();
    const [x, y] = viaOf(c);
    expect(x).toBeCloseTo(5, 4);
    expect(y).toBeCloseTo(18.6603, 4);
  });
});

describe("pathProfile arcTo radius form — equivalence with the three-point form", () => {
  test("the emitted segment matches arcTo(to, via) handed the computed via", () => {
    const radiusForm = pathProfile([0, 0]).arcTo([10, 0], { r: 10, sweep: "cw" }).close();
    const via = radiusForm.segments[0].via;
    const viaForm = pathProfile([0, 0]).arcTo([10, 0], via).close();
    expect(radiusForm.segments[0].to[0]).toBeCloseTo(viaForm.segments[0].to[0], 9);
    expect(radiusForm.segments[0].to[1]).toBeCloseTo(viaForm.segments[0].to[1], 9);
    expect(radiusForm.segments[0].via[0]).toBeCloseTo(viaForm.segments[0].via[0], 9);
    expect(radiusForm.segments[0].via[1]).toBeCloseTo(viaForm.segments[0].via[1], 9);
  });
});

describe("pathProfile arcTo radius form — boundary and error cases", () => {
  test("r exactly d/2 is accepted (semicircle)", () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: 5 }).close()).not.toThrow();
  });

  test("r = d/2 - 1e-6 throws naming r=, the chord half-length, and both points", () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: 5 - 1e-6 }).close())
      .toThrow(/shorter than half the chord/);
    try {
      pathProfile([0, 0]).arcTo([10, 0], { r: 5 - 1e-6 }).close();
      throw new Error("expected a throw");
    } catch (e) {
      expect(e.message).toMatch(/r=4\.999999/);
      expect(e.message).toMatch(/5\.0000/);
      expect(e.message).toMatch(/\(0, 0\)/);
      expect(e.message).toMatch(/\(10, 0\)/);
    }
  });

  test('sweep: "clockwise" throws', () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: 5, sweep: "clockwise" }).close())
      .toThrow(/sweep must be "ccw" or "cw"/);
  });

  test("to equal to the current point throws /coincides/", () => {
    expect(() => pathProfile([0, 0]).arcTo([0, 0], { r: 5 }).close())
      .toThrow(/coincides/);
  });

  test("arcTo(to, 5) — a number, not an array or object — throws /needs a via/", () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], 5).close())
      .toThrow(/needs a via/);
  });

  test("arcTo(to) — no second argument — throws /needs a via/", () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0]).close())
      .toThrow(/needs a via/);
  });

  test("arcTo(to, null) throws /needs a via/", () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], null).close())
      .toThrow(/needs a via/);
  });

  test("r: Infinity throws /must be > 0 and finite/ rather than emitting via: [NaN, NaN]", () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: Infinity }).close())
      .toThrow(/must be > 0 and finite/);
  });

  test('r: "6" (a string, not a number) throws /must be > 0 and finite/', () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: "6" }).close())
      .toThrow(/must be > 0 and finite/);
  });

  test("r: true (a boolean, not a number) throws /must be > 0 and finite/", () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: true }).close())
      .toThrow(/must be > 0 and finite/);
  });

  test('an unknown key ("largeArc") throws naming it and the three legal keys', () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: 6, largeArc: true }).close())
      .toThrow(/"largeArc".*r, sweep, large/);
  });

  test('a plausible-but-wrong key ("radius") throws naming it, not "r must be > 0"', () => {
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { radius: 6 }).close())
      .toThrow(/"radius".*r, sweep, large/);
  });

  test("a sweep typo is reported even when r would also fail — enum/boolean checks run before the numeric ones", () => {
    // r=1 on a 10mm chord is also invalid (shorter than the d/2=5 minimum), but the
    // sweep typo must be reported on its own rather than masked by that radius error.
    expect(() => pathProfile([0, 0]).arcTo([10, 0], { r: 1, sweep: "clockwise" }).close())
      .toThrow(/sweep must be/);
  });
});

describe("pathProfile arcTo radius form — real outlines validate", () => {
  test("an outward ccw arc on a rectangle validates as a simple CCW profile", () => {
    const c = pathProfile([0, 0]).lineTo([40, 0]).lineTo([40, 20]).arcTo([0, 20], { r: 20 }).close();
    expect(validateProfile(c).ok).toBe(true);
  });

  test("an inward cw notch arc also validates as a simple outline", () => {
    const c = pathProfile([0, 0])
      .lineTo([40, 0])
      .arcTo([40, 20], { r: 12, sweep: "cw" })
      .lineTo([0, 20])
      .close();
    expect(validateProfile(c).ok).toBe(true);
  });
});

describe("pathProfile arcTo radius form — current point tracking", () => {
  test("the current point advances through cubicTo", () => {
    const c = pathProfile([0, 0])
      .cubicTo([10, 0], [3, 0], [7, 0])
      .arcTo([10, 10], { r: 5 })
      .close();
    // From (10,0) to (10,10), r=5 is a semicircle: via = midpoint + normal*r.
    // chord dir u = (0,1); left normal n = (-1,0); midpoint (10,5); ccw default
    // side = -1 => via = (10,5) + (-1,0)*5*(-1) = (15,5).
    const [x, y] = c.segments[1].via;
    expect(x).toBeCloseTo(15, 4);
    expect(y).toBeCloseTo(5, 4);
  });

  test("the current point advances through a prior radius arc (chained arcs)", () => {
    const c = pathProfile([0, 0])
      .arcTo([10, 0], { r: 5 })
      .arcTo([20, 0], { r: 5 })
      .close();
    // Second arc's via must be computed from the FIRST arc's `to` = (10, 0),
    // i.e. identical (shifted) to the first arc's own via relative geometry.
    const via1 = c.segments[0].via;
    const via2 = c.segments[1].via;
    expect(via1[0]).toBeCloseTo(5, 4);
    expect(via1[1]).toBeCloseTo(-5, 4);
    expect(via2[0]).toBeCloseTo(15, 4);
    expect(via2[1]).toBeCloseTo(-5, 4);
  });
});
