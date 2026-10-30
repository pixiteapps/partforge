// The organic domain's lint rules (src/framework/domains/organic/lint.js): geometry-free
// checks over the k.implicit / k.implicitFrames specs the validating probe records. An
// error is only ever something the build would also throw; the rest are warnings or notes.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const all = (r) => [...r.errors, ...r.warnings, ...r.notes];
const of = (r, rule) => all(r).filter((f) => f.rule === rule);

const partWith = (build, extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
  ...extra,
});
const implicitPart = (spec, extra) => partWith((k) => k.implicit(spec), extra);

// --- implicit-spec-invalid --------------------------------------------------

test("implicit-spec-invalid: an unknown node kind is an error with the engine's message", () => {
  const [f, ...rest] = of(lintPart(implicitPart({ root: { kind: "spher", r: 5 } })), "implicit-spec-invalid");
  expect(rest).toEqual([]);
  expect(f.severity).toBe("error");
  expect(f.message).toMatch(/unknown kind/);
  expect(f.path).toBe("parts");
});

test("implicit-spec-invalid: a frame cycle, a bad formula and a nested contact are errors", () => {
  const cycle = { frames: { a: { parent: "b" }, b: { parent: "a" } }, root: { kind: "sphere", r: 5, frame: "a" } };
  const formula = { root: { kind: "expr", sdf: "lenght(p) - 5", box: [[-6, -6, -6], [6, 6, 6]] } };
  const nested = { root: { kind: "union", children: [
    { kind: "contact", children: [{ kind: "sphere", r: 5, label: "a" }, { kind: "sphere", r: 5, at: [8, 0, 0], label: "b" }] },
  ] } };
  for (const spec of [cycle, formula, nested]) {
    expect(of(lintPart(implicitPart(spec)), "implicit-spec-invalid").map((f) => f.severity), JSON.stringify(spec)).toEqual(["error"]);
  }
});

test("implicit-spec-invalid: a valid spec and a valid k.implicitFrames call are quiet", () => {
  expect(of(lintPart(implicitPart({ root: { kind: "sphere", r: 5 } })), "implicit-spec-invalid")).toEqual([]);
  const frames = partWith((k) => { k.implicitFrames({ root: { kind: "sphere", r: 5 } }); return k.box({ size: [1, 1, 1] }); });
  expect(of(lintPart(frames), "implicit-spec-invalid")).toEqual([]);
  const badFrames = partWith((k) => { k.implicitFrames({ root: { kind: "spher", r: 5 } }); return k.box({ size: [1, 1, 1] }); });
  expect(of(lintPart(badFrames), "implicit-spec-invalid")).toHaveLength(1);
});

test("implicit-spec-invalid: texture names are checked against a static images object only", () => {
  const textured = (image) => ({
    root: { kind: "sphere", r: 10 },
    detail: [{ kind: "texture", image, amplitude: 0.4, size: [10, 10] }],
  });
  const skin = { skin: new URL("file:///skin.png") };
  expect(of(lintPart(implicitPart(textured("skin"), { images: skin })), "implicit-spec-invalid")).toEqual([]);
  expect(of(lintPart(implicitPart(textured("nope"), { images: skin })), "implicit-spec-invalid")).toHaveLength(1);
  // A function-form images field is not statically known: never a false error.
  expect(of(lintPart(implicitPart(textured("nope"), { images: () => ({}) })), "implicit-spec-invalid")).toEqual([]);
});

test("implicit-spec-invalid: the same spec built many times is one finding", () => {
  const part = partWith((k) => k.union([0, 1, 2].map(() => k.implicit({ root: { kind: "spher", r: 5 } }))));
  expect(of(lintPart(part), "implicit-spec-invalid")).toHaveLength(1);
});

test("implicit-spec-invalid: a spec driven by params lints clean at its defaults", () => {
  const part = partWith((k, p) => k.implicit({ root: { kind: "capsule", b: [0, p.len, 0], r: p.r } }), { defaults: { len: 20, r: 3 } });
  expect(of(lintPart(part), "implicit-spec-invalid")).toEqual([]);
});

// --- implicit-thin-feature --------------------------------------------------

const ballAndPlate = (extra = {}) => ({ root: { kind: "union", children: [
  { kind: "sphere", r: 10 }, { kind: "box", size: [20, 20, 0.5], at: [0, 0, 12] },
] }, ...extra });

test("implicit-thin-feature: a plate thinner than two cells warns, naming both tiers", () => {
  const [f, ...rest] = of(lintPart(implicitPart(ballAndPlate())), "implicit-thin-feature");
  expect(rest).toEqual([]);
  expect(f.severity).toBe("warning");
  expect(f.message).toMatch(/0\.50 mm/);
  expect(f.message).toMatch(/preview/);
  expect(f.message).toMatch(/print/);
});

test("implicit-thin-feature: quiet when both grids resolve the thinnest feature", () => {
  expect(of(lintPart(implicitPart({ root: { kind: "sphere", r: 10 }, resolution: 0.6, preview: 1.5 })), "implicit-thin-feature")).toEqual([]);
  expect(of(lintPart(implicitPart(ballAndPlate({ preview: 0.2, resolution: 0.2 }))), "implicit-thin-feature")).toEqual([]);
});

test("implicit-thin-feature: names only the tier that fails", () => {
  const [f] = of(lintPart(implicitPart(ballAndPlate({ preview: 0.2 }))), "implicit-thin-feature");
  expect(f.message).toMatch(/print/);
  expect(f.message).not.toMatch(/preview/);
});

// --- implicit-blend-eats-child ----------------------------------------------

const blended = (k) => ({ root: { kind: "union", k, children: [{ kind: "sphere", r: 10 }, { kind: "sphere", r: 1, at: [11, 0, 0] }] } });

test("implicit-blend-eats-child: a blend wider than a child warns, naming the child", () => {
  const [f, ...rest] = of(lintPart(implicitPart(blended(4))), "implicit-blend-eats-child");
  expect(rest).toEqual([]);
  expect(f.severity).toBe("warning");
  expect(f.message).toContain("root.children[1]");
});

test("implicit-blend-eats-child: quiet when the blend is narrower than every child", () => {
  expect(of(lintPart(implicitPart(blended(1))), "implicit-blend-eats-child")).toEqual([]);
});

test("implicit-blend-eats-child: a contact attach k wider than a piece warns", () => {
  const spec = (k) => ({ frames: { j: { at: [6, 0, 0] } }, root: { kind: "contact", attach: [{ a: "big", b: "small", near: "j", radius: 2, k }], children: [
    { kind: "sphere", r: 10, label: "big" }, { kind: "sphere", r: 1.5, at: [11, 0, 0], label: "small" },
  ] } });
  expect(of(lintPart(implicitPart(spec(5))), "implicit-blend-eats-child")).toHaveLength(1);
  expect(of(lintPart(implicitPart(spec(1))), "implicit-blend-eats-child")).toEqual([]);
});

// --- implicit-csg-in-disguise -----------------------------------------------

const drilled = (extra = {}) => ({ root: { kind: "subtract", children: [
  { kind: "box", size: [20, 20, 20] }, { kind: "cylinder", r: 3, h: 30 },
], ...extra } });

test("implicit-csg-in-disguise: boxes and cylinders with sharp booleans are a note", () => {
  const r = lintPart(implicitPart(drilled()));
  expect(r.notes.filter((f) => f.rule === "implicit-csg-in-disguise")).toHaveLength(1);
});

test("implicit-csg-in-disguise: a blend, a round or a curved primitive makes it organic", () => {
  expect(of(lintPart(implicitPart(drilled({ k: 1 }))), "implicit-csg-in-disguise")).toEqual([]);
  expect(of(lintPart(implicitPart({ root: { kind: "round", r: 1, child: drilled().root } })), "implicit-csg-in-disguise")).toEqual([]);
  const sphere = { root: { kind: "subtract", children: [{ kind: "sphere", r: 10 }, { kind: "cylinder", r: 3, h: 30 }] } };
  expect(of(lintPart(implicitPart(sphere)), "implicit-csg-in-disguise")).toEqual([]);
});

test("an invalid spec gets only implicit-spec-invalid", () => {
  const r = lintPart(implicitPart({ root: { kind: "union", k: 40, children: [{ kind: "box", size: [1, 1, 0.1] }, { kind: "spher" }] } }));
  expect(all(r).filter((f) => f.rule.startsWith("implicit-")).map((f) => f.rule)).toEqual(["implicit-spec-invalid"]);
});

// --- implicit-needs-manifold ------------------------------------------------

test("implicit-needs-manifold: k.implicit in a part pinned to OCCT is an error", () => {
  const [f] = of(lintPart(implicitPart({ root: { kind: "sphere", r: 5 } }, { meta: { title: "T", backend: "occt" } })), "implicit-needs-manifold");
  expect(f.severity).toBe("error");
  expect(f.path).toBe("meta.backend");
});

test("implicit-needs-manifold: k.implicit beside a shell (which routes the part to OCCT) is an error", () => {
  const part = partWith((k) => k.union([k.implicit({ root: { kind: "sphere", r: 5 } }), k.box({ size: [4, 4, 4] }).shell({ thickness: 1 })]));
  expect(of(lintPart(part), "implicit-needs-manifold")).toHaveLength(1);
});

test("implicit-needs-manifold: quiet on Manifold and without k.implicit", () => {
  expect(of(lintPart(implicitPart({ root: { kind: "sphere", r: 5 } }, { meta: { title: "T", backend: "manifold" } })), "implicit-needs-manifold")).toEqual([]);
  expect(of(lintPart(partWith((k) => k.box({ size: [1, 1, 1] }), { meta: { title: "T", backend: "occt" } })), "implicit-needs-manifold")).toEqual([]);
});
