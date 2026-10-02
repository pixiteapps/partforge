// scripts/bench-mesh-fillet-census.mjs
// The 2026-10 fillet census as a repeatable measurement: for every part tree under
// <dir>, build each sub-part at default params on Manifold and fillet ALL its sharp
// edges at 0.5 mm with the throwing primitive, recording success or the refusal
// reason. Selector-free on purpose: it is an upper bound on what the mesh fillet
// refuses, not a model of what authors write. One child process per part (WASM state,
// runaway builds), killed after 240 s.
// Usage: node scripts/bench-mesh-fillet-census.mjs <dir>
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const R = 0.5;
if (process.argv[2] === "--one") {
  const dir = process.argv[3];
  const { resolveParams, buildPosed, viewSubParts } = await import("../src/framework/part-model.js");
  const { bootManifoldKernel } = await import("../src/testing/manifold.js");
  const { fontsFor } = await import("../src/framework/fonts.js");
  const part = (await import(pathToFileURL(resolve(dir, "part.js")))).default;
  const k = await bootManifoldKernel({ fonts: fontsFor(part, part.defaults ?? {}), imports: part.imports });
  const { p, d } = resolveParams(part, {});
  const names = new Set();
  for (const view of Object.keys(part.views)) for (const n of viewSubParts(part, view, p)) names.add(n);
  for (const name of names) {
    let line;
    try {
      const s = buildPosed(k, part, name, { purpose: "display", view: Object.keys(part.views)[0], p, d });
      const t0 = Date.now();
      try { s._filletRaw(R); line = `OK ${Date.now() - t0}`; }
      catch (e) { line = `REROUTE ${String(e?.message ?? e).replace(/[-\d.]+/g, "#").slice(0, 120)}`; }
    } catch (e) { line = `BUILD_ERROR ${String(e?.message ?? e).slice(0, 80)}`; }
    console.log(`${name}\t${line}`);
  }
  process.exit(0);
}

const root = process.argv[2];
if (!root) { console.error("usage: node scripts/bench-mesh-fillet-census.mjs <dir>"); process.exit(2); }
const totals = new Map();
for (const ent of readdirSync(root)) {
  const dir = join(root, ent);
  if (!existsSync(join(dir, "part.js"))) continue;
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "--one", dir], { encoding: "utf8", timeout: 240_000 });
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  if (r.error || r.status !== 0) lines.push(`(part)\tCRASH ${r.error?.code ?? r.status}`);
  for (const l of lines) {
    console.log(`${ent}\t${l}`);
    const kind = l.split("\t")[1]?.startsWith("OK") ? "OK" : l.split("\t")[1] ?? "?";
    totals.set(kind, (totals.get(kind) ?? 0) + 1);
  }
}
console.log("\n--- totals ---");
for (const [kind, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${kind}`);
