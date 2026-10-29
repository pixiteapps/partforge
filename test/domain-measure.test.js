// measure() stamps every registered domain's facts on each sub-part row under the
// domain's id; a facts function that throws yields { error } for that row and every
// other row still measures (the shape sheetRowFacts already uses). A row carrying
// domain facts is never served from the measure memo. The registry is mocked to
// carry the fixture domain plus a throwing twin (with no metrics, or the two would
// collide at load — test/domain-metrics-collision.test.js).
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  const throwing = { ...fixture, id: "fixture-throws", oracle: { facts: () => { throw new Error("boom"); }, metrics: {}, checks: [] } };
  return { DOMAINS: Object.freeze([fixture, throwing]) };
});
const { measure } = await import("../src/framework/oracle/measure.js");
const { buildView } = await import("../src/framework/oracle/build.js");
const { createChangeTracker } = await import("../src/framework/oracle/changes.js");
const { bootManifoldKernel } = await import("../src/testing.js");
const { default: demo } = await import("./fixtures/demo-part.js");

test("every row carries each domain's facts under the domain id, a throw as { error }", async () => {
  const k = await bootManifoldKernel();
  const report = measure(k, demo, "all", {}, { now: () => 0 });
  expect(report.subparts.length).toBeGreaterThan(0);
  for (const row of report.subparts) {
    // demo-part defaults r: 10 — a plain part (no print profile, no sheet) still
    // hands its resolved params to a domain's facts.
    expect(row.fixture).toEqual({ seen: row.name, r: 10 });
    expect(row["fixture-throws"]).toEqual({ error: "boom" });
  }
});

test("a row with domain facts is never served from the measure memo", async () => {
  const k = await bootManifoldKernel();
  const t = createChangeTracker();
  const run = () => {
    t.begin("key", "all");
    const built = buildView(k, demo, "all", {});
    t.endBuild(built);
    const m = measure(k, demo, "all", {}, { built, now: () => 0, memo: t.memo });
    t.finish(k, "all", built, m);
    return m;
  };
  run();
  let gets = 0;
  const realGet = t.memo.get;
  t.memo.get = (...a) => { const v = realGet(...a); if (v) gets++; return v; };
  run();
  expect(gets).toBe(0);
});
