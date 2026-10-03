// The rule the cache and the oracle rest on: if a param change leaves every
// recorded read's value unchanged, a real rebuild produces the same mesh.
// Checked over shipped and branching parts: build at a baseline, then nudge each
// param to several candidates (including every other option of an enum).
import { afterAll, beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, handle, viewSubParts } from "../src/testing.js";
import { relevanceHash } from "../src/framework/param-deps.js";
import { h } from "../src/framework/geometry/solid-hash.js";
import { guarded } from "./fixtures/guarded-part.js";
import { enumSwitch, disjoint, pocketGuard, leaky, leak } from "./fixtures/branching-parts.js";
import demo from "../src/parts/demo.js";
import bracket from "../src/parts/bracket.js";
import planter from "../src/parts/planter.js";
import hingedBox from "../src/parts/hinged-box.js";
import gasket from "../src/parts/gasket.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const fingerprint = (m) => h(String(m.triangles), Array.from(m.positions).map((x) => x.toFixed(4)).join(","));

// key -> every option value, found anywhere in the part's control spec.
function optionsByKey(node, out = {}) {
  if (Array.isArray(node)) node.forEach((n) => optionsByKey(n, out));
  else if (node && typeof node === "object") {
    if (typeof node.key === "string" && Array.isArray(node.options)) out[node.key] = node.options.map((o) => o.value);
    for (const v of Object.values(node)) if (v && typeof v === "object") optionsByKey(v, out);
  }
  return out;
}

function candidates(v, options) {
  if (options) return options.filter((o) => o !== v);
  if (typeof v === "boolean") return [!v];
  if (typeof v !== "number") return [];
  const step = Math.abs(v) > 1 ? 1 : 0.1;
  return [...new Set([v + step, v * 0.5, v === 0 ? 1 : -v, v + 7.3])].filter((c) => c !== v);
}

async function build(part, view, params) {
  const subparts = viewSubParts(part, view, params);
  const posts = [];
  await handle(k, part, { type: "generate", subparts, view, params, cache: false }, (m) => posts.push(m));
  const reply = posts.find((m) => m.type === "meshes");
  return reply ? new Map(reply.meshes.map((m) => [m.name, m])) : null;
}

// Returns { pairs, violations, builds, failed }. `between` runs before each nudged build.
async function check(part, baseline = {}, between = () => {}) {
  const opts = optionsByKey(part.parameters);
  const start = { ...part.defaults, ...baseline };
  const res = { pairs: 0, violations: [], builds: 0, failed: 0 };
  for (const view of Object.keys(part.views)) {
    const base = await build(part, view, start);
    if (!base) throw new Error("baseline failed to build");
    for (const [key, v] of Object.entries(start)) {
      for (const next of candidates(v, opts[key])) {
        const params = { ...start, [key]: next };
        between();
        const after = await build(part, view, params);
        res.builds++;
        if (!after) { res.failed++; continue; } // an invalid nudge fails the build
        for (const [name, m] of base) {
          if (!after.has(name)) continue;
          if (relevanceHash(m.reads, start) !== relevanceHash(m.reads, params)) continue;
          res.pairs++;
          if (fingerprint(after.get(name)) !== fingerprint(m)) res.violations.push(`${view}.${name} after ${key}=${next}`);
        }
      }
    }
  }
  return res;
}

const cases = [
  ["guarded", guarded, [{}], 4],
  ["demo", demo, [{}], 4],
  ["bracket", bracket, [{}], 0],
  ["planter", planter, [{}], 0],
  ["hingedBox", hingedBox, [{}], 6],
  ["gasket", gasket, [{}], 0],
  ["enumSwitch", enumSwitch, [{}, { mode: "holes" }], 12],
  ["disjoint", disjoint, [{}, { w: 20, seg: 9 }], 32],
  ["pocketGuard", pocketGuard, [{}, { px: 30 }], 4],
];
const counts = {};

for (const [label, part, baselines, floor] of cases) {
  test(`${label}: unchanged recorded reads => identical mesh`, async () => {
    let pairs = 0, builds = 0, failed = 0;
    for (const baseline of baselines) {
      const r = await check(part, baseline);
      expect(r.violations, `${label} from ${JSON.stringify(baseline)}`).toEqual([]);
      pairs += r.pairs; builds += r.builds; failed += r.failed;
    }
    counts[label] = pairs;
    expect(failed, `${label}: every nudge failed to build, nothing was checked`).toBeLessThan(builds);
    expect(pairs, `${label} stopped exercising the property`).toBeGreaterThanOrEqual(floor);
  }, 120_000);
}

test("negative control: state read outside p/d is reported as a violation", async () => {
  leak.n = 0;
  const r = await check(leaky, {}, () => { leak.n += 1; });
  leak.n = 0;
  expect(r.pairs).toBeGreaterThan(0);
  expect(r.violations.length).toBeGreaterThanOrEqual(1);
});

afterAll(() => { expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0); });
