import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (collisions) => ({
  meta: { title: "T" },
  defaults: {},
  parts: {
    base: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) },
    lid: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) },
  },
  views: { main: { label: "Main" } },
  collisions,
});
const findings = (collisions) => {
  const r = lintPart(partWith(collisions));
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule.startsWith("collisions-"));
};

test("a valid block is clean", () => {
  expect(findings({ clearance: 0.2, allow: ["lid×base"], pose: false })).toEqual([]);
  expect(findings(undefined)).toEqual([]);
});

test("collisions-unknown-part names the entry", () => {
  const f = findings({ allow: ["lid×ghost"] });
  expect(f.map((x) => x.rule)).toEqual(["collisions-unknown-part"]);
  expect(f[0].severity).toBe("error");
  expect(f[0].message).toContain("lid×ghost");
});

test("collisions-bad-pair: no × or the same part twice", () => {
  for (const entry of ["lid", "lid×lid"]) {
    const f = findings({ allow: [entry] });
    expect(f.map((x) => x.rule)).toEqual(["collisions-bad-pair"]);
    expect(f[0].severity).toBe("error");
  }
});

test("collisions-bad-clearance: negative or non-numeric", () => {
  for (const clearance of [-1, "x"]) {
    const f = findings({ clearance });
    expect(f.map((x) => x.rule)).toEqual(["collisions-bad-clearance"]);
    expect(f[0].severity).toBe("error");
  }
});
