// A test-only domain manifest. It is never in src/framework/domains/registry.js's
// DOMAINS: seam tests `vi.mock` the registry to return it, so every consumer (kernel
// front, lint, measure, verify-metrics, the process registry, the guide index) is
// exercised against a domain that declares one of everything.
import { warn } from "../../../src/framework/lint/finding.js";

export default {
  id: "fixture",
  title: "Fixture",
  when: "a test-only domain; never in a real part",
  subpath: "partforge/fixture",
  guide: "test/fixtures/domain-fixture/guide.md",
  referenceParts: [],
  // tappedBore is a contract op with a compound default and no backend
  // implementation, so tagging it is legal and the attach observably wins.
  kernelOps: [{ name: "tappedBore", attach: (k) => { k.fixtureAttached = true; k.tappedBore = () => "fixture"; } }],
  lintRules: [{ id: "fixture-rule", run: (ctx) => (ctx.part?.fixtureFlag ? [warn("fixture-rule", "fixture flag set", "a fixture hint")] : []) }],
  oracle: {
    facts: (sp, ctx) => ({ seen: ctx?.name ?? null }),
    metrics: { fixtureSeen: { kind: "warn", extract: (s) => s.fixture?.seen, hint: "fixture metric", doc: "fixture" } },
    checks: [],
  },
  processes: [],
  workerSafe: true,
};
