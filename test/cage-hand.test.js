// The cage hand (src/parts/cage-hand.js): a k.subdiv hand whose finger bends come from
// limbs posed in derive, one angles-mode handle per digit. It lints clean, builds watertight
// across its whole parameter range, each limb's tip sits on its cage tip, and posing never
// changes the cage's faces (only its points move).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/oracle.js";
import { buildView } from "../src/framework/oracle/build.js";
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
    ...FINGERS.flatMap((f) => [`${f}Knuckle`, `${f}Curl`]), "thumbCurl", "thumbOppose", "thumbAbduct",
  ].sort());
  for (const f of FINGERS) {
    expect(CONTROLS.find((c) => c.key === `${f}Knuckle`)).toMatchObject({ min: -10, max: 90 });
    expect(CONTROLS.find((c) => c.key === `${f}Curl`)).toMatchObject({ min: 0, max: 80 });
  }
  expect(CONTROLS.find((c) => c.key === "thumbCurl")).toMatchObject({ min: 0, max: 50 });
  expect(CONTROLS.find((c) => c.key === "thumbOppose")).toMatchObject({ min: 0, max: 120 });
  expect(CONTROLS.find((c) => c.key === "thumbAbduct")).toMatchObject({ min: 0, max: 75 });
  expect(Object.keys(part.derive(part.defaults)).sort()).toEqual([...DIGITS].sort());
  expect(Object.keys(part.views).sort()).toEqual(["assembly", "print"]);
  expect(Object.keys(part.handles).sort()).toEqual([...DIGITS, "oppose", "abduct"].sort());
  expect(part.handles.oppose).toMatchObject({ drag: "rotary", params: ["thumbOppose"], showOn: "hand" });
  expect(part.handles.abduct).toMatchObject({ drag: "rotary", params: ["thumbAbduct"], showOn: "hand" });
  // Each handle's point turns about its handle's axis: its distance from the axis holds
  // across the param's range, with the other motion at rest and part way.
  const fromAxis = (q, { origin, direction }) => {
    const r = q.map((v, i) => v - origin[i]), along = r.reduce((sum, v, i) => sum + v * direction[i], 0);
    return Math.hypot(...r.map((v, i) => v - along * direction[i]));
  };
  for (const abduct of [0, 40]) {
    const radius = (deg) => { const p = { ...part.defaults, thumbOppose: deg, thumbAbduct: abduct }; return fromAxis(part.handles.oppose.point(p), part.handles.oppose.axis(p)); };
    expect(radius(120)).toBeCloseTo(radius(0), 6);
  }
  for (const oppose of [0, 60]) {
    const radius = (deg) => fromAxis(part.handles.abduct.point({ ...part.defaults, thumbOppose: oppose, thumbAbduct: deg }), part.handles.abduct.axis);
    expect(radius(75)).toBeCloseTo(radius(0), 6);
  }
  for (const f of FINGERS) expect(part.handles[f]).toEqual({ on: f, drag: "angles", params: [`${f}Knuckle`, `${f}Curl`], joints: { mcp: `${f}Knuckle`, pip: `${f}Curl` } });
  expect(part.handles.thumb).toEqual({ on: "thumb", drag: "angles", params: ["thumbCurl"], joints: { mcp: "thumbCurl" } });
});

test("is listed as an organic reference part", () => {
  expect(organic.referenceParts).toContain("src/parts/cage-hand.js");
});

// Defaults, every parameter at its min at once and at its max at once (a fist: the
// tightest pose the sliders reach), then each parameter alone at its min and at its max.
const OK_SIGN = { thumbOppose: 50, thumbCurl: 25, indexKnuckle: 50, indexCurl: 65, middleKnuckle: 5, middleCurl: 8, ringKnuckle: 0, ringCurl: 6, pinkyKnuckle: -5, pinkyCurl: 6 };
// Holding a bar of 1.5 inch radius that lies across the palm: the fingers over it, the
// thumb abducted and opposed under it.
const BAR_GRIP = { thumbOppose: 120, thumbAbduct: 60, thumbCurl: 25, ...Object.fromEntries(FINGERS.flatMap((f) => [[`${f}Knuckle`, 50], [`${f}Curl`, 50]])) };
const BAR = { radius: 38.1, y: -66, z: 76 };
const CASES = [
  ["defaults", {}],
  ["every parameter at its min", Object.fromEntries(CONTROLS.map((c) => [c.key, c.min]))],
  // A fist: every bend at its max. The thumb is neither opposed nor abducted, since a thumb
  // in front of the palm meets the closed fingers (test/cage-drag-validity.test.js).
  ["every bend at its max", { ...Object.fromEntries(CONTROLS.map((c) => [c.key, c.max])), thumbOppose: 0, thumbAbduct: 0 }],
  // The OK sign: the thumb opposed until its tip meets the bent index finger's.
  ["the OK sign", OK_SIGN],
  ["the bar grip", BAR_GRIP],
  ...CONTROLS.flatMap((c) => [[`${c.key} min`, { [c.key]: c.min }], [`${c.key} max`, { [c.key]: c.max }]]),
];

test.each(CASES)("builds watertight on the preview tier: %s", (_, params) => {
  const report = measure(k, part, "assembly", params);
  expect(report.ok).toBe(true);
  expect(report.subparts.map((s) => s.watertight)).toEqual([true]);
  expect(report.warnings).toEqual([]);
}, 60_000);

test("the OK sign: the thumb's tip and the index finger's are a fingertip apart", () => {
  const d = part.derive({ ...part.defaults, ...OK_SIGN });
  const gap = Math.hypot(...d.thumb.report.tip.map((v, i) => v - d.index.report.tip[i]));
  expect(gap).toBeGreaterThan(12);
  expect(gap).toBeLessThan(17);
});

test("the bar grip: nothing enters a 1.5 inch radius bar, and the thumb and index finger close round more than half of it", () => {
  const params = { ...part.defaults, ...BAR_GRIP };
  const [{ mesh }] = buildView(k, part, "assembly", params);
  k.cleanup?.();
  const P = mesh.positions, d = part.derive(params);
  const outside = (i) => Math.hypot(P[i + 1] - BAR.y, P[i + 2] - BAR.z) - BAR.radius;
  let deepest = Infinity;
  for (let i = 0; i < P.length; i += 3) deepest = Math.min(deepest, outside(i));
  // Soft skin on a hard bar: within half a millimetre of touching, never deeper.
  expect(deepest).toBeGreaterThan(-0.5);
  // Each tip's pad is within 3 mm of the bar.
  for (const n of ["thumb", "index"]) {
    const tip = d[n].report.tip;
    let gap = Infinity;
    for (let i = 0; i < P.length; i += 3) if (dist([P[i], P[i + 1], P[i + 2]], tip) < 13) gap = Math.min(gap, outside(i));
    expect(gap, n).toBeLessThan(3);
  }
  // Seen along the bar, the arc from the index tip round the front to the thumb tip is
  // the part of the bar the hand leaves open: under 160°, so the hand holds over 200°.
  const angle = (n) => Math.atan2(d[n].report.tip[2] - BAR.z, d[n].report.tip[1] - BAR.y) * (180 / Math.PI);
  const open = (((angle("thumb") - angle("index")) % 360) + 360) % 360;
  expect(open).toBeLessThan(160);
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
