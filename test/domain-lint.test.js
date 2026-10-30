// Lint folds every domain's rules in from the registry, after the core rules, and runs
// them inside lintPart's guard like any other rule. The registry is mocked to carry the
// fixture domain (test/fixtures/domain-fixture/manifest.js).
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([fixture]) };
});
const { RULES, lintPart } = await import("../src/lint.js");

test("a domain's lint rules join RULES after the core rules", () => {
  expect(RULES.at(-1).id).toBe("fixture-rule");
});

test("a domain rule runs inside lintPart's guard", async () => {
  const { default: demo } = await import("./fixtures/demo-part.js");
  const report = lintPart({ ...demo, fixtureFlag: true });
  expect(report.warnings.map((w) => w.rule)).toContain("fixture-rule");
});
