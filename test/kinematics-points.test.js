// A limb from joint points: `points` (each joint, then the tip) in place of at, lengths and
// joint offsets, with each joint's frame aimed by its own toward, the limb's, or its bone.
import { describe, it, expect } from "vitest";
import { limb } from "../src/framework/domains/kinematics/index.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => Math.sqrt(dot(a, a));
const unit = (a) => a.map((v) => v / norm(a));
const near3 = (a, b, tol) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));
const origins = (bones, half) => [...bones.joints.map((j) => j[half].origin), bones.tip[half]];

const BENT = [[0, 0, 0], [0, 0, 10], [5, 0, 18], [5, -4, 25]];
const bent = (extra = {}) => limb("a", { points: BENT, bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"], ...extra });

describe("limb from points", () => {
  it("a straight limb equals the lengths form", () => {
    const P = limb("a", { points: [[1, 2, 3], [1, 2, 13], [1, 2, 21], [1, 2, 26]], bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"] });
    const L = limb("a", { at: [1, 2, 3], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"], lengths: [10, 8, 5] });
    const p = P.pose({ bend: [30, 20, 10] }), l = L.pose({ bend: [30, 20, 10] });
    expect(p.report).toEqual(l.report);
    p.bones.joints.forEach((j, i) => {
      near3(j.posed.origin, l.bones.joints[i].posed.origin, 1e-12);
      near3(j.posed.y, l.bones.joints[i].posed.y, 1e-12);
    });
  });

  it("a bent polyline rests on its points", () => {
    const { bones } = bent().pose({});
    origins(bones, "rest").forEach((o, i) => near3(o, BENT[i], 1e-9));
    bones.joints.forEach((j, i) => near3(j.rest.y, unit(sub(BENT[i + 1], BENT[i])), 1e-9));
  });

  it("a last bone along its own direction is never read as off its aim", () => {
    // acos of a cosine a hair under 1 reads as ~1e-6°; the angle must come out as 0.
    const pts = [[0, 0, 0], [0, 40, -2], [0, 64, -6], [0, 84, -12]];
    const L = limb("bent", { points: pts, bendToward: [0, 0, -1], joints: ["mcp", "pip", "dip"] });
    near3(L.pose({}).bones.tip.rest, pts[3], 1e-9);
    // Rounding noise in a bone is not an offset: a straight limb's frames carry none.
    const at = L.pose({}).frames["bent.pip"].at;
    expect([at[0], at[2]]).toEqual([0, 0]);
    expect(Math.abs(at[1] - Math.hypot(40, 2))).toBeLessThan(1e-12);
  });

  it("each joint bends about its own bone", () => {
    const L = bent();
    const rest = L.pose({}).bones, posed = L.pose({ bend: { j1: 90 } }).bones;
    expect(Math.abs(norm(sub(posed.tip.posed, BENT[1])) - norm(sub(BENT[3], BENT[1])))).toBeLessThan(1e-9);
    expect(Math.abs(dot(posed.joints[1].posed.y, rest.joints[1].rest.y))).toBeLessThan(1e-9);
    // j0 did not move, and j2 moved with j1.
    near3(posed.joints[0].posed.y, rest.joints[0].rest.y, 1e-12);
    expect(norm(sub(posed.joints[2].posed.origin, BENT[2]))).toBeGreaterThan(1);
  });

  it("a limb toward aims every joint", () => {
    const pts = [[0, 0, 0], [0, 0, 10], [5, 0, 18], [5, 0, 25]];
    const { bones } = limb("a", { points: pts, toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"] }).pose({});
    bones.joints.forEach((j) => near3(j.rest.y, [0, 0, 1], 1e-12));
    origins(bones, "rest").forEach((o, i) => near3(o, pts[i], 1e-9));
  });

  it("a joint's own toward and bendToward", () => {
    const pts = [[0, 0, 0], [0, 0, 0], [10, -3, 20], [16, -6, 30], [20, -8, 38]];
    const thumb = limb("thumb", {
      points: pts, bendToward: [-1, -1, 0],
      joints: [
        { name: "abduct", toward: [0, 0, 1], bendToward: [0, -1, 0] },
        { name: "oppose", axis: "twist", toward: [0, 0, 1], range: [-90, 90] },
        "mcp", "ip",
      ],
    });
    const rest = thumb.pose({}).bones;
    origins(rest, "rest").forEach((o, i) => near3(o, pts[i], 1e-9));
    near3(rest.joints[0].rest.y, [0, 0, 1], 1e-12);
    near3(rest.joints[1].rest.y, [0, 0, 1], 1e-12);
    near3(rest.joints[2].rest.y, unit(sub(pts[3], pts[2])), 1e-12);

    const m = thumb.pose({ bend: { oppose: 40 } }).bones.joints[2].posed.origin;
    expect(Math.abs(m[2] - pts[2][2])).toBeLessThan(1e-9);
    expect(Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(pts[2][0], pts[2][1]))).toBeLessThan(1e-9);
    const turned = Math.acos(dot(unit([m[0], m[1], 0]), unit([pts[2][0], pts[2][1], 0]))) * 180 / Math.PI;
    expect(Math.abs(turned - 40)).toBeLessThan(1e-9);

    const a = thumb.pose({ bend: { abduct: 30 } }).bones.joints[2].posed.origin;
    expect(a[1]).toBeLessThan(pts[2][1] - 5);
  });

  it("a mirrored thumb-shaped limb is the reflection of the plain one", () => {
    const def = (extra) => ({
      points: [[0, 0, 0], [0, 0, 0], [10, -3, 20], [16, -6, 30], [20, -8, 38]], bendToward: [-1, -1, 0],
      joints: [
        { name: "abduct", toward: [0, 0, 1], bendToward: [0, -1, 0] },
        { name: "oppose", axis: "twist", toward: [0, 0, 1], range: [-90, 90] },
        "mcp", "ip",
      ],
      ...extra,
    });
    const plain = limb("thumb", def({})), mirrored = limb("thumb", def({ mirror: "YZ" }));
    for (const opts of [{}, { bend: { abduct: 30, oppose: 40, mcp: 20, ip: 10 } }]) {
      const a = plain.pose(opts).bones, b = mirrored.pose(opts).bones;
      for (const half of ["rest", "posed"]) {
        origins(a, half).forEach((o, i) => near3(origins(b, half)[i], [-o[0], o[1], o[2]], 1e-9));
      }
    }
  });

  it("a re-aimed joint's hinge axis does not move with its own value", () => {
    const L = bent();
    const rest = L.pose({}), posed = L.pose({ bend: { j1: 40 } });
    // j1 carries a fixed turn (its bone leaves j0's line); its axis is read from its own step.
    const info = posed.ikInfo();
    near3(info.axes.j1, rest.ikInfo().axes.j1, 1e-9);
    near3(info.points.j2, posed.bones.joints[2].posed.origin, 1e-3);
    near3(posed.ikForward({}, "j2").origin, posed.bones.joints[2].posed.origin, 1e-12);
    near3(posed.ikForward({}, "tip").origin, posed.bones.tip.posed, 1e-12);
    // ikForward with an override poses like pose itself.
    near3(rest.ikForward({ j1: 40 }, "j2").origin, posed.bones.joints[2].posed.origin, 1e-12);
  });

  it("a mirrored limb is the reflection of the plain one", () => {
    const plain = bent(), mirrored = bent({ mirror: "YZ" });
    for (const opts of [{}, { bend: [20, 30, 10] }]) {
      const a = plain.pose(opts).bones, b = mirrored.pose(opts).bones;
      for (const half of ["rest", "posed"]) {
        origins(a, half).forEach((o, i) => near3(origins(b, half)[i], [-o[0], o[1], o[2]], 1e-9));
      }
    }
  });

  it("the skin reads its bones", () => {
    const { bones } = bent().pose({ bend: [20, 30, 10] });
    expect(bones.kind).toBe("partforge.bones");
    expect(bones.joints).toHaveLength(3);
    for (const j of bones.joints) for (const f of [j.rest, j.posed]) {
      for (const a of [f.x, f.y, f.z]) expect(Math.abs(norm(a) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.x, f.y))).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.y, f.z))).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.x, f.z))).toBeLessThan(1e-12);
    }
  });

  it("hinge axes and rings read the joint's own step, not its fixed turn", () => {
    const info = bent().pose({}).ikInfo();
    // At rest a bend joint's axis is its frame's x (a bend of θ is −θ about local X, so +1 turns about −x).
    info.joints.forEach((j) => near3(info.axes[j.name], info.frames[j.name].x.map((v) => -v), 1e-3));
    expect(Math.abs(dot(info.axes.j1, unit(sub(BENT[2], BENT[1]))))).toBeLessThan(1e-3);
  });

  describe("errors", () => {
    const three = ["j0", "j1", "j2"];
    const cases = [
      ['limb "a".points: replaces at, lengths and joint offsets — remove at', () => limb("a", { points: BENT, at: [0, 0, 0], bendToward: [0, -1, 0], joints: three })],
      ['limb "a".points: replaces at, lengths and joint offsets — remove lengths', () => limb("a", { points: BENT, lengths: [1, 1, 1], bendToward: [0, -1, 0], joints: three })],
      ['limb "a".joints[1].offset: points already place this joint — remove offset', () => limb("a", { points: BENT, bendToward: [0, -1, 0], joints: ["j0", { name: "j1", offset: [1, 0, 0] }, "j2"] })],
      ['limb "a".points: expected 4 entries (one per joint, then the tip), got 3', () => limb("a", { points: BENT.slice(0, 3), bendToward: [0, -1, 0], joints: three })],
      ["limb \"a\".joints[0].toward: this joint's bone has no length, so it needs a toward (its own, or the limb's)", () => limb("a", { points: [[0, 0, 0], [0, 0, 0], [0, 0, 10]], bendToward: [0, -1, 0], joints: ["j0", "j1"] })],
      ["limb \"a\".joints[0].toward: a joint's own toward needs the limb's points", () => limb("a", { toward: [0, 0, 1], bendToward: [0, -1, 0], joints: [{ name: "j0", toward: [0, 0, 1] }], lengths: [10] })],
      ['limb "a".joints[1].bendToward: must not be parallel to this joint\'s aim', () => limb("a", { points: BENT, bendToward: [0, -1, 0], joints: ["j0", { name: "j1", bendToward: [5, 0, 8] }, "j2"] })],
    ];
    for (const [msg, fn] of cases) it(msg, () => expect(fn).toThrow(msg));

    it("the last bone must lie along its joint's aim", () => {
      const fn = () => limb("a", { points: BENT, toward: [0, 0, 1], bendToward: [0, -1, 0], joints: three });
      expect(fn).toThrow("the last bone must lie along its joint's aim");
      expect(fn).toThrow("29.7°");
    });

    it("reach needs a straight limb", () => {
      const fn = () => bent().pose({ reach: [3, -2, 20] });
      expect(fn).toThrow("reach needs a straight limb");
      expect(fn).toThrow("goals");
    });
  });

  it("goals and grip run", () => {
    const L = bent();
    const g = L.pose({ goals: [{ at: "tip", position: [8, -6, 20] }] });
    expect(typeof g.report.goals[0].status).toBe("string");
    expect(Number.isFinite(g.report.goals[0].residual)).toBe(true);
    // A target the limb can reach (its own tip at another pose) is reached.
    const target = L.pose({ bend: [20, 30, 10] }).bones.tip.posed;
    const r = L.pose({ goals: [{ at: "tip", position: target }] }).report.goals[0];
    expect(r.residual).toBeLessThan(0.01);
    expect(r.status).toBe("reached");
    const grip = L.pose({ grip: { around: { kind: "sphere", r: 6, at: [6, -8, 16] }, r: [3, 3, 3, 3] } }).report.grip;
    expect(typeof grip.touching).toBe("boolean");
    expect(Number.isFinite(grip.gap)).toBe(true);
  });

  it("reach works on a limb with one aim and a joint off the line, as with an offset", () => {
    // The limb's frames have local x = −world x, so world x −2 is offset [2, 0, 0].
    const P = limb("a", { points: [[0, 0, 0], [-2, 0, 10], [-2, 0, 18], [-2, 0, 23]], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"] });
    const L = limb("a", { at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["j0", { name: "j1", offset: [2, 0, 0] }, "j2"], lengths: [10, 8, 5] });
    const target = L.pose({ bend: [25, 40, 15] }).bones.tip.posed;
    const p = P.pose({ reach: target }), l = L.pose({ reach: target });
    expect(p.report.reach.status).toBe("reached");
    expect(p.report).toEqual(l.report);
  });

  it("reach still works on a straight limb from points", () => {
    const P = limb("a", { points: [[0, 0, 0], [0, 0, 10], [0, 0, 18], [0, 0, 23]], bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"] });
    expect(P.pose({ reach: [0, -8, 18] }).report.reach.status).toBe("reached");
  });
});
