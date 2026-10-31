// The hand reference part (src/parts/hand.js): five limbs — four fingers and a thumb —
// hanging off a palm limb's wrist frame, posed by curl / spread / oppose params and six
// presets, with an angles-mode handle per digit (lockable) for Pose mode. Every segment
// is a rigid printed piece placed by matrix, and the print view is a flat kit that the
// pose never reaches.
import { beforeAll, expect, test } from "vitest";
import part from "../src/parts/hand.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { lintPart } from "../src/lint.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { resolveParams } from "../src/framework/part-model.js";
import { solveAngles, limbInfo } from "../src/framework/pose/param-solve.js";
import { createPoseSession } from "../src/framework/pose/pose-session.js";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const FINGERS = ["index", "middle", "ring", "pinky"];
const DIGITS = ["thumb", ...FINGERS];
const PRESET_NAMES = ["open", "relaxed", "fist", "point", "peace", "ok"];

/** The `{ type: "preset" }` node's bundles, wherever it sits in the schema. */
function presets() {
  const found = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n?.type === "preset") found.push(n.presets);
      if (Array.isArray(n?.controls)) walk(n.controls);
    }
  };
  walk(part.parameters);
  expect(found).toHaveLength(1);
  return found[0];
}

const withParams = (over) => ({ ...part, defaults: { ...part.defaults, ...over } });

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("limbs: a palm with wristPitch and wristYaw; four fingers spread, mcp, pip, dip (0.75 × pip); a thumb oppose, mcp, ip", () => {
  const { d } = resolveParams(part, {});
  expect(d.palm.joints).toEqual(["palm.wristPitch", "palm.wristYaw"]);
  for (const f of FINGERS) {
    expect(d[f].joints, f).toEqual(["spread", "mcp", "pip", "dip"].map((j) => `${f}.${j}`));
    const [, , pip, dip] = resolveParams(part, { [`${f}Curl`]: 0.7 }).d[f].values;
    expect(dip, f).toBeCloseTo(0.75 * pip, 9);
  }
  expect(d.thumb.joints).toEqual(["thumb.oppose", "thumb.mcp", "thumb.ip"]);
});

test("the fingers hang off the palm: turning the wrist moves every fingertip", () => {
  const rest = resolveParams(part, { wristPitch: 0 }).d;
  const bent = resolveParams(part, { wristPitch: 30 }).d;
  for (const f of DIGITS) expect(bent[f].report.tip, f).not.toEqual(rest[f].report.tip);
});

test("params: per finger curl, spread and lock; thumb oppose, curl and lock; wrist pitch and yaw", () => {
  const keys = [
    ...FINGERS.flatMap((f) => [`${f}Curl`, `${f}Spread`, `${f}Lock`]),
    "thumbOppose", "thumbCurl", "thumbLock", "wristPitch", "wristYaw",
  ];
  for (const key of keys) expect(typeof part.defaults[key], key).toBe("number");
});

test("handles: one angles-mode handle per digit — its curl and spread plus the wrist, locked by its own lock", () => {
  expect(Object.keys(part.handles).sort()).toEqual([...DIGITS].sort());
  for (const f of FINGERS) {
    expect(part.handles[f]).toEqual({ limb: f, mode: "angles", params: [`${f}Curl`, `${f}Spread`, "wristPitch", "wristYaw"], lock: `${f}Lock` });
  }
  expect(part.handles.thumb).toEqual({ limb: "thumb", mode: "angles", params: ["thumbCurl", "thumbOppose", "wristPitch", "wristYaw"], lock: "thumbLock" });
});

test("presets: open, relaxed, fist, point, peace and ok; none touches a lock", () => {
  const all = presets();
  expect(Object.keys(all).sort()).toEqual([...PRESET_NAMES].sort());
  for (const [name, bundle] of Object.entries(all)) {
    for (const key of Object.keys(bundle)) {
      expect(key in part.defaults, `${name}.${key}`).toBe(true);
      expect(key.endsWith("Lock"), `${name}.${key}`).toBe(false);
    }
  }
});

test("fist curls every finger to at least 0.8", () => {
  const fist = presets().fist;
  for (const f of FINGERS) expect(fist[`${f}Curl`], f).toBeGreaterThanOrEqual(0.8);
});

test("lints with zero errors", () => {
  expect(lintPart(part).errors).toEqual([]);
});

test.each(PRESET_NAMES)("preset %s lints clean and builds with no interpenetrating segments", (name) => {
  const posed = withParams(presets()[name]);
  expect(lintPart(posed).errors).toEqual([]);
  const m = measure(k, posed, "assembly");
  expect(m.subparts.length).toBe(Object.keys(part.parts).length);
  expect(m.overlaps).toEqual([]);
});

test("the pose never reaches the print: the print view's bounding boxes match at the default pose and at fist", () => {
  const boxes = (params) => Object.fromEntries(measure(k, part, "print", params).subparts.map((s) => [s.name, s.bounds]));
  const rest = boxes({});
  const fist = boxes(presets().fist);
  expect(Object.keys(rest).length).toBe(Object.keys(part.parts).length);
  expect(fist).toEqual(rest);
  expect(measure(k, part, "print").overlaps).toEqual([]);
});

test("posing is matrix-only: every segment probe-trusted, one baseHash across relaxed and fist", () => {
  const a = probePoses(part, "assembly", presets().relaxed);
  const b = probePoses(part, "assembly", presets().fist);
  for (const name of Object.keys(part.parts)) {
    expect(a.get(name).trusted, name).toBe(true);
    expect(b.get(name).baseHash, name).toBe(a.get(name).baseHash);
  }
});

test("a drag writes only the handle's params, and a locked digit's params stay put", () => {
  const params = { ...part.defaults };
  const tip = resolveParams(part, params).d.middle.report.tip;
  const target = [tip[0], tip[1] + 10, tip[2] - 10];
  const allHandles = Object.values(part.handles);
  const free = solveAngles({ part, params, handle: part.handles.middle, grab: "tip", target, allHandles });
  expect(Object.keys(free.values).sort()).toEqual(["middleCurl", "middleSpread", "wristPitch", "wristYaw"].sort());
  // Locking the index freezes everything its handle lists — the wrist too — so a
  // middle-finger drag can move only the middle finger's own params.
  const locked = solveAngles({ part, params: { ...params, indexLock: 1 }, handle: part.handles.middle, grab: "tip", target, allHandles });
  expect(Object.keys(locked.values).sort()).toEqual(["middleCurl", "middleSpread"]);
  // A locked digit's own drag moves nothing.
  const self = solveAngles({ part, params: { ...params, middleLock: 1 }, handle: part.handles.middle, grab: "tip", target, allHandles });
  expect(self.values).toEqual({});
});

test("releasing a fingertip drag settles invisibly: the snap moves no tip 0.2 mm or more", () => {
  const tips = (params) => Object.fromEntries(DIGITS.map((id) => [id, limbInfo(part, params, part.handles[id]).points.tip]));
  for (const [id, step] of [["index", [-3, 4, -2]], ["thumb", [4, 3, 2]], ["pinky", [2, -3, 3]]]) {
    const params = { ...part.defaults };
    const session = createPoseSession({
      part, getParams: () => params, write: (v) => Object.assign(params, v), commit() {}, restore: (v) => Object.assign(params, v),
    });
    expect(session.begin(id, "tip")).toBe(true);
    const start = tips(params)[id];
    for (let i = 1; i <= 6; i++) session.frame(start.map((c, j) => c + step[j] * i));
    const before = tips(params);
    session.end();
    const after = tips(params);
    for (const d of DIGITS) expect(dist(after[d], before[d]), `${id} drag: ${d} tip`).toBeLessThan(0.2);
  }
});
