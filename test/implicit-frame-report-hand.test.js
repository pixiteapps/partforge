// The frame report on the reference hand: the checks the October grip trial was missing.
import { test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("fist: index fingertip lies inside the palm's label box", () => {
  const f = k.implicitFrames(handSpec(HAND_POSES.fist)).report();
  const tip = f.frames["index.tip"].origin, palm = f.labels.palm;
  for (let i = 0; i < 3; i++) {
    expect(tip[i], `axis ${i}: tip ${tip} palm ${palm.min}..${palm.max}`).toBeGreaterThanOrEqual(palm.min[i]);
    expect(tip[i], `axis ${i}: tip ${tip} palm ${palm.min}..${palm.max}`).toBeLessThanOrEqual(palm.max[i]);
  }
});

test("the placement pattern keeps solid and frames together", () => {
  // Every joint sits inside the flesh, so after the same placement every frame origin
  // lies inside the placed solid's bounds. (Label boxes are generous by up to a blend's
  // reach, ~20 mm on the palm, so they are not the check here.)
  const place = (x) => x.rotateY(180);
  const hand = place(k.implicit(handSpec()));
  const lift = [0, 0, -hand.boundingBox().min[2]];
  const bb = hand.translate(lift).boundingBox();
  const { frames } = place(k.implicitFrames(handSpec())).translate(lift).report();
  for (const [name, f] of Object.entries(frames)) {
    for (let i = 0; i < 3; i++) {
      expect(f.origin[i], `${name} axis ${i}`).toBeGreaterThanOrEqual(bb.min[i] - 0.5);
      expect(f.origin[i], `${name} axis ${i}`).toBeLessThanOrEqual(bb.max[i] + 0.5);
    }
  }
});
