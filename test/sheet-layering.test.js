// Sheet parts' module layering (sheet parts spec C.1). The process registry and its
// descriptors are read by lint, the oracle and the geometry surface alike, so they
// stay import-free; the writers (export/*, process/<id>/export.js — reached through
// process/exporters.js) touch paper and fflate and must stay out of all three. Held:
//   1. only process/registry.js and process/exporters.js import a process folder,
//   2. a descriptor imports nothing but sheet/constants.js and lint/finding.js,
//   3. every process/<id>/ folder is a registered process and each descriptor's id
//      is its folder (P2's kit-layering test pins the exporter ids to the same list),
//   4. lint's and the oracle's closures reach no joinery, sheetPart, writer or bare
//      package,
//   5. the registry, the resolver and the sheet rules load without paper.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { walk, importsOf } from "./helpers/import-graph.js";
import { PROCESSES, PROCESS_IDS } from "../src/framework/process/registry.js";

// paper-core builds a PaperScope and probes a canvas the moment it is imported
// (test/oracle-no-paper.test.js); here it throws instead, so anything in this file
// that pulls it in fails loudly.
vi.mock("paper/dist/paper-core.js", () => {
  throw new Error("paper-core loaded by a module that must stay paper-free");
});

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SRC = `${ROOT}/src`;
const PROCESS_DIR = `${SRC}/framework/process`;
const rel = (p) => relative(ROOT, p);
const jsFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? jsFiles(p) : name.endsWith(".js") ? [p] : [];
});
// A relative specifier resolved against its importer, as a repo path.
const target = (file, spec) => rel(join(file, "..", spec));
const processFolder = (p) => p.match(/^src\/framework\/process\/[^/]+\//)?.[0] ?? null;
const FORBIDDEN = (p) => p === "src/framework/sheet/joinery.js" || p === "src/framework/sheet/part.js"
  || p.startsWith("src/framework/export/") || p === "src/framework/process/exporters.js";

test("only the registry and the exporter table import a process folder", () => {
  const ALLOWED = new Set(["src/framework/process/registry.js", "src/framework/process/exporters.js"]);
  for (const file of jsFiles(SRC)) {
    const from = rel(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const to = target(file, spec);
      const folder = processFolder(to);
      if (!folder || processFolder(from) === folder) continue;   // a process's own files may import each other
      expect(ALLOWED.has(from), `${from} imports ${to} — only process/registry.js and process/exporters.js reach into a process folder`).toBe(true);
    }
  }
});

test("a process descriptor imports only sheet/constants.js and lint/finding.js", () => {
  for (const id of PROCESS_IDS) {
    const file = `${PROCESS_DIR}/${id}/descriptor.js`;
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      expect(["src/framework/sheet/constants.js", "src/framework/lint/finding.js"], `${rel(file)} imports ${spec}`)
        .toContain(spec.startsWith(".") ? target(file, spec) : spec);
    }
  }
});

test("every process folder is a registered process, and each descriptor's id is its folder", async () => {
  const folders = readdirSync(PROCESS_DIR).filter((n) => statSync(join(PROCESS_DIR, n)).isDirectory()).sort();
  expect(folders).toEqual([...PROCESS_IDS].sort());
  for (const folder of folders) {
    const mod = await import(`../src/framework/process/${folder}/descriptor.js`);
    const descriptor = Object.values(mod).find((v) => v && typeof v === "object" && typeof v.id === "string");
    expect(descriptor?.id, folder).toBe(folder);
    expect(PROCESSES).toContain(descriptor);
    expect(descriptor.docId).toBe("sheet-parts");
  }
});

test("lint's closure reaches no joinery, sheetPart, writer, or bare package", () => {
  const { files, bare } = walk(`${SRC}/lint.js`, "sheet-layering lint walk");
  expect([...files].map(rel).filter(FORBIDDEN)).toEqual([]);
  expect([...bare]).toEqual([]);
});

test("the oracle's measure and verify closures reach no joinery, sheetPart, writer, or bare package", () => {
  for (const entry of ["oracle/measure.js", "oracle/verify.js"]) {
    const { files, bare } = walk(`${SRC}/framework/${entry}`, `sheet-layering ${entry} walk`);
    expect([...files].map(rel).filter(FORBIDDEN), entry).toEqual([]);
    expect([...bare], entry).toEqual([]);
  }
});

test("the registry, the resolver and the sheet rules load without paper", async () => {
  await expect(import("../src/framework/process/registry.js")).resolves.toBeTruthy();
  await expect(import("../src/framework/sheet/resolve.js")).resolves.toBeTruthy();
  await expect(import("../src/framework/lint/rules-sheet.js")).resolves.toBeTruthy();
});
