// A part's declared lines, read at the measured pose for measure(). Worker-safe: no DOM,
// no three, no node. Never throws; an unreadable line becomes `{ name, on, error }`.
import { linesInView, readLine } from "../lines/read.js";

/** One entry per declared line in `view`: the reading without its points, or an error. */
export function measureLines(part, view, d) {
  return linesInView(part, view).map((decl) => {
    try {
      const { name, on, mode, length, bendRatio, minBendRatio } = readLine(d, decl);
      return { name, on, mode, length, bendRatio, minBendRatio };
    } catch (e) {
      return { name: decl.name, on: decl.on, error: String(e?.message || e).split("\n")[0].slice(0, 200) };
    }
  });
}
