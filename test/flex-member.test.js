// The flexing-member model (oracle/flex-root.js, `verify.flex`), beyond the sharp root
// test/flex-root.test.js pins: the root fillet RADIUS against the process's share of the
// member's thickness, the root strain at a declared deflection, and how far the member
// stands off the bed in its print pose. Real builds throughout.
import { beforeAll, describe, expect, it, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";
import { measure } from "../src/framework/oracle/measure.js";
import { buildView } from "../src/framework/oracle/build.js";
import { flexRoot } from "../src/framework/oracle/flex-root.js";
import { flexMembers } from "../src/framework/oracle/flex-members.js";
import { rootFilletFor, strainFor, flexTiltFor, DEFAULT_ROOT_FILLET, DEFAULT_STRAIN, DEFAULT_FLEX_TILT } from "../src/framework/oracle/dfm-profiles.js";
import { FDM } from "../src/framework/process/fdm/descriptor.js";
import { lintPart } from "../src/framework/lint/index.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const forge = (build, verifyBlock, extra = {}) => ({
  meta: { title: "Clip", units: "mm" }, defaults: { t: 2 }, views: { v: { label: "V" } },
  parts: { clip: { views: ["v"], build, ...extra } },
  ...(verifyBlock ? { verify: verifyBlock } : {}),
});
// test/flex-root.test.js's clip: a 20×10×6 base and a 2-thick, 3-tall arm reaching 15 mm
// out along −Y, its root edges on the base's front face (y = 0).
const base = (k) => k.box({ min: [-10, 0, -3], max: [10, 10, 3] }).label("Base");
const arm = (k, p, h = 3) => k.box({ min: [-p.t / 2, -15, -h / 2], max: [p.t / 2, 1, h / 2] }).label("Arm");
const sharp = (k, p) => k.union([base(k), arm(k, p)]);
const filleted = (r) => (k, p) => k.union([base(k), arm(k, p)]).fillet({ r, edges: { inPlane: "XZ", at: 0 } });
const mesh = (build) => buildView(kernel, forge(build), "v")[0].mesh;
const rows = (v, metric) => v.cases.flatMap((c) => c.checks).filter((c) => c.metric === metric);
// Column-major mat4 turning +Y into +Z (90° about X): the arm stood on end.
const standUp = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

describe("flexRoot: the radius, the extents, the tilt", () => {
  it("reads a fillet's radius off the member and the air, whatever the tessellation", () => {
    for (const r of [0.3, 0.6, 1, 2]) {
      const out = flexRoot(mesh(filleted(r)), ["Arm"]);
      expect(out.rootRadius, `r = ${r}`).toBeCloseTo(r, 1);
      expect(Math.abs(out.rootRadius - r) / r, `r = ${r} within 1%`).toBeLessThan(0.01);
    }
    expect(flexRoot(mesh(sharp), ["Arm"]).rootRadius).toBe(0);
  });

  it("the member's extents: thickness its smallest, length its reach, the axis along it", () => {
    const out = flexRoot(mesh(sharp), ["Arm"]);
    expect(out.thickness).toBeCloseTo(2, 3);
    expect(out.length).toBeCloseTo(15, 3);
    expect(Math.abs(out.axis[1])).toBeCloseTo(1, 3);
    // The fillet shortens the exposed arm by its radius.
    expect(flexRoot(mesh(filleted(1)), ["Arm"]).length).toBeCloseTo(14, 3);
  });

  it("tilt: flat in the display pose, standing once the print pose turns it up", () => {
    expect(flexRoot(mesh(sharp), ["Arm"]).tilt).toBeCloseTo(0, 3);
    expect(flexRoot(mesh(sharp), ["Arm"], { printMatrix: standUp }).tilt).toBeCloseTo(90, 3);
  });

  it("flexMembers: labels, lists and member objects; anything else is dropped", () => {
    expect(flexMembers(["A", ["B", "C"], { feature: "D", deflection: 1.5, thickness: 2 }, { feature: "E", labels: ["E", "E rib"] }, 3, {}, { feature: "F", deflection: -1 }]))
      .toEqual([
        { feature: "A", labels: ["A"], deflection: null, thickness: null },
        { feature: "B", labels: ["B", "C"], deflection: null, thickness: null },
        { feature: "D", labels: ["D"], deflection: 1.5, thickness: 2 },
        { feature: "E", labels: ["E", "E rib"], deflection: null, thickness: null },
        { feature: "F", labels: ["F"], deflection: null, thickness: null },
      ]);
  });
});

describe("the profiles arm the readings", () => {
  test("rootFillet: verify.flex alone, half the thickness everywhere, null switches it off", () => {
    expect(rootFilletFor({}, undefined)).toBe(DEFAULT_ROOT_FILLET);
    for (const id of ["fdm-pla", "fdm-petg", "resin"]) expect(rootFilletFor({}, id)).toBe(0.5);
    expect(rootFilletFor({}, { base: "fdm-pla", rootFillet: null })).toBeNull();
    expect(rootFilletFor({}, { base: "fdm-pla", rootFillet: 0.25 })).toBe(0.25);
  });
  test("strain: the material's number, the default with no profile, null switches it off", () => {
    expect(strainFor({}, undefined)).toBe(DEFAULT_STRAIN);
    expect([strainFor({}, "fdm-pla"), strainFor({}, "fdm-petg"), strainFor({}, "resin")]).toEqual([1.5, 3, 2]);
    expect(strainFor({}, { base: "resin", strain: null })).toBeNull();
  });
  test("flexTilt: the FDM profiles alone, or an authored expectation; resin never asks", () => {
    expect(flexTiltFor({}, "fdm-pla")).toBe(45);
    expect(flexTiltFor({}, "resin")).toBeNull();
    expect(flexTiltFor({}, undefined)).toBeNull();
    expect(flexTiltFor({}, "resin", { expanded: [{ expect: { clip: { flexTilt: "<=10" } } }] })).toBe(DEFAULT_FLEX_TILT);
    expect(FDM.costs.standing).toBe("flexTilt");
  });
});

describe("flexRoot: the gate is a ratio of the member's thickness", () => {
  test("half the thickness passes under any process or none; a smaller fillet fails by its radius", () => {
    for (const process of [undefined, "fdm-pla", "resin"]) {
      const ok = verify(kernel, forge(filleted(1), { ...(process ? { process } : {}), flex: ["Arm"] }));
      expect(rows(ok, "flexRoot"), String(process)).toEqual([expect.objectContaining({ status: "pass", actual: 1, expr: ">=1", feature: "Arm" })]);
      const small = verify(kernel, forge(filleted(0.3), { ...(process ? { process } : {}), flex: ["Arm"] }));
      const [c] = rows(small, "flexRoot");
      expect(c).toMatchObject({ status: "fail", actual: 0.3, expr: ">=1", pattern: "flex-root-sharp" });
      expect(c.note).toMatch(/"Arm": root radius 0\.3 mm, needs ≥ 1 \(2 mm thick\)/);
      expect(small.ok).toBe(false);
    }
  });

  test("the profile's share sets the need; a declared thickness overrides the mesh's; null switches the gate off", () => {
    expect(rows(verify(kernel, forge(filleted(0.6), { process: { base: "fdm-pla", rootFillet: 0.25 }, flex: ["Arm"] })), "flexRoot")[0])
      .toMatchObject({ status: "pass", actual: 0.6, expr: ">=0.5" });
    const thick = verify(kernel, forge(filleted(1), { flex: [{ feature: "Arm", thickness: 4 }] }));
    expect(rows(thick, "flexRoot")[0]).toMatchObject({ status: "fail", actual: 1, expr: ">=2" });
    expect(rows(thick, "flexRoot")[0].note).toMatch(/\(4 mm thick\)/);
    const off = verify(kernel, forge(sharp, { process: { base: "fdm-pla", rootFillet: null }, flex: ["Arm"] }));
    expect(rows(off, "flexRoot")).toEqual([]);
  });
});

describe("flexStrain: an advisory from a declared deflection", () => {
  // The filleted arm is 14 mm long and 2 mm thick: 1.5 · 2 · y / 14² = 1.53% per mm of travel.
  test("not read without a deflection; under the limit passes; over it warns, by the material", () => {
    expect(rows(verify(kernel, forge(filleted(1), { process: "fdm-pla", flex: ["Arm"] })), "flexStrain")).toEqual([]);
    const fine = verify(kernel, forge(filleted(1), { process: "fdm-pla", flex: [{ feature: "Arm", deflection: 0.8 }] }));
    expect(rows(fine, "flexStrain")).toEqual([expect.objectContaining({ status: "pass", kind: "warn", expr: "<=1.5", feature: "Arm" })]);
    expect(rows(fine, "flexStrain")[0].actual).toBeCloseTo(1.22, 1);
    for (const [process, status] of [["fdm-pla", "warn"], ["fdm-petg", "pass"], ["resin", "warn"], [undefined, "warn"]]) {
      const v = verify(kernel, forge(filleted(1), { ...(process ? { process } : {}), flex: [{ feature: "Arm", deflection: 1.5 }] }));
      const [c] = rows(v, "flexStrain");
      expect(c.status, String(process)).toBe(status);
      expect(c.actual).toBeCloseTo(2.3, 1);
      expect(c.note).toMatch(/"Arm": 2\.30% at 1\.5 mm \(14 mm long, 2 mm thick\)/);
      if (status === "warn") {
        expect(c).toMatchObject({ pattern: "flex-strain-over", pass: false });
        expect(c.hint).toMatch(/Lengthen the member/);
      }
      expect(v.ok, "a warning never fails").toBe(true);
    }
  });

  test("a declared thickness halves the strain; strain: null switches it off", () => {
    const thin = verify(kernel, forge(filleted(1), { process: "fdm-pla", flex: [{ feature: "Arm", deflection: 1.5, thickness: 1 }] }));
    expect(rows(thin, "flexStrain")[0].actual).toBeCloseTo(1.15, 1);
    const off = verify(kernel, forge(filleted(1), { process: { base: "fdm-pla", strain: null }, flex: [{ feature: "Arm", deflection: 1.5 }] }));
    expect(rows(off, "flexStrain")).toEqual([]);
  });
});

describe("flexTilt: the standing cost", () => {
  const stood = (build) => forge(build, undefined, { place: (s, { purpose }) => (purpose === "export" ? s.rotate(90, [0, 0, 0], [1, 0, 0]) : s) });
  const withVerify = (part, verifyBlock) => ({ ...part, verify: verifyBlock });

  test("an arm lying on the bed passes; one stood up by its print pose is a cost the user may accept", () => {
    const flat = verify(kernel, forge(filleted(1), { process: "fdm-pla", flex: ["Arm"] }));
    expect(rows(flat, "flexTilt")).toEqual([expect.objectContaining({ status: "pass", kind: "cost", expr: "<=45", actual: 0 })]);
    const up = verify(kernel, withVerify(stood(filleted(1)), { process: "fdm-pla", flex: ["Arm"] }));
    const [c] = rows(up, "flexTilt");
    expect(c).toMatchObject({ status: "cost", pass: false, actual: 90, accepted: false, pattern: "flex-member-standing", feature: "Arm" });
    expect(c.note).toMatch(/"Arm": 90° off the bed/);
    expect(up.costs).toContainEqual(expect.objectContaining({ metric: "flexTilt" }));
    expect(up.ok, "a cost never fails").toBe(true);
    const kept = verify(kernel, withVerify(stood(filleted(1)), { process: "fdm-pla", flex: ["Arm"], accept: ["standing"] }));
    expect(rows(kept, "flexTilt")[0].accepted).toBe(true);
  });

  test("resin and a part with no profile never ask; an authored expectation reads it anyway", () => {
    expect(rows(verify(kernel, withVerify(stood(filleted(1)), { process: "resin", flex: ["Arm"] })), "flexTilt")).toEqual([]);
    expect(rows(verify(kernel, withVerify(stood(filleted(1)), { flex: ["Arm"] })), "flexTilt")).toEqual([]);
    const asked = verify(kernel, withVerify(stood(filleted(1)), { process: "resin", flex: ["Arm"], expect: { clip: { flexTilt: "<=10" } } }));
    expect(rows(asked, "flexTilt")[0]).toMatchObject({ status: "cost", expr: "<=10", actual: 90 });
  });

  test("a print pose the probes cannot read leaves the tilt unread", () => {
    const part = forge(filleted(1), { process: "fdm-pla", flex: ["Arm"] },
      { place: (s, { purpose }) => (purpose === "export" && s.volume() > 0 ? s.rotate(90, [0, 0, 0], [1, 0, 0]) : s) });
    const [c] = rows(verify(kernel, part), "flexTilt");
    expect(c).toMatchObject({ status: "skip", actual: null });
    expect(measure(kernel, part, "v").subparts[0].flexRoots[0].tilt).toBeNull();
  });
});

describe("lint", () => {
  const ids = (part, id) => {
    const r = lintPart(part);
    return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule === id || f.id === id);
  };

  test("verify-bad-flex: a member object's fields", () => {
    expect(ids(forge(sharp, { flex: [{ feature: "Arm", deflection: 1, thickness: 2 }, { feature: "Arm", labels: ["Arm", "Arm rib"] }] }), "verify-bad-flex")).toEqual([]);
    const bad = ids(forge(sharp, { flex: [{ feature: 3 }, { feature: "Arm", labels: "x" }, { feature: "Arm", deflection: -1 }, { feature: "Arm", bogus: 1 }] }), "verify-bad-flex");
    expect(bad.map((f) => f.path)).toEqual(["verify.flex[0].feature", "verify.flex[1].labels", "verify.flex[2].deflection", "verify.flex[3].bogus"]);
    expect(bad.every((f) => f.severity === "error")).toBe(true);
  });

  test("verify-flex-unknown-label reads a member object's labels", () => {
    expect(ids(forge(sharp, { flex: [{ feature: "Arm", deflection: 1 }] }), "verify-flex-unknown-label")).toEqual([]);
    const [f] = ids(forge(sharp, { flex: [{ feature: "Armm" }] }), "verify-flex-unknown-label");
    expect(f.hint).toMatch(/did you mean "Arm"/);
  });

  test("accept: [\"standing\"] is a known FDM cost", () => {
    expect(ids(forge(sharp, { process: "fdm-pla", flex: ["Arm"], accept: ["standing"] }), "verify-unknown-accept")).toEqual([]);
    expect(ids(forge(sharp, { process: "resin", flex: ["Arm"], accept: ["standing"] }), "verify-unknown-accept")).toHaveLength(1);
  });
});

test("measure stamps the label groups a member object declares; a seed holding them is reused", () => {
  // No profile: the seed then owes verify nothing but the members (no min wall, no bed).
  const part = forge(filleted(1), { flex: [{ feature: "Arm", deflection: 1 }] });
  const m = measure(kernel, part, "v");
  expect(m.measuredFlex).toEqual([["Arm"]]);
  expect(m.subparts[0].flexRoots[0]).toMatchObject({ feature: "Arm", attached: true, tilt: 0 });
  expect(m.subparts[0].flexRoots[0].rootRadius).toBeCloseTo(1, 1);
  const seeded = verify(kernel, part, { seed: { params: {}, result: m }, measureFn: () => { throw new Error("re-measured"); } });
  expect(rows(seeded, "flexStrain")).toHaveLength(1);
  expect(seeded.ok).toBe(true);
});
