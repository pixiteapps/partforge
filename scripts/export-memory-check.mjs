// Memory check for feedback #212: a forge of many heavy plates, displayed whole, then
// exported a few plates at a time and all at once — run the way the worker runs them
// (one Manifold WASM heap shared by the preview and print kernels).
//
//   node scripts/export-memory-check.mjs [plates] [--old]
//
// --old reproduces the behaviour before the fix (display cache kept, no cleanup
// between export pieces) so the two peaks can be compared on the same machine.
// Prints peak RSS per phase. Not part of `npm test`: RSS is a machine-dependent number.
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { handle } from "../src/framework/jobs.js";

const plates = Number(process.argv[2]) || 40;
const old = process.argv.includes("--old");

// A 200 mm plate carrying a 14×14 grid of rounded studs — cylinders unioned onto a
// slab, then cored: a few hundred booleans per plate, like a terrain plate's details.
const plate = (i) => (k) => {
  const studs = [];
  for (let x = 0; x < 14; x++) for (let y = 0; y < 14; y++) {
    studs.push(k.cylinder({ r: 5 + ((x + y + i) % 3), h: 6 + ((x * y + i) % 5) }).translate([-91 + x * 14, -91 + y * 14, 4]));
  }
  const body = k.box({ size: [200, 200, 4] }).translate([0, 0, 2]).union(k.union(studs));
  const cores = [];
  for (let x = 0; x < 14; x++) for (let y = 0; y < 14; y++) cores.push(k.cylinder({ r: 2, h: 20 }).translate([-91 + x * 14, -91 + y * 14, 1]));
  return body.cut(k.union(cores));
};
const names = Array.from({ length: plates }, (_, i) => `plate${i + 1}`);
const part = {
  defaults: {},
  views: { assembly: { label: "Assembly" } },
  parts: Object.fromEntries(names.map((n, i) => [n, { label: `Plate ${i + 1}`, views: ["assembly"], build: plate(i) }])),
};

const wasm = await Module();
wasm.setup();
const preview = createManifoldKernel(wasm, { quality: "preview" });
const print = createManifoldKernel(wasm, { quality: "print" });
// --old: no cache drop, and the print kernel's cleanup deferred to the end of each job
// (what jobs.js did before: one cleanup in handle()'s finally, none between pieces).
const realCleanup = print.cleanup;
if (old) {
  preview.dropCache = undefined;
  print.dropCache = undefined;
  print.cleanup = () => {};
}

const mb = (b) => Math.round(b / 1048576);
let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
const timer = setInterval(sample, 20);

async function run(kernel, msg) {
  const posts = [];
  peak = 0; sample();
  const t = Date.now();
  // The worker's own pre-export step (worker.js EXPORT_JOBS).
  if (msg.type.startsWith("export-")) { preview.dropCache?.(); print.dropCache?.(); }
  await handle(kernel, part, msg, (m) => posts.push(m));
  sample();
  if (old && kernel === print) realCleanup();
  return { posts, peak: mb(peak), s: (Date.now() - t) / 1000 };
}

const g = await run(preview, { type: "generate", view: "assembly", subparts: names, params: {} });
const tris = g.posts.find((m) => m.type === "meshes")?.meshes.reduce((a, m) => a + m.triangles, 0);
console.log(`${old ? "OLD" : "NEW"} generate ${plates} plates: ${tris} triangles, peak ${g.peak} MB, ${g.s}s`);

const few = await run(print, { type: "export-stl", view: "assembly", parts: names.slice(0, 3), params: {}, quality: "print", jobId: 1 });
const fewDl = few.posts.find((m) => m.type === "download-parts");
console.log(`export 3 plates: ${fewDl ? `${fewDl.parts.length} files` : few.posts.find((m) => m.type === "error")?.message}, peak ${few.peak} MB, ${few.s}s`);

const all = await run(print, { type: "export-stl", view: "assembly", params: {}, quality: "print", jobId: 2 });
const allDl = all.posts.find((m) => m.type === "download-parts");
console.log(`export all ${plates}: ${allDl ? `${allDl.parts.length} files` : all.posts.find((m) => m.type === "error")?.message}, peak ${all.peak} MB, ${all.s}s`);
clearInterval(timer);
process.exit(0);
