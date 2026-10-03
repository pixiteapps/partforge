// The rule the cache and the oracle rest on: if a param change leaves every
// recorded read's value unchanged, a real rebuild produces the same mesh.
// Checked over shipped parts: build at defaults, nudge each param in turn.
import { afterAll, beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, handle, viewSubParts } from "../src/testing.js";
import { relevanceHash } from "../src/framework/param-deps.js";
import { h } from "../src/framework/geometry/solid-hash.js";
import { guarded } from "./fixtures/guarded-part.js";
import demo from "../src/parts/demo.js";
import bracket from "../src/parts/bracket.js";
import planter from "../src/parts/planter.js";
import hingedBox from "../src/parts/hinged-box.js";
import gasket from "../src/parts/gasket.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const nudge = (v) => (typeof v === "number" ? v + (Math.abs(v) > 1 ? 1 : 0.1) : typeof v === "boolean" ? !v : undefined);
const fingerprint = (m) => h(String(m.triangles), Array.from(m.positions).map((x) => x.toFixed(4)).join(","));
const checked = { pairs: 0 };

async function build(part, view, params) {
  const subparts = viewSubParts(part, view, { ...part.defaults, ...params });
  const posts = [];
  await handle(k, part, { type: "generate", subparts, view, params, cache: false }, (m) => posts.push(m));
  const reply = posts.find((m) => m.type === "meshes");
  return reply ? new Map(reply.meshes.map((m) => [m.name, m])) : null;
}

for (const [label, part] of Object.entries({ guarded, demo, bracket, planter, hingedBox, gasket })) {
  test(`${label}: unchanged recorded reads => identical mesh`, async () => {
    let pairs = 0;
    for (const view of Object.keys(part.views)) pairs += await checkView(part, label, view);
    checked.pairs += pairs;
    console.log(`soundness ${label}: ${pairs} unchanged-read pairs checked`);
  }, 60_000);
}

async function checkView(part, label, view) {
  {
    const base = await build(part, view, { ...part.defaults });
    expect(base, `${label} should build at defaults`).not.toBe(null);
    let pairs = 0;
    for (const [key, v] of Object.entries(part.defaults)) {
      const next = nudge(v);
      if (next === undefined) continue;
      const params = { ...part.defaults, [key]: next };
      const after = await build(part, view, params);
      if (!after) continue; // a nudge into an invalid value fails the build: not this test's subject
      for (const [name, m] of base) {
        if (!after.has(name)) continue;
        if (relevanceHash(m.reads, part.defaults) !== relevanceHash(m.reads, params)) continue;
        pairs++;
        expect(fingerprint(after.get(name)), `${label}.${name} after ${key}`).toBe(fingerprint(m));
      }
    }
    // A part whose every param is read by its only sub-part checks nothing; the afterAll guard keeps the file honest.
    return pairs;
  }
}

afterAll(() => { expect(checked.pairs, "the property must actually exercise some pairs").toBeGreaterThan(0); });
