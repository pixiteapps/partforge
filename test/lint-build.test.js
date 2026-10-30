// Group 3 — kernel API usage, via the validating probe. Every error here already
// fails at runtime today; the linter just reaches it before a WASM boot.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (build, extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
  ...extra,
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a throwing derive is an error naming the thrown message", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 }),
    { derive: () => { throw new Error("bad derive maths"); } }));
  expect(ids(r.errors)).toContain("derive-throws");
  expect(find(r, "derive-throws").message).toContain("bad derive maths");
  expect(find(r, "derive-throws").path).toBe("derive");
});

test("a working derive is not flagged as derive-throws", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 }),
    { derive: (p) => ({ doubled: (p.r ?? 5) * 2 }) }));
  expect(ids(r.errors)).not.toContain("derive-throws");
});

test("a part with no derive at all is not flagged as derive-throws", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 })));
  expect(ids(r.errors)).not.toContain("derive-throws");
});

test("a valid build produces no build findings", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 })));
  expect(ids(r.errors)).toEqual([]);
});

test("an unknown kernel op is an error", () => {
  const r = lintPart(partWith((k) => k.cylindre({ r: 5, h: 10 })));
  expect(ids(r.errors)).toContain("unknown-kernel-op");
  expect(find(r, "unknown-kernel-op").message).toContain("cylindre");
});

test("an unknown solid op is an error", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 }).tranlsate([1, 0, 0])));
  expect(ids(r.errors)).toContain("unknown-solid-op");
});

test("an unknown option key is an error carrying the did-you-mean text", () => {
  const r = lintPart(partWith((k) => k.cylinder({ radius: 5, h: 10 })));
  expect(ids(r.errors)).toContain("invalid-op-options");
  expect(find(r, "invalid-op-options").message).toMatch(/did you mean r\?/);
});

test("a missing required option is an error", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5 })));
  expect(find(r, "invalid-op-options").message).toMatch(/h is required/);
});

test("a throwing build is an error naming the sub-part", () => {
  const r = lintPart(partWith(() => { throw new Error("bad maths"); }));
  expect(ids(r.errors)).toContain("build-throws");
  expect(find(r, "build-throws").message).toContain("bad maths");
  expect(find(r, "build-throws").path).toBe("parts.body.build");
});

test("an OCCT-only op with meta.backend manifold is an error", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }).shell({ t: 0.5, open: { dir: "Z" } }),
    { meta: { title: "T", backend: "manifold" } }));
  expect(ids(r.errors)).toContain("manifold-backend-uses-occt-op");
  expect(find(r, "manifold-backend-uses-occt-op").message).toContain("shell");
});

test("an OCCT-only op without a pinned backend is fine — routing handles it", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }).shell({ t: 0.5, open: { dir: "Z" } })));
  expect(ids(r.errors)).not.toContain("manifold-backend-uses-occt-op");
});

test("Solid.fillet with meta.backend manifold is fine now — the mesh backend implements it", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }).fillet({ r: 1 }),
    { meta: { title: "T", backend: "manifold" } }));
  expect(ids(r.errors)).not.toContain("manifold-backend-uses-occt-op");
});

test("Shape2D.fillet under a pinned Manifold backend is fine — it is the shared pure-JS op", () => {
  const r = lintPart(partWith(
    (k) => k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(2).extrude({ h: 3 }),
    { meta: { title: "T", backend: "manifold" } }));
  expect(ids(r.errors)).not.toContain("manifold-backend-uses-occt-op");
});

test("a runaway build is an error, not a hang", () => {
  const r = lintPart(partWith((k) => { for (;;) k.box({ size: [1, 1, 1] }); }));
  expect(ids(r.errors)).toContain("build-runaway");
});

test("an impure build is a warning citing the error pattern", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: Math.random() * 5 + 1, h: 10 })));
  expect(ids(r.warnings)).toContain("nondeterministic-build");
  expect(find(r, "nondeterministic-build").pattern).toBe("impure-build-stale-preview");
});

test("a pure build is not flagged as nondeterministic", () => {
  const r = lintPart(partWith((k, p) => k.cylinder({ r: p.r ?? 5, h: 10 })));
  expect(ids(r.warnings)).not.toContain("nondeterministic-build");
});

test("params override defaults for the probe pass", () => {
  // r: 0 is invalid geometry but a legal option value; what we assert is that the
  // override reaches build(), by making the build throw only for the injected value.
  const part = partWith((k, p) => {
    if (p.mode === "explode") throw new Error("exploded");
    return k.box({ size: [1, 1, 1] });
  });
  part.defaults = { mode: "ok" };
  expect(ids(lintPart(part).errors)).not.toContain("build-throws");
  expect(ids(lintPart(part, { params: { mode: "explode" } }).errors)).toContain("build-throws");
});

// `probes` — same (k, p, d) contract as build, so the same probe pass covers them.
test("a throwing probe is an error located at the probe", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }),
    { probes: { slab: () => { throw new Error("bad slab maths"); } } }));
  expect(ids(r.errors)).toContain("probe-throws");
  expect(find(r, "probe-throws").message).toContain("bad slab maths");
  expect(find(r, "probe-throws").path).toBe("probes.slab");
});

test("an unknown kernel op inside a probe is caught like one inside a build", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }),
    { probes: { slab: (k) => k.cylindre({ r: 5, h: 10 }) } }));
  expect(ids(r.errors)).toContain("unknown-kernel-op");
});

test("an impure probe is flagged nondeterministic", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }),
    { probes: { jitter: (k) => k.cylinder({ r: Math.random() * 5 + 1, h: 10 }) } }));
  expect(ids(r.warnings)).toContain("nondeterministic-build");
});

test("a pure probe raises no build findings", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }),
    { probes: { slab: (k, p, d) => k.box({ size: [1, 1, 1] }).volume() } }));
  expect(ids(r.errors)).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

// A throw after the build consulted a stubbed DATA query (contains, boundingBox,
// area, …: answers the geometry-free probe fabricates) proves nothing about the
// part — the build may simply have believed the fabricated answer. It is a note,
// never an error, so a part that builds fine is not blocked from loading.
test("a throw after a stubbed data query is a note, not an error — and the part really builds", async () => {
  const { default: part } = await import("./fixtures/stub-query-truss-part.js");
  const r = lintPart(part);
  // partforge-cloud's loadPart refuses a part exactly when `ok` is false (with any
  // non-source error); the CLI's `lint --strict` gate is pinned in lint-cli.test.js.
  expect(r.ok).toBe(true);
  expect(ids(r.errors)).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
  const n = r.notes.find((f) => f.rule === "build-throws");
  expect(n.severity).toBe("note");
  expect(n.message).toContain("Truss pitch is too large");
  expect(n.message).toMatch(/could not be evaluated geometry-free/);
  expect(n.message).toContain("contains");
  expect(n.path).toBe("parts.truss.build");
  const { bootManifoldKernel } = await import("../src/testing.js");
  const k = await bootManifoldKernel();
  try {
    const mesh = part.parts.truss.build(k, part.defaults, {}).toMesh();
    expect(mesh.triangles).toBeGreaterThan(0);
  } finally { k.cleanup?.(); }
});

test("a build that throws with no stubbed query consulted is still an error", () => {
  const r = lintPart(partWith((k) => { k.cylinder({ r: 5, h: 10 }).translate([1, 0, 0]); throw new Error("always"); }));
  expect(ids(r.errors)).toContain("build-throws");
  expect(r.notes.map((f) => f.rule)).not.toContain("build-throws");
});

test("a throw after a stubbed query is a note even when the throw looks unrelated", () => {
  // Lint cannot tell what a throw depended on once a fabricated answer is in play,
  // so it does not guess; the real build reports the real error at runtime.
  const r = lintPart(partWith((k) => {
    const s = k.shape2d([[0, 0], [1, 0], [1, 1]]);
    s.contains([0.5, 0.2]);
    return null.extrude({ h: 1 });
  }));
  expect(ids(r.errors)).not.toContain("build-throws");
  expect(r.notes.map((f) => f.rule)).toContain("build-throws");
});

test("query tracking is per build: one sub-part's query does not excuse another's throw", () => {
  const part = partWith((k) => k.box({ size: [1, 1, 1] }).boundingBox() && k.box({ size: [1, 1, 1] }));
  part.parts.lid = { views: ["main"], build: () => { throw new Error("lid maths"); } };
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("build-throws");
  expect(find(r, "build-throws").path).toBe("parts.lid.build");
});

test("a probe that throws stays an error, even after a stubbed query", () => {
  // At runtime a throwing probe degrades quietly to { error } — this error is what
  // makes it loud, and probes exist to read queries, so the note is builds-only.
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }), { probes: {
    gap: (k) => { if (k.box({ size: [2, 2, 2] }).volume() < 5) throw new Error("too small"); return 1; },
    slab: () => { throw new Error("bad slab maths"); },
  } }));
  expect(r.errors.filter((f) => f.rule === "probe-throws").map((f) => f.path)).toEqual(["probes.gap", "probes.slab"]);
  expect(r.notes.map((f) => f.rule)).not.toContain("probe-throws");
});

test("a part posing a limb with grip in derive lints clean through partforge/kinematics", async () => {
  const { limb } = await import("../src/framework/domains/kinematics/index.js");
  expect(typeof limb).toBe("function");
  const sub = (joint) => ({ build: (k) => k.box({ min: [0, 0, 0], max: [2, 8, 2] }), views: { assembly: (s, p, d) => d.f.place(s, joint) } });
  const part = {
    meta: { title: "Limb" },
    defaults: { curl: 0.2, gripOn: true },
    derive: (p) => {
      const L = limb("f", { toward: [0, 1, 0], bendToward: [0, 0, -1], r: [3, 2.5, 2, 1.5],
        joints: ["a", "b", "c"], lengths: [20, 15, 10] });
      const rod = { kind: "cylinder", r: 4, h: 60, at: [0, 10, -12], axis: [1, 0, 0] };
      return { f: p.gripOn ? L.pose({ grip: { around: rod } }) : L.pose({ curl: p.curl }) };
    },
    parts: { a: sub("a"), b: sub("b"), c: sub("c") },
    views: { assembly: { label: "A", animations: { close: { duration: 1, tracks: { curl: [[0, 0], [1, 1]] } } } } },
  };
  const r = lintPart(part);
  const rules = [...r.errors, ...r.warnings].map((f) => f.rule);
  for (const bad of ["build-throws", "probe-throws", "derive-throws", "unknown-kernel-op", "animation-track-rebuilds"]) expect(rules).not.toContain(bad);
});
