#!/usr/bin/env node
// Dev-only (not run in CI): a hybrid STEP export — the hand reference part's organic body
// beside an exact B-rep plate — written the way the app writes it, then imported by
// FreeCAD's command-line build, which reads AP242 tessellated solids (OCCT 7.7+). Prints
// what FreeCAD found per body. CI holds the file's structure (test/step-tessellated.test.js,
// test/step-hybrid-occt.test.js); this is the check that a real reader accepts it.
//
//   node scripts/check-step-freecad.mjs [--out hybrid.step] [--freecad /path/to/freecadcmd]
//
// Manifold and OCCT never boot in one process, so the Manifold half (meshing the hand,
// the export's mesh-subparts job) runs in a child process of this script.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };

const { default: hand } = await import("../src/parts/hand.js");
const { handle } = await import("../src/framework/jobs.js");
// The hand's organic body beside a plain plate: one sub-part each.
const part = {
  meta: { title: "Hybrid hand" }, defaults: hand.defaults,
  parts: {
    hand: { ...hand.parts.hand, views: ["all"] },
    plate: { label: "Plate", views: ["all"], build: (k) => k.box({ min: [-60, -40, -30], max: [60, 20, -24] }), display: { color: "#3366cc" } },
  },
  views: { all: { label: "All" } },
};
const run = async (kernel, msg) => {
  const posts = [];
  await handle(kernel, part, { view: "all", params: {}, jobId: 1, ...msg }, (m) => posts.push(m));
  const err = posts.find((m) => m.type === "error");
  if (err) throw new Error(err.message);
  return posts.at(-1);
};

if (process.argv.includes("--mesh")) {
  const { bootManifoldKernel } = await import("../src/testing/manifold.js");
  const { meshes: { hand: m } } = await run(await bootManifoldKernel(), { type: "mesh-subparts", parts: ["hand"], quality: "print" });
  const out = arg("--mesh");
  writeFileSync(`${out}.pos`, Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength));
  writeFileSync(`${out}.idx`, Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "pf-step-"));
const meshBase = join(dir, "hand");
console.log("meshing the hand on Manifold (print grid)…");
execFileSync(process.execPath, [self, "--mesh", meshBase], { stdio: "inherit" });
const pos = readFileSync(`${meshBase}.pos`), idx = readFileSync(`${meshBase}.idx`);
const mesh = {
  positions: new Float32Array(pos.buffer, pos.byteOffset, pos.byteLength / 4),
  indices: new Uint32Array(idx.buffer, idx.byteOffset, idx.byteLength / 4),
};

console.log("writing the STEP file on OCCT…");
const { bootOcctKernel } = await import("../src/testing/occt.js");
const dl = await run(await bootOcctKernel(), { type: "export-step", meshes: { hand: mesh } });
const out = arg("--out", join(dir, "hybrid.step"));
writeFileSync(out, Buffer.from(dl.data));
const triangles = mesh.indices.length / 3;
// The mesh's own volume (divergence theorem), to compare with what FreeCAD reads back.
let volume = 0;
const P = mesh.positions, I = mesh.indices;
for (let t = 0; t < I.length; t += 3) {
  const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
  volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
}
console.log(`${out}: ${(dl.data.byteLength / 1e6).toFixed(1)} MB, hand ${triangles} triangles (${Math.round(dl.data.byteLength / triangles)} bytes per triangle), mesh volume ${volume.toFixed(1)}`);

const freecad = arg("--freecad", "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd");
const py = join(dir, "import.py");
writeFileSync(py, `
import os, FreeCAD, Part, Import
print("FreeCAD", ".".join(FreeCAD.Version()[:3]), "OCC", Part.OCC_VERSION)
doc = FreeCAD.newDocument("check")
Import.insert(os.environ["STEP_PATH"], doc.Name)
for o in doc.Objects:
    s = getattr(o, "Shape", None)
    if s is None or s.isNull():
        continue
    print("BODY", o.Label, s.ShapeType, "solids", len(s.Solids), "closed", s.isClosed(), "volume", round(s.Volume, 1))
`);
console.log("importing in FreeCAD…");
const report = execFileSync(freecad, [py], { env: { ...process.env, STEP_PATH: out }, encoding: "utf8" });
console.log(report.split("\n").filter((l) => /^(FreeCAD|BODY)/.test(l)).join("\n"));
