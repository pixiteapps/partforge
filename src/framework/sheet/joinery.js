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

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

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

// --- panels ----------------------------------------------------------------------

const EDGE_NAMES = ["bottom", "right", "top", "left"];
const isJoint = (j) => isPlainObject(j) && j.joint === "fingers";
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
    return fingerPoints(j, f.L, head, tail);
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
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  return { outline, size: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
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
