// Import lint rules — static, geometry-free checks that catch what an import
// misdeclaration would otherwise throw for only at build/verify time (see
// rules-imports.js's own header comment). Pure: no kernel boots.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

const partWith = (extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
  ...extra,
});

// --- import-unknown-name ---------------------------------------------------

test("k.import(\"name\") with no matching imports declaration is an error", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: { body: { views: ["main"], build: (k) => k.import("nope") } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("import-unknown-name");
  expect(find(r, "import-unknown-name").message).toContain("nope");
  expect(find(r, "import-unknown-name").message).toContain("scan");
});

test("k.import(\"name\") matching a declared import is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: { body: { views: ["main"], build: (k) => k.import("scan") } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-unknown-name");
});

// --- import-mesh-on-occt ----------------------------------------------------

test("a declared STL import on an OCCT-routed part (meta.backend) is an error", () => {
  const part = partWith({
    meta: { title: "T", backend: "occt" },
    imports: { scan: new URL("https://example.com/scan.stl") },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("import-mesh-on-occt");
  expect(find(r, "import-mesh-on-occt").message).toContain("scan");
  expect(find(r, "import-mesh-on-occt").message).toMatch(/meta\.backend/);
});

test("a declared STL import on an OCCT-routed part (shell op) names the CAD op as the cause", () => {
  // shell, not fillet: since contract v3 fillet/chamfer are mesh-native and no
  // longer probe-route to OCCT — shell is the remaining statically-routed CAD op.
  const part = partWith({
    imports: { scan: new URL("https://example.com/scan.stl") },
    parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }).shell({ t: 0.2 }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("import-mesh-on-occt");
  expect(find(r, "import-mesh-on-occt").message).not.toMatch(/meta\.backend/);
});

test("a declared STL import on a Manifold-routed part is not flagged", () => {
  const part = partWith({ imports: { scan: new URL("https://example.com/scan.stl") } });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-mesh-on-occt");
});

test("a declared STEP import on an OCCT-routed part is not flagged (STEP is fine on OCCT)", () => {
  const part = partWith({
    meta: { title: "T", backend: "occt" },
    imports: { scan: new URL("https://example.com/scan.step") },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-mesh-on-occt");
});

test("a bytes/thunk import source is skipped (format unknowable statically)", () => {
  const part = partWith({
    meta: { title: "T", backend: "occt" },
    imports: { scan: () => new ArrayBuffer(0) },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-mesh-on-occt");
});

// --- reference-unknown -------------------------------------------------------

test("a sub-part reference naming no declared import is an error", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "nope", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("reference-unknown");
  expect(find(r, "reference-unknown").message).toContain("nope");
});

test("a sub-part reference naming a declared import is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "scan", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("reference-unknown");
});

// --- ref-metric-without-reference -------------------------------------------

test("a ref* verify metric on a sub-part with no reference is a warning", () => {
  const part = partWith({
    verify: { expect: { body: { refXorVolume: "<=50mm3" } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("ref-metric-without-reference");
  expect(find(r, "ref-metric-without-reference").message).toContain("body");
});

test("a ref* verify metric on a sub-part that declares a reference is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "scan", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
    verify: { expect: { body: { refXorVolume: "<=50mm3" } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
});

test("a non-ref metric on a sub-part with no reference is not flagged", () => {
  const part = partWith({
    verify: { expect: { body: { holes: 0 } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
});

test("a typo'd sub-part name in verify.expect is not double-flagged here (verify-unknown-subpart owns it)", () => {
  const part = partWith({
    verify: { expect: { boddy: { refXorVolume: "<=50mm3" } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
});

// A function-form `verify.expect` is not statically inspectable in general, but
// `resolveExpectOnce()` (shared with the Group 4 verify rules) already resolves it
// safely against the probe's params — this rule intentionally does NOT skip the
// function form, so a ref* metric surfaced through it is checked exactly like the
// static-object form.
test("a ref* metric inside a function-form verify.expect with no reference is a warning", () => {
  const part = partWith({
    verify: { expect: (p, d) => ({ body: { refXorVolume: "<=50mm3" } }) },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("ref-metric-without-reference");
  expect(find(r, "ref-metric-without-reference").message).toContain("body");
});

test("a ref* metric inside a function-form verify.expect WITH a reference is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "scan", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
    verify: { expect: (p, d) => ({ body: { refXorVolume: "<=50mm3" } }) },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
});

// --- reference to a sub-part -------------------------------------------------

const box = (k) => k.box({ size: [1, 1, 1] });
const refPart = (parts, extra = {}) => partWith({ parts, ...extra });

test("a reference naming a sub-part, with no import, is not flagged", () => {
  const r = lintPart(refPart({
    body: { views: ["main"], reference: "ref", build: box },
    ref: { views: ["main"], exportable: false, build: box },
  }));
  const all = [...r.errors, ...r.warnings].map((f) => f.rule);
  for (const id of ["reference-unknown", "reference-ambiguous", "reference-self", "reference-exportable"]) {
    expect(all).not.toContain(id);
  }
});

test("a reference naming neither an import nor a sub-part names both places", () => {
  const r = lintPart(refPart({ body: { views: ["main"], reference: "nope", build: box } }));
  const f = find(r, "reference-unknown");
  expect(f.message).toContain("import");
  expect(f.message).toContain("sub-part");
});

test("a name that is both an import and a sub-part is ambiguous only", () => {
  const r = lintPart(refPart({
    body: { views: ["main"], reference: "ref", build: box },
    ref: { views: ["main"], exportable: false, build: box },
  }, { imports: { ref: () => new ArrayBuffer(0) } }));
  expect(ids(r.errors)).toContain("reference-ambiguous");
  expect(ids(r.errors)).not.toContain("reference-unknown");
});

test("a sub-part referencing itself is reference-self", () => {
  const r = lintPart(refPart({ body: { views: ["main"], reference: "body", build: box } }));
  expect(ids(r.errors)).toContain("reference-self");
  expect(find(r, "reference-self").path).toBe("parts.body.reference");
});

test("a two-part cycle is reported once per sub-part", () => {
  const r = lintPart(refPart({
    a: { views: ["main"], reference: "b", exportable: false, build: box },
    b: { views: ["main"], reference: "a", exportable: false, build: box },
  }));
  const paths = r.errors.filter((f) => f.rule === "reference-self").map((f) => f.path).sort();
  expect(paths).toEqual(["parts.a.reference", "parts.b.reference"]);
});

test("a chain leading into a cycle flags only the cycle members", () => {
  const r = lintPart(refPart({
    a: { views: ["main"], reference: "b", exportable: false, build: box },
    b: { views: ["main"], reference: "c", exportable: false, build: box },
    c: { views: ["main"], reference: "b", exportable: false, build: box },
  }));
  const paths = r.errors.filter((f) => f.rule === "reference-self").map((f) => f.path).sort();
  expect(paths).toEqual(["parts.b.reference", "parts.c.reference"]);
});

test("a reference sub-part that is still exportable is a warning at its exportable key", () => {
  const r = lintPart(refPart({
    body: { views: ["main"], reference: "ref", build: box },
    ref: { views: ["main"], build: box },
  }));
  expect(ids(r.warnings)).toContain("reference-exportable");
  expect(find(r, "reference-exportable").path).toBe("parts.ref.exportable");
});

test("ref-metric-without-reference's hint names the sub-part form", () => {
  const part = partWith({ verify: { expect: { body: { refXorVolume: "<=50mm3" } } } });
  const r = lintPart(part);
  expect(find(r, "ref-metric-without-reference").hint).toContain('reference: "<sub-part name>"');
});
