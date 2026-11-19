// The organic domain (src/framework/domains/organic/): k.implicit and k.implicitFrames
// registered in place. The engine stays in geometry/implicit/ — both backends and the
// native core call it, and core may not import a domain folder — so the domain is the
// manifest that tags the two ops, the partforge/organic entry, its types and its guide.
import { expect, test } from "vitest";
import { DOMAINS, domainOfOp } from "../src/framework/domains/registry.js";
import { domainsOf } from "../src/lint.js";
import { finishKernel } from "../src/framework/geometry/kernel-front.js";
import * as organic from "../src/framework/domains/organic/index.js";

const src = (text) => ({ files: { "part.js": text }, entrypoint: "part.js" });

test("the registry carries organic, tagging k.implicit and k.implicitFrames", () => {
  const d = DOMAINS.find((m) => m.id === "organic");
  expect(d).toMatchObject({ title: "Organic", subpath: "partforge/organic", guide: "docs/domains/organic.md" });
  expect(d.kernelOps.map((op) => op.name)).toEqual(["implicit", "implicitFrames"]);
  expect(domainOfOp("implicit")).toBe("organic");
  expect(domainOfOp("implicitFrames")).toBe("organic");
});

test("domainsOf finds a part that calls k.implicit or k.implicitFrames, or imports partforge/organic", () => {
  expect(domainsOf(src("export default { parts: { a: { build: (k) => k.implicit({ root: { kind: \"sphere\", r: 5 } }) } } };"))).toEqual(["organic"]);
  expect(domainsOf(src("const probe = (k) => k.implicitFrames(spec);"))).toEqual(["organic"]);
  expect(domainsOf(src('import { validateImplicit } from "partforge/organic";'))).toEqual(["organic"]);
});

test("a kernel without the engine gets a k.implicit that says so, and a working k.implicitFrames", () => {
  const k = finishKernel({});
  expect(() => k.implicit({ root: { kind: "sphere", r: 5 } })).toThrow(
    "implicit: this kernel has no implicit engine — build the part on the Manifold backend");
  const set = k.implicitFrames({ frames: { tip: { at: [0, 0, 10] } }, root: { kind: "sphere", r: 5, frame: "tip", label: "ball" } });
  expect(set.report().frames.tip.origin).toEqual([0, 0, 10]);
});

test("a backend's own k.implicit wins over the domain fallback", () => {
  const native = () => "native";
  expect(finishKernel({ implicit: native }).implicit({ root: { kind: "sphere", r: 1 } })).toBe("native");
});

test("partforge/organic validates a spec without a kernel, listing every issue", () => {
  expect(() => organic.validateImplicit({ root: { kind: "sphere", r: 5 } })).not.toThrow();
  let caught;
  try { organic.validateImplicit({ root: { kind: "sphere", r: -1, wobble: 2 } }); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(organic.ImplicitSpecError);
  expect(caught.code).toBe("IMPLICIT_SPEC");
  expect(caught.issues).toEqual(['root: unknown field "wobble"', "root.r: must be a number > 0"]);
});

test("partforge/organic lists the grammar's node and detail kinds, frozen", () => {
  expect(organic.IMPLICIT_NODE_KINDS).toContain("contact");
  expect(organic.IMPLICIT_NODE_KINDS).toContain("sphere");
  expect(organic.IMPLICIT_DETAIL_KINDS).toEqual(["creases", "noise", "texture", "expr"]);
  expect(Object.isFrozen(organic.IMPLICIT_NODE_KINDS)).toBe(true);
});

test("partforge/organic stays light: no mesher, no native core", async () => {
  const { walk } = await import("./helpers/import-graph.js");
  const { files } = walk(new URL("../src/framework/domains/organic/index.js", import.meta.url).pathname, "organic walk");
  const heavy = [...files].filter((f) => /geometry\/implicit\/(index|mesher|program)\.js$|\/core\//.test(f));
  expect(heavy).toEqual([]);
});
