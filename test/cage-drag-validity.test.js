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
// The hand's cage at params, skinned to derive's limbs as the part's build does.
const handAt = (params) => {
  const { d } = resolveParams(hand, { ...hand.defaults, ...params });
  return cageHand(createCage, d).snapshot();
};
// Every finger at one knuckle and one curl (the tip joint follows at 0.75, the thumb's at
// 0.8), and the thumb's three motions.
const handCage = (knuckle, curl, thumb, oppose = -22, abduct = 0) => handAt({
  ...Object.fromEntries(FINGERS.flatMap((f) => [[`${f}Knuckle`, knuckle], [`${f}Curl`, curl]])),
  thumbCurl: thumb, thumbOppose: oppose, thumbAbduct: abduct,
});
// The plan a drag uses: the base delivery's own snapshot at the level its build picked.
const planOf = (snapshot) => subdivPlan(snapshot, levelFor(snapshot, SUBDIV_TOLERANCE.preview, { maxTriangles: SUBDIV_MAX_TRIANGLES.preview }).level);

describe("dragValidity on the cage hand", () => {
  const base = handAt({});
  const plan = planOf(base);

  test("checks at level 1 of the hand's level-3 plan", () => {
    expect(DRAG_CHECK_LEVEL).toBe(1);
    expect(plan.level).toBe(3);
  });

  test("is null across the hand's whole slider range, every corner of it included", () => {
    const corners = [];
    for (const knuckle of [-10, 40, 90]) for (const curl of [0, 40, 80]) for (const thumb of [0, 25, 50]) corners.push([knuckle, curl, thumb, -22]);
    // An open hand, the thumb anywhere in its range: opposed, abducted and curled.
    for (const oppose of [-22, 38, 98]) for (const abduct of [0, 35, 70]) for (const thumb of [0, 25, 50]) corners.push([0, 0, thumb, oppose, abduct]);
    for (const corner of corners) expect(dragValidity(plan, handCage(...corner).points), corner.join(" ")).toBeNull();
    // The part's own bends at their maxima, the thumb neither opposed nor abducted.
    const max = { ...Object.fromEntries(hand.parameters.flatMap((g) => g.controls).map((c) => [c.key, c.max])), thumbOppose: -22, thumbAbduct: 0 };
    expect(dragValidity(plan, handAt(max).points)).toBeNull();
  });

  test("an opposed, curled thumb meets a closed fist: the pose is refused and names the thumb", () => {
    const r = dragValidity(plan, handCage(90, 80, 40, 38).points, { ids: base.ids });
    expect(r?.message).toMatch(/^subdiv: the body passes through itself between /);
    expect(r.message).toMatch(/thumb/);
  });

  test("is null at 240 seeded random poses inside the slider ranges, every bend varied together, the thumb not opposed", () => {
    let seed = 0x5eed1234;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const controls = hand.parameters.flatMap((g) => g.controls);
    const refused = [];
    for (let i = 0; i < 240; i++) {
      const params = { ...Object.fromEntries(controls.map((c) => [c.key, c.min + rand() * (c.max - c.min)])), thumbOppose: -22, thumbAbduct: 0 };
      const snapshot = handAt(params);
      const r = dragValidity(plan, snapshot.points, { ids: base.ids });
      if (r) refused.push({ params, message: r.message, full: meshSubdiv(snapshot, "preview").warnings });
    }
    expect(refused).toEqual([]);
  });

  test("neighbouring base knuckles 100° apart are valid: the strip between two fingers stretches", () => {
    for (const [a, b] of [[90, -10], [-10, 90]])
      expect(dragValidity(plan, handAt({ indexKnuckle: a, middleKnuckle: b, ringKnuckle: a, pinkyKnuckle: b }).points, { ids: base.ids }), `${a} ${b}`).toBeNull();
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
