// The cel style's pure half must stay free of three (it is read by lint-time and
// worker-side code), and nothing under src/framework/cel/ may enter the geometry
// worker's closure: the cel materials are main-thread, three.js-bound.
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const FW = `${ROOT}/src/framework`;

test("cel-style.js does not import three", () => {
  const { bare, importer } = walk(`${FW}/cel/cel-style.js`, "cel no-three walk");
  const three = [...bare].filter((s) => s === "three" || s.startsWith("three/"));
  expect(three.length, three.length ? `three reached:\n  ${chainTo(three[0], importer, ROOT)}` : "").toBe(0);
});

test("the worker import closure reaches nothing under src/framework/cel/", () => {
  const { files, importer } = walk(`${FW}/worker.js`, "cel worker walk");
  for (const file of files) {
    const inCel = file.startsWith(`${FW}/cel/`);
    expect(inCel, inCel ? `the geometry worker must not reach cel/:\n  ${chainTo(file, importer, ROOT)}` : "").toBe(false);
  }
});
