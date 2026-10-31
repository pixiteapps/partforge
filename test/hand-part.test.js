// The organic domain's reference part (src/parts/hand.js): it lints clean, measures
// watertight with no build warnings, reports its frames, and is the engine's fixture hand.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure, verify } from "../src/oracle.js";
import { lintPart } from "../src/lint.js";
import { BULGE_DEFAULT } from "../src/framework/geometry/implicit/contact.js";
import part, { HAND_DEFAULTS, handSpec } from "../src/parts/hand.js";
import * as fixture from "./fixtures/implicit-trees.js";
import organic from "../src/framework/domains/organic/manifest.js";

let k, report;
beforeAll(async () => {
  k = await bootManifoldKernel();
  report = measure(k, part, "assembly");
}, 120_000);

test("the fixture hand is the part's own builders, at the engine's bulge default", () => {
  expect(fixture.handSpec).toBe(handSpec);
  expect(HAND_DEFAULTS.bulge).toBe(BULGE_DEFAULT);
});

test("the part's defaults are HAND_DEFAULTS' pose", () => {
  const D = HAND_DEFAULTS;
  expect(part.defaults).toEqual({
    curl: D.curl, spread: D.spread, oppose: D.oppose, handLength: D.handLength,
    flexIndex: D.flex.index, flexMiddle: D.flex.middle, flexRing: D.flex.ring, flexPinky: D.flex.pinky, flexThumb: D.flex.thumb,
  });
});

test("lints with no errors and no warnings", () => {
  const r = lintPart(part);
  expect([...r.errors, ...r.warnings].map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
});

test("measures watertight, with no build warnings", () => {
  expect(report.ok).toBe(true);
  expect(report.subparts.map((s) => s.watertight)).toEqual([true]);
  expect(report.warnings).toEqual([]);
});

test("reports every fingertip's frame", () => {
  const tips = report.probes.frames.frames;
  for (const digit of ["index", "middle", "ring", "pinky", "thumb"]) {
    expect(tips[`${digit}.tip`].origin.every(Number.isFinite), digit).toBe(true);
  }
});

test("verifies, and is the organic domain's reference part", () => {
  expect(verify(k, part).ok).toBe(true);
  expect(organic.referenceParts).toEqual(["src/parts/hand.js"]);
});
