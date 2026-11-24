// The cage hand (src/parts/cage-hand.js): a k.subdiv hand whose finger bends come from
// limbs posed in derive, one angles-mode handle per digit. It lints clean, builds watertight
// across its whole parameter range, each limb's tip sits on its cage tip, and posing never
// changes the cage's faces (only its points move).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/oracle.js";
import { lintPart } from "../src/lint.js";
import { resolveParams } from "../src/framework/part-model.js";
import { cage } from "../src/framework/domains/organic/index.js";
import part, { cageHand } from "../src/parts/cage-hand.js";
import organic from "../src/framework/domains/organic/manifest.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
const DIGITS = [...FINGERS, "thumb"];
const CONTROLS = part.parameters.flatMap((g) => g.controls);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The cage at params p, built the way the part's build does: bends from the posed limbs.
function cageAt(p) {
  const { p: params, d } = resolveParams(part, p);
  const bends = Object.fromEntries(DIGITS.map((n) => [n, d[n].values]));
  return { c: cageHand(cage, params, bends), d };
}

let k;
beforeAll(async () => { k = await bootManifoldKernel({ quality: "preview" }); }, 120_000);

test("lints with no errors or warnings", () => {
  const { errors, warnings } = lintPart(part);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});

test("params, derive and handles: one posed limb and one angles-mode handle per digit", () => {
  expect(CONTROLS.map((c) => c.key).sort()).toEqual([
    ...FINGERS.flatMap((f) => [`${f}Knuckle`, `${f}Curl`]), "thumbCurl", "thumbOppose",
  ].sort());
  for (const f of FINGERS) {
    expect(CONTROLS.find((c) => c.key === `${f}Knuckle`)).toMatchObject({ min: -10, max: 90 });
    expect(CONTROLS.find((c) => c.key === `${f}Curl`)).toMatchObject({ min: 0, max: 80 });
  }
  expect(CONTROLS.find((c) => c.key === "thumbCurl")).toMatchObject({ min: 0, max: 50 });
  expect(CONTROLS.find((c) => c.key === "thumbOppose")).toMatchObject({ min: 0, max: 90 });
  expect(Object.keys(part.derive(part.defaults)).sort()).toEqual([...DIGITS].sort());
  expect(Object.keys(part.views).sort()).toEqual(["assembly", "print"]);
  expect(Object.keys(part.handles).sort()).toEqual([...DIGITS, "oppose"].sort());
  expect(part.handles.oppose).toMatchObject({ drag: "rotary", params: ["thumbOppose"], showOn: "hand" });
  // The handle sits on the pad and turns with it about the hinge: its distance from the axis holds.
  const { origin } = part.handles.oppose.axis;
  const radius = (deg) => { const q = part.handles.oppose.point({ ...part.defaults, thumbOppose: deg }); return Math.hypot(q[0] - origin[0], q[1] - origin[1]); };
  expect(radius(90)).toBeCloseTo(radius(0), 6);
  for (const f of FINGERS) expect(part.handles[f]).toEqual({ on: f, drag: "angles", params: [`${f}Knuckle`, `${f}Curl`], joints: { mcp: `${f}Knuckle`, pip: `${f}Curl` } });
  expect(part.handles.thumb).toEqual({ on: "thumb", drag: "angles", params: ["thumbCurl"], joints: { mcp: "thumbCurl" } });
});

test("is listed as an organic reference part", () => {
  expect(organic.referenceParts).toContain("src/parts/cage-hand.js");
});

// Defaults, every parameter at its min at once and at its max at once (a fist: the
// tightest pose the sliders reach), then each parameter alone at its min and at its max.
const CASES = [
  ["defaults", {}],
  ["every parameter at its min", Object.fromEntries(CONTROLS.map((c) => [c.key, c.min]))],
  // A fist: every bend at its max. The thumb is not opposed, since an opposed, curled thumb
  // meets the closed fingers (test/cage-drag-validity.test.js).
  ["every bend at its max", { ...Object.fromEntries(CONTROLS.map((c) => [c.key, c.max])), thumbOppose: 0 }],
  ...CONTROLS.flatMap((c) => [[`${c.key} min`, { [c.key]: c.min }], [`${c.key} max`, { [c.key]: c.max }]]),
];

test.each(CASES)("builds watertight on the preview tier: %s", (_, params) => {
  const report = measure(k, part, "assembly", params);
  expect(report.ok).toBe(true);
  expect(report.subparts.map((s) => s.watertight)).toEqual([true]);
  expect(report.warnings).toEqual([]);
}, 60_000);

test("at its defaults each limb's tip is within 6 mm of its cage tip", () => {
  const { c, d } = cageAt(part.defaults);
  for (const n of DIGITS) expect(dist(d[n].report.tip, c.centroid(`${n}Tip`)), n).toBeLessThan(6);
});

test("posing moves points, never faces: the face count is the same at defaults and at every max", () => {
  const count = cageAt(part.defaults).c.faces().length;
  for (const ctl of CONTROLS) expect(cageAt({ ...part.defaults, [ctl.key]: ctl.max }).c.faces().length, ctl.key).toBe(count);
});

// The flat under the wrist is placed from the cage, so it is the same at every pose: the
// built body's lowest point is that flat, and it removes 0.5 to 3 mm of the smooth body.
test.each(CASES.slice(0, 3))("the flat under the wrist is a real flat, 0.5 to 3 mm deep: %s", (_, params) => {
  const { p, d } = resolveParams(part, params);
  const built = part.parts.hand.build(k, p, d);
  const smoothMin = k.subdiv(cageAt(params).c).boundingBox().min[2];
  const flat = built.boundingBox().min[2];
  expect(flat - smoothMin).toBeGreaterThanOrEqual(0.5);
  expect(flat - smoothMin).toBeLessThanOrEqual(3);
  expect(flat).toBeCloseTo(cageAt(params).c.bounds().min[2] + 2.4, 6);
}, 60_000);
