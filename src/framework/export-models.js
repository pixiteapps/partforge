// The three plain model exports — STL, STEP and 3MF of the selected sub-parts — as
// functions, shared by jobs.js's export-stl / export-step / export-3mf jobs and the
// kit's 3D section (export/kit/model-section.js), so a model in a kit is byte for byte
// the file a plain download writes.
//
// Outside export/ on purpose: jobs.js imports this eagerly, and nothing under export/ may
// load at worker boot (test/worker-layering.test.js). Its imports are the ones jobs.js
// already held; the bed layout still loads lazily, on the first 3MF/STEP export.
//
// `ctx` is the job's own: { kernel, part, posed, label, exportName, onProgress, quality }.
import { meshTo3MF } from "./geometry/threemf.js";
import { printColor } from "./materials/resolve.js";
import { describeKernelThrow } from "./kernel-error.js";

// The 3MF/STEP bed layout (export/bed-layout.js, which reads the DFM profile table).
const loadBedLayout = () => import("./export/bed-layout.js");

// The WASM traps that mean the kernel ran out of heap (or was corrupted by doing so).
const HEAP_TRAP_RE = /out of bounds memory access|memory access out of bounds|Cannot enlarge memory|out of memory/i;

// A piece of a many-piece export failed: say WHICH piece, how far the export got, and
// — when it is the heap that ran out — the one remedy the user can apply. The raw
// message stays LAST, after a colon, so a host's own trap classifier still matches it.
export function exportPieceError(thrown, { kernel, piece, index, count }) {
  const err = describeKernelThrow(thrown, { evidence: kernel._throwEvidence?.(thrown) });
  if (count < 2 || err?.code) return err; // one piece: the error already names it; coded errors are routed, not shown
  const raw = String(err?.message || err);
  const advice = HEAP_TRAP_RE.test(raw)
    ? " ran out of memory — export fewer parts at a time (each export needs room for the parts it builds)"
    : " failed";
  return new Error(`exporting "${piece}" (part ${index + 1} of ${count})${advice}: ${raw}`, { cause: thrown });
}

const sizeOfBox = (box) => [0, 1, 2].map((i) => box.max[i] - box.min[i]);

function sizeOfPositions(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < positions.length; j += 3) {
    for (let i = 0; i < 3; i++) {
      if (positions[j + i] < min[i]) min[i] = positions[j + i];
      if (positions[j + i] > max[i]) max[i] = positions[j + i];
    }
  }
  return positions.length ? sizeOfBox({ min, max }) : [0, 0, 0];
}

// One STL per part, in `names` order: [{ part, name, data, size? }] — `name` the part's
// export name, `size` its [x, y, z] extent when `sizes` is asked for.
export async function buildStlFiles(ctx, names, { sizes = false } = {}) {
  const { kernel, posed, label, exportName, onProgress, quality } = ctx;
  const out = [];
  for (const [i, name] of names.entries()) {
    onProgress(`building ${label(name)}`);
    try {
      const solid = posed(name, "export", onProgress);
      const size = sizes ? sizeOfBox(solid.boundingBox()) : undefined;
      out.push({ part: name, name: exportName(name), data: await solid.toSTL({ quality }), ...(sizes ? { size } : {}) });
    } catch (thrown) {
      throw exportPieceError(thrown, { kernel, piece: label(name), index: i, count: names.length });
    }
    // Each file is JS-owned once toSTL returns, so this piece's solids can go now.
    // Without it a many-piece export held every piece's print-quality build until
    // the job ended — the 105-plate forge of feedback #212 ran out of heap at
    // about the 100th plate.
    kernel.cleanup?.();
  }
  return out;
}

// An organic sub-part's mesh (ctx.meshes): its bounds for the bed layout, and a copy
// moved by the layout's offset.
function meshBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = positions[i + a];
    if (v < min[a]) min[a] = v;
    if (v > max[a]) max[a] = v;
  }
  return { min, max };
}
function shiftMesh({ positions, indices }, o) {
  const p = Float32Array.from(positions);
  for (let i = 0; i < p.length; i += 3) { p[i] += o[0]; p[i + 1] += o[1]; p[i + 2] += o[2]; }
  return { positions: p, indices };
}

// Every part in one STEP file. 3MF/STEP hold every selected piece in one file; printed
// views-map pieces export as built, so they are laid out apart (export/bed-layout.js).
// Sheet pieces keep their assembled pose. Returns { data, sizes? } — sizes keyed by part.
//
// `ctx.meshes` (name → { positions, indices }) are organic sub-parts already built and
// meshed in their export pose by the Manifold worker (export-controller.js): they are
// not built here, they are laid out by their mesh's bounds, and each reaches toSTEP as a
// small stand-in solid carrying its mesh, which the writer turns into a tessellated
// solid. Without `meshes` this is the plain export.
export async function buildStepFile(ctx, names, { sizes = false } = {}) {
  const { kernel, part, posed, label, exportName, onProgress } = ctx;
  const meshes = ctx.meshes ?? {};
  const { layoutExportPieces, laidOutOnBed, exportLayoutOffsets } = await loadBedLayout();
  // A failed build names its sub-part, as STL and 3MF do — above all a k.implicit
  // call the probe did not see, which reaches OCCT and throws here.
  const buildPiece = (name, i) => {
    onProgress(`building ${label(name)}`);
    try { return posed(name, "export", onProgress); }
    catch (thrown) { throw exportPieceError(thrown, { kernel, piece: label(name), index: i, count: names.length }); }
  };
  const extents = new Map();
  const colorOf = (name) => printColor(part.parts[name]?.display);
  let bodies;
  if (!names.some((name) => meshes[name])) {
    bodies = layoutExportPieces(part, names.map((name, i) => {
      const solid = buildPiece(name, i);
      if (sizes) extents.set(name, sizeOfBox(solid.boundingBox()));
      return { name, solid };
    })).map(({ name, solid }) => ({ name: exportName(name), solid, color: colorOf(name) }));
  } else {
    const pieces = names.map((name, i) => {
      if (meshes[name]) {
        const box = meshBounds(meshes[name].positions);
        if (sizes) extents.set(name, sizeOfBox(box));
        return { name, mesh: meshes[name], box };
      }
      const solid = buildPiece(name, i);
      const box = laidOutOnBed(part, name) || sizes ? solid.boundingBox() : null;
      if (sizes) extents.set(name, sizeOfBox(box));
      return { name, solid, box };
    });
    const offsets = exportLayoutOffsets(part, pieces.filter((pc) => laidOutOnBed(part, pc.name)));
    bodies = pieces.map(({ name, solid, mesh }) => {
      const o = offsets.get(name);
      if (!mesh) return { name: exportName(name), solid: o ? solid.translate(o) : solid, color: colorOf(name) };
      return { name: exportName(name), solid: kernel.box({ size: [1, 1, 1] }), color: colorOf(name), mesh: o ? shiftMesh(mesh, o) : mesh };
    });
  }
  onProgress("writing STEP file");
  const data = await kernel.toSTEP(bodies);
  return { data, ...(sizes ? { sizes: extents } : {}) };
}

// Every part in one 3MF file. One piece in the kernel at a time, as STL: build, read the
// bounds the bed layout needs, mesh into JS-owned arrays, free — then lay out from the
// bounds and shift the meshes (translation only, so this is the layout
// layoutExportPieces makes). Returns { data, sizes? } — sizes keyed by part.
export async function build3mfFile(ctx, names, { sizes = false } = {}) {
  const { kernel, part, posed, label, exportName, onProgress, quality } = ctx;
  const { laidOutOnBed, exportLayoutOffsets } = await loadBedLayout();
  const built = [];
  for (const [i, name] of names.entries()) {
    onProgress(`building ${label(name)}`);
    try {
      const solid = posed(name, "export", onProgress);
      const box = laidOutOnBed(part, name) ? solid.boundingBox() : null;
      const { positions, indices } = solid.toIndexedMesh({ quality });
      built.push({ name, box, positions, indices });
    } catch (thrown) {
      throw exportPieceError(thrown, { kernel, piece: label(name), index: i, count: names.length });
    }
    kernel.cleanup?.();
  }
  const offsets = exportLayoutOffsets(part, built.filter((b) => b.box));
  const extents = new Map();
  const meshes = built.map(({ name, positions, indices }) => {
    if (sizes) extents.set(name, sizeOfPositions(positions));
    const o = offsets.get(name);
    if (o) for (let j = 0; j < positions.length; j += 3) { positions[j] += o[0]; positions[j + 1] += o[1]; positions[j + 2] += o[2]; }
    return { name: exportName(name), positions, indices, color: printColor(part.parts[name]?.display) };
  });
  onProgress("writing 3MF file");
  return { data: meshTo3MF(meshes), ...(sizes ? { sizes: extents } : {}) };
}
