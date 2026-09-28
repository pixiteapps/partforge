// Sheet frames and poses — pure math, no kernel. A SheetPose { face, up, at } must be
// a proper rotation for every legal pair (so an engraving never comes out mirrored),
// its rigid steps must land a canonical point exactly where sheetToWorld says, and
// worldToSheet must invert sheetToWorld on the face.
import { describe, expect, test } from "vitest";
import { composePose } from "../src/framework/geometry/pose.js";
import { AXIS_WORDS } from "../src/framework/sheet/constants.js";
import { FLAT_POSE, poseFrame, poseSteps, sheetToWorld, validatePose, worldToSheet } from "../src/framework/sheet/pose.js";

const det = ([a, b, c]) =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const close3 = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

// All 24 legal poses: 6 faces × the 4 axis words perpendicular to each.
const POSES = AXIS_WORDS.flatMap((face) => AXIS_WORDS.filter((up) => up[1] !== face[1])
  .map((up) => ({ face, up, at: [12.5, -7, 3.25] })));

test("there are exactly 24 legal poses and validatePose accepts each", () => {
  expect(POSES).toHaveLength(24);
  for (const pose of POSES) expect(validatePose(pose)).toBeNull();
});

describe.each(POSES)("pose face $face, up $up", (pose) => {
  test("the frame is a proper rotation (det +1): X = up × face", () => {
    const { X, Y, F } = poseFrame(pose);
    expect(det([X, Y, F])).toBe(1);
  });

  test("the rigid steps carry canonical [u, v, t − depth] to sheetToWorld(pose, [u, v], depth)", () => {
    const t = 3;
    const m = composePose(poseSteps(pose, t));
    for (const [u, v, depth] of [[0, 0, 0], [40, 0, 0], [0, 25, 0], [17, 9, 1.5], [3, 5, t]])
      close3(apply(m, [u, v, t - depth]), sheetToWorld(pose, [u, v], depth));
  });

  test("worldToSheet inverts sheetToWorld and ignores the depth", () => {
    for (const [u, v] of [[0, 0], [31.5, -4], [-2, 60]]) {
      const [a, b] = worldToSheet(pose, sheetToWorld(pose, [u, v], 1.2));
      expect(a).toBeCloseTo(u, 9);
      expect(b).toBeCloseTo(v, 9);
    }
  });

  test("poseSteps use only translate and rotate, with finite numbers", () => {
    const steps = poseSteps(pose, 3);
    expect(steps[0]).toEqual({ t: "translate", v: [0, 0, -3] });
    expect(steps.at(-1)).toEqual({ t: "translate", v: [12.5, -7, 3.25] });
    for (const st of steps) {
      expect(["translate", "rotate"]).toContain(st.t);
      if (st.t === "rotate") {
        expect(st.center).toEqual([0, 0, 0]);
        expect([90, 120, 180]).toContain(st.deg);
        expect(st.axis.every(Number.isFinite)).toBe(true);
      }
    }
  });
});

test("an identity pose records no rotation step", () => {
  expect(poseSteps({ face: "+Z", up: "+Y", at: [1, 2, 3] }, 2)).toEqual([
    { t: "translate", v: [0, 0, -2] },
    { t: "translate", v: [1, 2, 3] },
  ]);
});

test("basis rotations keep an exact unit axis", () => {
  // the front panel of a box: laser face −Y, drawing up +Z → 90° about +X
  expect(poseSteps({ face: "-Y", up: "+Z", at: [0, 0, 0] }, 3)[1]).toEqual({ t: "rotate", deg: 90, center: [0, 0, 0], axis: [1, 0, 0] });
});

test("the box poses: drawing +x runs left to right as seen from outside", () => {
  // front: seen from −Y, right is +X
  expect(poseFrame({ face: "-Y", up: "+Z", at: [0, 0, 0] }).X).toEqual([1, 0, 0]);
  // back: seen from +Y, right is −X
  expect(poseFrame({ face: "+Y", up: "+Z", at: [0, 0, 0] }).X).toEqual([-1, 0, 0]);
  // bottom: seen from below with +Y up, right is −X
  expect(poseFrame({ face: "-Z", up: "+Y", at: [0, 0, 0] }).X).toEqual([-1, 0, 0]);
});

test("FLAT_POSE is null — no transform at all", () => {
  expect(FLAT_POSE).toBeNull();
});

describe("validatePose reasons", () => {
  test.each([
    [null, "pose must be a { face, up, at } object"],
    [[0, 0, 0], "pose must be a { face, up, at } object"],
    [{ face: "Z", up: "+Y", at: [0, 0, 0] }, 'face must be one of +X, -X, +Y, -Y, +Z, -Z, got "Z"'],
    [{ face: "+Z", up: "up", at: [0, 0, 0] }, 'up must be one of +X, -X, +Y, -Y, +Z, -Z, got "up"'],
    [{ face: "+Z", up: "-Z", at: [0, 0, 0] }, "up (-Z) must be perpendicular to face (+Z)"],
    [{ face: "+Z", up: "+Y", at: [0, 0] }, "at must be a finite [x, y, z], got [0,0]"],
    [{ face: "+Z", up: "+Y", at: [0, NaN, 0] }, "at must be a finite [x, y, z], got [0,null,0]"],
  ])("%j → %s", (pose, reason) => {
    expect(validatePose(pose)).toBe(reason);
  });
});

test("the converters name themselves when a pose or point is bad", () => {
  const good = { face: "+Z", up: "+Y", at: [0, 0, 0] };
  expect(() => sheetToWorld({ face: "+Z", up: "+Z", at: [0, 0, 0] }, [0, 0]))
    .toThrow("sheetToWorld: up (+Z) must be perpendicular to face (+Z)");
  expect(() => worldToSheet({ face: "+Q", up: "+Y", at: [0, 0, 0] }, [0, 0, 0]))
    .toThrow('worldToSheet: face must be one of +X, -X, +Y, -Y, +Z, -Z, got "+Q"');
  expect(() => sheetToWorld(good, [1])).toThrow("sheetToWorld: point must be a finite [u, v], got [1]");
  expect(() => sheetToWorld(good, [1, 2], "3")).toThrow('sheetToWorld: depth must be a finite number (mm), got "3"');
  expect(() => worldToSheet(good, [1, 2])).toThrow("worldToSheet: point must be a finite [x, y, z], got [1,2]");
});
