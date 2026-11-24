// The cage hand (src/parts/cage-hand.js): a k.subdiv hand built straight and posed by one
// cage.skin call from the limbs derive poses, one angles-mode handle per digit. It lints
// clean, builds watertight across its whole parameter range, each limb's tip sits on its
// cage tip, and posing never changes the cage's faces (only its points move).
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

// The cage at params p, built the way the part's build does: skinned to derive's limbs.
function cageAt(p) {
  const { d } = resolveParams(part, { ...part.defaults, ...p });
  return { c: cageHand(cage, d), d };
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
  expect(CONTROLS.find((c) => c.key === "thumbAbduct")).toMatchObject({ min: 0, max: 70 });
  const d = part.derive(part.defaults);
  expect(Object.keys(d).sort()).toEqual([...DIGITS].sort());
  // Each finger's limb starts at its base knuckle in the palm; the thumb's at the wrist,
  // with three joints at its root that never move.
  for (const f of FINGERS) expect(d[f].bones.joints.map((j) => j.name)).toEqual([`${f}.mcp`, `${f}.pip`, `${f}.dip`]);
  expect(d.thumb.bones.joints.map((j) => j.name.slice(6))).toEqual(["abduct", "oppose", "lean", "tilt", "roll", "mcp", "ip"]);
  for (const n of DIGITS) expect(d[n].bones.r, n).not.toBeNull();
  expect(Object.keys(part.views).sort()).toEqual(["assembly", "print"]);
  expect(Object.keys(part.handles).sort()).toEqual([...DIGITS].sort());
  for (const f of FINGERS) expect(part.handles[f]).toEqual({ on: f, drag: "angles", params: [`${f}Knuckle`, `${f}Curl`], joints: { mcp: `${f}Knuckle`, pip: `${f}Curl` } });
  expect(part.handles.thumb).toEqual({ on: "thumb", drag: "angles", params: ["thumbCurl"], joints: { abduct: "thumbAbduct", oppose: "thumbOppose", mcp: "thumbCurl" } });
  // Every joint a handle names is one of its limb's.
  for (const [id, h] of Object.entries(part.handles)) {
    const names = d[h.on].ikInfo().joints.map((j) => j.name);
    for (const j of Object.keys(h.joints)) expect(names, `${id}.${j}`).toContain(j);
  }
});

test("is listed as an organic reference part", () => {
  expect(organic.referenceParts).toContain("src/parts/cage-hand.js");
});

// Defaults, every parameter at its min at once and at its max at once (a fist: the
// tightest pose the sliders reach), then each parameter alone at its min and at its max.
// The OK sign: the thumb opposed until its tip meets the bent index finger's.
const OK_SIGN = { thumbOppose: 70, thumbCurl: 15, indexKnuckle: 55, indexCurl: 70, middleKnuckle: 5, middleCurl: 8, ringKnuckle: 0, ringCurl: 6, pinkyKnuckle: -5, pinkyCurl: 6 };
// Holding a bar of 1.5 inch radius that lies across the palm: the fingers over it, the
// thumb abducted and opposed under it.
const BAR_GRIP = { thumbOppose: 120, thumbAbduct: 70, thumbCurl: 25, ...Object.fromEntries(FINGERS.flatMap((f) => [[`${f}Knuckle`, 60], [`${f}Curl`, 45]])) };
const BAR = { radius: 38.1, y: -78, z: 64 };
// One parameter at an end of its range. Neighbouring fingers share the skin between their
// base knuckles, so for a knuckle the other fingers' come within 50° of it, as a hand's do.
const alone = (key, value) => (key.endsWith("Knuckle")
  ? { ...Object.fromEntries(FINGERS.map((f) => [`${f}Knuckle`, Math.min(value + 50, Math.max(value - 50, part.defaults[`${f}Knuckle`]))])), [key]: value }
  : { [key]: value });
const CASES = [
  ["defaults", {}],
  ["every parameter at its min", Object.fromEntries(CONTROLS.map((c) => [c.key, c.min]))],
  // A fist: every bend at its max. The thumb is neither opposed nor abducted, since a thumb
  // in front of the palm meets the closed fingers (test/cage-drag-validity.test.js).
  ["every bend at its max", { ...Object.fromEntries(CONTROLS.map((c) => [c.key, c.max])), thumbOppose: 0, thumbAbduct: 0 }],
  ["the OK sign", OK_SIGN],
  ["the bar grip", BAR_GRIP],
  // An open hand with the thumb at the far corner of its range.
  ["an open hand, the thumb opposed, abducted and curled", { ...Object.fromEntries(FINGERS.flatMap((f) => [[`${f}Knuckle`, 0], [`${f}Curl`, 0]])), thumbOppose: 120, thumbAbduct: 70, thumbCurl: 50 }],
  ...CONTROLS.flatMap((c) => [[`${c.key} min`, alone(c.key, c.min)], [`${c.key} max`, alone(c.key, c.max)]]),
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
  // Each tip's pad is within 4 mm of the bar.
  for (const n of ["thumb", "index"]) {
    const tip = d[n].report.tip;
    let gap = Infinity;
    for (let i = 0; i < P.length; i += 3) if (dist([P[i], P[i + 1], P[i + 2]], tip) < 13) gap = Math.min(gap, outside(i));
    expect(gap, n).toBeLessThan(4);
  }
  // Seen along the bar, the arc from the index tip round the front to the thumb tip is
  // the part of the bar the hand leaves open: under 160°, so the hand holds over 200°.
  const angle = (n) => Math.atan2(d[n].report.tip[2] - BAR.z, d[n].report.tip[1] - BAR.y) * (180 / Math.PI);
  const open = (((angle("thumb") - angle("index")) % 360) + 360) % 360;
  expect(open).toBeLessThan(160);
}, 60_000);

// The poses the tip and face tests read: defaults, the two hand shapes, and every
// parameter alone at each end.
const POSES = CASES.filter(([name]) => name !== "every parameter at its min" && name !== "every bend at its max");

test("each limb's tip is on its cage tip, at rest and posed", () => {
  for (const [name, params] of POSES) {
    const { c, d } = cageAt(params);
    for (const n of DIGITS) expect(dist(d[n].report.tip, c.centroid(`${n}Tip`)), `${name}: ${n}`).toBeLessThan(1);
  }
});

test("posing moves points, never faces: faces and ids are the same at rest and at every pose", () => {
  const rest = cageHand(cage, null).snapshot();
  for (const [name, params] of CASES) {
    const s = cageAt(params).c.snapshot();
    expect(s.faces, name).toEqual(rest.faces);
    expect(s.ids, name).toEqual(rest.ids);
    expect(s.points.length, name).toBe(rest.points.length);
  }
  // The limbs at rest leave the cage as it was built.
  expect(cageHand(cage, part.derive(Object.fromEntries(CONTROLS.map((c) => [c.key, 0])))).snapshot().points).toEqual(rest.points);
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
