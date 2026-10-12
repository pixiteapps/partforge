// Resolve a routed part's pockets, drills and extra ops at (p, d) — the cnc-router
// process's half of resolveSheet (sheet/resolve.js dispatches here by process id).
//
// PROBE-SAFE like sheet/resolve.js: kernel and Shape2D METHODS only, no geometry
// queries, no branching on geometry. The exact circle for a drill is written as the
// contract's two-arc ring (sheetHole's form) rather than imported from joinery.js, which
// the oracle's closure may not reach.
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (q) => Array.isArray(q) && q.length === 2 && isNum(q[0]) && isNum(q[1]);
const isSolid = (v) => !!v && typeof v === "object" && typeof v.cutAll === "function" && typeof v.translate === "function";
const circleRing = ([x, y], r) => ({ start: [x + r, y], segments: [{ to: [x - r, y], via: [x, y + r] }, { to: [x + r, y], via: [x, y - r] }] });

const fail = (sp, problem) => new Error(`routed part${sp.label ? ` "${sp.label}"` : ""}: ${problem}`);
const name = (entry, i, kind) => (typeof entry.label === "string" && entry.label.trim() ? `${kind} "${entry.label}"` : `${kind} ${i + 1}`);
const depthOf = (sp, entry, who) => {
  if (!isNum(entry.depth) || entry.depth <= 0) throw fail(sp, `${who} depth must be a finite number > 0 (mm), got ${JSON.stringify(entry.depth)}`);
  return entry.depth;
};
const labelOf = (entry) => (typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : null);
const list = (sp, fn, args, what, shape) => {
  if (!fn) return [];
  const out = fn(...args);
  if (out === null || out === undefined) return [];
  if (!Array.isArray(out)) throw fail(sp, `${what} must return an array of ${shape}`);
  return out.filter((e) => e !== null && e !== undefined);
};

// `base` is resolveSheet's ResolvedSheet so far (profile, thickness, score…); the
// return value is merged onto it as `routed`.
export function resolveRouted(k, sp, p, d, base) {
  const s = sp.sheet;
  const t = base.thickness;

  const pockets = list(sp, s.pockets, [k, p, d], "pockets(k, p, d)", "{ region, depth, label? }").map((e, i) => {
    const who = name(e, i, "pocket");
    if (!e || typeof e !== "object" || e.region === null || e.region === undefined) throw fail(sp, `${who} needs a region (a Shape2D or profile)`);
    const depth = depthOf(sp, e, who);
    if (depth > t) throw fail(sp, `${who} is ${e.depth} mm deep in ${t} mm stock — a pocket may be at most the thickness; make it a through cut in \`profile\` if it should go through`);
    return { region: k.shape2d(e.region), depth, label: labelOf(e) };
  });

  const drills = list(sp, s.drills, [p, d], "drills(p, d)", "{ at, d, depth }").map((e, i) => {
    const who = name(e, i, "drill");
    if (!e || typeof e !== "object" || !isPoint(e.at)) throw fail(sp, `${who} needs at: [x, y]`);
    if (!isNum(e.d) || e.d <= 0) throw fail(sp, `${who} d must be a finite number > 0 (mm), got ${JSON.stringify(e.d)}`);
    const depth = depthOf(sp, e, who);
    const through = depth >= t;
    return { shape: k.shape2d(circleRing(e.at, e.d / 2)), at: [e.at[0], e.at[1]], d: e.d, depth: through ? t : depth, through, label: labelOf(e) };
  });

  const extra = list(sp, s.extra, [k, p, d], "extra(k, p, d)", "{ solid, footprint, label, method }").map((e, i) => {
    const label = labelOf(e);
    if (!label) throw fail(sp, `extra op ${i + 1} needs a label — say what it is ("12° domino slot")`);
    const who = `extra op "${label}"`;
    if (typeof e.method !== "string" || !e.method.trim()) throw fail(sp, `${who} needs a method — say how the operator makes it ("table saw, blade tilted 12°")`);
    if (!isSolid(e.solid)) throw fail(sp, `${who} needs a solid — the geometry it removes, for the preview and the STEP`);
    if (e.footprint === null || e.footprint === undefined) throw fail(sp, `${who} needs a footprint — its outline on the machined face, for the drawing`);
    return { solid: e.solid, footprint: k.shape2d(e.footprint), label, method: e.method.trim() };
  });

  return { pockets, drills, extra };
}
