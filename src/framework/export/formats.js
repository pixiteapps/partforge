// The cut & print kit's option contract and the export-format table. IMPORT-FREE on
// purpose: three very different readers load this file — the kit's lazy writers in the
// worker, the runtime on the main thread (listExportFormats), and partforge-cloud, whose
// coupling test imports KIT_OPTIONS_ERROR from "partforge" — and none of them may pay
// for paper or a kernel to read a table (test/kit-export-guards.test.js holds it).
//
// validateKitOptions checks MEANING: enums, ranges, stock entries. A host's own inbound
// validator checks only shape and size; that split is deliberate (design spec E.1), so
// every refusal here is written for the person at the export dialog. Each one starts
// with KIT_OPTIONS_ERROR, the prefix cloud routes to "Back to options" instead of
// offering to have the assistant fix a part that is not broken.

export const KIT_OPTIONS_ERROR = "cut kit options:";

// Every format partforge can export. `needsSheet`: the format exists only when at least
// one checked part is a sheet part (the kit). A host intersects this with its own table.
export const EXPORT_FORMATS = Object.freeze([
  Object.freeze({ id: "stl", label: "STL", ext: "stl", mime: "model/stl", needsSheet: false }),
  Object.freeze({ id: "step", label: "STEP", ext: "step", mime: "application/step", needsSheet: false }),
  Object.freeze({ id: "3mf", label: "3MF", ext: "3mf", mime: "model/3mf", needsSheet: false }),
  Object.freeze({ id: "bundle", label: "Cut and print kit", ext: "zip", mime: "application/zip", needsSheet: true }),
]);

// Destination → the cut-file format it writes. Pinned equal to the laser descriptor's
// `destinations` by test/kit-formats.test.js — two spellings of one fact.
export const DESTINATIONS = Object.freeze({ "own-laser": "svg", service: "dxf" });

// 300 × 300 mm until the paying user's machine is known (design spec decision 12).
export const DEFAULT_STOCK_SIZE = Object.freeze([300, 300]);

export const KIT_LIMITS = Object.freeze({
  kerf: Object.freeze([0, 0.5]),
  margin: Object.freeze([0, 50]),
  // min 1 mm: two pieces never share a cut line (the laser would cut it twice).
  spacing: Object.freeze([1, 50]),
  sets: Object.freeze([1, 20]),
  stockEntries: 20,
  stockSide: Object.freeze([10, 3000]),
  sheetsPerGroup: 50,
  pieces: 200,
});

export const KIT_DEFAULTS = Object.freeze({
  destination: "own-laser", kerf: 0, colors: "lightburn", stock: null,
  margin: 5, spacing: 3, printFormat: "stl", sets: 1,
});

const OPTION_KEYS = ["destination", "cutFormat", "kerf", "colors", "stock", "margin", "spacing", "printFormat", "sets"];

const fail = (message) => new Error(`${KIT_OPTIONS_ERROR} ${message}`);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const inRange = (v, [lo, hi]) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

// `undefined` means "all defaults" (a caller that sent no options at all); anything else
// that is not a plain object is refused. Returns a fresh, fully populated object with
// `cutFormat` derived from the destination.
export function validateKitOptions(o) {
  const opts = o === undefined ? {} : o;
  if (!isPlainObject(opts)) throw fail("options must be an object");
  for (const key of Object.keys(opts))
    if (!OPTION_KEYS.includes(key)) throw fail(`unknown option "${key}" — the options are ${OPTION_KEYS.join(", ")}`);
  const pick = (key) => (opts[key] === undefined ? KIT_DEFAULTS[key] : opts[key]);

  const destination = pick("destination");
  if (typeof destination !== "string" || !Object.hasOwn(DESTINATIONS, destination))
    throw fail(`destination must be "own-laser" or "service", got ${JSON.stringify(destination)}`);
  const cutFormat = DESTINATIONS[destination];
  if (opts.cutFormat !== undefined && opts.cutFormat !== cutFormat)
    throw fail(`cutFormat ${JSON.stringify(opts.cutFormat)} does not match destination "${destination}" (which writes ${cutFormat})`);

  const kerf = pick("kerf");
  if (!inRange(kerf, KIT_LIMITS.kerf))
    throw fail(`kerf must be a number from ${KIT_LIMITS.kerf[0]} to ${KIT_LIMITS.kerf[1]} mm, got ${JSON.stringify(kerf)}`);
  const colors = pick("colors");
  if (colors !== "lightburn") throw fail(`colors must be "lightburn", got ${JSON.stringify(colors)}`);
  const stock = normalizeStock(opts.stock);
  const margin = pick("margin");
  if (!inRange(margin, KIT_LIMITS.margin))
    throw fail(`margin must be a number from ${KIT_LIMITS.margin[0]} to ${KIT_LIMITS.margin[1]} mm, got ${JSON.stringify(margin)}`);
  const spacing = pick("spacing");
  if (!inRange(spacing, KIT_LIMITS.spacing))
    throw fail(`spacing must be a number from ${KIT_LIMITS.spacing[0]} to ${KIT_LIMITS.spacing[1]} mm, got ${JSON.stringify(spacing)}`);
  const printFormat = pick("printFormat");
  if (printFormat !== "stl" && printFormat !== "3mf")
    throw fail(`printFormat must be "stl" or "3mf", got ${JSON.stringify(printFormat)}`);
  const sets = pick("sets");
  if (!Number.isInteger(sets) || sets < KIT_LIMITS.sets[0] || sets > KIT_LIMITS.sets[1])
    throw fail(`sets must be a whole number from ${KIT_LIMITS.sets[0]} to ${KIT_LIMITS.sets[1]}, got ${JSON.stringify(sets)}`);

  return { destination, cutFormat, kerf, colors, stock, margin, spacing, printFormat, sets };
}

// null/undefined → null ("every group gets DEFAULT_STOCK_SIZE"); otherwise fresh
// `{ group, size: [w, h] }` copies. A group key is sheetGroup()'s `"<material>|<t>"`, or
// "*" for an explicit default — which groups exist is only known once the parts are
// resolved, so matching happens later, in resolveStock.
function normalizeStock(stock) {
  if (stock === undefined || stock === null) return null;
  if (!Array.isArray(stock)) throw fail("stock must be an array of { group, size: [w, h] }");
  if (stock.length > KIT_LIMITS.stockEntries)
    throw fail(`stock has ${stock.length} entries — at most ${KIT_LIMITS.stockEntries}`);
  const seen = new Set();
  return stock.map((entry, i) => {
    const shaped = isPlainObject(entry) && Object.keys(entry).every((k) => k === "group" || k === "size")
      && typeof entry.group === "string" && entry.group.length > 0
      && Array.isArray(entry.size) && entry.size.length === 2;
    if (!shaped) throw fail(`stock entry ${i + 1} needs a group and a size [w, h] in mm`);
    const { group, size } = entry;
    const [lo, hi] = KIT_LIMITS.stockSide;
    if (!size.every((v) => inRange(v, KIT_LIMITS.stockSide)))
      throw fail(`stock "${group}" size must be two numbers from ${lo} to ${hi} mm, got ${JSON.stringify(size)}`);
    if (seen.has(group)) throw fail(`stock names "${group}" twice`);
    seen.add(group);
    return { group, size: [size[0], size[1]] };
  });
}

// Match validated stock entries to the kit's groups (`[{ group, label }]`, definition
// order; label = `${material} ${fmtMm(t)} mm`). Never a silent fallback: an entry naming
// no group, or a group with neither its own entry nor a "*" default, is an options error
// (design spec D.3). Returns group → [w, h].
export function resolveStock(stock, groups) {
  const sizes = new Map();
  if (stock === null || stock === undefined) {
    for (const { group } of groups) sizes.set(group, [DEFAULT_STOCK_SIZE[0], DEFAULT_STOCK_SIZE[1]]);
    return sizes;
  }
  const known = new Set(groups.map((g) => g.group));
  const byGroup = new Map();
  for (const { group, size } of stock) {
    if (group !== "*" && !known.has(group))
      throw fail(`stock names "${group}", which no checked sheet part uses — the kit's groups are ${groups.map((g) => JSON.stringify(g.group)).join(", ")}`);
    byGroup.set(group, size);
  }
  for (const { group, label } of groups) {
    const size = byGroup.get(group) ?? byGroup.get("*");
    if (!size) throw fail(`no stock size for "${group}" (${label}) — add a stock entry for it or a "*" default`);
    sizes.set(group, [size[0], size[1]]);
  }
  return sizes;
}
