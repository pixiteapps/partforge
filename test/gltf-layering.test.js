// partforge/gltf runs in Node (the cloud's sandbox job), a browser main thread
// (exportPreview) and a Web Worker. Two checks: the static import closure of OUR
// modules (the import-graph walker, as worker-layering.test.js does it), and an
// encode with no DOM, Blob or FileReader in scope, which is the only way to judge
// the bare packages the walker cannot descend into.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";
import { boxSoup } from "./helpers/preview-glb.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = `${ROOT}/src/gltf.js`;
const ALLOWED = new Set([
  "@gltf-transform/core", "@gltf-transform/extensions", "@gltf-transform/functions", "meshoptimizer/encoder",
]);
const DOM_GLOBALS = ["document", "window", "localStorage", "sessionStorage", "HTMLElement", "customElements", "Blob", "FileReader"];
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

afterEach(() => vi.unstubAllGlobals());

test("partforge/gltf imports no package beyond the encoder's own (no three, no Node builtin)", () => {
  const { bare, importer } = walk(ENTRY, "gltf walk");
  for (const spec of bare) {
    expect(ALLOWED.has(spec), `partforge/gltf must not import "${spec}":\n  ${chainTo(spec, importer, ROOT)}`).toBe(true);
  }
});

test("no module of ours in the closure touches a main-thread-only global", () => {
  const { files, importer } = walk(ENTRY, "gltf walk");
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const hit = DOM_GLOBALS.find((g) => new RegExp(`\\b${g}\\b`).test(src));
    expect(hit == null, hit ? `\`${hit}\` in partforge/gltf's closure:\n  ${chainTo(file, importer, ROOT)}` : "").toBe(true);
  }
});

test("it encodes with no document, window, Blob or FileReader in scope", async () => {
  for (const g of ["document", "window", "Blob", "FileReader"]) vi.stubGlobal(g, undefined);
  const { encodePreviewGlb } = await import("../src/gltf.js");
  const bytes = await encodePreviewGlb({ meshes: [boxSoup("a")], view: "v" });
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
});
