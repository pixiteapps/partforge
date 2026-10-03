// test/param-deps-subpart.test.js
import { expect, test } from "vitest";
import { subPartReadKeys, relevantParamKeys, relevanceHash, RELEVANT_ALL, recordedRelevantKeys, subPartParamKeys } from "../src/framework/param-deps.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    one: { views: ["v"], build: (k, p) => k.cylinder({ r: p.a, h: p.a }) },   // reads a only
    two: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.b, p.b, p.b] }) }, // reads b only
  },
};

test("each sub-part's read set contains only the params it reads", () => {
  const map = subPartReadKeys(part, "v", part.defaults);
  expect([...map.get("one")]).toEqual(["a"]);
  expect([...map.get("two")]).toEqual(["b"]);
});

// Regression: the probe kernel must implement the full solid build-step vocabulary
// (at / along / rotateX|Y|Z / rotateAbout). If it doesn't, a build using any of them
// throws inside relevantParamKeys, which silently falls back to RELEVANT_ALL — so the
// panel stops dimming/hiding controls. Every real part uses .at(), so this guards them.
const vocab = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    p: { views: ["v"], build: (k, p) =>
      k.cylinder({ r: p.a, h: p.a })
        .at([0, 0, 0]).along("+Z").rotateX(0).rotateY(0).rotateZ(0).rotateAbout({ axis: "Z", deg: p.a }) },
  },
};

test("relevance analysis handles the build-step vocabulary instead of falling back to RELEVANT_ALL", () => {
  const r = relevantParamKeys(vocab, "v", vocab.defaults);
  expect(r).not.toBe(RELEVANT_ALL);   // probe must not throw on at/along/rotate*
  expect([...r]).toContain("a");      // read by cylinder + rotateAbout
  expect([...r]).not.toContain("b");  // never read → stays irrelevant (the whole point)
});

test("relevance analysis survives an unknown/future solid op — the probe is drift-proof", () => {
  // Hardening: the probe must not throw when a build calls a kernel/solid method it hasn't
  // been told about (the exact drift that broke relevance when the build-step vocabulary
  // landed). A made-up op should be tolerated, not collapse the analysis to RELEVANT_ALL.
  const future = {
    defaults: { a: 1 }, views: view,
    parts: { p: { views: ["v"], build: (k, p) =>
      k.cylinder({ r: p.a, h: p.a }).someFutureOp(p.a).at([0, 0, 0]) } },
  };
  const r = relevantParamKeys(future, "v", future.defaults);
  expect(r).not.toBe(RELEVANT_ALL);
  expect([...r]).toContain("a");
});

test("relevanceHash is stable for equal values and differs when a value changes", () => {
  expect(relevanceHash(["a"], { a: 1, b: 2 })).toBe(relevanceHash(["a"], { a: 1, b: 9 }));
  expect(relevanceHash(["a"], { a: 1 })).not.toBe(relevanceHash(["a"], { a: 2 }));
});

test("an unanalyzable build yields RELEVANT_ALL (safe fallback)", () => {
  const bad = { defaults: {}, views: view, parts: { x: { views: ["v"], build: () => { throw new Error("nope"); } } } };
  expect(subPartReadKeys(bad, "v", {})).toBe(RELEVANT_ALL);
});

const gated = {
  defaults: { pattern: "random", cellR: 2, showLid: false, lidT: 1, size: 10 },
  views: { v: { label: "V" } },
  parts: {
    body: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.size, p.size, 1] }) },
    lid: { views: ["v"], enabled: (p) => p.showLid, build: (k, p) => k.box({ min: [0, 0, 0], max: [1, 1, p.lidT] }) },
  },
};

test("recorded relevance: union of on-screen recorded reads plus every in-view gate", () => {
  const readsOf = (n) => (n === "body" ? new Set(["size", "pattern"]) : null);
  const r = recordedRelevantKeys(gated, "v", gated.defaults, readsOf);
  expect([...r].sort()).toEqual(["pattern", "showLid", "size"]);
});

test("recorded relevance: a sub-part not yet built contributes its prediction", () => {
  const params = { ...gated.defaults, showLid: true };
  const readsOf = (n) => (n === "body" ? new Set(["size"]) : null);
  const r = recordedRelevantKeys(gated, "v", params, readsOf);
  expect(r.has("lidT")).toBe(true);
  expect(r.has("size")).toBe(true);
});

test("subPartParamKeys: recorded, else predicted, else everything", () => {
  expect(subPartParamKeys(gated, "v", gated.defaults, () => new Set(["cellR"]), "body")).toEqual(["cellR"]);
  expect(subPartParamKeys(gated, "v", gated.defaults, () => null, "body")).toEqual(["size"]);
  expect(subPartParamKeys(gated, "v", gated.defaults, undefined, "nope")).toEqual(Object.keys(gated.defaults).sort());
});
