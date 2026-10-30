// verify-metrics.js spreads every domain's oracle.metrics into SUBPART_METRICS. The
// registry is mocked to carry the fixture domain (metric `fixtureSeen`).
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([fixture]) };
});
const { SUBPART_METRICS } = await import("../src/framework/verify-metrics.js");

test("a domain metric joins the sub-part vocabulary", () => {
  expect(SUBPART_METRICS.fixtureSeen.kind).toBe("warn");
  expect(SUBPART_METRICS.fixtureSeen.extract({ fixture: { seen: "a" } })).toBe("a");
});
