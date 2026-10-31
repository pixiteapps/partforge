// docs/domains/organic.md holds its claims to the code. The guide is written for an agent
// that has nothing else, so every example it shows must be what the code does:
// - every runnable ```js block is executed, in order, in one scope (with a real Manifold
//   kernel `k`); a top-level statement followed by `// <value>` (on its line, or on the `//`
//   lines right after it) must deep-equal that value, read from the guide text itself;
// - the worked example's part is measured and verified, and its probe output is the one shown;
// - the node and detail tables list exactly the grammar's kinds, with its required and
//   optional fields (so the guide fails when the grammar grows);
// - every quoted error and warning is produced, verbatim, by a real call;
// - the numbers in the prose (defaults, limits, the preview ladder) are the code's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure, verify } from "../src/oracle.js";
import { lintPart } from "../src/lint.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import * as organic from "../src/framework/domains/organic/index.js";
import organicManifest from "../src/framework/domains/organic/manifest.js";
import { NODE_KINDS, DETAIL_KINDS } from "../src/framework/geometry/implicit/grammar.js";
import { compileImplicit, choosePreviewEdge, IMPLICIT_DEFAULTS } from "../src/framework/geometry/implicit/index.js";
import { PREVIEW_LADDER } from "../src/framework/geometry/implicit/preview-edge.js";
import { MAX_GRID_CELLS, MAX_SAMPLES } from "../src/framework/geometry/implicit/sparse.js";
import { TEXTURE_LIMITS } from "../src/framework/geometry/implicit/textures.js";
import { BULGE_DEFAULT, MAX_OWNER_K, DETAIL_SEAM_FADE } from "../src/framework/geometry/implicit/contact.js";
import { finishKernel } from "../src/framework/geometry/kernel-front.js";
import { implicitDistance } from "../src/framework/geometry/implicit/distance.js";
import { handSpec } from "./fixtures/implicit-trees.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const guide = read("../docs/domains/organic.md");
const fences = (lang, text = guide) => [...text.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
const section = (heading, level = "##") => {
  const start = guide.indexOf(`\n${level} ${heading}\n`);
  expect(start, `no "${level} ${heading}"`).toBeGreaterThanOrEqual(0);
  const end = guide.slice(start + 1).search(/\n#{2,3} /);
  return guide.slice(start, end === -1 ? undefined : start + 1 + end);
};
// A JSON round trip drops undefined fields and Float64 noise the same way the guide prints.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// Comment text → value: an annotation after a run of 2+ spaces is prose, not value.
const valueText = (comment) => comment.trim().split(/\s{2,}/)[0];
const evalValue = (text) => new Function(`return (${text});`)();

/**
 * One runnable block → a script. A statement at column 0 ending in `;` with a `// value`
 * becomes a check; one with no comment takes its value from the `//` lines right after it.
 * The worked example's `export default` becomes `const part =`, so later blocks can use it.
 */
function toScript(block) {
  const lines = block.replace(/^export default /m, "const part = ").split("\n").filter((l) => !/^import /.test(l));
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

let k, scope;
beforeAll(async () => {
  k = await bootManifoldKernel();
  const checked = [];
  const check = (src, run, text) => {
    expect(plain(run()), src).toEqual(evalValue(text));
    checked.push(src);
  };
  const body = `${fences("js").map(toScript).join("\n")}\nreturn { part, pawSpec };`;
  scope = new Function("k", "limb", "implicitDistance", "check", ...Object.keys(organic), body)(k, limb, implicitDistance, check, ...Object.values(organic));
  scope.checked = checked;
});

test("every runnable example in the guide returns the value it shows", () => {
  expect(fences("js").length).toBeGreaterThanOrEqual(7);
  expect(scope.checked.length).toBe(14);   // every shown value; a parse change that drops one fails here
});

test("the import line names exactly the partforge/organic exports", () => {
  const line = 'import { validateImplicit, ImplicitSpecError, ImplicitSizeError, IMPLICIT_NODE_KINDS, IMPLICIT_DETAIL_KINDS } from "partforge/organic";';
  expect(guide).toContain(line);
  expect(Object.keys(organic).sort()).toEqual(["IMPLICIT_DETAIL_KINDS", "IMPLICIT_NODE_KINDS", "ImplicitSizeError", "ImplicitSpecError", "validateImplicit"]);
});

// A markdown table's rows → { kind: [required[], optional[]] }, from its first three columns.
function tableKinds(text) {
  const out = {};
  for (const row of text.split("\n").filter((l) => /^\| `/.test(l))) {
    const [kind, req, opt] = row.split("|").slice(1, 4).map((c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    out[kind[0]] = [req.sort(), opt.sort()];
  }
  return out;
}
const schemaKinds = (kinds) => Object.fromEntries(Object.entries(kinds).map(([kind, s]) => [kind, [Object.keys(s.req).sort(), Object.keys(s.opt ?? {}).sort()]]));

test("the node table lists exactly the grammar's node kinds and fields", () => {
  const table = tableKinds(section("Node reference"));
  expect(Object.keys(table)).toEqual(organic.IMPLICIT_NODE_KINDS);
  expect(table).toEqual(schemaKinds(NODE_KINDS));
});

test("the detail table lists exactly the grammar's detail kinds and fields", () => {
  const table = tableKinds(section("Surface detail"));
  expect(Object.keys(table)).toEqual(organic.IMPLICIT_DETAIL_KINDS);
  expect(table).toEqual(schemaKinds(DETAIL_KINDS));
});

test("the spec options table lists exactly the options k.implicit takes", () => {
  const rows = section("The spec").split("\n").filter((l) => /^\| `/.test(l)).map((l) => /`(\w+)`/.exec(l)[1]);
  expect(rows).toEqual(["frames", "root", "detail", "resolution", "preview"]);
  expect(() => organic.validateImplicit({ root: { kind: "sphere", r: 1 }, quality: 1 })).toThrow("quality: unknown option");
  expect(() => organic.validateImplicit({ root: { kind: "sphere", r: 1 }, preview: 0.04 })).toThrow("preview: must be a number ≥ 0.05");
});

test("every quoted error and warning is the code's own", () => {
  const errors = section("Errors and warnings");
  const [errorBlock, warningBlock] = fences("text", errors).map((b) => b.trim().split("\n"));
  const triggers = [
    () => k.implicitFrames({ root: { kind: "union", children: [{ kind: "sphere", r: 2 }, { kind: "contact", children: [{ kind: "sphere", r: 2 }, { kind: "sphere", r: 2 }] }] } }),
    () => k.implicitFrames({ root: { kind: "halfspace", normal: "z" } }),
    () => k.implicitFrames({ root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return lenght(p) - 1.0;" } }),
    () => k.implicitFrames({ root: { kind: "bend", radius: 5, child: { kind: "capsule", b: [0, 0, 30], r: 2 } } }),
    () => k.implicitFrames({ root: { kind: "sphere", r: 5 }, detail: [{ kind: "texture", image: "skin", amplitude: 0.3, size: [20, 20] }] }),
    () => k.implicit({ root: { kind: "subtract", children: [{ kind: "sphere", r: 2 }, { kind: "sphere", r: 5 }] }, preview: 1 }),
    () => k.implicit({ root: { kind: "box", size: [1000, 1000, 1000] }, preview: 0.05 }),
  ];
  const caught = triggers.map((f) => { try { f(); } catch (e) { return e; } throw new Error(`no throw: ${f}`); });
  expect(caught.map((e) => e.message)).toEqual(errorBlock);
  expect(caught.map((e) => e.name)).toEqual([...Array(5).fill("ImplicitSpecError"), "Error", "ImplicitSizeError"]);
  expect(caught[6]).toBeInstanceOf(organic.ImplicitSizeError);
  expect(caught[6].code).toBe("IMPLICIT_SIZE");
  expect(caught[0]).toBeInstanceOf(organic.ImplicitSpecError);

  // The warning, from a real build's warnings.
  k.takeBuildWarnings();
  k.implicit({ root: { kind: "box", size: [30, 30, 1.6] }, preview: 1 });
  expect(k.takeBuildWarnings()).toEqual(warningBlock);

  // validateImplicit's message is the issues joined, and k.implicit throws the same error.
  const bad = { root: { kind: "sphere", r: -1, wobble: 2 } };
  let v, b;
  try { organic.validateImplicit(bad); } catch (e) { v = e; }
  try { k.implicit(bad); } catch (e) { b = e; }
  expect(v.message).toBe(`implicit: ${v.issues.join("; ")}`);
  expect(b.message).toBe(v.message);
  expect(b.code).toBe("IMPLICIT_SPEC");
  expect(errors).toContain("`implicit-limbs-miss-target`");
  expect(read("../docs/ERROR-PATTERNS.md")).toContain("\n## implicit-limbs-miss-target\n");
});

test("the backend messages are the code's own", () => {
  const backend = section("Backend: Manifold only");
  const occtMessage = fences("text", backend)[0].trim();
  expect(read("../src/framework/geometry/occt-backend.js")).toContain(JSON.stringify(occtMessage).slice(1, -1).replace(/\\"/g, '\\"'));
  const fallback = /throws\s+`([^`]+)`/.exec(backend)[1];
  expect(() => finishKernel({}).implicit({ root: { kind: "sphere", r: 1 } })).toThrow(fallback);
  expect(finishKernel({}).implicitFrames({ root: { kind: "sphere", r: 1, label: "a" } }).report().labels.a.center).toEqual([0, 0, 0]);
});

test("the prose's numbers are the code's", () => {
  const res = section("Resolution, preview and cost");
  expect(IMPLICIT_DEFAULTS.resolution).toBe(0.6);
  expect(section("The spec")).toContain("Default `0.6`");
  expect(res).toContain(`${PREVIEW_LADDER.slice(0, -1).join(", ")} and ${PREVIEW_LADDER.at(-1)} mm`);
  expect(res).toContain("2·10¹⁰ cells");
  expect(MAX_GRID_CELLS).toBe(2e10);
  expect(res).toContain("24,000,000 samples");
  expect(MAX_SAMPLES).toBe(24_000_000);
  expect(res).toContain(`${TEXTURE_LIMITS.maxSide} px per side`);
  expect(res).toContain(`${TEXTURE_LIMITS.maxTexelsPerPart.toLocaleString("en-US")} texels`);
  const contact = section("Blends and contact", "###");
  expect(contact).toContain(`\`bulge\` (mm, default ${BULGE_DEFAULT})`);
  expect(contact).toContain(`at most ${MAX_OWNER_K}`);
  expect(section("Surface detail")).toContain(`within ${DETAIL_SEAM_FADE} mm of a crease`);
  // The automatic preview: the paw at 0.5 mm, the hand fixture at 1.5 mm.
  expect(res).toContain("paw previews at\n  0.5 mm, and the hand fixture at 1.5 mm");
  const paw = scope.pawSpec(scope.part.defaults);
  expect(choosePreviewEdge(compileImplicit(paw))).toBe(0.5);
  const { preview, ...hand } = handSpec();
  expect(choosePreviewEdge(compileImplicit(hand))).toBe(1.5);
});

test("validateImplicit checks structure only; k.implicitFrames compiles", () => {
  const formula = { root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return lenght(p) - 1.0;" } };
  const nested = { root: { kind: "union", children: [{ kind: "contact", children: [{ kind: "sphere", r: 2 }, { kind: "sphere", r: 2 }] }] } };
  const image = { root: { kind: "sphere", r: 5 }, detail: [{ kind: "texture", image: "skin", amplitude: 0.3, size: [20, 20] }] };
  for (const spec of [formula, nested, image]) {
    expect(() => organic.validateImplicit(spec)).not.toThrow();
    expect(() => k.implicitFrames(spec)).toThrow(organic.ImplicitSpecError);
  }
  expect(() => organic.validateImplicit(image, { imageNames: new Set(["bark"]) })).toThrow('unknown image "skin"');
});

test("lint compiles the tree, and the guide lists every organic rule", () => {
  const partWith = (spec) => ({
    meta: { title: "t", backend: "manifold" }, parameters: [], defaults: {},
    parts: { a: { label: "A", views: ["v"], build: (kk) => kk.implicit(spec) } }, views: { v: { label: "V" } },
  });
  const errs = (spec) => lintPart(partWith(spec)).errors.map((f) => f.rule);
  expect(errs({ root: { kind: "sphere", r: -1, wobble: 1 } })).toEqual(["implicit-spec-invalid"]);
  expect(errs({ root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return lenght(p);" } })).toEqual(["implicit-spec-invalid"]);
  expect(errs({ root: { kind: "sphere", r: 1 } })).toEqual([]);
  expect(errs({ frames: {} })).toContain("invalid-op-options");
  const lintSection = section("What lint and verify check");
  for (const { id } of organicManifest.lintRules) expect(lintSection, id).toContain(`\`${id}\``);
  expect(lintSection).toContain("default pose");
  expect(lintSection).toContain("src/parts/hand.js");
});

test("the worked example builds, measures and verifies as the guide says", () => {
  const { part } = scope;
  const r = measure(k, part, "paw");
  const [, left, right] = /under `probes\.frames`\.\nIts tip origins are `([^`]+)` for `left\.tip` and\n`([^`]+)` for `right\.tip`/
    .exec(section("Worked example: a two-toe paw"));
  expect(r.probes.frames.frames["left.tip"].origin).toEqual(JSON.parse(left));
  expect(r.probes.frames.frames["right.tip"].origin).toEqual(JSON.parse(right));
  expect(plain(r.probes.frames)).toEqual(plain(k.implicitFrames(scope.pawSpec(part.defaults)).report()));
  // Calling report() inside a probe fails lint, as the guide warns.
  const reporting = { ...part, probes: { frames: (kk, p) => kk.implicitFrames(scope.pawSpec(p)).report().frames } };
  expect(lintPart(reporting).errors.map((f) => f.rule)).toEqual(["unknown-solid-op"]);
  expect(section("Reporting frames: `k.implicitFrames`")).toContain("the lint error `unknown-solid-op`");
  const solid = k.implicit(scope.pawSpec(part.defaults));
  expect(solid.boundingBox().min[2]).toBeCloseTo(-3.6, 1);
  expect(verify(k, part).ok).toBe(true);
  expect(lintPart(part).errors).toEqual([]);
});

test("the guide is indexed by the core guide and points at its neighbours", () => {
  // implicitDistance is shown imported from where it ships.
  expect(section("Jointed bodies")).toContain('import { implicitDistance } from "partforge/geometry";');
  expect(read("../src/framework/geometry/polygon.js")).toMatch(/export \{ implicitDistance \}/);
  expect(read("../docs/AUTHORING-PARTS.md")).toContain("[`docs/domains/organic.md`](domains/organic.md)");
  expect(guide).toContain("test/fixtures/implicit-trees.js");
  expect(guide).toContain("docs/domains/kinematics.md");
});
