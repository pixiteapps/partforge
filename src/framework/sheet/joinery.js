// Joinery helpers for sheet parts — pure, kernel-free, plain data in and out. They
// belong in derive(): a joint is JSON-safe data, an outline is a plain CCW point list
// (no closing duplicate), a hole is an exact two-arc contour. Re-exported from
// partforge/geometry (geometry/polygon.js).
//
// Three numbers, never mixed:
//   thickness  the depth of a joint's band — the MATING sheet's measured thickness
//   clearance  the finished joint's TOTAL play: fingers split it between the two
//              panels (c/4 per side each), tabs, nut traps and printed tongues put it
//              all on the slot
//   kerf       never an argument — outputs are nominal material regions and the kit
//              offsets the cut layer once at download
//
// sheetPanel's nominal edge lines are the box [0, W] × [0, H], edges in CCW order
// bottom → right → top → left, each measured from its own start. A joint lives in a
// band `thickness` wide along its edge: OUTER fingers and tab tongues protrude OUTSIDE
// the box, INNER fingers are notches INSIDE it. Plain, tab and T-slot edges have no
// band. Corner ownership belongs to the helper: where two banded edges meet, the
// corner square is material iff both edges own their ends — outer fingers own theirs,
// inner fingers do not — so outer+outer fills the square, inner+inner notches it, and
// a mixed corner leaves it empty. A band next to an inner band starts `thickness` in
// from the corner, which is what lets two panels' finger cells line up.
import { fmtMm } from "./constants.js";

// Metric screws for tSlots(): clearance hole (ISO 273, medium series) and hex nut
// across-flats / height (ISO 4032), mm.
export const JOINERY_SCREWS = Object.freeze({
  "M2.5": Object.freeze({ hole: 2.9, nut: Object.freeze({ flats: 5.0, height: 2.0 }) }),
  "M3": Object.freeze({ hole: 3.4, nut: Object.freeze({ flats: 5.5, height: 2.4 }) }),
  "M4": Object.freeze({ hole: 4.5, nut: Object.freeze({ flats: 7.0, height: 3.2 }) }),
});

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPt = (p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]);

function checkOptions(helper, o, keys, example) {
  if (!isPlainObject(o)) throw new Error(`${helper}: expected an options object — ${example}`);
  for (const key of Object.keys(o)) {
    if (key === "kerf") throw new Error(`${helper}: kerf is not a joinery option — joinery is drawn nominal and kerf is chosen when you download the kit`);
    if (!keys.includes(key)) throw new Error(`${helper}: unknown option "${key}" — the options are ${keys.join(", ")}`);
  }
  return o;
}

function positive(helper, key, v) {
  if (!isNum(v) || v <= 0) throw new Error(`${helper}: ${key} must be a number > 0 (mm), got ${JSON.stringify(v)}`);
  return v;
}

function clearanceFor(helper, v, thickness) {
  if (!isNum(v) || v < 0 || v >= thickness)
    throw new Error(`${helper}: clearance must be a number from 0 to less than the thickness (mm), got ${JSON.stringify(v)}`);
  return v;
}

// --- joints (plain data) ---------------------------------------------------------

export function fingers(opts) {
  const o = checkOptions("fingers", opts, ["thickness", "clearance", "finger", "side"], "fingers({ thickness, clearance, finger, side })");
  const thickness = positive("fingers", "thickness", o.thickness);
  const clearance = clearanceFor("fingers", o.clearance ?? 0.1, thickness);
  const finger = positive("fingers", "finger", o.finger ?? 2 * thickness);
  if (finger < 2 * thickness - 1e-9)
    throw new Error(`fingers: finger must be at least 2 × thickness (${fmtMm(2 * thickness)} mm), got ${fmtMm(finger)}`);
  const side = o.side ?? "outer";
  if (side !== "outer" && side !== "inner") throw new Error(`fingers: side must be "outer" or "inner", got ${JSON.stringify(side)}`);
  return { joint: "fingers", thickness, clearance, finger, side };
}

export function tabs(opts) {
  const o = checkOptions("tabs", opts, ["thickness", "count", "width"], "tabs({ thickness, count, width })");
  const thickness = positive("tabs", "thickness", o.thickness);
  const count = o.count ?? 2;
  if (!Number.isInteger(count) || count < 1 || count > 50)
    throw new Error(`tabs: count must be a whole number from 1 to 50, got ${JSON.stringify(count)}`);
  const width = positive("tabs", "width", o.width ?? 3 * thickness);
  return { joint: "tabs", thickness, count, width };
}

export function tSlots(opts) {
  const o = checkOptions("tSlots", opts, ["thickness", "screw", "screwLength", "at", "clearance"], "tSlots({ thickness, screw, screwLength, at, clearance })");
  const thickness = positive("tSlots", "thickness", o.thickness);
  const screw = o.screw ?? "M3";
  if (typeof screw !== "string" || !Object.hasOwn(JOINERY_SCREWS, screw))
    throw new Error(`tSlots: screw must be one of ${Object.keys(JOINERY_SCREWS).join(", ")}, got ${JSON.stringify(screw)}`);
  const screwLength = positive("tSlots", "screwLength", o.screwLength ?? 12);
  const at = o.at ?? [0.5];
  if (!Array.isArray(at) || at.length === 0 || !at.every((f) => isNum(f) && f > 0 && f < 1))
    throw new Error(`tSlots: at must be an array of fractions between 0 and 1, got ${JSON.stringify(at)}`);
  const clearance = clearanceFor("tSlots", o.clearance ?? 0.2, thickness);
  const { nut } = JOINERY_SCREWS[screw];
  const reach = screwLength - thickness;
  const need = nut.height + clearance / 2 + 1.5;   // nut trap + 1 mm of material before it
  if (reach < need)
    throw new Error(`tSlots: an ${screw} × ${fmtMm(screwLength)} mm screw reaches ${reach.toFixed(2)} mm past a ${thickness.toFixed(2)} mm panel — the nut trap needs at least ${need.toFixed(2)} mm; use a longer screw`);
  return { joint: "tslots", thickness, screw, screwLength, at: [...at].sort((a, b) => a - b), clearance };
}

// --- panels ----------------------------------------------------------------------

const EDGE_NAMES = ["bottom", "right", "top", "left"];
const isJoint = (j) => isPlainObject(j) && (j.joint === "fingers" || j.joint === "tabs" || j.joint === "tslots");
const bandInside = (j) => j?.joint === "fingers" && j.side === "inner";

// One edge's boundary in its own frame: [s, n] points from s = 0 to s = L, where s
// runs along the edge from its start and n is the offset OUTWARD from the nominal
// line (+ protrudes, − notches). `head`/`tail` are how far the band starts in from
// each corner (a neighbouring inner band's thickness, else 0).
function fingerPoints(j, L, head, tail) {
  const t = j.thickness, q = j.clearance / 4;
  const span = L - head - tail;
  let n = Math.floor(span / j.finger + 1e-9);
  if (n % 2 === 0) n -= 1;
  n = Math.max(n, 3);
  const cell = span / n;
  if (cell < 2 * t - 1e-9)
    throw new Error(`fingers: a ${span.toFixed(2)} mm edge is too short — 3 fingers of at least ${(2 * t).toFixed(2)} mm (2 × thickness) need ${(6 * t).toFixed(2)} mm`);
  const outer = j.side === "outer";
  // Cell k (0-based) carries this panel's material iff (k even) === outer; the
  // interior boundary between two cells moves q = c/4 INTO the material cell, so a
  // finger is c/4 narrower and a notch c/4 wider per interior side.
  const isMaterial = (k) => (k % 2 === 0) === outer;
  const offset = (k) => (outer ? (isMaterial(k) ? t : 0) : (isMaterial(k) ? 0 : -t));
  const cuts = [];
  for (let k = 1; k < n; k++) cuts.push(head + k * cell + (isMaterial(k) ? q : -q));
  const runs = [];                                   // [from, to, n] covering [0, L]
  if (head > 0) runs.push([0, head, outer ? 0 : -t]); // outer: empty mixed corner; inner: notched square
  const bounds = [head, ...cuts, L - tail];
  for (let k = 0; k < n; k++) runs.push([bounds[k], bounds[k + 1], offset(k)]);
  if (tail > 0) runs.push([L - tail, L, outer ? 0 : -t]);
  return runsToPoints(runs);
}

function runsToPoints(runs) {
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last[2] === r[2]) last[1] = r[1];
    else merged.push([...r]);
  }
  const pts = [[merged[0][0], merged[0][2]]];
  for (let i = 0; i < merged.length; i++) {
    pts.push([merged[i][1], merged[i][2]]);
    if (i + 1 < merged.length) pts.push([merged[i][1], merged[i + 1][2]]);
  }
  return pts;
}

// Tongues centred at (i + 0.5)·L/count, each `width` wide, protruding `thickness`;
// they must stay apart and clear of a neighbouring inner band (head/tail).
function tabPoints(j, L, head, tail) {
  const pitch = L / j.count;
  if (j.width >= pitch - 1e-9 || pitch / 2 - j.width / 2 < head - 1e-9 || pitch / 2 - j.width / 2 < tail - 1e-9)
    throw new Error(`tabs: ${j.count} tabs of ${fmtMm(j.width)} mm do not fit a ${L.toFixed(2)} mm edge`);
  const pts = [[0, 0]];
  for (let i = 0; i < j.count; i++) {
    const c = (i + 0.5) * pitch, a = c - j.width / 2, b = c + j.width / 2;
    pts.push([a, 0], [a, j.thickness], [b, j.thickness], [b, 0]);
  }
  pts.push([L, 0]);
  return pts;
}

// Each T-slot, into the panel from the nominal edge: a shank slot `hole` wide and
// reach + 1 deep (reach = screwLength − thickness, the screw's length past the mating
// panel), crossed by a nut trap (flats + c) along the edge × (nut height + c) deep whose
// far face sits 0.5 mm short of the screw tip.
function tSlotPoints(j, L, name, head, tail) {
  const { hole, nut } = JOINERY_SCREWS[j.screw];
  const c = j.clearance, reach = j.screwLength - j.thickness;
  const near = reach - nut.height - 0.5 - c / 2;     // trap's near face, depth from the edge
  const far = reach - 0.5 + c / 2;                   // trap's far face
  const shank = reach + 1;                           // shank slot depth
  const ws = hole / 2, wt = (nut.flats + c) / 2;
  const pts = [[0, 0]];
  let prevEnd = head;
  for (const f of j.at) {
    const s = f * L;
    if (s - wt < prevEnd + 1e-9 || s + wt > L - tail - 1e-9)
      throw new Error(`sheetPanel: edges.${name} has a T-slot at ${f} that does not fit its ${L.toFixed(2)} mm edge`);
    prevEnd = s + wt;
    pts.push(
      [s - ws, 0], [s - ws, -near], [s - wt, -near], [s - wt, -far], [s - ws, -far], [s - ws, -shank],
      [s + ws, -shank], [s + ws, -far], [s + wt, -far], [s + wt, -near], [s + ws, -near], [s + ws, 0],
    );
  }
  pts.push([L, 0]);
  return pts;
}

// Drop repeated points and the middle of straight runs (cyclic).
function cleanRing(pts) {
  const eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  let ring = pts.filter((p, i) => !eq(p, pts[(i + 1) % pts.length]));
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (Math.abs(cross) < 1e-9 && dot > 0) { ring.splice(i, 1); changed = true; break; }
    }
  }
  return ring;
}

// Every outline is rectilinear, so "does it cross itself" is a cheap exact test on
// axis-aligned segments — the only way two edges' joints can collide (a T-slot or a
// tongue crowding a corner, a T-slot deeper than the panel).
function assertSimple(ring) {
  const n = ring.length;
  const seg = (i) => [ring[i], ring[(i + 1) % n]];
  const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue;           // the closing pair shares a vertex
      const [a, b] = seg(i), [c, d] = seg(k);
      const ox = lo(hi(a[0], b[0]), hi(c[0], d[0])) - hi(lo(a[0], b[0]), lo(c[0], d[0]));
      const oy = lo(hi(a[1], b[1]), hi(c[1], d[1])) - hi(lo(a[1], b[1]), lo(c[1], d[1]));
      if (ox > -1e-9 && oy > -1e-9)
        throw new Error(`sheetPanel: the joints collide — the outline crosses itself near [${fmtMm(a[0])}, ${fmtMm(a[1])}]; move the tabs or T-slots away from each other and from the corners`);
    }
  }
}

export function sheetPanel(opts) {
  const o = checkOptions("sheetPanel", opts, ["width", "height", "edges"], "sheetPanel({ width, height, edges: { bottom, right, top, left } })");
  const W = positive("sheetPanel", "width", o.width);
  const H = positive("sheetPanel", "height", o.height);
  const edges = o.edges ?? {};
  if (!isPlainObject(edges)) throw new Error("sheetPanel: edges must be an object — { bottom, right, top, left }, each a joint or omitted");
  for (const [key, j] of Object.entries(edges)) {
    if (!EDGE_NAMES.includes(key)) throw new Error(`sheetPanel: unknown edge "${key}" — the edges are ${EDGE_NAMES.join(", ")}`);
    if (j !== undefined && !isJoint(j)) throw new Error(`sheetPanel: edges.${key} is not a joint — build it with fingers(), tabs() or tSlots()`);
  }
  // CCW: start, direction, outward normal, nominal length.
  const frames = [
    { name: "bottom", S: [0, 0], dir: [1, 0], out: [0, -1], L: W },
    { name: "right", S: [W, 0], dir: [0, 1], out: [1, 0], L: H },
    { name: "top", S: [W, H], dir: [-1, 0], out: [0, 1], L: W },
    { name: "left", S: [0, H], dir: [0, -1], out: [-1, 0], L: H },
  ];
  const joints = frames.map((f) => edges[f.name]);
  const local = frames.map((f, i) => {
    const j = joints[i], prev = joints[(i + 3) % 4], next = joints[(i + 1) % 4];
    if (!j) return [[0, 0], [f.L, 0]];
    const head = bandInside(prev) ? prev.thickness : 0, tail = bandInside(next) ? next.thickness : 0;
    if (j.joint === "fingers") return fingerPoints(j, f.L, head, tail);
    if (j.joint === "tabs") return tabPoints(j, f.L, head, tail);
    return tSlotPoints(j, f.L, f.name, head, tail);
  });
  const toWorld = (f, [s, n]) => [f.S[0] + s * f.dir[0] + n * f.out[0], f.S[1] + s * f.dir[1] + n * f.out[1]];
  const ring = [];
  frames.forEach((f, i) => {
    const pf = frames[(i + 3) % 4], prevPts = local[(i + 3) % 4], pts = local[i];
    const nPrev = prevPts[prevPts.length - 1][1], nThis = pts[0][1];
    // The corner join: where the previous edge's last offset line meets this edge's first.
    ring.push([f.S[0] + nPrev * pf.out[0] + nThis * f.out[0], f.S[1] + nPrev * pf.out[1] + nThis * f.out[1]]);
    for (const p of pts.slice(1, -1)) ring.push(toWorld(f, p));
  });
  const outline = cleanRing(ring).map(([x, y]) => [x + 0, y + 0]);
  assertSimple(outline);
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  return { outline, size: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
}

// --- mates -----------------------------------------------------------------------

// The holes the OTHER panel needs for a tabs or T-slot edge. `line` is the tabbed
// panel's MID-PLANE line drawn in the slotted panel's frame, line[0] matching the
// tabbed edge's start (positions along it are fractions of its length, so it should be
// as long as the tabbed edge). Tabs → (width + c) × (thickness + c) rectangles centred
// on the line (c defaults to 0.1); T-slots → sheetHole({ d: hole + c }) at the same
// fractions (c defaults to 0).
export function matchingSlots(joint, opts) {
  if (!isJoint(joint)) throw new Error("matchingSlots: the first argument must be a joint from fingers(), tabs() or tSlots()");
  if (joint.joint === "fingers")
    throw new Error('matchingSlots: fingers mate edge to edge and need no slots — give the other panel\'s edge fingers({ …, side: "inner" }) (or "outer")');
  const o = checkOptions("matchingSlots", opts, ["line", "clearance"], "matchingSlots(joint, { line: [[x0, y0], [x1, y1]], clearance })");
  if (!Array.isArray(o.line) || o.line.length !== 2 || !o.line.every(isPt)) throw new Error("matchingSlots: line must be two finite [x, y] points");
  const [p0, p1] = o.line;
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (L < 1e-9) throw new Error("matchingSlots: line must be two finite [x, y] points");
  const dir = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L], nrm = [-dir[1], dir[0]];
  const along = (f) => [p0[0] + dir[0] * f * L, p0[1] + dir[1] * f * L];
  if (joint.joint === "tabs") {
    const c = clearanceFor("matchingSlots", o.clearance ?? 0.1, joint.thickness);
    const a = (joint.width + c) / 2, b = (joint.thickness + c) / 2;
    return Array.from({ length: joint.count }, (_, i) => {
      const m = along((i + 0.5) / joint.count);
      return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([u, v]) => [m[0] + u * dir[0] + v * nrm[0] + 0, m[1] + u * dir[1] + v * nrm[1] + 0]);
    });
  }
  const c = clearanceFor("matchingSlots", o.clearance ?? 0, joint.thickness);
  return joint.at.map((f) => sheetHole({ d: JOINERY_SCREWS[joint.screw].hole + c, at: along(f) }));
}

// A hole for a printed tongue, and the tongue itself, from ONE spec. The slot is a
// CCW (w + c) × (h + c) rectangle centred at the origin (w along x) — all the play is
// on the slot; the tongue [w, h, thickness] is k.box({ size: tongue }) (centred in XY,
// base at z = 0).
export function printedTab(opts) {
  const o = checkOptions("printedTab", opts, ["size", "thickness", "clearance"], "printedTab({ size: [w, h], thickness, clearance })");
  if (!Array.isArray(o.size) || o.size.length !== 2 || !o.size.every((v) => isNum(v) && v > 0))
    throw new Error(`printedTab: size must be two numbers > 0 (mm), got ${JSON.stringify(o.size)}`);
  const thickness = positive("printedTab", "thickness", o.thickness);
  const c = clearanceFor("printedTab", o.clearance ?? 0.3, thickness);
  const [w, h] = o.size, a = (w + c) / 2, b = (h + c) / 2;
  return { slot: [[-a, -b], [a, -b], [a, b], [-a, b]], tongue: [w, h, thickness] };
}

// An arc-exact round hole: a CCW circle of diameter d as two three-point arcs — the
// contour circleProfile(d / 2, at) returns, named by diameter. Prefer either to
// circlePolygon (a 48-gon) on a sheet part — the cut file keeps a true circle.
export function sheetHole(opts) {
  const o = checkOptions("sheetHole", opts, ["d", "at"], "sheetHole({ d, at: [x, y] })");
  if (!isNum(o.d) || o.d <= 0) throw new Error(`sheetHole: d must be a number > 0 (mm), got ${JSON.stringify(o.d)}`);
  if (!isPt(o.at)) throw new Error("sheetHole: at must be a finite [x, y]");
  const r = o.d / 2, [x, y] = o.at;
  return { start: [x + r, y], segments: [{ to: [x - r, y], via: [x, y + r] }, { to: [x + r, y], via: [x, y - r] }] };
}

// --- the five-panel box ------------------------------------------------------------

// An open-top finger-jointed box, W × D × H outside (bottom included). Every outline is
// in its own drawing frame, seen from OUTSIDE, with [0, 0] at the box's outer corner
// named by its pose's `at` and bbox [0, 0]–size. Joints: front/back vertical edges
// outer, left/right vertical edges inner, wall bottom edges outer, all four bottom
// edges inner, top edges plain — so every corner cube has exactly one owner.
export function fingerBox(opts) {
  const o = checkOptions("fingerBox", opts, ["width", "depth", "height", "thickness", "clearance", "finger"], "fingerBox({ width, depth, height, thickness, clearance, finger })");
  const W = positive("fingerBox", "width", o.width);
  const D = positive("fingerBox", "depth", o.depth);
  const H = positive("fingerBox", "height", o.height);
  const t = positive("fingerBox", "thickness", o.thickness);
  const outer = fingers({ thickness: t, clearance: o.clearance ?? 0.1, finger: o.finger ?? 2 * t, side: "outer" });
  const inner = { ...outer, side: "inner" };
  const panel = (name, width, height, edges, [dx, dy], pose) => {
    let built;
    try { built = sheetPanel({ width, height, edges }); }
    catch (e) { throw new Error(`fingerBox: the ${name} panel — ${e.message}`, { cause: e }); }
    return { outline: built.outline.map(([x, y]) => [x + dx + 0, y + dy + 0]), size: built.size, pose };
  };
  const wall = { bottom: outer, right: outer, left: outer };
  const side = { bottom: outer, right: inner, left: inner };
  return {
    bottom: panel("bottom", W, D, { bottom: inner, right: inner, top: inner, left: inner }, [0, 0],
      { face: "-Z", up: "+Y", at: [W / 2, -D / 2, 0] }),
    front: panel("front", W - 2 * t, H - t, wall, [t, t], { face: "-Y", up: "+Z", at: [-W / 2, -D / 2, 0] }),
    back: panel("back", W - 2 * t, H - t, wall, [t, t], { face: "+Y", up: "+Z", at: [W / 2, D / 2, 0] }),
    left: panel("left", D, H - t, side, [0, t], { face: "-X", up: "+Z", at: [-W / 2, D / 2, 0] }),
    right: panel("right", D, H - t, side, [0, t], { face: "+X", up: "+Z", at: [W / 2, -D / 2, 0] }),
  };
}
