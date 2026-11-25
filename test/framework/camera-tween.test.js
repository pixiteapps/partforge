// Pure orbit-tween math: eased spherical interpolation, shortest-path azimuth,
// pole clamping, retargeting, cancel.
import { expect, test, vi } from "vitest";
import { createCameraTween, tweenPoseAt } from "../../src/framework/camera-tween.js";

const FROM = { position: [10, 0, 0], target: [0, 0, 0] };

test("update interpolates from → to and reports done at the end", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  expect(mid.done).toBe(false);
  // radius preserved through the arc (both poses are 10 from the target)
  expect(Math.hypot(...mid.position)).toBeCloseTo(10, 5);
  const end = tw.update(0.5);
  expect(end.done).toBe(true);
  expect(end.position[0]).toBeCloseTo(0, 5);
  expect(end.position[2]).toBeCloseTo(10, 5);
  expect(tw.isActive()).toBe(false);
});

test("azimuth takes the short way around", () => {
  const tw = createCameraTween();
  // +x → -z is -90° the short way; the long way would pass through -x
  tw.start(FROM, { position: [0, 0, -10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  expect(mid.position[0]).toBeGreaterThan(0); // stays on the +x side of the arc
});

// The regression: the destination used to be clamped 0.01 rad off the pole, so
// every "top"/"bottom" cue landed 0.573° short of the axis and a top view kept a
// sliver of side wall in it. Both poles, because the clamp had two ends.
test.each([
  ["top", [0, 10, 0]],
  ["bottom", [0, -10, 0]],
])("a straight-overhead %s destination lands exactly on the axis", (_name, position) => {
  const tw = createCameraTween();
  tw.start(FROM, { position, target: [0, 0, 0] }, { duration: 1 });
  const end = tw.update(1);
  const horizontal = Math.hypot(end.position[0], end.position[2]);
  // Exactly on the Y axis: no horizontal offset at all, to the last ulp.
  expect(horizontal).toBeLessThan(1e-12);
  expect(end.position[1]).toBeCloseTo(position[1], 12);
});

test("the arc into a pole approaches it monotonically, never overshooting", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 10, 0], target: [0, 0, 0] }, { duration: 1 });
  let previous = Infinity;
  for (let i = 0; i < 10; i++) {
    const step = tw.update(0.1);
    const horizontal = Math.hypot(step.position[0], step.position[2]);
    expect(horizontal).toBeLessThanOrEqual(previous);
    previous = horizontal;
  }
});

test("onComplete fires exactly once, at the end", () => {
  const done = vi.fn();
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1, onComplete: done });
  tw.update(0.5);
  expect(done).not.toHaveBeenCalled();
  tw.update(0.6);
  expect(done).toHaveBeenCalledTimes(1);
});

test("restart while active retargets from the caller-supplied current pose", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  tw.start({ position: mid.position, target: mid.target },
    { position: [-10, 0, 0], target: [0, 0, 0] }, { duration: 1 });
  expect(tw.update(0).position[0]).toBeCloseTo(mid.position[0], 5); // no jump at retarget
});

test("cancel drops the tween and suppresses onComplete", () => {
  const done = vi.fn();
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1, onComplete: done });
  tw.cancel();
  expect(tw.update(1)).toBeNull();
  expect(done).not.toHaveBeenCalled();
});

test("duration 0 completes on the first update (reduced-motion jump cut)", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 0 });
  expect(tw.update(0.016).done).toBe(true);
});

test("update() and tweenPoseAt agree at every sampled time", () => {
  // +x → -z with a moving target: the short-way azimuth wrap must match too
  const to = { position: [0, 3, -10], target: [2, 1, 0] };
  const tw = createCameraTween();
  tw.start(FROM, to, { duration: 1 });
  let elapsed = 0;
  for (let i = 0; i < 12; i++) {
    elapsed += 0.1;
    const out = tw.update(0.1);
    const pure = tweenPoseAt(FROM, to, elapsed / 1);
    expect({ position: out.position, target: out.target }).toEqual(pure);
    if (out.done) break;
  }
  expect(tw.isActive()).toBe(false);
});

test("tweenPoseAt lands on its ends exactly and takes the short way", () => {
  const to = { position: [0, 0, -10], target: [0, 0, 0] };
  expect(tweenPoseAt(FROM, to, 0)).toEqual(FROM);
  expect(tweenPoseAt(FROM, to, 1)).toEqual(to);
  expect(tweenPoseAt(FROM, to, 0.5).position[0]).toBeGreaterThan(0);
  // a pure function: the inputs are not touched or aliased
  const out = tweenPoseAt(FROM, to, 1);
  out.position[0] = 99;
  expect(to.position[0]).toBe(0);
});
