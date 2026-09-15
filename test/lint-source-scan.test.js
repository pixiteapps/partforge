import { describe, it, expect } from "vitest";
import {
  findDefaultsLiteral, defaultsEntriesIn, pickDefaultsFile, stripNonCode, lineOf,
} from "../src/framework/lint/source-scan.js";

const SRC = `// a part
export default {
  meta: { title: "T" },
  defaults: {
    wall: 2.5,          // readable
    name: "abc\\nd",     // readable, escape
    flag: true,          // readable
    bad: 13 / 3,         // expression
    pts: [1, 2],         // readable, JSON-literal array (Task 2)
    tpl: \`x\`,            // template
    hex: 0xff,           // deliberately unreadable
    sep: 1_000,          // deliberately unreadable
  },
};
`;

describe("findDefaultsLiteral", () => {
  it("finds the literal and ignores 'defaults:' inside strings/comments", () => {
    const span = findDefaultsLiteral(SRC);
    expect(span).not.toBeNull();
    expect(SRC.slice(span.start, span.start + 1)).toBe("{");
    expect(findDefaultsLiteral('const s = "defaults: {nope}";')).toBeNull();
    expect(findDefaultsLiteral("// defaults: {nope}\n")).toBeNull();
  });
});

describe("defaultsEntriesIn", () => {
  it("classifies readable vs unreadable per entry, with absolute indices", () => {
    const entries = defaultsEntriesIn(SRC);
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey.wall.readable).toBe(true);
    expect(byKey.name.readable).toBe(true);
    expect(byKey.flag.readable).toBe(true);
    expect(byKey.pts.readable).toBe(true);
    for (const k of ["bad", "tpl", "hex", "sep"]) expect(byKey[k].readable).toBe(false);
    expect(byKey.bad.raw).toBe("13 / 3");
    // index points at the value inside the whole source
    expect(SRC.slice(byKey.bad.index, byKey.bad.index + 6)).toBe("13 / 3");
  });
  it("returns null when there is no defaults literal", () => {
    expect(defaultsEntriesIn("export default { parts: {} };")).toBeNull();
  });
});

describe("pickDefaultsFile", () => {
  it("prefers the entrypoint, then any file with a readable entry", () => {
    const files = { "helper.js": "export const defaults = 1;", "part.js": SRC };
    expect(pickDefaultsFile(files, "part.js").path).toBe("part.js");
    const only = { "a.js": "x", "b.js": SRC };
    expect(pickDefaultsFile(only, "a.js").path).toBe("b.js");
    expect(pickDefaultsFile({ "a.js": "x" }, "a.js")).toBeNull();
  });
  it("falls back to a wholly-unreadable literal so findings can still name the file", () => {
    const files = { "part.js": "export default { defaults: { a: 13 / 3 } };" };
    const found = pickDefaultsFile(files, "part.js");
    expect(found.path).toBe("part.js");
    expect(found.entries.every((e) => !e.readable)).toBe(true);
  });
});

describe("stripNonCode", () => {
  it("blanks strings, templates and comments but keeps length and newlines", () => {
    const src = 'const a = "Math.random()"; // Date.now()\nconst b = `perf ${x}`;\nMath.random();';
    const out = stripNonCode(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toContain("Date.now");
    expect(out.slice(src.lastIndexOf("Math.random"))).toContain("Math.random");
  });
});

describe("lineOf", () => {
  it("is 1-indexed", () => {
    expect(lineOf("a\nb\nc", 0)).toBe(1);
    expect(lineOf("a\nb\nc", 2)).toBe(2);
    expect(lineOf("a\nb\nc", 4)).toBe(3);
  });
});

describe("non-string input never throws", () => {
  it("guards findDefaultsLiteral, stripNonCode and lineOf", () => {
    for (const bad of [null, 42]) {
      expect(() => findDefaultsLiteral(bad)).not.toThrow();
      expect(findDefaultsLiteral(bad)).toBeNull();
      expect(() => stripNonCode(bad)).not.toThrow();
      expect(stripNonCode(bad)).toBe("");
      expect(() => lineOf(bad, 0)).not.toThrow();
      expect(lineOf(bad, 0)).toBe(1);
    }
  });
});
