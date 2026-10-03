// mount() runs on a host page's main thread (the cloud's sandbox frame, every demo),
// and paper — the 2-D contour engine behind contour-ops — belongs in the kernel
// workers. paper builds a canvas the moment it is evaluated: on a real page that is
// startup cost for nothing, and under a DOM with no 2-D canvas (happy-dom, as the
// cloud's mount tests run) it throws at import. 0.138.1 regressed this when
// pose-probe started importing vectors.js (→ vector-format → contour-ops → paper)
// just for the two-line vectorsFor; the declaration resolvers now live in the
// import-free asset-decls.js. Eager walk: what the loader evaluates at import time.
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

test.each([`${ROOT}/src/framework/mount.js`, `${ROOT}/src/framework/pose-probe.js`])(
  "%s does not load paper at import time",
  (entry) => {
    const { bare, importer } = walk(entry, "no-paper walk", { eager: true });
    const paper = [...bare].filter((s) => s === "paper" || s.startsWith("paper/"));
    expect(paper.length, paper.length ? `paper reached:\n  ${chainTo(paper[0], importer, ROOT)}` : "").toBe(0);
  },
);
