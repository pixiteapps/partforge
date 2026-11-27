// A part's declared lines as drawable tube meshes, one per line in the view. Pure and
// worker-safe (no DOM, no three, no kernel). lineMeshes never throws: an unreadable line
// is an entry with `mesh: null` and the reason in `error`.
import { linesInView, readLine } from "./read.js";
import { tubeMesh, LINE_COLOR } from "./tube.js";

const errText = (e) => String(e?.message || e).split("\n")[0].slice(0, 200);

/**
 * `[{ name: "line:<decl name>", line, mesh, display: { color }, reading, error }]`, one per
 * declared line in `view`, in declaration order. `reading` is readLine's result; the tube's
 * radius is half the line's `d`.
 */
export function lineMeshes(part, view, d) {
  let decls;
  try { decls = linesInView(part, view); } catch { return []; }
  return decls.map((decl) => {
    const display = { color: typeof decl.display?.color === "string" ? decl.display.color : LINE_COLOR };
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
