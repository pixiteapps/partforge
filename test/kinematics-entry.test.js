// partforge/kinematics is a published entry: worker-safe, one-way (core never imports the
// domain), and its manifest is the shape the domain registry will read.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";
import { expectWorkerSafe } from "./helpers/worker-safety.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = `${ROOT}/src/framework/domains/kinematics/index.js`;

test("the entry's import closure reaches no implicit engine and is worker-safe (no DOM, three, paper or Node builtin)", () => {
  const graph = walk(ENTRY, "kinematics entry walk");
  for (const f of graph.files) {
    expect(f.includes("/geometry/implicit/"), `implicit engine reached:\n  ${chainTo(f, graph.importer, ROOT)}`).toBe(false);
  }
  expectWorkerSafe(graph, ROOT, "the kinematics domain");
});

test("partforge/kinematics resolves through the package exports and yields limb and aimFromAngles", async () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
  expect(pkg.exports["./kinematics"].default).toBe("./src/framework/domains/kinematics/index.js");
  const mod = await import("../src/framework/domains/kinematics/index.js");
  expect(typeof mod.limb).toBe("function");
  expect(Object.keys(mod).sort()).toEqual(["aimFromAngles", "limb"]);
});

test("the manifest is exactly the interface the domain registry reads", async () => {
  const { default: m } = await import("../src/framework/domains/kinematics/manifest.js");
  expect(m).toEqual({
    id: "kinematics",
    title: "Kinematics",
    when: "jointed limbs, fingers, arms, robot hands; posing links about joints; reach and grip",
    subpath: "partforge/kinematics",
    guide: "docs/domains/kinematics.md",
    referenceParts: ["src/parts/robot-finger.js"],
    kernelOps: [],
    lintRules: [],
    oracle: { facts: null, metrics: {}, checks: [] },
    processes: [],
    workerSafe: true,
  });
});

test("nothing outside src/framework/domains/ imports the kinematics domain", () => {
  const offenders = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) { scan(p); continue; }
      if (!/\.(js|mjs)$/.test(name) || p.startsWith(`${ROOT}/src/framework/domains/`)) continue;
      if (/domains\/kinematics\b/.test(readFileSync(p, "utf8"))) offenders.push(p.replace(`${ROOT}/`, ""));
    }
  };
  scan(`${ROOT}/src`);
  expect(offenders).toEqual([]);
});
