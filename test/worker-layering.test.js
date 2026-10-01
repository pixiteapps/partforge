// The geometry Web Worker's import closure is a layering boundary, and until now it
// was held only by discipline. Nothing statically reachable from src/framework/worker.js
// may touch the DOM, three.js, or Node — the worker has no `document`, no `window`, and
// no `node:fs`. A contributor who imports tooltip.js into jobs.js for one convenient
// helper passes every other test in this suite and only explodes at worker runtime with
// "document is not defined", inside a WASM-booting worker, with no stack worth reading.
// So walk the graph and assert it.
//
// This is also what keeps the src/framework/oracle/ vs src/testing/ split honest: the
// oracle (measure/verify/build/BVH) runs inside this worker for the `inspect` job, while
// src/testing/ boots kernels from disk and writes PNGs. If someone moves a Node-only
// helper back under the oracle, the `node:` check below names the chain.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = `${ROOT}/src/framework/worker.js`;

// three.js is the viewer's dependency and drags in DOM assumptions; the rest are the
// Node builtins that a headless-harness module would bring along. Bare builtin names
// are listed alongside the `node:` prefix because both forms resolve in Node.
const BANNED_PACKAGES = ["three"];
const NODE_BUILTINS = ["fs", "path", "url", "module", "os", "crypto", "child_process", "worker_threads", "process", "util", "stream", "zlib"];

// Main-thread-only globals. `self`, `globalThis`, and `fetch` all exist in a worker and
// are deliberately absent from this list.
const DOM_GLOBALS = ["document", "window", "localStorage", "sessionStorage", "HTMLElement", "customElements"];

// Same comment-stripping rule the walker uses: this codebase explains WHY in prose, and
// that prose mentions `document` when describing what a module must not do.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const graph = () => walk(ENTRY, "worker-layering walk");

test("the worker import closure reaches no Node builtin", () => {
  const { bare, importer } = graph();
  for (const spec of bare) {
    const name = spec.replace(/^node:/, "").split("/")[0];
    const isBuiltin = spec.startsWith("node:") || NODE_BUILTINS.includes(name);
    expect(isBuiltin, isBuiltin
      ? `the geometry worker must not import the Node builtin "${spec}":\n  ${chainTo(spec, importer, ROOT)}`
      : "").toBe(false);
  }
});

test("the worker import closure reaches no DOM-bound package", () => {
  const { bare, importer } = graph();
  for (const banned of BANNED_PACKAGES) {
    expect(bare.has(banned), bare.has(banned)
      ? `the geometry worker must not import "${banned}":\n  ${chainTo(banned, importer, ROOT)}`
      : "").toBe(false);
  }
});

test("no module in the worker closure touches a main-thread-only global", () => {
  const { files, importer } = graph();
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const hit = DOM_GLOBALS.find((g) => new RegExp(`\\b${g}\\b`).test(src));
    expect(hit == null, hit
      ? `the geometry worker has no \`${hit}\` — this module cannot be in its import closure:\n  ${chainTo(file, importer, ROOT)}`
      : "").toBe(true);
  }
});

test("the worker import closure reaches nothing under src/framework/ingest/", () => {
  // The only DOM-dependent module in the vector2d feature (svg-ingest.js's own
  // header comment) — it runs paper.js's importSVG + a DOMParser normalization
  // pass, both of which need a real DOM, in the browser host that runs ingest
  // once per artwork. Nothing under here may reach the worker: today the DOM
  // check above happens to catch it too, but only because the word `document`
  // survives in a few error strings there by accident — this branch already
  // demonstrates that accident is fragile (vector-format.js was renamed
  // "document" → "file" in its own error text so THAT module could safely
  // enter the worker). Assert the actual invariant directly instead of relying
  // on incidental wording.
  const { files, importer } = graph();
  for (const file of files) {
    const inIngest = file.startsWith(`${ROOT}/src/framework/ingest/`);
    expect(inIngest, inIngest
      ? `src/framework/ingest/ is DOM-dependent; the geometry worker must not reach it:\n  ${chainTo(file, importer, ROOT)}`
      : "").toBe(false);
  }
});

test("the worker import closure reaches nothing under src/testing/", () => {
  // src/testing/ is the Node-only harness (kernel booters, the PNG renderer, the
  // ERROR-PATTERNS reader). The worker-reachable oracle lives in src/framework/oracle/.
  const { files, importer } = graph();
  for (const file of files) {
    const inTesting = file.startsWith(`${ROOT}/src/testing/`);
    expect(inTesting, inTesting
      ? `src/testing/ is the Node-only harness; the geometry worker must not reach it:\n  ${chainTo(file, importer, ROOT)}`
      : "").toBe(false);
  }
});

test("the worker's EAGER import closure loads no oracle pipeline module", () => {
  // The oracle is worker-reachable but not worker-boot code: measure/verify/build,
  // silhouette/match, and the describe stack together are the largest JS payload in
  // the worker bundle, and only the `inspect` and `describe` jobs run them. jobs.js
  // therefore loads each family with a literal dynamic import() on first use —
  // partforge's own Vite config and partforge-cloud both build workers as ES modules,
  // so those imports split into chunks that a user who never runs an oracle job never
  // downloads or parses. This walk sees only STATIC imports (eager: true), so it
  // fails the moment someone hoists an oracle import back to the top of jobs.js.
  //
  // Two allowed exceptions, both tiny pure leaves the linter shares (rules-verify.js
  // reads the DFM profile table and the assertion grammar — data, not pipeline).
  const ORACLE_EAGER_OK = new Set(["dfm-profiles.js", "assert-dsl.js"]);
  const { files, importer } = walk(ENTRY, "eager worker walk", { eager: true });
  for (const file of files) {
    if (!file.includes("/src/framework/oracle/")) continue;
    const base = file.split("/").pop();
    expect(ORACLE_EAGER_OK.has(base), ORACLE_EAGER_OK.has(base)
      ? ""
      : `oracle modules load lazily (first inspect/describe job), never at worker boot:\n  ${chainTo(file, importer, ROOT)}`).toBe(true);
  }
});

test("the worker's EAGER import closure loads no cut & print kit module", () => {
  // The kit — export/* (formats, writers, layout, README, zip) and the process
  // exporters behind it — loads the way the oracle does: jobs.js's `loadBundle` is a
  // literal dynamic import(), so a session that never downloads a kit never downloads
  // or parses one. export/formats.js is no exception: small, but nothing at worker boot
  // needs it (the main thread imports it for listExportFormats()).
  const { files, importer } = walk(ENTRY, "eager worker walk", { eager: true });
  for (const file of files) {
    const kit = file.includes("/src/framework/export/")
      || /\/src\/framework\/process\/(exporters|[^/]+\/export)\.js$/.test(file);
    expect(kit, kit
      ? `the cut & print kit loads lazily (first export-bundle job), never at worker boot:\n  ${chainTo(file, importer, ROOT)}`
      : "").toBe(false);
  }
});

test("the kit is still in the worker's FULL closure — its lazy import resolves", () => {
  // The guard for the guard above: if loadBundle's specifier stopped being a literal, or
  // the kit moved, the eager test would pass for the wrong reason while the DOM/Node
  // bans above silently stopped covering the kit.
  const { files } = graph();
  expect(files.has(`${ROOT}/src/framework/export/bundle.js`)).toBe(true);
  expect(files.has(`${ROOT}/src/framework/process/laser/export.js`)).toBe(true);
});
