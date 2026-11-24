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
import whale, { whaleCage } from "../src/parts/organic-whale.js";
import cageHandPart, { cageHand } from "../src/parts/cage-hand.js";
import { MAX_CAGE_FACES } from "../src/framework/geometry/subdiv/cage.js";
import { levelFor, subdivide, SUBDIV_TOLERANCE, MAX_SUBDIV_LEVEL, MIN_SUBDIV_LEVEL, SUBDIV_MAX_TRIANGLES } from "../src/framework/geometry/subdiv/surface.js";

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
  const body = `${fences("js").map(toScript).join("\n")}\nreturn { part, pawSpec, whaleCage, cageHand, poseDigits, bendsOf };`;
  scope = new Function("k", "limb", "implicitDistance", "check", ...Object.keys(organic), body)(k, limb, implicitDistance, check, ...Object.values(organic));
  scope.checked = checked;
});

test("every runnable example in the guide returns the value it shows", () => {
  expect(fences("js").length).toBeGreaterThanOrEqual(7);
  expect(scope.checked.length).toBe(44);   // every shown value; a parse change that drops one fails here
});

test("the import line names exactly the partforge/organic exports", () => {
  const line = 'import { validateImplicit, ImplicitSpecError, ImplicitSizeError, IMPLICIT_NODE_KINDS, IMPLICIT_DETAIL_KINDS, cage } from "partforge/organic";';
  expect(guide).toContain(line);
  expect(Object.keys(organic).sort()).toEqual(["IMPLICIT_DETAIL_KINDS", "IMPLICIT_NODE_KINDS", "ImplicitSizeError", "ImplicitSpecError", "cage", "validateImplicit"]);
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
  expect(lintSection).toContain("src/parts/organic-hand.js");
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

// The subdivision cage section.
const cageSection = () => section("A controlled surface: the subdivision cage");

test("the guide's whaleCage is the reference part's, line for line", () => {
  const file = read("../src/parts/organic-whale.js");
  const fn = /^export (function whaleCage[\s\S]*?\n\})\n/m.exec(file)[1];
  const block = fences("js", section("Worked example: a whale", "###"))[0];
  expect(block).toContain(fn);
  expect(block).toContain(/^const CAGE_LENGTH = .*;$/m.exec(file)[0]);
  const p = whale.defaults;
  expect(scope.whaleCage(k, p).snapshot()).toEqual(whaleCage(k, p).snapshot());
  expect(organicManifest.referenceParts).toContain("src/parts/organic-whale.js");
  expect(guide).toContain("`src/parts/organic-whale.js`");
  expect(guide).not.toContain("There is no reference part file");
});

test("the whale's numbers in the guide are the code's", () => {
  const text = section("Worked example: a whale", "###");
  const snap = whaleCage(k, whale.defaults).snapshot();
  const tris = (level) => (subdivide(snap, level).indices.length / 3).toLocaleString("en-US");
  const at = (tier) => levelFor(snap, SUBDIV_TOLERANCE[tier], { maxTriangles: SUBDIV_MAX_TRIANGLES[tier] });
  const preview = at("preview"), print = at("print");
  expect(preview.met && print.met).toBe(true);
  expect(text).toContain(`Its cage has ${snap.faces.length} faces.`);
  expect(text).toContain(`previews at level ${preview.level} (${tris(preview.level)} triangles)`);
  expect(text).toContain(`prints at level ${print.level} (${tris(print.level)} triangles)`);
});

test("the guide's hand is the reference part's, line for line", () => {
  const file = read("../src/parts/cage-hand.js");
  const block = fences("js", section("Worked example: a hand that curls", "###"))[0];
  const constants = /^import \{ limb \}[\s\S]*?\nconst DIGITS = .*;$/m.exec(file)[0];
  expect(block).toContain(constants);
  expect(block).toContain(/^(function poseDigits[\s\S]*?\n\})\n/m.exec(file)[1]);
  expect(block).toContain(/^export (function cageHand[\s\S]*?\n\})\n/m.exec(file)[1]);
  expect(block).toContain(/^const bendsOf = .*;$/m.exec(file)[0]);
  // The guide's functions make the part's cage, and the shown params are its defaults.
  const handParams = /^const handParams = (\{[\s\S]*?\});$/m.exec(block)[1];
  expect(evalValue(handParams)).toEqual(cageHandPart.defaults);
  const d = cageHandPart.derive(cageHandPart.defaults);
  const bends = Object.fromEntries(Object.entries(d).map(([n, posed]) => [n, posed.values]));
  expect(scope.bendsOf(scope.poseDigits(cageHandPart.defaults))).toEqual(bends);
  expect(scope.cageHand(k.cage, cageHandPart.defaults, bends).snapshot()).toEqual(cageHand(k.cage, cageHandPart.defaults, bends).snapshot());
  expect(organicManifest.referenceParts).toContain("src/parts/cage-hand.js");
  // "within 1 mm of its cage tip" at the defaults.
  const c = cageHand(k.cage, cageHandPart.defaults, bends);
  for (const [n, posed] of Object.entries(d)) expect(Math.hypot(...posed.report.tip.map((v, i) => v - c.centroid(`${n}Tip`)[i])), n).toBeLessThan(1);
});

test("the guide's hand builds clean open, at its defaults and as a fist, at preview and at print", async () => {
  const { createManifoldKernel } = await import("../src/framework/geometry/manifold-backend.js");
  const Module = (await import("manifold-3d")).default;
  const wasm = await Module(); wasm.setup();
  const print = createManifoldKernel(wasm, { quality: "print" });
  const controls = cageHandPart.parameters.flatMap((g) => g.controls);
  const open = Object.fromEntries(controls.map((c) => [c.key, 0]));
  const fist = { ...Object.fromEntries(controls.map((c) => [c.key, c.max])), thumbOppose: 0 };
  for (const p of [open, cageHandPart.defaults, fist]) {
    const bends = scope.bendsOf(scope.poseDigits(p));
    k.takeBuildWarnings();
    expect(k.subdiv(scope.cageHand(k.cage, p, bends)).volume()).toBeGreaterThan(50000);
    expect(k.takeBuildWarnings()).toEqual([]);
    print.takeBuildWarnings();
    expect(print.subdiv(scope.cageHand(print.cage, p, bends)).volume()).toBeGreaterThan(50000);
    expect(print.takeBuildWarnings()).toEqual([]);
  }
  // The recipe's rule, on a 20 mm thick limb bent 90° over three rings: rings a quarter
  // of the thickness long build, shorter ones fold through themselves.
  const bent = (by) => {
    const c = print.cage({ box: { size: [20, 20, 20] } });
    let cur = c.extrude("+z:0,0", { by: 20 });
    for (let i = 0; i < 3; i++) {
      const hinge = c.centroid(cur);
      cur = c.extrude(cur, { by });
      c.rotate(cur, { axis: "x", deg: 30, about: hinge });
    }
    c.extrude(cur, { by: 20 });
    return c;
  };
  expect(print.subdiv(bent(5)).volume()).toBeGreaterThan(0);
  expect(() => print.subdiv(bent(2))).toThrow(/^subdiv: the body passes through itself/);
});

test("the cage section's limits and tolerances are the code's", () => {
  const surface = section("The surface: `k.subdiv`", "###");
  expect(surface).toContain(`${SUBDIV_TOLERANCE.preview} mm for preview, ${SUBDIV_TOLERANCE.print} mm for print`);
  expect(surface).toContain(`The levels run from\n  ${MIN_SUBDIV_LEVEL} to ${MAX_SUBDIV_LEVEL}`);
  const n = (x) => x.toLocaleString("en-US");
  expect(surface.replace(/\s+/g, " ")).toContain(
    `no level past ${n(SUBDIV_MAX_TRIANGLES.preview)} triangles for preview or ${n(SUBDIV_MAX_TRIANGLES.print)} triangles for print`);
  expect(surface).toContain(`at most ${MAX_CAGE_FACES.toLocaleString("en-US")} faces`);
  // "a ball about 84% as wide": the one-face-per-side cube's width over the cube's.
  const b = k.subdiv(k.cage({ box: { size: [20, 20, 20] } })).boundingBox();
  expect(surface).toContain(`a ball about ${Math.round(100 * (b.max[0] - b.min[0]) / 20)}%`);
  expect(cageSection()).toContain("`k.cage` and `k.subdiv` are kernel ops");
});

test("every quoted cage and subdiv error is the code's own", async () => {
  const errors = section("Cage errors", "###");
  const [cageBlock, subdivBlock] = fences("text", errors).map((b) => b.trim().split("\n"));
  const fish = () => k.cage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
  const grown = () => { const c = fish(); c.extrude("+y:0,0", { by: 12 }); return c; };
  const bar = () => { const c = k.cage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } }); c.extrude("+x:0,0", { by: 10 }); return c; };
  const ring = k.cage({ box: { size: [30, 30, 30], segs: [3, 3, 3] } });
  const cageTriggers = [
    () => bar().move("+x:0,0", [1, 0, 0]),
    () => grown().extrude("+y:9,0", { by: 1 }),
    () => fish().extrude("+z:1,1~", { by: 1 }),
    () => k.cage({ box: { size: [10, 10, 10] }, mirror: "xz" }),
    () => fish().extrude(["+y:1,0", "+y:3,0"], { by: 1 }),
    () => ring.extrude(["+z:0,0", "+z:1,0", "+z:2,0", "+z:0,1", "+z:2,1", "+z:0,2", "+z:1,2", "+z:2,2"], { by: 1 }),
    () => grown().extrude("-z:1,1", { by: 1, id: "+y:0,0>" }),
    () => k.cage({ box: { size: [10, 10, 10], segs: [30, 30, 30] } }),
    () => bar().rotate("+z:0,0", { axis: "up", deg: 10 }),
  ];
  const message = (f) => { try { f(); } catch (e) { return e.message; } throw new Error(`no throw: ${f}`); };
  expect(cageTriggers.map(message)).toEqual(cageBlock);
  // The rules the prose states, beside the quoted errors.
  expect(message(() => grown().extrude("-z:1,1", { by: 1, id: "fin~" }))).toMatch(/^cage: extrude id may not contain "~"/);
  // A body through itself: the print error; the warning at preview is the same text.
  const { createManifoldKernel } = await import("../src/framework/geometry/manifold-backend.js");
  const Module = (await import("manifold-3d")).default;
  const wasm = await Module(); wasm.setup();
  const print = createManifoldKernel(wasm, { quality: "print" });
  const through = (kk) => { const c = kk.cage({ box: { size: [20, 20, 20] } }); c.extrude("+x:0,0", { by: -25, scale: 0.3 }); return c; };
  const flat = (kk) => { const c = kk.cage({ box: { size: [20, 20, 20] } }); c.move("+x:0,0", [-20, 0, 0]); return c; };
  expect([
    message(() => print.subdiv(through(print))),
    message(() => k.subdiv(flat(k))),
    message(() => k.subdiv(whaleCage(k, whale.defaults).snapshot())),
  ]).toEqual(subdivBlock);
  k.takeBuildWarnings();
  k.subdiv(through(k));
  expect(k.takeBuildWarnings()).toEqual([subdivBlock[0]]);
  // The two tolerance warnings' wording, with their two numbers left open: the first when
  // level 5 is not fine enough (a 200 mm cube with one face per side, at print), the
  // second when the triangle limit stops the level.
  const warnings = [...errors.matchAll(/`(subdiv: the surface is within [^`]+)`/g)].map((m) => m[1].replace(/\s+/g, " "));
  expect(warnings).toHaveLength(2);
  const re = (w) => new RegExp(`^${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("<n>", "[0-9.e+]+").replace("<tolerance>", "0\\.05")}$`);
  const { meshSubdiv } = await import("../src/framework/geometry/subdiv/index.js");
  expect(meshSubdiv(k.cage({ box: { size: [200, 200, 200] } }).snapshot(), "print").warnings).toEqual([expect.stringMatching(re(warnings[0]))]);
  const out = meshSubdiv(k.cage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } }).snapshot(), "print", { maxTriangles: 200 });
  expect(out.warnings).toEqual([expect.stringMatching(re(warnings[1]))]);
  // A face crossing itself, as the Validity section quotes it.
  const fold = /named once, as\s+`([^`]+)`/.exec(section("Validity", "###"))[1];
  const folded = k.cage({ box: { size: [20, 20, 20], segs: [2, 2, 2] } });
  folded.extrude("+x:0,0", { by: -30, scale: 1.5 });
  k.takeBuildWarnings();
  k.subdiv(folded);
  expect(k.takeBuildWarnings().map(String).join("\n")).toMatch(new RegExp(`[:;] ${fold.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(;|$)`));
});

test("the backend section's subdiv messages are the code's own", () => {
  const backend = section("Backend: Manifold only");
  expect(backend).toContain("`subdiv: OCCT cannot build k.subdiv (it is mesh-native)`");
  expect(read("../src/framework/geometry/occt-backend.js")).toContain('IMPLICIT_ON_OCCT.replace(/^implicit:/, "subdiv:").replaceAll("k.implicit", "k.subdiv")');
  const fallback = /no\s+subdivision engine throws\s+`([^`]+)`/.exec(backend)[1];
  expect(() => finishKernel({}).subdiv(k.cage({ box: { size: [1, 1, 1] } }))).toThrow(fallback);
  expect(finishKernel({}).cage({ box: { size: [2, 2, 2] } }).centroid("+z:0,0")).toEqual([0, 0, 1]);
});
