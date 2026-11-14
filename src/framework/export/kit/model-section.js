// The kit's 3D section: model files of the checked parts, written exactly as the plain
// downloads write them (export-models.js, shared with jobs.js's export jobs). STL is one
// file per part, `print/<name>.stl`, names made unique in definition order; 3MF and STEP
// are one file, `print/<forge>.3mf|step`, printed pieces laid out on the bed. `sets` never
// multiplies a model: the README and parts list say how many to print.
import { buildStlFiles, build3mfFile, buildStepFile } from "../../export-models.js";
import { cleanLabel } from "../readme.js";
import { KIT_OPTIONS_ERROR } from "../formats.js";
import { makeEntry } from "./entries.js";
import { SECTION_LABELS } from "./options.js";
import { kitName, namer, clipPhase, bytesOf } from "./names.js";

// `names` is ctx.selectedFrom() of the section's parts.
export function prepareModelSection(names, options) {
  if (names.length === 0) throw new Error(`${KIT_OPTIONS_ERROR} ${SECTION_LABELS["3d"]}: none of the checked parts can be exported`);
  return { names, format: options.format };
}

// The section's entries plus its PRINTED PARTS rows; `quantity` is how many of each to
// print (the kit's sets when a cut section is in it, else 1).
export async function buildModelSection(ctx, plan, { quantity }) {
  const { part, label } = ctx;
  const { names, format } = plan;
  const mctx = {
    kernel: ctx.kernel, part, posed: ctx.posed, label, exportName: ctx.exportName,
    onProgress: (phase) => ctx.onProgress(clipPhase(phase)), quality: ctx.msg?.quality ?? "print",
    // Organic sub-parts already meshed on Manifold (export-controller.js's exportKit), for STEP.
    meshes: ctx.msg?.meshes,
  };
  const entries = [];
  const files = new Map(); // part name → { file, size }
  const { claim, renamed } = namer();
  if (format === "stl") {
    for (const f of await buildStlFiles(mctx, names, { sizes: true })) {
      const filesOf = (n) => [`print/${n}.stl`];
      const file = filesOf(claim(kitName(f.name), filesOf, [cleanLabel(label(f.part))]))[0];
      entries.push(makeEntry(file, "model-stl", bytesOf(f.data)));
      files.set(f.part, { file, size: f.size });
    }
  } else {
    const build = format === "3mf" ? build3mfFile : buildStepFile;
    const { data, sizes } = await build(mctx, names, { sizes: true });
    const file = `print/${kitName(ctx.fileBase)}.${format}`;
    entries.push(makeEntry(file, `model-${format}`, bytesOf(data)));
    for (const name of names) files.set(name, { file, size: sizes.get(name) });
  }
  const rows = names.map((name) => {
    const display = part.parts[name]?.display;
    const { file, size } = files.get(name);
    return { file, labels: [cleanLabel(label(name))], quantity,
      material: typeof display?.material === "string" ? display.material : "", size };
  });
  return {
    entries, renamed,
    printed: rows.map(({ file, labels, quantity: q }) => ({ file, labels, quantity: q })),
    rows: rows.map((r) => ({ file: r.file, kind: "print", labels: r.labels, material: r.material, thickness: null,
      width: r.size[0], height: r.size[1], quantity: r.quantity })),
  };
}
