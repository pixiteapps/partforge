// One lazy exporter loader per process id, in the registry's order. Besides
// process/registry.js this is the ONLY module allowed to import process/<id>/*
// (test/sheet-layering.test.js), and it does so only through literal dynamic imports:
// an exporter reaches the drawing stage and so paper, which lint, the oracle and
// partforge/geometry must never load (test/kit-export-guards.test.js).
//
// Adding a process: one folder, one line in registry.js, one line here —
// test/kit-export-guards.test.js fails until the two id lists agree.
export const EXPORTER_LOADERS = Object.freeze({
  laser: () => import("./laser/export.js"),
});

// The process's ProcessExporter ({ drawing(s, o, k, ctx) }), loaded on first use.
export async function loadExporter(id) {
  const load = Object.hasOwn(EXPORTER_LOADERS, id) ? EXPORTER_LOADERS[id] : null;
  if (!load) throw new Error(`no exporter for process "${id}"`);
  return (await load()).default;
}
