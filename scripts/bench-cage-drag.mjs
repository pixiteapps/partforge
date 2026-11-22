// scripts/bench-cage-drag.mjs — where one rebuild of a subdivision-cage body spends its time.
// Usage: node scripts/bench-cage-drag.mjs   (Node 24)
// Times are CPU milliseconds, the median of 12 runs at the preview tier. Each run moves a
// parameter a little (a curl, a tail lift), so no cache answers a build. Rows:
//   cage code     the part's cage code, plus cage.snapshot()
//   levelFor      the level search (builds the levels up to the one it picks)
//   subdivide     the smoothing, reusing the search's mesh
//   selfIntersect the self-intersection check on the smoothed mesh
//   manifold      manifoldFromWeldedMesh, the Manifold import
//   cut           the part's boolean cut on the imported body
//   toMesh        toMesh({ quality: "preview" }) on the cut body
//   whole build   k.subdiv + cut + toMesh from the part's own build function
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { resolveParams } from "../src/framework/part-model.js";
import { levelFor, subdivide, SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES } from "../src/framework/geometry/subdiv/surface.js";
import { selfIntersections } from "../src/framework/geometry/subdiv/self-intersect.js";
import { manifoldFromWeldedMesh } from "../src/framework/geometry/mesh-build.js";
import hand, { cageHand } from "../src/parts/cage-hand.js";
import whale, { whaleCage } from "../src/parts/organic-whale.js";

const RUNS = 12;
const PREVIEW = { quality: "preview" };
const cpuMs = (u) => (u.user + u.system) / 1000;
const time = (f) => { const t = process.cpuUsage(); const r = f(); return [r, cpuMs(process.cpuUsage(t))]; };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const f1 = (x) => x.toFixed(1);

// Each case: how to make the cage at step i, and the part's own build (for the whole row).
const bendsOf = (d) => Object.fromEntries(Object.keys(d).map((n) => [n, d[n].values]));
const CASES = [
  {
    name: "cage-hand",
    params: (i) => ({ ...hand.defaults, indexCurl: 20 + 0.3 * i, middleCurl: 20 + 0.2 * i }),
    cage: (k, p) => cageHand(k.cage, p, bendsOf(resolveParams(hand, p).d)),
    whole: (k, p) => hand.parts.hand.build(k, p, resolveParams(hand, p).d),
    part: hand.parts.hand,
  },
  {
    name: "organic-whale",
    params: (i) => ({ ...whale.defaults, tailLift: 6 + 0.3 * i }),
    cage: (k, p) => whaleCage(k, p),
    whole: (k, p) => whale.parts.whale.build(k, p),
    part: whale.parts.whale,
  },
];

const wasm = await (await import("manifold-3d")).default().then((m) => { m.setup(); return m; });
const kernel = await bootManifoldKernel();
const bracket = (name, f) => { kernel.beginSubPart(name); try { return f(); } finally { kernel.endSubPart(); kernel.cleanup?.(); } };

// The cut after k.subdiv, applied as the part does: a flat under the body.
function cutOf(k, body) {
  const { min, max } = body.boundingBox();
  const flat = 1.5;
  return body.cut(k.box({ min: [min[0] - 1, min[1] - 1, min[2] - 1], max: [max[0] + 1, max[1] + 1, min[2] + flat] }));
}

const tolerance = SUBDIV_TOLERANCE.preview, maxTriangles = SUBDIV_MAX_TRIANGLES.preview;
const results = [];
for (const c of CASES) {
  const rows = { "cage code": [], levelFor: [], subdivide: [], selfIntersect: [], manifold: [], cut: [], toMesh: [], "whole build": [] };
  let info = {};
  // Run 0 warms the engine and is dropped; runs 1..RUNS are timed.
  for (let i = 0; i <= RUNS; i++) {
    const p = c.params(i);
    const keep = i > 0;
    const push = (row, ms) => { if (keep) rows[row].push(ms); };
    // Stages on a fresh cage.
    bracket(c.name, () => {
      const [snapshot, tCage] = time(() => c.cage(kernel, p).snapshot());
      push("cage code", tCage);
      const [lf, tLevel] = time(() => levelFor(snapshot, tolerance, { maxTriangles }));
      push("levelFor", tLevel);
      const [mesh, tSub] = time(() => subdivide(snapshot, lf.level, lf.mesh));
      push("subdivide", tSub);
      push("selfIntersect", time(() => selfIntersections(mesh))[1]);
      const [m, tMan] = time(() => manifoldFromWeldedMesh(wasm, mesh.positions, mesh.indices, wasm.Manifold.reserveIDs(1)));
      push("manifold", tMan);
      m.delete?.();
      info = { level: lf.level, faces: snapshot.faces.length, triangles: mesh.indices.length / 3, met: lf.met };
    });
    // The cut and toMesh, on a body k.subdiv has already built (that cost is the rows above).
    bracket(c.name, () => {
      const q = c.params(i + 100);
      const body = kernel.subdiv(c.cage(kernel, q));
      const [cutBody, tCut] = time(() => cutOf(kernel, body));
      push("cut", tCut);
      push("toMesh", time(() => cutBody.toMesh(PREVIEW))[1]);
    });
    // The whole thing, as the worker builds it.
    bracket(c.name, () => {
      const q = c.params(i + 200);
      push("whole build", time(() => c.whole(kernel, q).toMesh(PREVIEW))[1]);
    });
  }
  results.push({ c, info, rows });
}

console.log(`\nCPU ms, median of ${RUNS}, preview tier, Node ${process.version}`);
for (const { c, info, rows } of results) {
  console.log(`\n${c.name}: level ${info.level}${info.met ? "" : " (tolerance unmet)"}, ${info.faces} cage faces, ${info.triangles} triangles`);
  for (const [row, v] of Object.entries(rows)) console.log(`  ${row.padEnd(14)} ${f1(median(v)).padStart(8)}`);
  const d = (r) => median(rows[r]);
  console.log(`  ${"drag sum".padEnd(14)} ${f1(d("cage code") + d("manifold") + d("cut") + d("toMesh")).padStart(8)}   (cage code + manifold + cut + toMesh)`);
}
