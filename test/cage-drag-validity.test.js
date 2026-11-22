// The drag validity check (subdiv/index.js's dragValidity, the design's "Stopping at the
// last valid pose"): meshSubdiv's two refusals on a coarse surface of the drag's plan, cheap
// enough to run before each pose a cage drag draws. Pure: no kernel.
import { describe, expect, test } from "vitest";
import { resolveParams } from "../src/framework/part-model.js";
import { createCage } from "../src/framework/geometry/subdiv/cage.js";
import { subdivPlan, levelFor, SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES } from "../src/framework/geometry/subdiv/surface.js";
import { dragValidity, DRAG_CHECK_LEVEL, meshSubdiv } from "../src/framework/geometry/subdiv/index.js";
import hand, { cageHand } from "../src/parts/cage-hand.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
// The hand's cage with every finger at one knuckle and one curl (the tip joint follows at
// 0.75), driven straight through cageHand so a bend past the part's range can be asked for.
const { p: P0 } = resolveParams(hand, hand.defaults);
const handCage = (knuckle, curl, thumb) => cageHand(createCage, P0,
  { ...Object.fromEntries(FINGERS.map((f) => [f, [knuckle, curl, 0.75 * curl]])), thumb: [thumb] }).snapshot();
const handAt = (params) => {
  const { p, d } = resolveParams(hand, { ...hand.defaults, ...params });
  return cageHand(createCage, p, Object.fromEntries([...FINGERS, "thumb"].map((n) => [n, d[n].values]))).snapshot();
};
// The plan a drag uses: the base delivery's own snapshot at the level its build picked.
const planOf = (snapshot) => subdivPlan(snapshot, levelFor(snapshot, SUBDIV_TOLERANCE.preview, { maxTriangles: SUBDIV_MAX_TRIANGLES.preview }).level);

describe("dragValidity on the cage hand", () => {
  const base = handAt({});
  const plan = planOf(base);

  test("checks at level 1 of the hand's level-4 plan", () => {
    expect(DRAG_CHECK_LEVEL).toBe(1);
    expect(plan.level).toBe(4);
  });

  test("is null across the hand's whole slider range, every corner of it included", () => {
    const corners = [];
    for (const knuckle of [-10, 40, 90]) for (const curl of [0, 45, 90]) for (const thumb of [0, 30, 60]) corners.push([knuckle, curl, thumb]);
    for (const [knuckle, curl, thumb] of corners) expect(dragValidity(plan, handCage(knuckle, curl, thumb).points), `${knuckle} ${curl} ${thumb}`).toBeNull();
    // The part's own params at its maxima, through its limbs.
    const max = Object.fromEntries(FINGERS.flatMap((f) => [[`${f}Knuckle`, 90], [`${f}Curl`, 90]]));
    expect(dragValidity(plan, handAt({ ...max, thumbCurl: 60 }).points)).toBeNull();
  });

  test("names the faces of a finger curled through the palm", () => {
    const r = dragValidity(plan, handCage(90, 110, 60).points, { ids: base.ids });
    expect(r?.message).toMatch(/^subdiv: the body passes through itself between /);
    expect(r.message).toMatch(/pinky/);
  });

  test("a pose whose points are not numbers is refused, not thrown", () => {
    const points = base.points.map((q) => [...q]);
    points[0] = [NaN, 0, 0];
    expect(dragValidity(plan, points)?.message).toMatch(/^subdiv: /);
  });
});

describe("dragValidity on small cages", () => {
  // A box whose top face is pushed down: past the bottom face the body turns inside out.
  const pushed = (push) => {
    const c = createCage({ box: { size: [20, 20, 20] } });
    c.move("+z:0,0", [0, 0, -push]);
    return c.snapshot();
  };

  test("a cage with no volume is refused with meshSubdiv's message", () => {
    const plan = planOf(pushed(0));
    expect(dragValidity(plan, pushed(15).points)).toBeNull();
    expect(dragValidity(plan, pushed(30).points)).toEqual({ message: "subdiv: the body has no volume" });
    expect(() => meshSubdiv(pushed(30), "preview")).toThrow("subdiv: the body has no volume");
  });

  test("an arm swung back through the body is refused at the same pose the full check refuses", () => {
    const swung = (deg) => {
      const c = createCage({ box: { size: [20, 20, 20] } });
      let a = c.extrude("+x:0,0", { by: 8 });
      a = c.extrude(a, { by: 8 });
      const hinge = c.centroid(a);
      a = c.extrude(a, { by: 25 });
      c.rotate(a, { axis: "z", deg, about: hinge });
      return c.snapshot();
    };
    const base = swung(0);
    const plan = planOf(base);
    expect(dragValidity(plan, swung(60).points)).toBeNull();
    const r = dragValidity(plan, swung(140).points, { ids: base.ids });
    expect(r?.message).toMatch(/^subdiv: the body passes through itself between \+x:0,0/);
    expect(meshSubdiv(swung(140), "preview").warnings.some((w) => w.startsWith("subdiv: the body passes through itself"))).toBe(true);
  });
});
