// The kit's layering. The drawing stage reaches paper (offsetRegions: contour-offset.js
// → paper-bridge.js — arc-fit.js is a paper-free leaf), so it must stay behind a dynamic
// import that only the export path takes: partforge/lint
// must stay dependency-free (test/lint-purity.test.js), the oracle paper-free
// (test/oracle-no-paper.test.js), and partforge/geometry's cloud chunk free of anything
// but paper. And adding a process means one line in process/registry.js AND one in
// process/exporters.js — the parity test is what makes forgetting the second fail.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo, importsOf } from "./helpers/import-graph.js";
import { EXPORTER_LOADERS, loadExporter } from "../src/framework/process/exporters.js";
import { PROCESS_IDS } from "../src/framework/process/registry.js";
import laserExporter from "../src/framework/process/laser/export.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const src = (rel) => readFileSync(`${ROOT}/${rel}`, "utf8");
const KIT_MODULES = ["src/framework/export/", "src/framework/process/exporters.js", "src/framework/process/laser/export.js"];

test("every registered process has an exporter, in registry order", () => {
  expect(Object.keys(EXPORTER_LOADERS)).toEqual(PROCESS_IDS);
});

test("loadExporter hands back the process's exporter, and refuses an unknown id", async () => {
  expect(await loadExporter("laser")).toBe(laserExporter);
  expect(typeof laserExporter.drawing).toBe("function");
  await expect(loadExporter("cnc")).rejects.toThrow('no exporter for process "cnc"');
  await expect(loadExporter("toString")).rejects.toThrow('no exporter for process "toString"');
});

test("process/exporters.js reaches an exporter only through a dynamic import", () => {
  const text = src("src/framework/process/exporters.js");
  expect(importsOf(text, { eager: true })).toEqual([]);
  expect(importsOf(text)).toEqual(["./laser/export.js"]);
});

test("export/formats.js imports nothing", () => {
  expect(importsOf(src("src/framework/export/formats.js"))).toEqual([]);
});

test("lint, the oracle and partforge/geometry never reach the kit's writers", () => {
  for (const entry of ["src/lint.js", "src/oracle.js", "src/framework/geometry/polygon.js"]) {
    const { files, importer } = walk(`${ROOT}/${entry}`, `kit-export-guards walk from ${entry}`);
    for (const file of files) {
      const hit = KIT_MODULES.some((m) => file.startsWith(`${ROOT}/${m}`));
      expect(hit, hit ? `${entry} must not reach the kit's export stage:\n  ${chainTo(file, importer, ROOT)}` : "").toBe(false);
    }
  }
});

test("the export stage is worker-safe: paper is its only package, and it touches no DOM global", () => {
  // It runs in the geometry worker once jobs.js loads it (P2b) — hold the worker's rules
  // (test/worker-layering.test.js) now, while the modules are new.
  const DOM_GLOBALS = ["document", "window", "localStorage", "sessionStorage", "HTMLElement", "customElements"];
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const bare = new Set();
  for (const entry of ["src/framework/process/exporters.js", "src/framework/export/svg.js", "src/framework/export/dxf.js", "src/framework/export/layout.js"]) {
    const walked = walk(`${ROOT}/${entry}`, `kit-export-guards walk from ${entry}`);
    for (const b of walked.bare) bare.add(b);
    for (const file of walked.files) {
      const hit = DOM_GLOBALS.find((g) => new RegExp(`\\b${g}\\b`).test(strip(readFileSync(file, "utf8"))));
      expect(hit == null, hit ? `\`${hit}\` in the kit's worker closure:\n  ${chainTo(file, walked.importer, ROOT)}` : "").toBe(true);
    }
  }
  expect([...bare]).toEqual(["paper/dist/paper-core.js"]);
});
