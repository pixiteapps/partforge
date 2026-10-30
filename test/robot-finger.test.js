// The kinematics reference part (src/parts/robot-finger.js), and the worked example of
// docs/domains/kinematics.md: three printed links posed by one limb in derive, placed
// with d.finger.place, animated by a single curl param through the pose fast path.
import { beforeAll, describe, expect, test } from "vitest";
import part from "../src/parts/robot-finger.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";
import { lintPart } from "../src/lint.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { resolveParams } from "../src/framework/part-model.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const LINKS = { proximal: "mcp", middle: "pip", distal: "dip" };
const withCurl = (curl) => ({ ...part, defaults: { ...part.defaults, curl } });

test("three link sub-parts; assembly is the first view, print the last; a close animation drives curl 0 → 1", () => {
  expect(Object.keys(part.parts)).toEqual(Object.keys(LINKS));
  expect(Object.keys(part.views)).toEqual(["assembly", "print"]);
  expect(part.defaults.curl).toBe(0.3);
  expect(part.views.assembly.animations.close.tracks).toEqual({ curl: [[0, 0], [1, 1]] });
});

test("the limb: mcp, pip, and dip following pip by 0.75", () => {
  const { d } = resolveParams(part, { curl: 0.8 });
  expect(d.finger.joints).toEqual(["finger.mcp", "finger.pip", "finger.dip"]);
  const [mcp, pip, dip] = d.finger.values;
  expect(mcp).toBeGreaterThan(0);
  expect(dip).toBeCloseTo(0.75 * pip, 9);
  expect(d.finger.report.clamped).toEqual([false, false, false]);
});

test("lints with no errors and no animation-track-rebuilds", () => {
  const r = lintPart(part);
  expect(r.errors).toEqual([]);
  // animation-track-rebuilds is a NOTE, so the notes are read too.
  const rules = [...r.errors, ...r.warnings, ...r.notes].map((f) => f.rule);
  expect(rules).toEqual([]);
  for (const bad of ["animation-track-rebuilds", "view-pose-not-rigid", "build-throws", "probe-throws"]) expect(rules).not.toContain(bad);
});

test("curl is pose-only: every link probe-trusted, one baseHash across curl 0.1 and 0.9", () => {
  const lo = probePoses(part, "assembly", { curl: 0.1 }), hi = probePoses(part, "assembly", { curl: 0.9 });
  for (const name of Object.keys(LINKS)) {
    expect(lo.get(name).trusted, name).toBe(true);
    expect(hi.get(name).trusted, name).toBe(true);
    expect(hi.get(name).baseHash, name).toBe(lo.get(name).baseHash);
  }
  for (const name of ["middle", "distal"]) expect(hi.get(name).pose, name).not.toEqual(lo.get(name).pose);
});

test("each link's placed origin is its joint's world origin", () => {
  for (const curl of [0, 0.3, 0.9]) {
    const { p, d } = resolveParams(part, { curl });
    for (const [name, joint] of Object.entries(LINKS)) {
      const marker = k.box({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
      const { min, max } = part.parts[name].views.assembly(marker, p, d).boundingBox();
      const centre = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
      const want = d.finger.world(joint).origin;
      for (let i = 0; i < 3; i++) expect(Math.abs(centre[i] - want[i]), `${name} @ curl ${curl}`).toBeLessThan(0.002);
    }
  }
});

describe("the verify block: no interpenetration between links", () => {
  test("declared on the assembly view", () => {
    expect(part.verify.expect._view.overlaps).toBe(0);
  });
  test.each([0, 0.9])("verify passes at curl %s", (curl) => {
    const v = verify(k, withCurl(curl));
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
  });
  test("the links stay apart at full curl too, and in the print layout", () => {
    expect(measure(k, part, "assembly", { curl: 1 }).overlaps).toEqual([]);
    expect(measure(k, part, "print").overlaps).toEqual([]);
  });
});
