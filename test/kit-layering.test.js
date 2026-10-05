// Two layering rules for the cut & print kit (spec C.1, D.1):
//  1. Every registered process has an exporter, in the same order — adding a process is
//     one folder, one line in process/registry.js and one in process/exporters.js.
//  2. The kit never loads ./oracle/*. The mesh oracle is the largest payload in the
//     worker and has OOM-killed iOS Safari; the kit draws sheets from their 2-D
//     declaration and checks them with the process's own facts(). Held twice: a static
//     walk of everything export/bundle.js can load, eagerly or lazily, and a real
//     export-bundle job run with EVERY oracle module mocked to record itself and throw
//     on import.
//
// `handle` and the kernel booter are imported from their own modules, never through
// src/testing.js: that barrel re-exports the whole oracle, and would trip the mocks
// below before the kit ever ran.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";

// Every oracle module refuses to load. The factory RECORDS its module before it throws:
// vitest replaces a factory error with its own "There was an error when mocking a module"
// text (the original only survives as `cause`), so the job below — whose failure reaches
// it only as a posted message — would otherwise never say WHICH module the kit reached.
const { loaded, refuse } = vi.hoisted(() => {
  const loaded = [];
  const refuse = (name) => { loaded.push(name); throw new Error(`the kit loaded oracle/${name}`); };
  return { loaded, refuse };
});
vi.mock("../src/framework/oracle/annotation-ray.js", () => refuse("annotation-ray.js"));
vi.mock("../src/framework/oracle/assert-dsl.js", () => refuse("assert-dsl.js"));
vi.mock("../src/framework/oracle/build.js", () => refuse("build.js"));
vi.mock("../src/framework/oracle/bvh.js", () => refuse("bvh.js"));
vi.mock("../src/framework/oracle/cases.js", () => refuse("cases.js"));
vi.mock("../src/framework/oracle/changes.js", () => refuse("changes.js"));
vi.mock("../src/framework/oracle/dfm-profiles.js", () => refuse("dfm-profiles.js"));
vi.mock("../src/framework/oracle/gaps.js", () => refuse("gaps.js"));
vi.mock("../src/framework/oracle/gates.js", () => refuse("gates.js"));
vi.mock("../src/framework/oracle/match.js", () => refuse("match.js"));
vi.mock("../src/framework/oracle/measure.js", () => refuse("measure.js"));
vi.mock("../src/framework/oracle/mesh.js", () => refuse("mesh.js"));
vi.mock("../src/framework/oracle/min-wall.js", () => refuse("min-wall.js"));
vi.mock("../src/framework/oracle/op-graph.js", () => refuse("op-graph.js"));
vi.mock("../src/framework/oracle/overhang.js", () => refuse("overhang.js"));
vi.mock("../src/framework/oracle/shape-probe.js", () => refuse("shape-probe.js"));
vi.mock("../src/framework/oracle/silhouette.js", () => refuse("silhouette.js"));
vi.mock("../src/framework/oracle/verify.js", () => refuse("verify.js"));

import { handle } from "../src/framework/jobs.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";
import { EXPORTER_LOADERS } from "../src/framework/process/exporters.js";
import { PROCESS_IDS } from "../src/framework/process/registry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// vi.mock specifiers must be literals, so the list above is written out; this keeps it
// honest — a new oracle module fails here until it is mocked too.
const MOCKED = [
  "annotation-ray.js", "assert-dsl.js", "build.js", "bvh.js", "cases.js", "changes.js", "dfm-profiles.js", "gaps.js",
  "gates.js", "match.js", "measure.js", "mesh.js", "min-wall.js", "op-graph.js", "overhang.js", "shape-probe.js",
  "silhouette.js", "verify.js",
];

test("the mock list names every oracle module", () => {
  expect(readdirSync(`${ROOT}/src/framework/oracle`).filter((f) => f.endsWith(".js")).sort()).toEqual(MOCKED);
});

test("an exporter exists for every registered process, in registry order", () => {
  expect(Object.keys(EXPORTER_LOADERS)).toEqual(PROCESS_IDS);
});

test("nothing the kit can load, eagerly or lazily, is under oracle/", () => {
  const { files, importer } = walk(`${ROOT}/src/framework/export/bundle.js`, "kit walk");
  for (const file of files) {
    const bad = file.includes("/src/framework/oracle/");
    expect(bad, bad ? `the cut & print kit must never load the oracle:\n  ${chainTo(file, importer, ROOT)}` : "").toBe(false);
  }
});

test("an export-bundle job runs to a download with every oracle module unloadable", async () => {
  const k = await bootManifoldKernel();
  const part = {
    meta: { title: "No Oracle" }, defaults: { t: 3 }, views: { all: { label: "All" } },
    parts: {
      panel: sheetPart({ label: "Panel", views: ["all"], material: "birch plywood", thickness: (p) => p.t,
        profile: (kk) => kk.shape2d([[0, 0], [60, 0], [60, 30], [0, 30]]),
        score: () => [[[5, 5], [55, 5]]] }),
      foot: { label: "Foot", views: ["all"], build: (kk) => kk.box({ size: [8, 8, 4] }) },
    },
  };
  for (const [destination, printFormat] of [["own-laser", "stl"], ["service", "3mf"]]) {
    const posts = [];
    await handle(k, part, { type: "export-bundle", jobId: 1, parts: ["panel", "foot"], view: "all", params: {},
      name: "No Oracle", quality: "preview", options: { destination, printFormat } }, (m) => posts.push(m));
    expect(loaded, "oracle modules the kit tried to load").toEqual([]);
    expect(posts.find((m) => m.type === "error")?.message).toBeUndefined();
    expect(posts.find((m) => m.type === "download")?.filename).toBe("no-oracle-kit.zip");
  }
});
