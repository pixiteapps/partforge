import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { lintPart, SOURCE_RULE_IDS } from "../src/lint.js";

// A minimal evaluated part binding `keys` to controls, defaults given directly.
const partWith = (defaults, keys = Object.keys(defaults)) => ({
  meta: { title: "T", units: "mm" },
  defaults,
  parameters: [{ title: "S", controls: keys.map((key) => ({ key, label: key, min: 0, max: 100, step: 1 })) }],
  parts: { body: { build: (k) => k.box({ size: [1, 1, 1] }), views: ["main"] } },
  views: { main: { label: "Main" } },
});

const srcWith = (defaultsText) => ({
  files: { "part.js": `export default {\n  defaults: ${defaultsText},\n};\n` },
  entrypoint: "part.js",
});

const findingsFor = (report, rule) =>
  [...report.errors, ...report.warnings].filter((f) => f.rule === rule);

describe("control-default-not-literal", () => {
  it("errors on a control-bound expression default, with file and line", () => {
    const report = lintPart(partWith({ wall: 13 / 3 }), {
      sources: srcWith("{\n    wall: 13 / 3,\n  }"),
    });
    const found = findingsFor(report, "control-default-not-literal");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].file).toBe("part.js");
    expect(found[0].line).toBe(3);
    expect(found[0].path).toBe("defaults.wall");
    expect(found[0].message).toContain("13 / 3");
  });

  it("stays silent for an UNBOUND non-literal default (legal by design)", () => {
    const part = partWith({ wall: 2 }, ["wall"]);
    part.defaults.pts = [[0, 0], [1, 0]];
    const report = lintPart(part, {
      sources: srcWith("{\n    wall: 2,\n    pts: [[0, 0], [1, 0]],\n  }"),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(0);
  });

  it("flags hex / separator spellings the settings rewriter refuses", () => {
    const report = lintPart(partWith({ a: 255, b: 1000 }), {
      sources: srcWith("{ a: 0xff, b: 1_000 }"),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(2);
  });

  it("accepts plain literals: numbers, strings with escapes, booleans", () => {
    const report = lintPart(partWith({ a: -2.5, b: "x\ny", c: true }), {
      sources: srcWith('{ a: -2.5, b: "x\\ny", c: true }'),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(0);
  });

  it("cites its own ERROR-PATTERNS entry", () => {
    const report = lintPart(partWith({ wall: 13 / 3 }), {
      sources: srcWith("{ wall: 13 / 3 }"),
    });
    expect(findingsFor(report, "control-default-not-literal")[0].pattern)
      .toBe("control-default-not-literal");
  });

  it("strips control characters out of the quoted source", () => {
    // A raw C0 byte in a finding message is an escaping hazard for the JSON
    // diagnostics channel this text flows into, and renders as nothing anyway.
    const report = lintPart(partWith({ wall: 4 }), {
      sources: srcWith("{ wall: [1,\u0007 2] }"),
    });
    const found = findingsFor(report, "control-default-not-literal");
    expect(found).toHaveLength(1);
    expect(found[0].message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(found[0].message).toContain("[1, 2]");
  });

  it("accepts a JSON literal on a key a custom control owns", () => {
    const part = partWith({ wall: 2 }, ["wall"]);
    part.defaults.tiles = [{ q: 0, h: 10 }];
    part.parameters[0].controls.push({ key: "tiles", type: "custom", label: "Tiles", widget: () => {} });
    const report = lintPart(part, {
      sources: srcWith("{\n    wall: 2,\n    tiles: [{ q: 0, h: 10 }],\n  }"),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(0);
  });

  it("still errors on an expression inside a custom control's JSON literal", () => {
    const part = partWith({ wall: 2 }, ["wall"]);
    part.defaults.tiles = [{ q: 0, h: 13 / 3 }];
    part.parameters[0].controls.push({ key: "tiles", type: "custom", label: "Tiles", widget: () => {} });
    const report = lintPart(part, {
      sources: srcWith("{\n    wall: 2,\n    tiles: [{ q: 0, h: 13 / 3 }],\n  }"),
    });
    const found = findingsFor(report, "control-default-not-literal");
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("defaults.tiles");
  });
});

// A statically hidden control renders no widget, so no panel edit of it can be
// lost — and `hidden: true` is the documented idiom for an internal constant,
// exactly where an author writes an expression. `when` is NOT hiddenness.
describe("control-default-not-literal and hidden controls", () => {
  const hiddenPart = (controlExtra, sectionExtra = {}) => ({
    meta: { title: "T", units: "mm" },
    defaults: { wall: 13 / 3 },
    parameters: [{ title: "S", ...sectionExtra, controls: [{ key: "wall", label: "wall", min: 0, max: 100, step: 1, ...controlExtra }] }],
    parts: { body: { build: (k) => k.box({ size: [1, 1, 1] }), views: ["main"] } },
    views: { main: { label: "Main" } },
  });
  const src = { sources: srcWith("{\n    wall: 13 / 3,\n  }") };

  it("stays silent for a `hidden: true` control", () => {
    expect(findingsFor(lintPart(hiddenPart({ hidden: true }), src), "control-default-not-literal")).toHaveLength(0);
  });

  it("fires for the same control when visible", () => {
    expect(findingsFor(lintPart(hiddenPart({}), src), "control-default-not-literal")).toHaveLength(1);
  });

  it("stays silent for a control inside a `hidden: true` section", () => {
    expect(findingsFor(lintPart(hiddenPart({}, { hidden: true }), src), "control-default-not-literal")).toHaveLength(0);
  });

  it("stays silent for a control inside a `hidden: true` group", () => {
    const part = hiddenPart({});
    part.parameters[0].controls = [{ type: "group", title: "G", hidden: true, controls: part.parameters[0].controls }];
    expect(findingsFor(lintPart(part, src), "control-default-not-literal")).toHaveLength(0);
  });

  it("fires for a `when`-conditioned (not hidden) control — it can still appear", () => {
    const part = hiddenPart({ when: { flag: true } });
    part.defaults.flag = true;
    part.parameters[0].controls.push({ key: "flag", type: "checkbox", label: "flag" });
    const report = lintPart(part, { sources: srcWith("{\n    wall: 13 / 3,\n    flag: true,\n  }") });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(1);
  });

  it("control-default-not-primitive still fires on a hidden control (its key seeds p)", () => {
    const part = hiddenPart({ hidden: true });
    part.defaults.wall = [1, 2];
    const report = lintPart(part, src);
    expect(findingsFor(report, "control-default-not-primitive")).toHaveLength(1);
  });
});

describe("impure-source-token", () => {
  it("warns on impurity tokens, naming file and line", () => {
    const report = lintPart(partWith({ a: 1 }), {
      sources: {
        files: {
          "part.js": 'export default { defaults: { a: 1 } };\n',
          "jig.js": "export const jig = () => Math.random();\nexport const t = Date.now();\nexport const d = new Date();\n",
        },
        entrypoint: "part.js",
      },
    });
    const found = findingsFor(report, "impure-source-token");
    expect(found.map((f) => [f.file, f.line, f.severity])).toEqual([
      ["jig.js", 1, "warning"], ["jig.js", 2, "warning"], ["jig.js", 3, "warning"],
    ]);
    // One finding per (file, token); a lone occurrence stays uncounted.
    expect(found.map((f) => f.message)).toEqual([
      "`Math.random` in jig.js — an impure build silently returns stale geometry",
      "`Date.now` in jig.js — an impure build silently returns stale geometry",
      "`new Date()` in jig.js — an impure build silently returns stale geometry",
    ]);
  });

  it("collapses many occurrences of one token into one counted finding", () => {
    // Per-occurrence findings were unbounded: a few thousand `Math.random()`
    // calls produced ~1.4 MB of identical findings on an LLM-facing channel.
    const lines = Array.from({ length: 300 }, () => "const x = Math.random();").join("\n");
    const report = lintPart(partWith({ a: 1 }), {
      sources: {
        files: { "part.js": 'export default { defaults: { a: 1 } };\n', "jig.js": `${lines}\n` },
        entrypoint: "part.js",
      },
    });
    const found = findingsFor(report, "impure-source-token");
    expect(found).toHaveLength(1);
    expect(found[0].message).toBe("`Math.random` ×300 in jig.js — an impure build silently returns stale geometry");
    expect([found[0].file, found[0].line]).toEqual(["jig.js", 1]);
  });

  it("cites its own ERROR-PATTERNS entry", () => {
    const report = lintPart(partWith({ a: 1 }), {
      sources: {
        files: { "part.js": 'export default { defaults: { a: 1 } };\nconst t = Date.now();\n' },
        entrypoint: "part.js",
      },
    });
    expect(findingsFor(report, "impure-source-token")[0].pattern).toBe("impure-source-token");
  });

  it("ignores tokens inside strings and comments, and new Date(0)", () => {
    const report = lintPart(partWith({ a: 1 }), {
      sources: {
        files: {
          "part.js": 'export default { defaults: { a: 1 } };\n// Math.random()\nconst s = "Date.now()";\nconst d = new Date(0);\n',
        },
        entrypoint: "part.js",
      },
    });
    expect(findingsFor(report, "impure-source-token")).toHaveLength(0);
  });

  it("scans code files only — prose in a .md tree file never warns", () => {
    const report = lintPart(partWith({ a: 1 }), {
      sources: {
        files: {
          "part.js": 'export default { defaults: { a: 1 } };\n',
          "NOTES.md": "Do not call Date.now() in a build; use a parameter instead.\n",
          "profile.json": '{ "note": "Math.random() is impure" }\n',
        },
        entrypoint: "part.js",
      },
    });
    expect(findingsFor(report, "impure-source-token")).toHaveLength(0);
  });

  it("still scans a .mjs file", () => {
    const report = lintPart(partWith({ a: 1 }), {
      sources: {
        files: { "part.js": 'export default { defaults: { a: 1 } };\n', "jig.mjs": "export const t = Date.now();\n" },
        entrypoint: "part.js",
      },
    });
    expect(findingsFor(report, "impure-source-token").map((f) => f.file)).toEqual(["jig.mjs"]);
  });
});

describe("sources plumbing", () => {
  it("no sources → report is IDENTICAL to the one with sources (part is clean)", () => {
    const withS = lintPart(partWith({ a: 1 }), { sources: srcWith("{ a: 1 }") });
    const without = lintPart(partWith({ a: 1 }));
    expect(withS).toEqual(without);
    expect([...withS.errors, ...withS.warnings].filter((f) => SOURCE_RULE_IDS.has(f.rule))).toHaveLength(0);
  });

  it("a __proto__-keyed file is kept, not silently dropped", () => {
    // `normalizeSources` builds its map with Object.create(null): on a plain
    // `{}`, `files["__proto__"] = text` would hit the prototype setter and
    // vanish, so the file would be invisible to every source rule.
    const files = {};
    Object.defineProperty(files, "__proto__",
      { enumerable: true, configurable: true, writable: true, value: "export default {\n  defaults: { wall: 13 / 3 },\n};\n" });
    const report = lintPart(partWith({ wall: 13 / 3 }), { sources: { files, entrypoint: "__proto__" } });
    const found = findingsFor(report, "control-default-not-literal");
    expect(found.map((f) => [f.file, f.line])).toEqual([["__proto__", 2]]);
  });

  it("hostile sources shapes never throw AND never fail the part", () => {
    // A malformed `sources` means "no source rules", never a broken part:
    // `lint-context-error` is not in SOURCE_RULE_IDS, so a host filtering
    // source findings to keep them non-blocking would refuse to render a part
    // that builds fine.
    const thrower = (prop) => {
      const o = { files: { "part.js": "export default {};" }, entrypoint: "part.js" };
      Object.defineProperty(o, prop, { get() { throw new Error(`hostile ${prop}`); } });
      return o;
    };
    const hostileFileValue = { entrypoint: "part.js", files: {} };
    Object.defineProperty(hostileFileValue.files, "part.js", { enumerable: true, get() { throw new Error("hostile value"); } });
    const hostileOwnKeys = {
      entrypoint: "part.js",
      files: new Proxy({}, { ownKeys() { throw new Error("hostile ownKeys"); } }),
    };
    const shapes = [
      null, 42, "x", {}, { files: null }, { files: { a: 1 }, entrypoint: 2 },
      thrower("files"), thrower("entrypoint"), hostileFileValue, hostileOwnKeys,
    ];
    shapes.forEach((sources, i) => {
      let report;
      expect(() => { report = lintPart(partWith({ a: 1 }), { sources }); }, `shape ${i}`).not.toThrow();
      const all = [...report.errors, ...report.warnings, ...report.notes];
      expect(all.filter((f) => f.rule === "lint-context-error"), `shape ${i}`).toHaveLength(0);
      expect(all.filter((f) => SOURCE_RULE_IDS.has(f.rule)), `shape ${i}`).toHaveLength(0);
      expect(report.ok, `shape ${i}`).toBe(true);
    });
  });

  it("SOURCE_RULE_IDS names exactly the source rules", () => {
    expect([...SOURCE_RULE_IDS].sort()).toEqual(["control-default-not-literal", "impure-source-token"]);
  });
});

describe("exemplar parts lint clean with their own source", () => {
  it("no source findings on any src/parts/*.js", async () => {
    for (const name of readdirSync("src/parts").filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(`src/parts/${name}`, "utf8");
      const mod = await import(`../src/parts/${name}`);
      const report = lintPart(mod.default, { sources: { files: { [name]: source }, entrypoint: name } });
      const bad = [...report.errors, ...report.warnings].filter((f) => SOURCE_RULE_IDS.has(f.rule));
      expect(bad, `${name}: ${JSON.stringify(bad)}`).toHaveLength(0);
    }
  });
});
