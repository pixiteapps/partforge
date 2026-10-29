// Flexing members (oracle/flex-root.js, `verify.flex`): a part names its snap arms,
// prongs and clips by feature label, and verify fails wherever one meets the rest of
// the part at a sharp inside corner — the root a cantilever snaps off at. The defect it
// exists for: a side-release buckle whose 2 mm prongs, unioned square onto the base,
// broke off flush with the base face. Real builds throughout, since the check reads the
// feature labels the kernel stamps on each triangle.
import { beforeAll, describe, expect, it, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";
import { measure } from "../src/framework/oracle/measure.js";
import { buildView } from "../src/framework/oracle/build.js";
import { flexRoot, flexGroups, SHARP_DEG } from "../src/framework/oracle/flex-root.js";
import { lintPart } from "../src/framework/lint/index.js";
import { SUBPART_METRICS, teachableMetrics } from "../src/framework/verify-metrics.js";
import { segsForSagitta, SEGS } from "../src/framework/geometry/circle-segs.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const forge = (build, verifyBlock) => ({
  meta: { title: "Clip", units: "mm" }, defaults: { t: 2 }, views: { v: { label: "V" } },
  parts: { clip: { views: ["v"], build } },
  ...(verifyBlock ? { verify: verifyBlock } : {}),
});
// A 20×10×6 base on y ∈ [0, 10] and a 2×3 arm (`t` thick in X) reaching 15 mm out along
// −Y from its front face, 1 mm into the base so the union is solid.
const base = (k) => k.box({ min: [-10, 0, -3], max: [10, 10, 3] }).label("Base");
const arm = (k, p, h = 3) => k.box({ min: [-p.t / 2, -15, -h / 2], max: [p.t / 2, 1, h / 2] }).label("Arm");
const sharp = (k, p) => k.union([base(k), arm(k, p)]);
// The arm's root edges all lie on the base's front face (y = 0): fillet them there.
const filleted = (k, p) => k.union([base(k), arm(k, p)]).fillet({ r: p.t / 2, edges: { inPlane: "XZ", at: 0 } });
// An arm as tall as the base: its top and bottom run flush into the base's.
const flush = (k, p) => k.union([base(k), arm(k, p, 6)]);
// A grip rib labelled apart, on the arm's +X face near its tip.
const ribbed = (k, p) => k.union([filleted(k, p),
  k.box({ min: [p.t / 2 - 0.5, -13, -1.5], max: [p.t / 2 + 0.6, -12, 1.5] }).label("Arm rib")]);
// The label put on the whole union: every triangle is "the member", so it meets nothing.
const whole = (k, p) => sharp(k, p).label("Arm");
// The finest fillet the mesh fillet draws, 16 segments per circle (blendSegs' floor
// regime, every r <= 1 mm): 22.5° per facet, the coarsest a root can be tessellated.
const fine = (k, p) => k.union([base(k), arm(k, p)]).fillet({ r: 0.3, edges: { inPlane: "XZ", at: 0 } });
// A second, sharp member beside the filleted arm, on the same sub-part.
const twoArms = (k, p) => k.union([filleted(k, p),
  k.box({ min: [4 - p.t / 2, -15, -1.5], max: [4 + p.t / 2, 1, 1.5] }).label("Prong")]);

const mesh = (build) => buildView(kernel, forge(build), "v")[0].mesh;
const flexChecks = (v) => v.cases.flatMap((c) => c.checks).filter((c) => c.metric === "flexRoot");

describe("flexRoot: the reading", () => {
  it("a square root: every root edge, 90°, located on the base face", () => {
    const r = flexRoot(mesh(sharp), ["Arm"]);
    // Two 3 mm sides of the arm and its 2 mm top and bottom.
    expect(r.found).toBe(true);
    expect(r.sharpLength).toBeCloseTo(10, 3);
    expect(r.maxTurn).toBeCloseTo(90, 3);
    expect(r.at[1]).toBeCloseTo(0, 5);
  });

  it("a filleted root reads clean", () => {
    expect(flexRoot(mesh(filleted), ["Arm"])).toEqual({ found: true, attached: true, sharpLength: 0, maxTurn: null, at: null });
  });

  it("the coarsest fillet the mesh fillet draws reads clean too", () => {
    expect(flexRoot(mesh(fine), ["Arm"])).toMatchObject({ attached: true, sharpLength: 0 });
  });

  it("a label that meets nothing is found but not attached, never a clean root", () => {
    expect(flexRoot(mesh(whole), ["Arm"])).toEqual({ found: true, attached: false, sharpLength: 0, maxTurn: null, at: null });
  });

  it("a face that runs flush into the body is not a corner", () => {
    // Only the two 6 mm sides meet the base face square.
    expect(flexRoot(mesh(flush), ["Arm"]).sharpLength).toBeCloseTo(12, 3);
  });

  it("a feature labelled apart on the member counts as the rest of the part unless grouped with it", () => {
    expect(flexRoot(mesh(ribbed), ["Arm"]).sharpLength).toBeGreaterThan(0);
    expect(flexRoot(mesh(ribbed), ["Arm", "Arm rib"]).sharpLength).toBe(0);
  });

  it("a label the mesh does not carry is not found", () => {
    expect(flexRoot(mesh(sharp), ["Prong"])).toMatchObject({ found: false });
  });

  it("the threshold clears the coarsest fillet facet twice over, and a 45° chamfer reads sharp", () => {
    // mesh-fillet's blendSegs: sagitta-sized at min(0.02 mm, 0.02·r), floored at 12 and
    // capped at the tier's count — so every radius under 1 mm draws at the same count.
    // The boundary edge between the member's flat face and the first chord turns by
    // half a facet; the facet itself is what a fillet-to-fillet edge turns, which the
    // reading never sees (both sides are the same feature).
    let coarsest = Infinity;
    for (let r = 0.05; r <= 50; r *= 1.3) coarsest = Math.min(coarsest, segsForSagitta(r, Math.min(0.02, 0.02 * r), 12, SEGS.preview));
    expect(coarsest).toBe(16);
    expect(360 / coarsest).toBeLessThan(SHARP_DEG);   // the boundary's half-facet, twice over
    expect(SHARP_DEG).toBeLessThan(45);
  });

  it("flexGroups: labels and lists of labels; anything else is dropped", () => {
    expect(flexGroups(["A", ["B", "C"], 3, [], ["D", ""], ""])).toEqual([["A"], ["B", "C"]]);
    expect(flexGroups(undefined)).toEqual([]);
    expect(flexGroups("A")).toEqual([]);
  });
});

describe("verify.flex: the gate", () => {
  test("a sharp root fails verify, under any process or none", () => {
    for (const process of [undefined, "fdm-pla", "resin"]) {
      const v = verify(kernel, forge(sharp, { ...(process ? { process } : {}), flex: ["Arm"] }));
      const [c] = flexChecks(v);
      expect(c).toMatchObject({ subpart: "clip", feature: "Arm", kind: "gate", status: "fail", pass: false, pattern: "flex-root-sharp", expr: "0" });
      expect(c.actual).toBeCloseTo(10, 3);
      expect(c.note).toMatch(/"Arm": 10\.0 mm of sharp inside corner \(90°\)/);
      expect(c.hint).toMatch(/half the member's thickness/);
      expect(c.location[1]).toBeCloseTo(0, 5);
      expect(v.ok).toBe(false);
    }
  });

  test("a rounded root passes, and is the part's only declared check", () => {
    const v = verify(kernel, forge(filleted, { flex: ["Arm"] }));
    expect(flexChecks(v)).toEqual([expect.objectContaining({ status: "pass", actual: 0 })]);
    expect(v.ok).toBe(true);
    expect(v.declared).toBe(1);
    expect(v.evaluated).toBe(1);
  });

  test("flexRoot is a registry gate like every other print check: taught, and declarable in expect", () => {
    expect(SUBPART_METRICS.flexRoot).toMatchObject({ kind: "gate", pattern: "flex-root-sharp" });
    expect(teachableMetrics(SUBPART_METRICS)).toContain("flexRoot");
    // An authored expectation on the sub-part replaces the volunteered one: one row, not two.
    const v = verify(kernel, forge(sharp, { flex: ["Arm"], expect: { clip: { flexRoot: "<=12" } } }));
    expect(flexChecks(v)).toEqual([expect.objectContaining({ subpart: "clip", feature: "Arm", status: "pass", expr: "<=12" })]);
    // Authored with no member declared: nothing was read, and the row says why.
    const bare = verify(kernel, forge(sharp, { expect: { clip: { flexRoot: "0" } } }));
    expect(flexChecks(bare)[0]).toMatchObject({ status: "warn", pass: null, actual: null, message: "no root to read" });
    expect(flexChecks(bare)[0].hint).toMatch(/verify\.flex/);
  });

  test("two members on one sub-part: one row, the worst member named, both in the note", () => {
    const v = verify(kernel, forge(twoArms, { flex: ["Arm", "Prong"] }));
    const rows = flexChecks(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subpart: "clip", feature: "Prong", status: "fail" });
    expect(rows[0].note).toMatch(/"Arm": rounded root/);
    expect(rows[0].note).toMatch(/"Prong": 10\.0 mm/);
  });

  test("a label that meets nothing withholds the verdict rather than passing it", () => {
    const v = verify(kernel, forge(whole, { flex: ["Arm"] }));
    const [c] = flexChecks(v);
    expect(c).toMatchObject({ feature: "Arm", status: "skip", pass: null, unevaluated: true });
    expect(c.message).toMatch(/"Arm" never meets the rest of the part/);
    expect(c.hint).toMatch(/apart from the body/);
    expect(v.ok).toBeNull();
  });

  test("nothing declared, nothing checked: an unrounded arm alone is not a defect", () => {
    expect(flexChecks(verify(kernel, forge(sharp, { process: "fdm-pla" })))).toEqual([]);
  });

  test("a member no sub-part carries is a skip naming the label", () => {
    const v = verify(kernel, forge(filleted, { flex: ["Arm", "Prong"] }));
    const skip = flexChecks(v).find((c) => c.feature === "Prong");
    expect(skip).toMatchObject({ status: "skip", pass: null, actual: null });
    expect(skip.message).toMatch(/no sub-part in this view carries the label "Prong"/);
    expect(v.ok).toBe(true);
  });

  test("measure stamps the groups it read; a quick lap on a seed without them withholds the gate", () => {
    const part = forge(filleted, { flex: ["Arm"] });
    expect(measure(kernel, part, "v").measuredFlex).toEqual([["Arm"]]);
    const bare = measure(kernel, part, "v", {}, { flex: [] });
    expect(bare.measuredFlex).toEqual([]);
    expect(bare.subparts[0].flexRoots).toBeNull();
    const quick = verify(kernel, part, { seed: { params: {}, result: bare }, quick: true });
    expect(flexChecks(quick)[0]).toMatchObject({ unevaluated: true, message: "not measured (quick check)" });
    expect(quick.ok).toBeNull();
    // A full lap re-measures rather than reuse that seed.
    expect(verify(kernel, part, { seed: { params: {}, result: bare } }).ok).toBe(true);
  });
});

describe("lint", () => {
  const ids = (part, id) => {
    const r = lintPart(part);
    return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule === id || f.id === id);
  };

  test("verify-bad-flex: the shape", () => {
    expect(ids(forge(sharp, { flex: ["Arm", ["Arm", "Arm rib"]] }), "verify-bad-flex")).toEqual([]);
    expect(ids(forge(sharp, { flex: "Arm" }), "verify-bad-flex")).toHaveLength(1);
    const bad = ids(forge(sharp, { flex: ["Arm", 3, [], ["Arm", ""]] }), "verify-bad-flex");
    expect(bad.map((f) => f.path)).toEqual(["verify.flex[1]", "verify.flex[2]", "verify.flex[3]"]);
    expect(bad[0].severity).toBe("error");
  });

  test("verify-flex-unknown-label: a name no build labels, with a suggestion", () => {
    expect(ids(forge(sharp, { flex: ["Arm"] }), "verify-flex-unknown-label")).toEqual([]);
    const [f] = ids(forge(sharp, { flex: ["Armm"] }), "verify-flex-unknown-label");
    expect(f.severity).toBe("warning");
    expect(f.message).toMatch(/"Armm"/);
    expect(f.hint).toMatch(/did you mean "Arm"/);
  });
});
