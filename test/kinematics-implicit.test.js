// The kinematics domain's implicit adapter: a posed limb's flesh() and attach() are plain
// k.implicit data the grammar accepts, and the limb's frames are the ones k.implicit reports.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { validateSpec } from "../src/framework/geometry/implicit/grammar.js";
import { limb } from "../src/framework/domains/kinematics/index.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const finger = (extra = {}) => limb("index", {
  toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80] }],
  lengths: [42, 25, 22], r: [9.5, 8.5, 7.4, 6.4], at: [-30, 96, 2], parent: "palm", ...extra,
});
const palm = { palm: {} };

describe("flesh and attach", () => {
  it("flesh validates and matches the limb", () => {
    const posed = finger().pose({ curl: 0.5 }, palm);
    const root = posed.flesh({ r: [9.5, 8.5, 7.4, 6.4], blend: 3 });
    expect(() => validateSpec({ frames: { ...palm, ...posed.frames }, root })).not.toThrow();
    expect(root).toMatchObject({ kind: "union", k: 3, label: "index" });
    expect(root.children).toEqual([
      { kind: "capsule", frame: "index.mcp", b: [0, 42, 0], r: [9.5, 8.5], label: "index.mcp" },
      { kind: "capsule", frame: "index.pip", b: [0, 25, 0], r: [8.5, 7.4], label: "index.pip" },
      { kind: "capsule", frame: "index.dip", b: [0, 22, 0], r: [7.4, 6.4], label: "index.dip" },
    ]);
  });
  it("flesh takes r from the limb, and a label", () => {
    const root = finger().pose({}, palm).flesh({ blend: 2, label: "pointer" });
    expect(root.label).toBe("pointer");
    expect(root.children.map((c) => c.r)).toEqual([[9.5, 8.5], [8.5, 7.4], [7.4, 6.4]]);
  });
  it("flesh errors: no r, wrong count; a SpecError with code SPEC", () => {
    const l = limb("s", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [5, 5] });
    expect(() => l.pose({}).flesh({ blend: 1 })).toThrow('limb "s": flesh needs r — pass r, or set r on the limb');
    expect(() => l.pose({}).flesh({ r: [3, 2] })).toThrow('limb "s".r: expected 3 radii, got 2');
    let caught;
    try { l.pose({}).flesh(); } catch (e) { caught = e; }
    expect(caught.name).toBe("SpecError");
    expect(caught.code).toBe("SPEC");
  });
  it("skips zero-length segments", () => {
    const l = limb("s", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [0, 10], r: [3, 3, 2] });
    expect(l.pose({}).flesh({ blend: 1 }).children.map((c) => c.frame)).toEqual(["s.b"]);
  });
  it("attach defaults and validates in a contact root", () => {
    const posed = finger().pose({}, palm);
    const at = posed.attach("palm", { k: 8 });
    expect(at).toEqual({ a: "index", b: "palm", near: "index.mcp", radius: 14, band: 3, k: 8 });
    const root = { kind: "contact", gap: 0, attach: [at], children: [
      { kind: "box", frame: "palm", size: [10, 10, 10], label: "palm" }, posed.flesh({ blend: 3 })] };
    expect(() => validateSpec({ frames: { ...palm, ...posed.frames }, root })).not.toThrow();
  });
  it("attach's radius skips zero-length segments, and `a` names the flesh label", () => {
    const l = limb("s", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [0, 12], r: [3, 3, 2] });
    expect(l.pose({}).attach("palm", { k: 1, a: "thumb" })).toMatchObject({ a: "thumb", near: "s.a", radius: 4 });
  });
  it("attach with a non-array r throws", () => {
    const l = limb("s", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a"], lengths: [10] });
    expect(() => l.pose({}).attach("palm", { k: 1, r: 5 })).toThrow(/limb "s": attach r must be an array/);
    expect(l.pose({}).attach("palm", { k: 1, r: [5, 4] }).band).toBeCloseTo(15 / 9.5);
  });
  it("attach without r or band throws", () => {
    const l = limb("s", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a"], lengths: [9] });
    expect(() => l.pose({}).attach("palm", { k: 1 })).toThrow(/limb "s": attach needs r for its default band — pass band or r/);
    expect(l.pose({}).attach("palm", { k: 1, band: 2 }).band).toBe(2);
  });
});

describe("flesh and attach refuse what the grammar would", () => {
  const zero = () => limb("z", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [0, 0], r: [3, 3, 2] });
  const K = 'limb "s".attach: k is required (the blend width in mm where the limb joins palm)';
  it("attach requires a finite k >= 0", () => {
    const l = limb("s", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a"], lengths: [10], r: [3, 2] });
    expect(() => l.pose({}).attach("palm")).toThrow(K);
    expect(() => l.pose({}).attach("palm", {})).toThrow(K);
    expect(() => l.pose({}).attach("palm", { k: -1 })).toThrow(K);
    expect(() => l.pose({}).attach("palm", { k: NaN })).toThrow(K);
    expect(() => l.pose({}).attach("palm", { k: "8" })).toThrow(K);
    expect(l.pose({}).attach("palm", { k: 0 }).k).toBe(0);
  });
  it("an all-zero-length limb has no flesh or attach", () => {
    expect(() => zero().pose({}).flesh({ blend: 1 })).toThrow('limb "z".flesh: the limb has no segment with length > 0');
    expect(() => zero().pose({}).attach("palm", { k: 1 })).toThrow('limb "z".attach: the limb has no segment with length > 0');
  });
});

describe("the limb's frames are k.implicit's frames", () => {
  it("world agrees with the frame report", () => {
    const posed = finger().pose({ bend: [30, 50, 20], spread: 7 }, palm);
    const spec = { frames: { ...palm, ...posed.frames }, root: { kind: "sphere", r: 1, frame: "palm" } };
    const rep = k.implicitFrames(spec).report().frames;
    for (const j of [...posed.joints, posed.tip]) expect(posed.world(j)).toEqual(rep[j]);
    expect(posed.world("pip")).toEqual(rep["index.pip"]);
    expect(posed.world("tip")).toEqual(rep["index.tip"]);
    expect(posed.world()).toEqual(rep["index.mcp"]);
  });
});
