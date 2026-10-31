// A two-finger hand for the parameter-space IK tests (test/pose-param-solve.test.js):
// a wrist frame turned by `wrist`, and two three-joint fingers `a` and `b` parented on
// it, each posed from a curl and a spread. Handle `a` drags finger a through the wrist
// and its own curl and spread; handle `b` drags finger b through its own two, and is
// frozen while `bLock` is on.
import { limb } from "partforge/kinematics";

const RANGE = [{ name: "mcp", range: [0, 90] }, { name: "pip", range: [0, 90] }];
const finger = (name, x) => limb(name, {
  parent: "wrist",
  at: [x, 0, 40],
  toward: [0, 0, 1],
  bendToward: [0, -1, 0],
  joints: [...RANGE, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
  lengths: [40, 30, 20],
});
const A = finger("a", -12);
const B = finger("b", 12);

export default {
  meta: { title: "IK hand fixture", units: "mm" },
  parameters: [
    { id: "pose", title: "Pose", controls: [
      { key: "wrist", label: "Wrist", unit: "°", min: -60, max: 60, step: 1 },
      { key: "aCurl", label: "A curl", min: 0, max: 1, step: 0.01 },
      { key: "aSpread", label: "A spread", unit: "°", min: -20, max: 20, step: 1 },
      { key: "bCurl", label: "B curl", min: 0, max: 1, step: 0.01 },
      { key: "bSpread", label: "B spread", unit: "°", min: -20, max: 20, step: 1 },
      { key: "bLock", label: "Lock B", type: "checkbox" },
    ] },
  ],
  defaults: { wrist: 0, aCurl: 0.2, aSpread: 0, bCurl: 0.2, bSpread: 0, bLock: 0 },
  derive: (p) => {
    const frames = { wrist: { at: [0, 0, 0], rotate: { axis: "x", deg: p.wrist } } };
    return {
      a: A.pose({ curl: p.aCurl, spread: p.aSpread }, frames),
      b: B.pose({ curl: p.bCurl, spread: p.bSpread }, frames),
    };
  },
  parts: {
    palm: {
      label: "Palm",
      build: (k) => k.box({ min: [-24, -8, 0], max: [24, 8, 40] }),
      views: { hand: (s, p) => s.rotate(p.wrist, [0, 0, 0], [1, 0, 0]) },
    },
  },
  views: { hand: { label: "Hand" } },
  handles: {
    a: { limb: "a", mode: "angles", params: ["wrist", "aCurl", "aSpread"] },
    b: { limb: "b", mode: "angles", params: ["bCurl", "bSpread"], lock: "bLock" },
  },
};
