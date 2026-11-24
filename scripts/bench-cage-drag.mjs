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
//   toMesh+ties   the same toMesh with ties (subdiv/ties.js), as a canonical generate asks;
//                 "ties" below is its median minus toMesh's: the cost of the ties alone
//   whole build   k.subdiv + cut + toMesh from the part's own build function
// Then, for the cage hand only, the viewer's side of a drag (skin/cage-deform.js), the
// median of 20 moves of one curl from one delivered base:
//   deformCage    one re-pose of the delivered mesh from the moved cage's points
//   skin deform() one full skin controller deform() after the first: the live build probe
//                 at the new params, the drag validity check, then deformCage, then the
//                 viewer write (a no-op stub here)
//   first deform  the first deform() of a drag on a freshly recorded base, which also makes
//                 the drag state (median of 8 fresh controllers); its parts, alone:
//     plan          makeCageBase: the subdiv plan from the base's snapshot
//     check         tiesAgree: every delivered vertex placed from its tie on the plan's rest
//                   surface against where it was delivered
//     copies        the copies of positions and normals, and the scratch pair
// and the bytes the controller holds for the hand beyond the delivery itself: idle (a
// recorded base: references only) and during a drag (the plan's typed arrays, the limit
// normals, the copies and the scratch).
//   dragValidity L1, L2   the drag validity check (subdiv/index.js) alone, at levels 1 and
//                 2 of the base's plan; DRAG_CHECK_LEVEL is the level the drag uses
// and the first curl, stepping every finger's curl past 90° in 0.5° steps with every
// knuckle at 90° and the thumb at 60°, that the full check (the body's own level, as
// meshSubdiv builds it) and the drag check each refuse.
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { resolveParams } from "../src/framework/part-model.js";
import { levelFor, subdivide, SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES } from "../src/framework/geometry/subdiv/surface.js";
import { selfIntersections } from "../src/framework/geometry/subdiv/self-intersect.js";
import { manifoldFromWeldedMesh } from "../src/framework/geometry/mesh-build.js";
import hand, { cageHand } from "../src/parts/cage-hand.js";
import whale, { whaleCage } from "../src/parts/organic-whale.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { createSkinDrag } from "../src/framework/skin/skin-drag.js";
import { makeCageBase, tiesAgree, deformCage } from "../src/framework/skin/cage-deform.js";
import { dragValidity, DRAG_CHECK_LEVEL } from "../src/framework/geometry/subdiv/index.js";
import { createCage } from "../src/framework/geometry/subdiv/cage.js";

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
  const rows = { "cage code": [], levelFor: [], subdivide: [], selfIntersect: [], manifold: [], cut: [], toMesh: [], "toMesh+ties": [], "whole build": [] };
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
      const [withTies, tTies] = time(() => cutBody.toMesh({ ...PREVIEW, ties: true }));
      if (!withTies.ties) throw new Error(`${c.name}: the cut body carries no ties`);
      push("toMesh+ties", tTies);
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
  console.log(`  ${"ties".padEnd(14)} ${f1(d("toMesh+ties") - d("toMesh")).padStart(8)}   (toMesh+ties − toMesh)`);
  console.log(`  ${"drag sum".padEnd(14)} ${f1(d("cage code") + d("manifold") + d("cut") + d("toMesh")).padStart(8)}   (cage code + manifold + cut + toMesh)`);
}

// The viewer's side of a cage drag on the hand: one delivered base, 20 moves of a curl.
{
  const DRAG_RUNS = 20;
  const at = { ...hand.defaults };
  const delivered = bracket("hand", () => {
    const m = hand.parts.hand.build(kernel, at, resolveParams(hand, at).d).toMesh({ ...PREVIEW, ties: true });
    return { frame: "canonical", positions: m.positions, normals: m.normals, ties: m.ties };
  });
  if (!delivered.ties) throw new Error("cage-hand: the delivered mesh carries no ties");
  const probeAt = (p) => probePoses(hand, "assembly", p, { scope: "build" }).get("hand");
  const base = makeCageBase(probeAt(at).cages[0], delivered.ties);
  const n = delivered.positions.length;
  const P = new Float32Array(n), N = new Float32Array(n);
  const deformMs = [], checkMs = { 1: [], 2: [] };
  for (let i = 0; i <= DRAG_RUNS; i++) {
    const live = probeAt({ ...at, indexCurl: 30 + i }).cages[0];
    const [ok, ms] = time(() => deformCage(base, live, P, N));
    if (!ok) throw new Error("deformCage refused the hand's own cage");
    if (i > 0) deformMs.push(ms);
    for (const level of [1, 2]) {
      const [bad, cms] = time(() => dragValidity(base.plan, live.points, { level }));
      if (bad) throw new Error(`the drag check refused a pose in the hand's range: ${bad.message}`);
      if (i > 0) checkMs[level].push(cms);
    }
  }
  const params = { ...at };
  let version = 0;
  const viewer = { hasSubMesh: () => true, setSubVertices: () => true };
  const skin = createSkinDrag(hand, viewer, { params, getView: () => "assembly", getParamsVersion: () => version });
  skin.recordDelivered("hand", delivered, { view: "assembly", params: { ...at } });
  const controllerMs = [];
  for (let i = 0; i <= DRAG_RUNS; i++) {
    params.indexCurl = 30 + 0.5 * i; version++;
    const [names, ms] = time(() => skin.deform());
    if (names.length !== 1) throw new Error("the skin controller did not deform the hand");
    if (i > 0) controllerMs.push(ms);
  }
  console.log(`\ncage-hand drag, CPU ms, median of ${DRAG_RUNS}: ${n / 3} delivered vertices, ${base.plan.indices.length / 3} limit triangles (level ${base.plan.level})`);
  console.log(`  ${"deformCage".padEnd(14)} ${f1(median(deformMs)).padStart(8)}`);
  console.log(`  ${"skin deform()".padEnd(14)} ${f1(median(controllerMs)).padStart(8)}   (live probe + check + deformCage)`);

  // The first deform of a drag: a fresh controller each time, so each one makes its drag state.
  const firstMs = [], planMs = [], agreeMs = [], copyMs = [];
  for (let i = 0; i <= 8; i++) {
    const q = { ...at };
    const fresh = createSkinDrag(hand, viewer, { params: q, getView: () => "assembly", getParamsVersion: () => (q.indexCurl === at.indexCurl ? 0 : 1) });
    fresh.recordDelivered("hand", delivered, { view: "assembly", params: { ...at } });
    q.indexCurl = 40;
    const [names, ms] = time(() => fresh.deform({ before: at }));
    if (names.length !== 1) throw new Error("the first deform did not deform the hand");
    const [b, pms] = time(() => makeCageBase(probeAt(at).cages[0], delivered.ties));
    const [agree, ams] = time(() => tiesAgree(b, delivered.positions));
    if (!agree) throw new Error("the hand's plan and ties disagree");
    const [, cms] = time(() => [delivered.positions.slice(), delivered.normals.slice(), new Float32Array(n), new Float32Array(n)]);
    if (i > 0) { firstMs.push(ms); planMs.push(pms); agreeMs.push(ams); copyMs.push(cms); }
  }
  console.log(`  ${"first deform".padEnd(14)} ${f1(median(firstMs)).padStart(8)}   (the drag state, then a deform)`);
  console.log(`    ${"plan".padEnd(12)} ${f1(median(planMs)).padStart(8)}`);
  console.log(`    ${"check".padEnd(12)} ${f1(median(agreeMs)).padStart(8)}`);
  console.log(`    ${"copies".padEnd(12)} ${f1(median(copyMs)).padStart(8)}`);

  // Bytes held beyond the delivery: every typed array reachable from the plan, once each.
  const seen = new Set();
  const typedBytes = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return 0;
    seen.add(o);
    if (ArrayBuffer.isView(o)) return o.byteLength;
    let sum = 0;
    for (const v of Array.isArray(o) ? o : Object.values(o)) sum += typedBytes(v);
    return sum;
  };
  const planBytes = typedBytes(base.plan) + base.limitNormals.byteLength;
  const meshBytes = 4 * 4 * n;   // copies of positions and normals, and the scratch pair (Float32)
  const mb = (x) => (x / 2 ** 20).toFixed(1);
  console.log(`  bytes held: idle 0 MB (references to the delivery); during a drag ${mb(planBytes + meshBytes)} MB (plan ${mb(planBytes)}, copies + scratch ${mb(meshBytes)})`);
  for (const level of [1, 2]) {
    console.log(`  ${`dragValidity L${level}`.padEnd(14)} ${f1(median(checkMs[level])).padStart(8)}${level === DRAG_CHECK_LEVEL ? "   (the drag's level)" : ""}`);
  }

  // What the drag check misses: the first curl past the range each check refuses.
  const { p } = resolveParams(hand, at);
  const curled = (c) => cageHand(createCage, p, {
    ...Object.fromEntries(["index", "middle", "ring", "pinky"].map((f) => [f, [90, c, 0.75 * c]])), thumb: [60],
  }).snapshot();
  let full = null, coarse = null;
  for (let c = 90; c <= 135 && (full === null || coarse === null); c += 0.5) {
    const s = curled(c);
    if (full === null) {
      const lf = levelFor(s, tolerance, { maxTriangles });
      if (selfIntersections(subdivide(s, lf.level, lf.mesh)).length) full = c;
    }
    if (coarse === null && dragValidity(base.plan, s.points)) coarse = c;
  }
  console.log(`  first curl refused (knuckles 90°, thumb 60°): full check ${full ?? "none"}°, drag check ${coarse ?? "none"}°`);
}
