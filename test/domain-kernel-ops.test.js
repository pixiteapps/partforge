// A domain's kernel ops attach through finishKernel (geometry/kernel-front.js) before
// the compound defaults, so precedence is backend-native, then domain, then compound
// default. The registry is mocked to carry the fixture domain, which tags tappedBore
// (a compound default). domainOfOp is covered in test/domain-registry.test.js.
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([fixture]) };
});
const { finishKernel } = await import("../src/framework/geometry/kernel-front.js");

test("finishKernel runs each domain op's attach, and the attach wins over a compound default", () => {
  const k = finishKernel({});
  expect(k.fixtureAttached).toBe(true);
  // The KERNEL_OP_SPECS loop wraps the attached op like a backend-native one, so it
  // is reached through its options form; the compound default would have built
  // geometry (and thrown on this empty kernel).
  expect(k.tappedBore({ d: 5, pitch: 0.8, turns: 3 })).toBe("fixture");
});

test("a domain op gets the contract's options validation", () => {
  const k = finishKernel({});
  expect(() => k.tappedBore({ d: -1, pitch: 0.8, turns: 3 })).toThrow(/tappedBore: d must be > 0/);
});

test("a backend-native op wins over a domain attach", () => {
  const native = () => "native";
  const k = finishKernel({ tappedBore: native });
  expect(k.fixtureAttached).toBeUndefined();
});

test("the organic manifest's subdiv and cage attaches give an engine-less kernel a refusal and a real cage", async () => {
  // The registry is mocked above, so run the real manifest's attaches by hand, as finishKernel does.
  const organic = (await import("../src/framework/domains/organic/manifest.js")).default;
  const { isCage } = await import("../src/framework/geometry/subdiv/index.js");
  const k = {};
  for (const op of organic.kernelOps) if (k[op.name] === undefined) op.attach(k);
  expect(isCage(k.cage({ box: { size: [2, 2, 2] } }))).toBe(true);
  expect(() => k.subdiv(k.cage({ box: { size: [2, 2, 2] } }))).toThrow(/^subdiv: this kernel has no subdivision engine/);
});
