// scripts/bench-mesh-fillet-census.mjs
// The 2026-10 fillet census as a repeatable measurement: for every part tree under
// <dir>, build each sub-part at default params on Manifold and fillet ALL its sharp
// edges at 0.5 mm with the throwing primitive, recording success or the refusal
// reason. Selector-free on purpose: it is an upper bound on what the mesh fillet
// refuses, not a model of what authors write. One child process per part (WASM state,
// runaway builds), killed after 240 s. One child per SUB-PART so a WASM fault in one
// cannot poison the next. Output: <part>\t<sub>\t<OK|REROUTE reason|BUILD_ERROR msg|CRASH ...>\t<ms>
// (cut -f1-3 compares outcomes without timings).
// Usage: node scripts/bench-mesh-fillet-census.mjs <dir>
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const R = 0.5;
const norm = (m, n) => String(m?.message ?? m).replace(/[-\d.]+/g, "#").replace(/\s+/g, " ").slice(0, n);
async function load(dir) {
  const { resolveParams, buildPosed, viewSubParts } = await import("../src/framework/part-model.js");
  const part = (await import(pathToFileURL(resolve(dir, "part.js")))).default;
  const { p, d } = resolveParams(part, {});
  const names = new Set();
  for (const view of Object.keys(part.views)) for (const n of viewSubParts(part, view, p)) names.add(n);
  return { part, p, d, names, buildPosed };
}
if (process.argv[2] === "--list") {
  const { names } = await load(process.argv[3]);
  for (const n of names) console.log(n);
  process.exit(0);
}
if (process.argv[2] === "--one") {
  const [dir, name] = [process.argv[3], process.argv[4]];
  const { part, p, d, buildPosed } = await load(dir);
  const { bootManifoldKernel } = await import("../src/testing/manifold.js");
  const { fontsFor } = await import("../src/framework/fonts.js");
  const k = await bootManifoldKernel({ fonts: fontsFor(part, part.defaults ?? {}), imports: part.imports });
  let line;
  try {
    const s = buildPosed(k, part, name, { purpose: "display", view: Object.keys(part.views)[0], p, d });
    const t0 = Date.now();
    try { s._filletRaw(R); line = `OK\t${Date.now() - t0}`; }
    catch (e) { line = `REROUTE ${norm(e, 120)}\t${Date.now() - t0}`; }
  } catch (e) { line = `BUILD_ERROR ${norm(e, 80)}\t-`; }
  console.log(line);
  process.exit(0);
}

const root = process.argv[2];
if (!root) { console.error("usage: node scripts/bench-mesh-fillet-census.mjs <dir>"); process.exit(2); }
const self = fileURLToPath(import.meta.url);
const run = (args) => spawnSync(process.execPath, [self, ...args], { encoding: "utf8", timeout: 240_000, maxBuffer: 64 << 20 });
const crash = (r) => `CRASH ${r.error?.code ?? r.signal ?? r.status} ${(r.stderr || "").slice(-200).replace(/\s+/g, " ").trim()}`;
const totals = new Map();
const rollup = { OK: 0, REROUTE: 0, BUILD_ERROR: 0, CRASH: 0 };
const emit = (ent, name, outcome, ms) => {
  console.log(`${ent}\t${name}\t${outcome}\t${ms}`);
  const kind = outcome.startsWith("OK") ? "OK" : outcome;
  totals.set(kind, (totals.get(kind) ?? 0) + 1);
  rollup[outcome.split(" ")[0]] = (rollup[outcome.split(" ")[0]] ?? 0) + 1;
};
for (const ent of readdirSync(root)) {
  const dir = join(root, ent);
  if (!existsSync(join(dir, "part.js"))) continue;
  const t0 = Date.now();
  const l = run(["--list", dir]);
  if (l.error || l.status !== 0) { emit(ent, "(part)", crash(l), Date.now() - t0); continue; }
  for (const name of l.stdout.split("\n").filter(Boolean)) {
    const t1 = Date.now();
    const r = run(["--one", dir, name]);
    const last = (r.stdout || "").trim().split("\n").pop();
    if (r.error || r.status !== 0 || !last) { emit(ent, name, crash(r), Date.now() - t1); continue; }
    const [outcome, ms] = last.split("\t");
    emit(ent, name, outcome, ms);
  }
}
console.log("\n--- totals ---");
for (const [kind, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${kind}`);
console.log(`ROLLUP OK=${rollup.OK} REROUTE=${rollup.REROUTE} BUILD_ERROR=${rollup.BUILD_ERROR} CRASH=${rollup.CRASH}`);
