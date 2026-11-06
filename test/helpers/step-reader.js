// A minimal ISO 10303-21 reader for tests: the DATA section as id → { type, body }, with
// quoted strings respected ('' is an escaped quote) and whitespace collapsed outside them.
// Deliberately separate from src/framework/geometry/step-tessellated.js's own parser, so a
// test does not check the writer with the writer's code.

/** `#n = BODY;` entities of the DATA section → Map(n → { type, body }). */
export function readStep(text) {
  const start = text.indexOf("DATA;");
  const end = text.lastIndexOf("ENDSEC;");
  if (start < 0 || end < start) throw new Error("readStep: no DATA section");
  const data = text.slice(start + 5, end);
  const out = new Map();
  let cur = "", inString = false;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === "'") {
      if (inString && data[i + 1] === "'") { cur += "''"; i++; continue; }
      inString = !inString;
      cur += c;
    } else if (!inString && c === ";") {
      const m = /^\s*#(\d+)\s*=\s*([\s\S]*)$/.exec(cur);
      if (!m) throw new Error(`readStep: not an entity: ${cur.trim().slice(0, 60)}`);
      const body = m[2].replace(/\s+/g, " ").trim();
      out.set(Number(m[1]), { type: typeOf(body), body });
      cur = "";
    } else {
      cur += inString ? c : (/\s/.test(c) ? " " : c);
    }
  }
  if (cur.trim()) throw new Error("readStep: trailing text after the last entity");
  return out;
}

/** The entity's type: its first keyword, or the first of a complex `( A(...) B(...) )`. */
export const typeOf = (body) => body.match(/^\(?\s*([A-Z0-9_]+)/)?.[1];

/** Every `#n` reference in an entity body, outside quoted strings. */
export function refsOf(body) {
  return [...body.replace(/'(?:[^']|'')*'/g, "''").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/** Every entity reachable from `id` (including it). */
export function reachable(entities, id) {
  const seen = new Set(), stack = [id];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const e = entities.get(n);
    if (e) stack.push(...refsOf(e.body));
  }
  return seen;
}
