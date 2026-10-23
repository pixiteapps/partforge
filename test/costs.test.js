import { beforeAll, expect, test } from "vitest";
import { verify } from "../src/framework/oracle/verify.js";
import { measure } from "../src/framework/oracle/measure.js";
import { SUBPART_METRICS } from "../src/framework/verify-metrics.js";
import { PRINT_PROCESSES } from "../src/framework/process/registry.js";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// A T: a wide slab riding a narrow stem, so the slab's underside is an overhang.
const overhungPart = {
  meta: { title: "Tee", units: "mm" },
  defaults: { w: 20 },
  parts: { tee: { views: ["v"], build: (kk, p) => kk.box({ size: [p.w, 10, 4] }).translate([-p.w / 2, 0, 6])
    .union(kk.box({ size: [4, 10, 6] }).translate([-2, 0, 0])) } },
  views: { v: { label: "V" } },
  verify: { process: "fdm-pla" },
};

test("overhang is a cost under an FDM profile with no orientation key", () => {
  const v = verify(k, overhungPart);
  const c = v.costs.find((c) => c.metric === "overhangArea");
  expect(c).toMatchObject({ status: "cost", kind: "cost", accepted: false });
  expect(v.warnings.find((c) => c.metric === "overhangArea")).toBeUndefined();
  expect(v.failures).toEqual([]);
  expect(v.ok).toBe(true);
});
test("accept marks the cost accepted and changes nothing else", () => {
  const v = verify(k, { ...overhungPart, verify: { process: "fdm-pla", accept: ["supports"] } });
  expect(v.costs[0]).toMatchObject({ metric: "overhangArea", accepted: true });
  expect(v.ok).toBe(true);
});
// `accept` covers the process's own default check only: an author's limit keeps its
// meaning and is never marked accepted.
test("an authored overhang limit is never marked accepted; the default check is", () => {
  const wide = { ...overhungPart, defaults: { w: 210 } };   // ~2,060 mm² of overhang
  const authored = verify(k, { ...wide, verify: { process: "fdm-pla", accept: ["supports"],
    expect: { tee: { overhangArea: "<=500" } } } });
  const a = authored.costs.find((c) => c.metric === "overhangArea");
  expect(a.actual).toBeGreaterThan(2000);
  expect(a).toMatchObject({ status: "cost", expr: "<=500", accepted: false });
  const byDefault = verify(k, { ...wide, verify: { process: "fdm-pla", accept: ["supports"] } });
  expect(byDefault.costs.find((c) => c.metric === "overhangArea")).toMatchObject({ status: "cost", accepted: true });
});
test("an inline base arms it; overhang: null switches it off", () => {
  expect(verify(k, { ...overhungPart, verify: { process: { base: "fdm-pla" } } }).costs).toHaveLength(1);
  expect(verify(k, { ...overhungPart, verify: { process: { base: "fdm-pla", overhang: null } } }).costs).toEqual([]);
});
test("resin reports no overhang cost", () => {
  expect(verify(k, { ...overhungPart, verify: { process: "resin" } }).costs).toEqual([]);
});
test("a quick lap lists the cost under unevaluated, accepted flag intact", () => {
  // A quick lap reuses a seed measured without the overhang pass.
  const part = { ...overhungPart, verify: { process: "fdm-pla", accept: ["supports"] } };
  const seed = { params: { w: 20 }, result: measure(k, part, "v", { w: 20 }, { overhang: null }) };
  const v = verify(k, part, { quick: true, seed });
  const u = v.unevaluated.find((c) => c.metric === "overhangArea");
  expect(u).toMatchObject({ accepted: true, unevaluated: true });
  expect(v.costs).toEqual([]);
});
test("evaluated counts a cost; declared counts it", () => {
  const v = verify(k, overhungPart);
  expect(v.declared).toBeGreaterThanOrEqual(1);
  expect(v.evaluated).toBeGreaterThanOrEqual(1);
});

// The descriptor's `costs` map (id -> metric) and the metric entry's `costId` are two
// declarations of one mapping; registry.js cannot import verify-metrics.js, so a test
// pins them equal in both directions.
test("descriptor costs and metric costIds agree", () => {
  const owners = (id) => PRINT_PROCESSES.filter((d) => Object.hasOwn(d.costs ?? {}, id));
  for (const [name, reg] of Object.entries(SUBPART_METRICS)) {
    if (reg.kind !== "cost") continue;
    expect(typeof reg.costId, name).toBe("string");
    const ds = owners(reg.costId);
    expect(ds, `${name}: costId "${reg.costId}" must be a key of exactly one descriptor's costs`).toHaveLength(1);
    expect(ds[0].costs[reg.costId]).toBe(name);
  }
  for (const d of PRINT_PROCESSES) {
    for (const [id, metric] of Object.entries(d.costs ?? {})) {
      expect(SUBPART_METRICS[metric], `${d.id}.costs.${id}`).toMatchObject({ kind: "cost", costId: id });
    }
  }
});
