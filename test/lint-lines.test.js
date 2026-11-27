import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";
import { concentricCapstan, slackCapstan, staticSlackCapstan } from "./fixtures/capstan-fixtures.js";

const lineFindings = (part) => {
  const r = lintPart(part);
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule.startsWith("line-"));
};
const swept = (part) => ({ ...part, verify: { sweeps: { drive: { param: "motorAngle" } } } });

test("a moving line with no sweep warns line-unswept naming the param", () => {
  for (const part of [concentricCapstan, slackCapstan]) {
    const f = lineFindings(part);
    expect(f.map((x) => x.rule)).toEqual(["line-unswept"]);
    expect(f[0].severity).toBe("warning");
    expect(f[0].path).toBe("verify.sweeps");
    expect(f[0].message).toContain("motorAngle");
    expect(f[0].message).toContain("rope");
    expect(f[0].message).toContain("assembly");
    expect(f[0].hint).toContain('verify.sweeps: { motorAngle: { param: "motorAngle" } }');
    expect(f[0].hint).toContain('verify.expect._view: { lineDrift: "<=0.2" }');
  }
});

test("a sweep of the param covers the line", () => {
  expect(lineFindings(swept(concentricCapstan))).toEqual([]);
  expect(lineFindings(swept(slackCapstan))).toEqual([]);
  // a sweep that moves no piece still covers it: verify reads the line along it (lineSweeps)
  expect(lineFindings(swept(staticSlackCapstan))).toEqual([]);
});

test("a sweep that runs only in another view does not cover it", () => {
  const part = {
    ...concentricCapstan,
    views: { assembly: { label: "Assembly" }, other: { label: "Other" } },
    verify: { sweeps: { drive: { param: "motorAngle", views: ["other"] } } },
  };
  const f = lineFindings(part);
  expect(f.map((x) => x.rule)).toEqual(["line-unswept"]);
  expect(f[0].message).toContain('view "assembly"');
});

test("a line shown only in a view the param is swept in is clean", () => {
  const part = {
    ...concentricCapstan,
    views: { assembly: { label: "Assembly" }, other: { label: "Other" } },
    lines: { rope: { on: "drive", views: ["other"] } },
    verify: { sweeps: { drive: { param: "motorAngle", views: ["other"] } } },
  };
  expect(lineFindings(part)).toEqual([]);
});

test("a line that does not move with the param is clean", () => {
  const still = { ...concentricCapstan, derive: () => ({ drive: concentricCapstan.derive({ motorAngle: 0 }).drive }) };
  expect(lineFindings(still)).toEqual([]);
});

test("an unknown source is a line-bad-source error", () => {
  const f = lineFindings(swept({ ...concentricCapstan, lines: { rope: { on: "nope" } } }));
  expect(f.map((x) => x.rule)).toEqual(["line-bad-source"]);
  expect(f[0].severity).toBe("error");
  expect(f[0].path).toBe("lines.rope");
  expect(f[0].message).toContain("nope");
});

test("an unknown line name is a line-bad-source error", () => {
  const f = lineFindings(swept({ ...concentricCapstan, lines: { rope: { on: "drive", line: "x" } } }));
  expect(f.map((x) => x.rule)).toEqual(["line-bad-source"]);
  expect(f[0].path).toBe("lines.rope");
  expect(f[0].message).toContain('"x"');
});

test("a missing or non-string on is a line-bad-source error", () => {
  for (const entry of [{}, { on: 3 }, { on: "" }, "drive"]) {
    const f = lineFindings(swept({ ...concentricCapstan, lines: { rope: entry } }));
    expect(f.map((x) => x.rule), JSON.stringify(entry)).toEqual(["line-bad-source"]);
    expect(f[0].path).toBe("lines.rope");
  }
});

test("an unknown view is a line-bad-source error", () => {
  const f = lineFindings(swept({ ...concentricCapstan, lines: { rope: { on: "drive", views: ["ghost"] } } }));
  expect(f.map((x) => x.rule)).toEqual(["line-bad-source"]);
  expect(f[0].message).toContain("ghost");
});

test("an empty views list is a line-bad-source error: the line shows in no view", () => {
  const f = lineFindings(swept({ ...concentricCapstan, lines: { rope: { on: "drive", views: [] } } }));
  expect(f.map((x) => x.rule)).toEqual(["line-bad-source"]);
  expect(f[0].severity).toBe("error");
  expect(f[0].path).toBe("lines.rope");
  expect(f[0].message).toBe("lines.rope.views is empty, so the line is shown in no view");
});

test("display must be an object with a 0xRRGGBB colour", () => {
  const rules = (display) => lineFindings(swept({ ...concentricCapstan, lines: { rope: { on: "drive", display } } })).map((x) => x.rule);
  expect(rules("red")).toEqual(["line-bad-source"]);
  expect(rules({ color: "red" })).toEqual(["line-bad-source"]);
  expect(rules({ color: "#ff0000" })).toEqual(["line-bad-source"]);
  expect(rules({ color: 1.5 })).toEqual(["line-bad-source"]);
  expect(rules({ color: -1 })).toEqual(["line-bad-source"]);
  expect(rules({ color: 0x1000000 })).toEqual(["line-bad-source"]);
  expect(rules({ color: 3 })).toEqual([]);
  expect(rules({ color: 0xff0000 })).toEqual([]);
});

test("a part with no lines block yields nothing", () => {
  const { lines: _l, ...noLines } = concentricCapstan;
  expect(lineFindings(noLines)).toEqual([]);
});
