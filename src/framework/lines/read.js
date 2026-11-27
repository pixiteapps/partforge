// Reading a part's declared lines: the top-level `lines` block names a key of derive's
// output (`on`) that is a line source (plain-data `lineInfo()`), and which of its lines.
// Pure and worker-safe: imports nothing but the error type.
import { SpecError } from "../geometry/errors.js";

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** The `lines` block in declaration order. A malformed entry is left out (lint reports it). */
export function normalizeLines(part) {
  const block = part?.lines;
  if (!isObj(block)) return [];
  const out = [];
  for (const [name, e] of Object.entries(block)) {
    if (!isObj(e) || typeof e.on !== "string" || !e.on) continue;
    const line = typeof e.line === "string" && e.line ? e.line : name;
    const views = Array.isArray(e.views) ? e.views.filter((v) => typeof v === "string") : null;
    const display = isObj(e.display) && typeof e.display.color === "string" ? { color: e.display.color } : null;
    out.push({ name, on: e.on, line, views, display });
  }
  return out;
}

/** The declared lines that show in `view`. */
export function linesInView(part, view) {
  return normalizeLines(part).filter((e) => e.views == null || e.views.includes(view));
}

/** A reading's error without readLine's own `line "<name>": ` prefix, for text that names the line already. */
export function lineErrorWhy(reading) {
  const err = String(reading.error);
  const prefix = `line "${reading.name}": `;
  return err.startsWith(prefix) ? err.slice(prefix.length) : err;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Read one declared line out of derive's output; throws a SpecError naming the line. */
export function readLine(d, decl) {
  const fail = (msg) => { throw new SpecError(`line "${decl.name}": ${msg}`, { field: `lines.${decl.name}` }); };
  const src = d?.[decl.on];
  if (typeof src?.lineInfo !== "function") fail(`derive().${decl.on} is not a line source (no lineInfo())`);
  let info;
  // the source's own throw keeps its message, prefixed with the line it was read for
  try { info = src.lineInfo(); } catch (e) { fail(String(e?.message || e)); }
  if (info?.kind !== "partforge.lines") fail(`derive().${decl.on}.lineInfo() is not a partforge.lines description`);
  const lines = info.lines;
  const l = isObj(lines) && Object.hasOwn(lines, decl.line) ? lines[decl.line] : null;
  if (!isObj(l)) fail(`derive().${decl.on} has no line "${decl.line}"`);
  const length = num(l.length);
  if (length == null) fail(`derive().${decl.on} line "${decl.line}" has no length`);
  return {
    name: decl.name, on: decl.on, mode: l.mode, d: l.d, closed: !!l.closed, length,
    bendRatio: num(l.bendRatio), minBendRatio: num(l.minBendRatio), points: l.points ?? [],
  };
}
