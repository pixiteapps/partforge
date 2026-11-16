// The kit as a list of entries { path, kind, data } that a host zips (or, for a kit with
// one model in it, saves as that bare file). Each kind owns the name grammar of the files
// it may carry, the successor to the one-ZIP kit's single name pattern. Imports nothing:
// it loads in the worker and on the main thread alike.

const NAME = "[a-z0-9][a-z0-9._-]*";
const DRAWING = `^(laser|cnc)\\/(sheets\\/${NAME}\\/sheet-\\d+-of-\\d+|parts\\/${NAME}(-x\\d+)?(-far)?(-marks)?)`;

const kind = (ext, mime, pattern) => Object.freeze({ ext, mime, pattern });

export const KIT_KINDS = Object.freeze({
  "model-stl": kind("stl", "model/stl", new RegExp(`^print\\/${NAME}\\.stl$`)),
  "model-3mf": kind("3mf", "model/3mf", new RegExp(`^print\\/${NAME}\\.3mf$`)),
  "model-step": kind("step", "application/step", new RegExp(`^print\\/${NAME}\\.step$`)),
  "drawing-svg": kind("svg", "image/svg+xml", new RegExp(`${DRAWING}\\.svg$`)),
  "drawing-dxf": kind("dxf", "image/vnd.dxf", new RegExp(`${DRAWING}\\.dxf$`)),
  text: kind("txt", "text/plain", /^README\.txt$/),
  table: kind("csv", "text/csv", /^parts\.csv$/),
});

export const MODEL_KINDS = new Set(["model-stl", "model-3mf", "model-step"]);

export function makeEntry(path, kindId, data) {
  return { path, kind: kindId, data };
}

// Every entry must name a known kind, match that kind's pattern, carry no "..", and be
// the only entry at its path (two files under one name would overwrite each other).
export function assertEntries(entries) {
  const seen = new Set();
  for (const { path, kind: kindId } of entries) {
    const spec = Object.hasOwn(KIT_KINDS, kindId) ? KIT_KINDS[kindId] : null;
    if (!spec || typeof path !== "string" || !spec.pattern.test(path) || path.includes("..") || seen.has(path)) {
      throw new Error(`cut kit: bad entry name ${JSON.stringify(path)}`);
    }
    seen.add(path);
  }
}

// The one entry to save bare: exactly one entry that is not text/table, and a model.
export function bareEntry(entries) {
  const files = entries.filter((x) => x.kind !== "text" && x.kind !== "table");
  return files.length === 1 && MODEL_KINDS.has(files[0].kind) ? files[0] : null;
}
