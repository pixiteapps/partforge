import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { resolveFrames } from "../src/framework/geometry/xform.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { lintPart } from "../src/lint.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const finger = (extra = {}) => limb("index", {
  toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80] }],
  lengths: [42, 25, 22], r: [9.5, 8.5, 7.4, 6.4], at: [-30, 96, 2], parent: "palm", ...extra,
});
const palm = { palm: {} };

describe("world and place", () => {
  const box = () => k.box({ min: [-1, 0, -1], max: [1, 4, 1] });
  const corners = [-1, 1].flatMap((x) => [0, 4].flatMap((y) => [-1, 1].map((z) => [x, y, z])));
  const mapped = (M, c) => [0, 1, 2].map((i) => M[3 * i] * c[0] + M[3 * i + 1] * c[1] + M[3 * i + 2] * c[2] + M[9 + i]);

  it("one pose, two engines: place matches the frame's world matrix", () => {
    const posed = finger().pose({ bend: [30, 50, 20], spread: 7, twist: 5 }, palm);
    const W = resolveFrames({ ...palm, ...posed.frames });
    for (const j of [...posed.joints, posed.tip]) {
      const bb = posed.place(box(), j).boundingBox();
      const pts = corners.map((c) => mapped(W.get(j).world, c));
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(bb.min[i] - Math.min(...pts.map((p) => p[i])))).toBeLessThan(0.001);
        expect(Math.abs(bb.max[i] - Math.max(...pts.map((p) => p[i])))).toBeLessThan(0.001);
      }
    }
    // joint names are accepted too
    const a = posed.place(box(), "pip").boundingBox(), b = posed.place(box(), "index.pip").boundingBox();
    expect(a).toEqual(b);
  });
  it("a mirrored limb's place is rigid and matches the frames", () => {
    const posed = finger({ mirror: "YZ" }).pose({ curl: 0.6, spread: 5 }, palm);
    const W = resolveFrames({ ...palm, ...posed.frames });
    for (const j of [...posed.joints, posed.tip]) {
      const placed = posed.place(box(), j);
      const bb = placed.boundingBox();
      const pts = corners.map((c) => mapped(W.get(j).world, c));
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(bb.min[i] - Math.min(...pts.map((p) => p[i])))).toBeLessThan(0.001);
        expect(Math.abs(bb.max[i] - Math.max(...pts.map((p) => p[i])))).toBeLessThan(0.001);
      }
      expect(Math.abs(placed.volume() - 16)).toBeLessThan(1e-6);
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      corners.forEach((c, i) => corners.forEach((c2, m) => expect(Math.abs(d(pts[i], pts[m]) - d(c, c2))).toBeLessThan(1e-9)));
    }
  });
  it("errors: parent frames and unknown joint", () => {
    const posed = finger().pose({});
    expect(() => posed.place(box())).toThrow(/place needs the parent frames/);
    expect(() => posed.world()).toThrow(/world needs the parent frames/);
    // On a parented limb with no frames, the unknown-joint check wins.
    expect(() => posed.place(box(), "pipp")).toThrow(/place: unknown joint "pipp"/);
    const free = limb("f", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a"], lengths: [5] }).pose({});
    expect(() => free.place(box(), "pipp")).toThrow(/place: unknown joint "pipp"/);
    expect(free.world("a").origin).toEqual([0, 0, 0]);
  });
});

describe("the pose fast path", () => {
  const sub = (joint) => ({ build: (kk) => kk.box({ min: [0, 0, 0], max: [2, 8, 2] }), views: { assembly: (s, p, d) => d.f.place(s, joint) } });
  const part = {
    meta: { title: "Limb" },
    defaults: { curl: 0.2 },
    derive: (p) => ({ f: limb("f", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b", "c"], lengths: [20, 15, 10] }).pose({ curl: p.curl }) }),
    parts: { a: sub("a"), b: sub("b"), c: sub("c") },
    views: { assembly: { label: "A", animations: { close: { duration: 1, tracks: { curl: [[0, 0], [1, 1]] } } } } },
  };
  it("curl is pose-only: same baseHash, different pose", () => {
    const lo = probePoses(part, "assembly", { curl: 0.2 }), hi = probePoses(part, "assembly", { curl: 0.8 });
    for (const n of ["a", "b", "c"]) {
      expect(lo.get(n).trusted).toBe(true);
      expect(hi.get(n).trusted).toBe(true);
      expect(hi.get(n).baseHash).toBe(lo.get(n).baseHash);
    }
    for (const n of ["b", "c"]) expect(hi.get(n).pose).not.toEqual(lo.get(n).pose);
  });
  it("lints clean of the pose rules", () => {
    const r = lintPart(part);
    const rules = [...r.errors, ...r.warnings].map((f) => f.rule);
    for (const bad of ["animation-track-rebuilds", "view-pose-not-rigid", "build-throws", "probe-throws"]) expect(rules).not.toContain(bad);
  });
});
