// The worker-safety rules shared by the layering guards (worker-layering.test.js and
// kinematics-entry.test.js), so they cannot drift apart.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { chainTo } from "./import-graph.js";

// three.js is the viewer's dependency and drags in DOM assumptions; paper probes for a DOM.
export const BANNED_PACKAGES = ["three"];
// Node builtins a headless-harness module would bring along (both bare and `node:` forms resolve).
export const NODE_BUILTINS = ["fs", "path", "url", "module", "os", "crypto", "child_process", "worker_threads", "process", "util", "stream", "zlib"];
// Main-thread-only globals. `self`, `globalThis`, and `fetch` all exist in a worker.
export const DOM_GLOBALS = ["document", "window", "localStorage", "sessionStorage", "HTMLElement", "customElements"];

// Prose in this codebase mentions `document` when describing what a module must not do.
export const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

export const isNodeBuiltin = (spec) => {
  const name = spec.replace(/^node:/, "").split("/")[0];
  return spec.startsWith("node:") || NODE_BUILTINS.includes(name);
};

/** The first main-thread-only global a file's source (comments stripped) names, or undefined. */
export const domGlobalIn = (file) => {
  const src = stripComments(readFileSync(file, "utf8"));
  return DOM_GLOBALS.find((g) => new RegExp(`\\b${g}\\b`).test(src));
};

/** Assert a walked closure is worker-safe: no Node builtin, no banned package, no DOM global. */
export function expectWorkerSafe({ files, bare, importer }, root, who) {
  for (const spec of bare) {
    const bad = isNodeBuiltin(spec) || spec.split("/")[0] === "paper" || BANNED_PACKAGES.includes(spec.split("/")[0]);
    expect(bad, bad ? `${who} must not import "${spec}":\n  ${chainTo(spec, importer, root)}` : "").toBe(false);
  }
  for (const file of files) {
    const hit = domGlobalIn(file);
    expect(hit == null, hit ? `${who} has no \`${hit}\`:\n  ${chainTo(file, importer, root)}` : "").toBe(true);
  }
}
