// docs/domains/kinematics.md holds its claims to the code. The guide is written for an agent
// that has nothing else, so every example it shows must be what the code does:
// - every runnable ```js block is executed, in order, in one scope; a top-level statement
//   followed by `// <value>` (on its line, or on the `//` lines right after it) must
//   deep-equal that value, read from the guide text itself; every k.implicit(spec) call
//   in them is handed a spec the k.implicit grammar accepts;
// - every message in the Errors block is produced, verbatim, by a real call, and is a
//   SpecError with code "SPEC";
// - the edge-case numbers in the prose are what the code reports;
// - the worked example's excerpt is quoted from src/parts/robot-finger.js line for line;
// - the guide never names a branch: it is shipped text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { implicitDistance } from "../src/framework/geometry/polygon.js";
import { validateSpec } from "../src/framework/geometry/implicit/grammar.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const guide = read("../docs/domains/kinematics.md");
const fences = (lang) => [...guide.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
const section = (heading) => {
  const start = guide.indexOf(`\n## ${heading}\n`);
  expect(start, `no "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const end = guide.indexOf("\n## ", start + 1);
  return guide.slice(start, end === -1 ? undefined : end);
};
// A JSON round trip drops undefined fields and Float64 noise the same way the guide prints.
const plain = (v) => JSON.parse(JSON.stringify(v));
// Comment text → value: an annotation after a run of 2+ spaces is prose, not value.
const valueText = (comment) => comment.trim().split(/\s{2,}/)[0];
const evalValue = (text) => new Function(`return (${text});`)();

/**
 * One runnable block → a script. A statement at column 0 ending in `;` with a `// value`
 * becomes a check; one with no comment takes its value from the `//` lines right after it.
 */
function toScript(block) {
  const lines = block.split("\n").filter((l) => !/^import /.test(l));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([^\s/].*?;)\s*\/\/ (.*)$/.exec(line);
    if (m && !/^(const|let) /.test(m[1])) {
      out.push(`check(${JSON.stringify(m[1])}, () => (${m[1].slice(0, -1)}), ${JSON.stringify(valueText(m[2]))});`);
      continue;
    }
    if (/^[^\s/].*;$/.test(line) && !/^(const|let) /.test(line) && /^\/\/ /.test(lines[i + 1] ?? "")) {
      const parts = [];
      while (/^\/\/ /.test(lines[i + 1] ?? "")) parts.push(valueText(lines[++i].slice(3)));
      out.push(`check(${JSON.stringify(line)}, () => (${line.slice(0, -1)}), ${JSON.stringify(parts.join(" "))});`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

test("every runnable example in the guide returns the value it shows", () => {
  const blocks = fences("js").filter((b) => !/^\s*(derive|parts|views|verify):/m.test(b));
  expect(blocks.length).toBeGreaterThanOrEqual(8);
  const checked = [];
  const check = (src, run, text) => {
    expect(plain(run()), src).toEqual(evalValue(text));
    checked.push(src);
  };
  // The guide's k.implicit calls run against the grammar alone (meshing a hand here would
  // only slow the test): each spec must validate, and every call must be reached.
  const specs = [];
  const k = { implicit: (spec) => { validateSpec(spec); specs.push(spec); return {}; } };
  new Function("limb", "implicitDistance", "k", "check", blocks.map(toScript).join("\n"))(limb, implicitDistance, k, check);
  expect(checked.length).toBe(32);   // every shown value; a parse change that drops one fails here
  expect(specs.length).toBe(1);
});

test("every error message in the guide is the code's own, a SpecError with code SPEC", () => {
  const index = limb("index", {
    at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1],
    joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
    lengths: [42, 25, 22], r: [9.5, 8.5, 7.4, 6.4],
  });
  const parented = limb("index", { parent: "palm", at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["mcp", "pip"], lengths: [42, 25] });
  const rod = { kind: "cylinder", r: 8, h: 40, axis: "x", at: [-30, 130, -22] };
  const thumb = limb("thumb", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "ball", type: "ball" }, "ip"], lengths: [30, 20] });
  const triggers = [
    () => index.pose({ bend: [1, 2], curl: 0.5 }),
    () => index.pose({ reach: [0, 0, 0], grip: { around: rod } }),
    () => index.pose({ bend: { dip: 10 } }),
    () => limb("x", { toward: [0, 1, 0], bendToward: [0, 2, 0], joints: ["a"], lengths: [1] }),
    () => limb("x", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [1] }),
    () => parented.pose({ reach: [0, 0, 0] }),
    () => index.pose({}).place({ rotate() {}, translate() {} }, "pipp"),
    () => index.pose({ grip: { around: { kind: "twist", children: [rod] } } }),
    () => index.pose({ grip: { around: () => NaN } }),
    () => limb("x", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "a", offset: [0, 0, 1] }], lengths: [1] }),
    () => thumb.pose({ bend: { ball: 30 } }),
    () => limb("thumb", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "ball", type: "ball", range: [0, 10] }], lengths: [1] }),
    () => index.pose({}).place({ rotate() {}, translate() {} }, "pip", { from: "printed" }),
  ];
  const produced = triggers.map((f) => {
    try { f(); } catch (e) {
      expect(e.name).toBe("SpecError");
      expect(e.code).toBe("SPEC");
      return e.message;
    }
    throw new Error(`no throw: ${f}`);
  });
  const errors = section("Errors");
  const listed = fences("text").find((b) => errors.includes(b)).trim().split("\n");
  expect(listed).toEqual(produced);

  // The prose claims about errors.
  const boom = new Error("boom");
  let caught;
  try { index.pose({ grip: { around: () => { throw boom; } } }); } catch (e) { caught = e; }
  expect(caught.name).toBe("SpecError");
  expect(caught.cause).toBe(boom);
  expect(caught.message).toMatch(/^limb "index"\.grip\.around: distance function threw/);
  expect(() => index.pose({ curl: 2 })).toThrow('limb "index".curl: must be a number from 0 to 1');
  expect(() => parented.pose({ curl: 0.3 }).world("pip")).toThrow("world needs the parent frames — pass them as pose(…, frames)");
  expect(() => limb("x", { rotate: { axis: "z", deg: 5 }, joints: ["a"], lengths: [1] }).pose({ spread: 3 }))
    .toThrow("spread/twist need toward/bendToward, not rotate");
  expect(() => limb("x", { rotate: { axis: "z", deg: 5 }, mirror: "YZ", joints: ["a"], lengths: [1] })).toThrow("mirror needs toward/bendToward, not rotate");
  expect(() => limb("x", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a"], lengths: [1], wat: 1 })).toThrow('unknown option "wat"');
});

test("the edge cases report what the guide says", () => {
  const one = (range, bendToward = [0, 0, -1]) => limb("e", { toward: [0, 1, 0], bendToward, joints: [{ name: "a", range }], lengths: [10] });
  const edge = section("Edge cases");
  // An unset joint whose range excludes 0 is clamped.
  expect(edge).toContain("`[10, 40]`");
  expect(edge).toContain("`bend: [10], clamped: [true]`");
  expect(plain(one([10, 40]).pose({}).report)).toMatchObject({ bend: [10], clamped: [true] });
  // hi = 0: nothing to close toward — curl and grip leave it at 0; the flipped form closes.
  expect(edge).toContain("`range: [-60, 0]`");
  expect(one([-60, 0]).pose({ curl: 1 }).report.bend).toEqual([0]);
  expect(one([-60, 0]).pose({ grip: { around: { kind: "sphere", r: 3, at: [0, 5, -8] }, r: [1, 1] } }).report.bend).toEqual([0]);
  expect(edge).toContain("`bendToward: [0, 0, 1]` with `range: [0, 60]`");
  expect(one([0, 60], [0, 0, 1]).pose({ curl: 1 }).report.bend).toEqual([60]);
  // An all-negative range closes toward range[0].
  expect(edge).toContain("`[-60, -5]`");
  expect(one([-60, -5]).pose({ curl: 1 }).report.bend).toEqual([-60]);
  // A skipped joint: skipped true, touched false, at its start value; grip closes base-first.
  const index = limb("index", {
    at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1],
    joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
    lengths: [42, 25, 22], r: [9.5, 8.5, 7.4, 6.4],
  });
  const g = index.pose({ grip: { around: { kind: "cylinder", r: 8, h: 40, axis: "x", at: [-30, 130, -80] } } }).report.grip;
  expect(g.joints[0].bend).toBeGreaterThan(0);
  expect(g.joints[1]).toEqual({ joint: "pip", bend: 0, touched: false, skipped: true });
});

test("reach: the solved spread replaces the pose spread; a rotate-based limb cannot aim sideways", () => {
  const def = { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [20, 20] };
  const target = limb("t", def).pose({ bend: [20, 30], spread: 15 }).report.tip;
  const solved = limb("t", def).pose({ reach: target, spread: -40 });
  expect(solved.report.reach.status).toBe("reached");
  const hatch = limb("t", { rotate: { axis: "z", deg: 0 }, joints: ["a", "b"], lengths: [20, 20] });
  expect(hatch.pose({ reach: target }).report.reach.status).toBe("out-of-range");
});

test("the worked example is quoted from src/parts/robot-finger.js", () => {
  const source = new Set(read("../src/parts/robot-finger.js").split("\n").map((l) => l.trim()));
  const excerpt = fences("js").find((b) => section("Worked example: `src/parts/robot-finger.js`").includes(b));
  for (const line of excerpt.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))) {
    expect(source.has(line), line).toBe(true);
  }
});

test("the guide is self-contained: the import lines, no branch names", () => {
  expect(guide).toContain('import { limb } from "partforge/kinematics";');
  expect(guide).toContain('import { implicitDistance } from "partforge/geometry";');
  expect(guide).toContain("src/parts/robot-finger.js");
  expect(guide).not.toMatch(/feat\/implicit/);
  // The Domains index line in the core guide points here.
  expect(read("../docs/AUTHORING-PARTS.md")).toContain("[`docs/domains/kinematics.md`](domains/kinematics.md)");
});
