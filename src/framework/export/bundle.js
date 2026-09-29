// The cut & print kit (spec D): one ZIP per forge — every checked sheet part drawn flat
// and laid out on the user's stock, every checked printed part as STL or 3MF, a README
// and a parts list.
//
// jobs.js loads this module LAZILY, on the first export-bundle job (`loadBundle`), never
// at worker boot (test/worker-layering.test.js). And nothing here may reach ./oracle/*
// (test/kit-layering.test.js mocks every oracle module to throw): the mesh oracle has
// OOM-killed iOS Safari, and the kit needs none of it — a sheet is drawn from its 2-D
// declaration and checked by its own process's facts()/checks().
import { safeName } from "../safe-name.js";
import { processById, SHEET_METRICS } from "../process/registry.js";

// Every entry name the kit may write (spec D.10). test/kit-bundle.test.js pins every
// kit it builds against it, and buildBundle asserts it again before zipping.
export const KIT_ENTRY_RE = /^(README\.txt|parts\.csv|sheets\/[a-z0-9][a-z0-9._-]*\/sheet-\d+-of-\d+\.(svg|dxf)|parts\/[a-z0-9][a-z0-9._-]*(-x\d+)?(-marks)?\.(svg|dxf)|print\/[a-z0-9][a-z0-9._-]*(-x\d+)?\.(stl|3mf))$/;

// A path segment from an author string. safeName already lowercases, collapses runs and
// refuses a leading dot or dash; folding every run of dots on top means no entry name
// can ever carry "..".
export const kitName = (s) => safeName(s, "part").replace(/\.{2,}/g, ".");

// The first of base, base-2, base-3, … whose files are all free, claimed in `taken`.
// `filesOf(name)` lists every path a name produces — a piece's cut file and its -marks
// file — so a name is free only when all of them are, and "front" ×2 can never land on
// the file of a piece literally named "front-x2". Called in definition order, so a
// forge always gets the same names.
export function uniqueName(base, taken, filesOf = (name) => [name]) {
  let name = base;
  for (let i = 2; filesOf(name).some((f) => taken.has(f)); i++) name = `${base}-${i}`;
  for (const f of filesOf(name)) taken.add(f);
  return name;
}

// Merge equal items, first-seen order kept. `hashOf` only NOMINATES candidates — the kit
// hashes with solid-hash.js's 32-bit FNV, which can collide — and `same(a, b)` confirms.
// Returns [{ item, members }], `item` being the first member.
export function dedupe(items, hashOf, same) {
  const groups = [];
  const byHash = new Map();
  for (const item of items) {
    const key = hashOf(item);
    const candidates = byHash.get(key) ?? [];
    const hit = candidates.find((g) => same(g.item, item));
    if (hit) { hit.members.push(item); continue; }
    const group = { item, members: [item] };
    candidates.push(group);
    byHash.set(key, candidates);
    groups.push(group);
  }
  return groups;
}

// verify's wording for the three expression forms a process's checks() emits — ">=N",
// "<=N" and a bare number (equality) — restated from oracle/assert-dsl.js, because the
// kit must never load ./oracle/*. test/kit-bundle-helpers.test.js holds the two equal.
// Any other form throws: it needs a line here, not a silent pass.
const EPS = 1e-6;
export function checkMessage(expr, actual) {
  const m = /^(>=|<=)?\s*([-+]?[0-9]*\.?[0-9]+)$/.exec(String(expr).trim());
  if (!m) throw new Error(`cut kit: unsupported sheet check "${expr}"`);
  const value = Number(m[2]);
  if (m[1] === ">=") {
    const pass = actual >= value - EPS;
    return { pass, message: `${actual} ${pass ? ">=" : "not >="} ${value}` };
  }
  if (m[1] === "<=") {
    const pass = actual <= value + EPS;
    return { pass, message: `${actual} ${pass ? "<=" : "not <="} ${value}` };
  }
  const pass = Math.abs(actual - value) <= EPS + EPS * Math.abs(value);
  return { pass, message: `${actual} ${pass ? "==" : "!="} ${value}` };
}

const NOT_EVALUATED = "2-D sheet checks not evaluated (time budget) — the kit ran out of time checking this piece for narrow webs, narrow gaps and stray marks; look it over before cutting";

// oracle/verify.js's wording for a reading the geometry engine refused (SheetFacts's
// readErrors, added past this file's own §5.4/§7.1 in the contract) — restated here
// rather than imported, for the same reason checkMessage restates assert-dsl: the kit
// must never load ./oracle/*. test/kit-bundle-helpers.test.js pins this string.
const SHEET_READ_ERROR_HINT = "The geometry engine could not run this 2-D laser check on the profile (the reason is in the message). The part still builds; an overlapping or self-touching contour, or a sliver, is the usual cause — simplify the profile there and re-run.";

// The README's CHECKS lines for one piece: every volunteered check its process runs
// that fails, as `${label}: ${message} — ${hint}` with the metric's own hint. A metric
// with no reading (budget-gated and not evaluated, or a custom build's volume match,
// which needs a solid the kit never builds) is skipped; an unevaluated piece gets one
// line saying so instead. A metric the geometry engine refused to read (readErrors) gets
// its own line, worded like verify's: `not measured — <reason>`, with a fixed hint —
// never the metric's own hint, which describes a value that was never taken.
export function sheetWarnings(label, facts) {
  const desc = facts ? processById(facts.process) : null;
  if (!desc) return [];
  const out = [];
  for (const [metric, expr] of Object.entries(desc.checks(facts))) {
    const reg = SHEET_METRICS[metric];
    const actual = reg?.extract({ sheet: facts });
    if (actual === null || actual === undefined) {
      const why = reg?.readError?.({ sheet: facts });
      if (why) out.push(`${label}: not measured — ${why} — ${SHEET_READ_ERROR_HINT}`);
      continue;
    }
    const { pass, message } = checkMessage(expr, actual);
    if (!pass) out.push(`${label}: ${message} — ${reg.hint}`);
  }
  if (facts.evaluated === false) out.push(`${label}: ${NOT_EVALUATED}`);
  return out;
}
