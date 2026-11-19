// The organic domain's reference part (src/parts/organic-hand.js): it lints clean, measures
// watertight with no build warnings, reports its frames, and is the engine's fixture hand.
// Its digits are limbs posed in derive, so Pose mode drags them, and a drag changes only the
// k.implicit frames, so the viewer can skin the last exact mesh while it rebuilds.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure, verify } from "../src/oracle.js";
import { lintPart } from "../src/lint.js";
import { BULGE_DEFAULT } from "../src/framework/geometry/implicit/contact.js";
import { resolveFrames } from "../src/framework/geometry/implicit/frames.js";
import { resolveParams } from "../src/framework/part-model.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { solveAngles } from "../src/framework/pose/param-solve.js";
import { framesOnlyChange } from "../src/framework/skin/frames-only.js";
import part, { HAND_DEFAULTS, handSpec } from "../src/parts/organic-hand.js";
import * as fixture from "./fixtures/implicit-trees.js";
import organic from "../src/framework/domains/organic/manifest.js";

const DIGITS = ["index", "middle", "ring", "pinky", "thumb"];
const presets = () => part.parameters[0].controls[0].presets;
const tipOf = (params, digit) => resolveParams(part, params).d[digit].world("tip").origin;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let k, report;
beforeAll(async () => {
  k = await bootManifoldKernel();
  report = measure(k, part, "assembly");
}, 120_000);

test("the fixture hand is the part's own builders, at the engine's bulge default", () => {
  expect(fixture.handSpec).toBe(handSpec);
  expect(HAND_DEFAULTS.bulge).toBe(BULGE_DEFAULT);
});

test("at its defaults the part's limbs pose the fixture's default hand", () => {
  const { d } = resolveParams(part, part.defaults);
  const want = resolveFrames(handSpec({}).frames);
  const got = resolveFrames(Object.assign({ palm: { at: [0, 0, 0] } }, ...DIGITS.map((n) => d[n].frames)));
  expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
  for (const [name, { world }] of want) {
    got.get(name).world.slice(0, 12).forEach((v, i) => expect(v, `${name}[${i}]`).toBeCloseTo(world[i], 9));
  }
});

test("params: per finger knuckle, curl, spread and lock; thumb opposition, knuckle, curl and lock; hand length", () => {
  const fingers = ["index", "middle", "ring", "pinky"].flatMap((f) => [`${f}Knuckle`, `${f}Curl`, `${f}Spread`]);
  expect(Object.keys(part.defaults).sort()).toEqual([
    ...fingers, "thumbOppose", "thumbKnuckle", "thumbCurl", "handLength", ...DIGITS.map((n) => `${n}Lock`),
  ].sort());
  for (const shape of Object.values(presets())) {
    expect(Object.keys(shape).some((key) => key.endsWith("Lock") || key === "handLength")).toBe(false);
  }
});

test("handles: one angles-mode handle per digit on its limb, locked by its own lock, its knuckle ringed", () => {
  expect(Object.keys(part.handles).sort()).toEqual([...DIGITS].sort());
  for (const [id, h] of Object.entries(part.handles)) {
    expect({ on: h.on, drag: h.drag, lock: h.lock, ring: h.joints.mcp }).toEqual({
      on: id, drag: "angles", lock: `${id}Lock`, ring: `${id}Knuckle`,
    });
  }
});

test("a fingertip drag moves the tip toward the cursor and writes only that finger's params", () => {
  const params = { ...part.defaults };
  // Where a bent middle finger puts its tip: reachable by construction.
  const target = tipOf({ ...params, middleKnuckle: 40, middleCurl: 0.4, middleSpread: 0 }, "middle");
  const allHandles = Object.values(part.handles);
  let at = { ...params };
  for (let i = 0; i < 8; i++) {
    const r = solveAngles({ part, params: at, handle: part.handles.middle, grab: "tip", target, allHandles });
    expect(Object.keys(r.values).sort()).toEqual(["middleCurl", "middleKnuckle", "middleSpread"]);
    at = { ...at, ...r.values };
  }
  expect(dist(tipOf(at, "middle"), target)).toBeLessThan(0.5);
  for (const other of ["index", "ring", "pinky", "thumb"]) expect(tipOf(at, other)).toEqual(tipOf(params, other));
  // A locked digit's own drag moves nothing.
  const self = solveAngles({ part, params: { ...params, middleLock: 1 }, handle: part.handles.middle, grab: "tip", target, allHandles });
  expect(self?.values ?? {}).toEqual({});
});

test("a pose change only moves frames: the probe lets the viewer skin it, a size change does not", () => {
  const rest = probePoses(part, "assembly", part.defaults, { scope: "build" }).get("hand");
  const fist = probePoses(part, "assembly", { ...part.defaults, ...presets().fist }, { scope: "build" }).get("hand");
  const big = probePoses(part, "assembly", { ...part.defaults, handLength: 200 }, { scope: "build" }).get("hand");
  for (const e of [rest, fist]) expect({ trusted: e.trusted, skinnable: e.skinnable }).toEqual({ trusted: true, skinnable: true });
  expect(fist.shapeHash).toBe(rest.shapeHash);
  expect(framesOnlyChange(rest.implicitSpecs, fist.implicitSpecs)).toBe(true);
  expect(big.shapeHash).not.toBe(rest.shapeHash);
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
  for (const digit of DIGITS) {
    expect(tips[`${digit}.tip`].origin.every(Number.isFinite), digit).toBe(true);
  }
});

test("verifies, and is the organic domain's reference part", () => {
  expect(verify(k, part).ok).toBe(true);
  expect(organic.referenceParts).toEqual(["src/parts/organic-hand.js"]);
});
