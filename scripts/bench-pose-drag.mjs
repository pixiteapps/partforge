// scripts/bench-pose-drag.mjs — times the pose-drag path on the hand reference part.
// Usage: node scripts/bench-pose-drag.mjs [--core on|off|both]   (Node 24; default on)
// Times are CPU milliseconds. Four groups:
//   (a) deform: skinVertices over the hand's delivered payload, curl 30 -> 31
//   (b) bind:   bindVertices on the body at the 1.5 mm preview grid
//   (c) exact rebuild: one finger (flexIndex 60 -> 62) and every finger (curl 30 -> 32),
//       cold (fresh kernel) and warm (after the base pose built), with the sample cache's hits
//   (d) provisional stage: pieces' meshes versus the full union's mesh, after the build
import { core, setCoreEnabled } from "../src/framework/core/core.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { bindVertices } from "../src/framework/geometry/implicit/bindings.js";
import { frameMotions, skinVertices } from "../src/framework/skin/deform.js";
import hand, { handSpec } from "../src/parts/hand.js";

const arg = process.argv.indexOf("--core");
const coreMode = arg >= 0 ? process.argv[arg + 1] : "on";
if (!["on", "off", "both"].includes(coreMode)) { console.error("usage: bench-pose-drag.mjs [--core on|off|both]"); process.exit(2); }

const cpuMs = (u) => (u.user + u.system) / 1000;
const time = (f) => { const t = process.cpuUsage(); const r = f(); return [r, cpuMs(process.cpuUsage(t))]; };
const f1 = (x) => x.toFixed(1);
const build = hand.parts.hand.build;
const defaults = hand.defaults;
const PREVIEW = { quality: "preview" };

// Build the hand inside a sub-part bracket, as the generate job does; records each k.implicit spec.
function buildHand(k, p, { keep } = {}) {
  const specs = [];
  const rec = Object.create(k);
  rec.implicit = (s) => { specs.push(s); return k.implicit(s); };
  k.beginSubPart("hand");
  try {
    const solid = build(rec, p);
    return keep ? keep(solid, specs) : (solid.toMesh(PREVIEW), specs);
  } finally { k.endSubPart(); k.cleanup?.(); }
}

const stats = (k) => { const s = k._sampleCache.stats(); k._sampleCache.resetStats(); return s; };
const share = ({ hits, misses }) => (hits + misses ? `${((100 * hits) / (hits + misses)).toFixed(0)}%` : "n/a");

for (const on of coreMode === "both" ? [false, true] : [coreMode === "on"]) {
  console.log(`\ncore ${on ? "on" : "off"}`);
  setCoreEnabled(on);
  if (on && !core()) { console.log("core unavailable"); continue; }

  // (a) deform --------------------------------------------------------------------------
  const k0 = await bootManifoldKernel();
  buildHand(k0, defaults);   // warm-up
  let baseMesh, baseSpecs;
  buildHand(k0, { ...defaults, curl: 29 }, { keep: (s) => s.toMesh(PREVIEW) });   // warm the engine on a nearby pose
  buildHand(k0, defaults, { keep: (s, sp) => { baseMesh = s.toMesh(PREVIEW); baseSpecs = sp; } });
  let liveSpecs;
  buildHand(k0, { ...defaults, curl: 31 }, { keep: (s, sp) => { liveSpecs = sp; } });
  const { bindings } = baseMesh;
  const motions = frameMotions(baseSpecs, liveSpecs, bindings.frames);
  const out = { positions: new Float32Array(baseMesh.positions.length), normals: new Float32Array(baseMesh.normals.length) };
  const base = { positions: baseMesh.positions, normals: baseMesh.normals, bindings };
  skinVertices(base, motions, out);   // warm-up
  const runs = [];
  for (let i = 0; i < 20; i++) runs.push(time(() => skinVertices(base, motions, out))[1]);
  runs.sort((a, b) => a - b);
  console.log(`(a) skinVertices, curl 30 -> 31: ${f1(runs[10])} ms median (min ${f1(runs[0])}, max ${f1(runs[19])}) on ${bindings.frameA.length} corners, ${bindings.frames.length - 1} frames`);

  // (b) bind ----------------------------------------------------------------------------
  const body = handSpec(defaults);
  const compiled = compileImplicit(body);
  k0.beginSubPart("body");
  const corners = k0.implicit(body).toMesh(PREVIEW).positions;   // the body alone: bindings are per call
  k0.endSubPart();
  // The worker binds the engine's welded vertices, not the corners toMesh unrolls them to.
  const seen = new Map();
  for (let i = 0; i < corners.length; i += 3) seen.set(`${corners[i]},${corners[i + 1]},${corners[i + 2]}`, i);
  const bodyPositions = new Float32Array(seen.size * 3);
  let w = 0;
  for (const i of seen.values()) { bodyPositions[w++] = corners[i]; bodyPositions[w++] = corners[i + 1]; bodyPositions[w++] = corners[i + 2]; }
  bindVertices(compiled, bodyPositions, 1.5);   // warm-up
  const bruns = [];
  for (let i = 0; i < 5; i++) bruns.push(time(() => bindVertices(compiled, bodyPositions, 1.5))[1]);
  bruns.sort((a, b) => a - b);
  console.log(`(b) bindVertices, body at 1.5 mm (${bodyPositions.length / 3} vertices): ${f1(bruns[2])} ms median (min ${f1(bruns[0])}, max ${f1(bruns[4])})`);

  // (c) exact rebuild -------------------------------------------------------------------
  console.log("(c) exact rebuild (build + preview mesh), ms   cold  warm  cache hits cold/warm");
  const cases = [["one finger  flexIndex 60 -> 62", { flexIndex: 62 }], ["all fingers curl 30 -> 32", { curl: 32 }]];
  for (const [name, change] of cases) {
    const kc = await bootManifoldKernel();
    stats(kc);
    const [, tc] = time(() => buildHand(kc, { ...defaults, ...change }));
    const sc = stats(kc);
    const kw = await bootManifoldKernel();
    buildHand(kw, defaults);
    stats(kw);
    const [, tw] = time(() => buildHand(kw, { ...defaults, ...change }));
    const sw = stats(kw);
    console.log(`    ${name.padEnd(30)} ${f1(tc).padStart(6)} ${f1(tw).padStart(5)}   ${share(sc)} / ${share(sw)}  (warm ${sw.hits} hits, ${sw.misses} misses)`);
  }

  // (d) provisional stage ---------------------------------------------------------------
  console.log("(d) provisional stage, ms (one finger, flexIndex 60 -> 62)   build  pieces  union   stage-total  final-total");
  for (const warm of [false, true]) {
    const kp = await bootManifoldKernel();
    if (warm) buildHand(kp, defaults);
    kp._setProvisionalUnions(true);
    kp.beginSubPart("hand");
    try {
      const rec = Object.create(kp);
      const [solid, tb] = time(() => build(rec, { ...defaults, flexIndex: 62 }));
      const pieces = kp._takeProvisionalPieces(solid);
      if (!pieces) { console.log("    no provisional pieces"); continue; }
      const [, tp] = time(() => pieces.map((pc) => pc.toMesh(PREVIEW)));
      const [, tu] = time(() => solid.toMesh(PREVIEW));
      console.log(`    ${(warm ? "warm" : "cold").padEnd(30)} ${f1(tb).padStart(6)} ${f1(tp).padStart(7)} ${f1(tu).padStart(6)} ${f1(tb + tp).padStart(12)} ${f1(tb + tu).padStart(12)}`);
    } finally { kp._setProvisionalUnions(false); kp.endSubPart(); }
  }
}
setCoreEnabled(true);
