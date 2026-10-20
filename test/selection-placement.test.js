import { describe, it, expect } from "vitest";
import { planSelectionPlacement, SELECTION_GUTTER } from "../src/framework/selection-placement.js";

const stage = { left: 0, top: 0, width: 800, height: 600 };
const box = { width: 300, height: 120 };

describe("planSelectionPlacement", () => {
  it("centres below the dot with the tail on the dot", () => {
    const p = planSelectionPlacement({ anchor: { x: 400, y: 200, visible: true }, box, stage });
    expect(p).toEqual({ left: 250, top: 210, side: "below", tailOffset: 150, maxHeight: 378 });
  });
  it("goes above when only above fits", () => {
    const p = planSelectionPlacement({ anchor: { x: 400, y: 550 }, box, stage });
    expect(p.side).toBe("above");
    expect(p.top).toBe(550 - 10 - 120);
    expect(p.maxHeight).toBe(528);
  });
  it("neither fits: takes the side with more room and caps maxHeight", () => {
    const tall = { width: 300, height: 560 };
    const low = planSelectionPlacement({ anchor: { x: 400, y: 100 }, box: tall, stage });
    expect(low.side).toBe("below");
    expect(low.maxHeight).toBe(478);
    const high = planSelectionPlacement({ anchor: { x: 400, y: 500 }, box: tall, stage });
    expect(high.side).toBe("above");
    expect(high.top).toBe(12);
    expect(high.maxHeight).toBe(478);
  });
  it("clamps to the gutters on both edges", () => {
    expect(planSelectionPlacement({ anchor: { x: 5, y: 100 }, box, stage }).left).toBe(SELECTION_GUTTER);
    expect(planSelectionPlacement({ anchor: { x: 795, y: 100 }, box, stage }).left).toBe(800 - 12 - 300);
  });
  it("a box wider than the stage pins to the left gutter", () => {
    expect(planSelectionPlacement({ anchor: { x: 100, y: 100 }, box: { width: 900, height: 50 }, stage }).left).toBe(12);
  });
  it("drops the tail when the dot is off screen or too near the box's corner", () => {
    expect(planSelectionPlacement({ anchor: { x: 400, y: 200, visible: false }, box, stage }).tailOffset).toBeNull();
    // clamped hard left: the dot sits 3px into a box that starts at 12
    expect(planSelectionPlacement({ anchor: { x: 15, y: 100 }, box, stage }).tailOffset).toBeNull();
  });
  it("rounds to whole pixels and measures the tail from the rounded left", () => {
    const p = planSelectionPlacement({ anchor: { x: 400.4, y: 200.6 }, box: { width: 301, height: 120 }, stage });
    expect(Number.isInteger(p.left) && Number.isInteger(p.top)).toBe(true);
    expect(p.tailOffset).toBe(Math.round(400.4 - p.left));
  });
});
