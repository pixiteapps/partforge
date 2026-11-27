// A part's declared lines as drawable tube meshes, one per line in the view. Pure and
// worker-safe (no DOM, no three, no kernel). lineMeshes never throws: an unreadable line
// is an entry with `mesh: null` and the reason in `error`.
import { linesInView, readLine } from "./read.js";
import { tubeMesh, LINE_COLOR } from "./tube.js";
// the assertion grammar alone: assert-dsl.js imports nothing
import { parseAssertion } from "../oracle/assert-dsl.js";

const errText = (e) => String(e?.message || e).split("\n")[0].slice(0, 200);

/**
 * Each declared line of `view` mapped to its reading at derive's output `d` (readLine's
 * result), or null when it cannot be read. No tube is meshed.
 */
export function lineReadings(part, view, d) {
  const out = new Map();
  let decls;
  try { decls = linesInView(part, view); } catch { return out; }
  for (const decl of decls) {
    try { out.set(decl.name, readLine(d, decl)); } catch { out.set(decl.name, null); }
  }
  return out;
}

/**
 * The drift a drag may move a line's length by before the line is tinted: the part's
 * `verify.expect._view.lineDrift` when it is a `<=` or `<` comparison against a number,
 * and `view` shows a line; null otherwise (no bound, another form, a function `expect`).
 */
export function lineDriftBound(part, view) {
  const expr = part?.verify?.expect?._view?.lineDrift;
  if (expr == null) return null;
  let a;
  try { a = parseAssertion(expr); } catch { return null; }
  if ((a.op !== "lte" && a.op !== "lt") || !Number.isFinite(a.value)) return null;
  let shown;
  try { shown = linesInView(part, view).length > 0; } catch { shown = false; }
  return shown ? a.value : null;
}

/**
 * `[{ name: "line:<decl name>", line, mesh, display: { color }, reading, error }]`, one per
 * declared line in `view`, in declaration order. `reading` is readLine's result; the tube's
 * radius is half the line's `d`.
 */
export function lineMeshes(part, view, d) {
  let decls;
  try { decls = linesInView(part, view); } catch { return []; }
  return decls.map((decl) => {
    const display = { color: Number.isInteger(decl.display?.color) ? decl.display.color : LINE_COLOR };
    const base = { name: `line:${decl.name}`, line: decl.name, display };
    try {
      const reading = readLine(d, decl);
      const radius = Number.isFinite(reading.d) ? reading.d / 2 : 0;
      const mesh = tubeMesh(reading.points, { radius, closed: reading.closed });
      return { ...base, mesh, reading, error: null };
    } catch (e) {
      return { ...base, mesh: null, reading: null, error: errText(e) };
    }
  });
}
