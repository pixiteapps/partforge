// The Cage: a coarse, closed quad mesh an author box-models from a box start with
// extrude / move / scale / rotate, read back by face id, and hands to k.subdiv as snapshot().
// Plain JavaScript, no kernel: every method changes the cage in place or throws a
// `cage: ` error naming the problem, and every change leaves the mesh closed.
//
// Storage: `points` is a growing list of [x, y, z] shared between faces (a move or scale
// changes a shared point once); `faces` maps id → four point indices, counter-clockwise
// seen from outside; `removed` maps an extruded face's id → the ids that replaced it.
//
// Creases: `creases` holds edges (point pairs) the surface keeps sharp. crease(face)
// marks the border of the face or region, crease(face, other) the edges two faces or
// regions share; the marks stay on those edges through later
// changes (an extruded face leaves its crease at the base of the extrusion), and an edge
// no face uses any more drops out of the snapshot.
//
// Box segments: an entry of box.segs is a count (even cuts) or a list of widths in mm that
// add up to the box's size on that axis (cuts where the widths end). Ids and the face
// count follow the number of segments either way; under a mirror the widths across the
// plane must read the same from both ends.
//
// Face ids:
//   box faces   `${side}:${i},${j}`; ±x: i indexes Y, j indexes Z; ±y: i X, j Z;
//               ±z: i X, j Y. Indices rise with the coordinate.
//   one face    cap `${id}` (default: the face's id + ">"), sides `${id}.s0` … `.s3`.
//   a region    caps `${id}:0`, `${id}:1`, … in the order listed (default id: the first
//               face's id + ">"), sides `${id}.s0` … one per boundary edge.
//   steps = n   segment m (1-based from the base) names its sides `${id}.${m}.sK`; the
//               last segment drops the `.${m}`. Only the last ring is a cap.
//   steps = [..] the same ids as steps = n for a list of n scales. Ring m is ring m - 1
//               moved by by / n and scaled about its own mean by entry m (a number or
//               [sx, sy, sz]); without a list, the rings run evenly from the base to the
//               cap that `scale` sizes. scale and a steps list together are an error.
//
// Reading ids back: faces(prefix, { facing, near }) keeps the faces whose normal is within
// 45° of `facing` ("+x" … "-z" or [x, y, z]) and orders them nearest `near` first, by face
// centroid. move(faces, distance) moves along the faces' summed normal, extrude's rule.
//
// Side order: side k sits on boundary edge k. Edge 0 is the edge whose midpoint is
// smallest on the first in-plane axis (the two world axes least aligned with the face's
// or region's normal, in x, y, z order); the rest follow counter-clockwise seen from
// outside. Tie-break (a tilted face can give two edges the same midpoint value on the
// first axis, within 1e-9 mm): the smaller midpoint on the second in-plane axis wins,
// then the edge met first in the stored walk.
//
// Mirror (`"yz"` reflects X, `"xz"` Y, `"xy"` Z, through the box center): the cage stays
// whole and closed, and every point has a twin (`twin`, itself on the plane) and a half
// (`half`: 1 positive, -1 far, 0 on the plane). Far-side faces are named after their
// positive twin plus `~`: the far box side's faces, the far half of each side the plane
// cuts, and every face a change makes there. Changing methods take positive ids only and
// apply to those faces and their reflections at once: the far points are set to the
// reflection of their twins, and a point on the plane keeps only the in-plane part of its
// change. A region sharing an edge with its own reflection extrudes as one region with
// it, so no wall is left on the plane; its sides are numbered from the positive edge that
// leaves the plane, counter-clockwise seen from outside, and the far ones carry `~`.

import { readSkinArgs, skinWeights, applySkin } from "./skin.js";

export const MAX_CAGE_FACES = 2000;

const MIN_EDGE = 1e-6;
const TIE_EPS = 1e-9;
// A normal sum shorter than this times the region's squared size (its bounding-box
// diagonal, squared) is rounding noise, not a direction.
const ZERO_NORMAL_REL = 1e-9;
const MIRRORS = ["yz", "xz", "xy"];   // index = the axis reflected
// A cage is known by this plain-data mark alone, never by identity (a WeakSet, instanceof):
// a host may hold two copies of this module, and a cage one copy made (`cage` from
// partforge/organic) must still be a cage to the other (the kernel's k.subdiv).
const CAGE_KIND = "partforge-cage";

const fail = (msg) => { throw new Error(`cage: ${msg}`); };
const noNegZero = (v) => v.map((x) => x + 0);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s[0], a[1] * s[1], a[2] * s[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mean = (pts) => {
  const s = pts.reduce((acc, p) => add(acc, p), [0, 0, 0]);
  return s.map((x) => x / pts.length);
};
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

// A number s means [s, s, s].
function vec3Scale(s, what) {
  if (isNum(s)) return [s, s, s];
  if (isVec3(s)) return s.slice();
  return fail(`${what} must be a finite number or [sx, sy, sz]`);
}

// Newell's normal of a polygon (sum over its edges), unnormalized.
function newell(pts) {
  const n = [0, 0, 0];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}
const unit = (n) => { const l = len(n); return l > 0 ? n.map((x) => x / l) : [0, 0, 0]; };

// The two world axes least aligned with n, in x, y, z order.
function inPlaneAxes(n) {
  const [a, b] = [0, 1, 2].sort((p, q) => Math.abs(n[p]) - Math.abs(n[q]) || p - q);
  return a < b ? [a, b] : [b, a];
}

// Index of edge 0 in a closed loop of positions (edge k runs loop[k] → loop[k + 1]).
function firstEdge(loop, n) {
  const [u, v] = inPlaneAxes(n);
  let best = 0, bu = Infinity, bv = Infinity;
  for (let k = 0; k < loop.length; k++) {
    const m = lerp(loop[k], loop[(k + 1) % loop.length], 0.5);
    if (m[u] < bu - TIE_EPS || (Math.abs(m[u] - bu) <= TIE_EPS && m[v] < bv - TIE_EPS)) {
      best = k; bu = m[u]; bv = m[v];
    }
  }
  return best;
}

const SIDES = [
  // side, fixed axis, sign, [i axis, j axis]
  ["+x", 0, 1, [1, 2]], ["-x", 0, -1, [1, 2]],
  ["+y", 1, 1, [0, 2]], ["-y", 1, -1, [0, 2]],
  ["+z", 2, 1, [0, 1]], ["-z", 2, -1, [0, 1]],
];

export function createCage(spec) {
  const { box, mirror } = spec ?? {};
  if (mirror !== undefined && !MIRRORS.includes(mirror))
    fail(`mirror must be "yz", "xz" or "xy", not ${JSON.stringify(mirror)}`);
  if (!box || typeof box !== "object") fail("createCage needs { box: { size, center?, segs? } }");
  if (!isVec3(box.size) || !box.size.every((x) => x > 0)) fail("box.size must be three positive finite numbers");
  const center = box.center ?? [0, 0, 0];
  if (!isVec3(center)) fail("box.center must be three finite numbers");
  const given = box.segs ?? [1, 1, 1];
  if (!Array.isArray(given) || given.length !== 3)
    fail(`box.segs must be three entries, each a positive integer or a list of widths, not ${JSON.stringify(given)}`);
  // Each axis: a count, and where its cuts fall (mm from the box's low side). A count n
  // cuts evenly; a list of widths cuts where the widths end, and must add up to the size.
  const segs = [], cutAt = [];
  given.forEach((s, a) => {
    if (Number.isInteger(s) && s > 0) {
      segs.push(s);
      cutAt.push((t) => (box.size[a] * t) / s);
      return;
    }
    if (!Array.isArray(s) || s.length === 0 || !s.every((w) => isNum(w) && w > 0))
      fail(`box.segs[${a}] must be a positive integer or a list of positive widths (mm), not ${JSON.stringify(s)}`);
    const sum = s.reduce((acc, w) => acc + w, 0);
    if (Math.abs(sum - box.size[a]) > 1e-9 * box.size[a])
      fail(`box.segs[${a}] widths add up to ${sum}, not the box's size ${box.size[a]}`);
    const cuts = [0];
    for (const w of s) cuts.push(cuts[cuts.length - 1] + w);
    cuts[s.length] = box.size[a];
    segs.push(s.length);
    cutAt.push((t) => cuts[t]);
  });
  const total = 2 * (segs[0] * segs[1] + segs[1] * segs[2] + segs[0] * segs[2]);
  if (total > MAX_CAGE_FACES) fail(`box.segs make ${total} faces, more than MAX_CAGE_FACES (${MAX_CAGE_FACES})`);
  const ax = mirror === undefined ? -1 : MIRRORS.indexOf(mirror);
  if (ax >= 0 && segs[ax] % 2 !== 0)
    fail(`mirror "${mirror}" needs an even box.segs count across the plane, not ${segs[ax]}`);
  if (ax >= 0 && Array.isArray(given[ax])) {
    const w = given[ax];
    if (w.some((x, i) => Math.abs(x - w[w.length - 1 - i]) > 1e-9 * box.size[ax]))
      fail(`mirror "${mirror}" needs box.segs[${ax}] widths that read the same from both ends`);
  }

  const state = { points: [], faces: new Map(), removed: new Map(), ax, plane: ax >= 0 ? center[ax] : 0,
    twin: [], half: [], creases: new Set() };

  // Box lattice points on the surface, shared by key.
  const lattice = new Map();
  const latticePoint = (idx) => {
    const key = idx.join(",");
    if (!lattice.has(key)) {
      lattice.set(key, state.points.length);
      state.points.push(idx.map((t, a) => center[a] - box.size[a] / 2 + cutAt[a](t)));
    }
    return lattice.get(key);
  };
  for (const [side, axis, sign, [ia, ja]] of SIDES) {
    // Corners (i, j) → (i+1, j) → (i+1, j+1) → (i, j+1) are counter-clockwise about
    // e_ia × e_ja; reverse them when that points inward.
    const cross = [0, 0, 0];
    cross[3 - ia - ja] = ia === 0 && ja === 1 ? 1 : ia === 1 && ja === 2 ? 1 : -1;
    const forward = cross[axis] * sign > 0;
    for (let i = 0; i < segs[ia]; i++) for (let j = 0; j < segs[ja]; j++) {
      const corner = (di, dj) => {
        const idx = [0, 0, 0];
        idx[axis] = sign > 0 ? segs[axis] : 0;
        idx[ia] = i + di; idx[ja] = j + dj;
        return latticePoint(idx);
      };
      const quad = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
      state.faces.set(boxFaceId(side, axis, sign, ia, i, j, ax, segs), forward ? quad : quad.reverse());
    }
  }
  if (ax >= 0) {
    // Pair lattice points across the plane; set the far ones from their twins so the
    // cage starts exactly symmetric.
    for (const [key, p] of lattice) {
      const idx = key.split(",").map(Number);
      const t = idx.slice();
      t[ax] = segs[ax] - idx[ax];
      state.twin[p] = lattice.get(t.join(","));
      state.half[p] = Math.sign(2 * idx[ax] - segs[ax]);
    }
    for (const p of lattice.values()) {
      if (state.half[p] === 0) state.points[p][ax] = state.plane;
      if (state.half[p] < 0) state.points[p] = reflectPoint(state.points[state.twin[p]], ax, state.plane);
    }
  }

  return makeCage(state);
}

// A box face's id; with a mirror, a far-side face takes its positive twin's id plus `~`.
function boxFaceId(side, axis, sign, ia, i, j, ax, segs) {
  if (ax < 0) return `${side}:${i},${j}`;
  if (axis === ax) return sign > 0 ? `${side}:${i},${j}` : `+${side.slice(1)}:${i},${j}~`;
  const across = ia === ax ? i : j;
  if (2 * across >= segs[ax]) return `${side}:${i},${j}`;
  const t = segs[ax] - 1 - across;
  return ia === ax ? `${side}:${t},${j}~` : `${side}:${i},${t}~`;
}

function reflectPoint(p, ax, plane) {
  const q = p.slice();
  q[ax] = 2 * plane - p[ax];
  return q;
}

export function isCage(value) {
  return value != null && typeof value === "object" && value.kind === CAGE_KIND && typeof value.snapshot === "function";
}

function makeCage(state) {
  const { points, faces, removed, ax, plane, twin, half, creases } = state;
  const mirrored = ax >= 0;
  const reflect = (p) => reflectPoint(p, ax, plane);
  const twinId = (id) => (id.endsWith("~") ? id.slice(0, -1) : `${id}~`);
  // skin is the last change to a cage: its weights were worked out from the rest cage, so
  // a change after it would leave them describing a cage that no longer exists.
  let skinned = false;
  const unlocked = (op) => { if (skinned) fail(`${op} after skin — skin is the last change to a cage`); };

  function resolve(id) {
    if (typeof id !== "string") fail(`a face is named by its id string, not ${JSON.stringify(id)}`);
    const verts = faces.get(id);
    if (verts) return verts;
    if (removed.has(id)) fail(`face "${id}" was extruded; it is now ${removed.get(id).join(", ")}`);
    const common = (s) => { let k = 0; while (k < s.length && k < id.length && s[k] === id[k]) k++; return k; };
    const near = [...faces.keys()].map((s) => [s, common(s)]).filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s);
    return fail(`no face "${id}"${near.length ? `; nearest: ${near.join(", ")}` : ""}`);
  }
  const ptsOf = (verts) => verts.map((i) => points[i]);
  // The faces a changing method names: positive-side ids only.
  const faceList = (face) => {
    const ids = Array.isArray(face) ? face : [face];
    if (ids.length === 0) fail("no faces named");
    for (const id of ids) {
      if (mirrored && typeof id === "string" && id.endsWith("~"))
        fail(`face "${id}" is a reflected face; change "${twinId(id)}" and the mirror follows`);
      resolve(id);
    }
    if (new Set(ids).size !== ids.length) fail(`a face is named twice in [${ids.join(", ")}]`);
    return ids;
  };
  const uniquePoints = (ids) => [...new Set(ids.flatMap((id) => faces.get(id)))];
  // The bounding-box diagonal of the faces' points.
  const regionSpan = (ids) => {
    const pts = uniquePoints(ids).map((p) => points[p]);
    return len([0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])) - Math.min(...pts.map((p) => p[a]))));
  };
  const shortEdge = (vertsList, pos) => vertsList.some((v) =>
    v.some((a, k) => len(sub(pos(a), pos(v[(k + 1) % 4]))) < MIN_EDGE));
  const assertFreeId = (id) => {
    if (faces.has(id) || removed.has(id)) fail(`id "${id}" is already in use`);
  };
  // An author's id may not reuse an existing id or name a family one already heads.
  const assertFreeFamily = (id) => {
    for (const used of [...faces.keys(), ...removed.keys()])
      if (used === id || used.startsWith(`${id}:`) || used.startsWith(`${id}.`))
        fail(`id "${id}" is already in use (by "${used}")`);
  };
  // Does the region share an edge with its own reflection (so it touches the plane)?
  const touchesPlane = (ids) => {
    const own = new Set(ids.flatMap((f) => faces.get(f).map((a, k, v) => `${a}>${v[(k + 1) % 4]}`)));
    return ids.some((f) => faces.get(twinId(f)).some((a, k, v) => own.has(`${v[(k + 1) % 4]}>${a}`)));
  };
  const pushPoint = (pos, h) => {
    points.push(pos);
    if (mirrored) { half.push(h); twin.push(points.length - 1); }
    return points.length - 1;
  };
  const pair = (p, q) => { twin[p] = q; twin[q] = p; };

  // New positions for positive-side points → the same map with their twins added: a far
  // twin is the reflection, a point on the plane keeps only its in-plane change.
  function withMirror(next) {
    if (!mirrored) return next;
    const all = new Map(next);
    for (const [p, q] of next) {
      if (half[p] === 0) { const r = q.slice(); r[ax] = plane; all.set(p, r); }
      else all.set(twin[p], reflect(q));
    }
    return all;
  }

  function extrude(face, opts = {}) {
    unlocked("extrude");
    const ids = faceList(face);
    const region = Array.isArray(face);
    const { by, scale = 1, steps: stepsOpt = 1, id } = opts;
    if (id !== undefined && (typeof id !== "string" || id === "")) fail("extrude id must be a non-empty string");
    if (id !== undefined && id.includes("~")) fail(`extrude id may not contain "~" (it marks reflected faces): "${id}"`);
    if (id !== undefined) assertFreeFamily(id);
    // A steps list gives each ring its own scale; it is never read as one [sx, sy, sz].
    const list = Array.isArray(stepsOpt);
    if (list && opts.scale !== undefined) fail("extrude takes scale or a steps list, not both");
    if (list && stepsOpt.length === 0) fail("extrude steps list is empty; give one scale per step, or an integer >= 1");
    if (!list && (!Number.isInteger(stepsOpt) || stepsOpt < 1))
      fail(`extrude steps must be an integer >= 1 or a list of scales, not ${JSON.stringify(stepsOpt)}`);
    const stepScales = list ? stepsOpt.map((e, i) => vec3Scale(e, `extrude steps[${i}]`)) : null;
    const steps = list ? stepsOpt.length : stepsOpt;
    if (!(isNum(by) || isVec3(by))) fail(`extrude by must be a finite number or [x, y, z], not ${JSON.stringify(by)}`);
    if ((isNum(by) ? Math.abs(by) : len(by)) === 0) fail("extrude by has zero length");
    const s = vec3Scale(scale, "extrude scale");

    // A region touching the plane extrudes joined with its reflection; any other mirrored
    // region extrudes alone and is then copied across.
    const joined = mirrored && touchesPlane(ids);
    const all = joined ? [...ids, ...ids.map(twinId)] : ids;
    const loop = boundaryLoop(all);
    const nsum = all.reduce((n, f) => add(n, newell(ptsOf(faces.get(f)))), [0, 0, 0]);
    const span = regionSpan(all);
    if (isNum(by) && len(nsum) <= ZERO_NORMAL_REL * span * span)
      fail("extrude by is a number, but the faces' normal sums to zero length; give by as [x, y, z]");
    const normal = unit(nsum);
    const offset = isNum(by) ? normal.map((x) => x * by) : by.slice();

    // Cap positions: every region point moved by `offset`, then scaled about their mean.
    // Joined: computed for the positive half and the plane, then reflected.
    const regionPts = uniquePoints(all);
    const near = joined ? regionPts.filter((p) => half[p] >= 0) : regionPts;
    // `from` (region point → position) moved by `step`, then scaled by `f` about the moved
    // points' mean (joined: the whole joined region's mean, held on the plane).
    const ringFrom = (from, step, f) => {
      const moved = new Map(near.map((p) => [p, add(from(p), step)]));
      let about = mean(joined ? regionPts.map((p) => moved.get(p) ?? reflect(moved.get(twin[p]))) : [...moved.values()]);
      if (joined) { about = about.slice(); about[ax] = plane; }
      const out = new Map([...moved].map(([p, q]) => [p, add(about, mul(sub(q, about), f))]));
      return joined ? withMirror(out) : out;
    };
    const capFaces = all.map((f) => faces.get(f));
    // With a steps list each ring is the one before it, moved one step and scaled by its
    // own entry; the interior points ride along so the cap ring carries them.
    const ringPos = [];
    if (list) {
      const step = offset.map((x) => x / steps);
      let from = (p) => points[p];
      for (let m = 1; m <= steps; m++) {
        const r = ringFrom(from, step, stepScales[m - 1]);
        if (shortEdge(capFaces, (p) => r.get(p)))
          fail(`extrude steps[${m - 1}] ${JSON.stringify(stepsOpt[m - 1])} makes a ring edge shorter than ${MIN_EDGE} mm; use a larger scale for that step`);
        ringPos[m] = r;
        from = (p) => r.get(p);
      }
    }
    const capPos = list ? ringPos[steps] : ringFrom((p) => points[p], offset, s);
    if (!list && shortEdge(capFaces, (p) => capPos.get(p)))
      fail(`extrude scale ${JSON.stringify(scale)} makes a cap edge shorter than ${MIN_EDGE} mm`);

    const base = id ?? `${ids[0]}>`;
    const capIds = region ? ids.map((_, k) => `${base}:${k}`) : [base];
    const sideId = (m, k) => (m === steps ? `${base}.s${k}` : `${base}.${m}.s${k}`);
    const edges = joined ? joinedSides(loop) : orderedSides(loop, normal);
    const sideIds = [];
    for (let m = 1; m <= steps; m++) for (const { k } of edges) sideIds.push(sideId(m, k));
    const newIds = [...capIds, ...sideIds];
    const copies = mirrored && !joined;
    const farIds = copies ? newIds.map(twinId) : joined ? capIds.map(twinId) : [];
    for (const nid of [...newIds, ...farIds]) assertFreeId(nid);
    const count = faces.size + (copies ? 2 : 1) * (newIds.length - ids.length);
    if (count > MAX_CAGE_FACES) fail(`extrude makes ${count} faces, more than MAX_CAGE_FACES (${MAX_CAGE_FACES})`);

    // Valid: commit. Rings 1 … steps on the boundary; the cap ring also covers the interior.
    const firstNew = points.length;
    const ring = [new Map(loop.map((p) => [p, p]))];
    for (let m = 1; m <= steps; m++) {
      const r = new Map();
      const srcs = m === steps ? regionPts : loop;
      const at = (p) => (m === steps ? capPos.get(p).slice()
        : list ? ringPos[m].get(p).slice() : lerp(points[p], capPos.get(p), m / steps));
      for (const p of srcs) {
        if (joined && half[p] < 0) continue;
        const pos = at(p);
        if (joined && half[p] === 0) pos[ax] = plane;
        r.set(p, pushPoint(pos, joined ? half[p] : 1));
      }
      if (joined) for (const p of srcs) if (half[p] < 0) {
        const q = r.get(twin[p]);
        r.set(p, pushPoint(reflect(points[q]), -1));
        pair(q, r.get(p));
      }
      ring.push(r);
    }
    const capOf = (f) => faces.get(f).map((p) => ring[steps].get(p));
    const made = [];   // [id, verts] of every new positive face, for the copy across
    all.forEach((f, i) => {
      const k = i % ids.length;
      const capId = i < ids.length ? capIds[k] : twinId(capIds[k]);
      const verts = capOf(f);
      faces.delete(f);
      removed.set(f, [capId]);
      faces.set(capId, verts);
      made.push([capId, verts]);
    });
    for (let m = 1; m <= steps; m++) for (const { a, b, k } of edges) {
      const lo = ring[m - 1], hi = ring[m];
      const sid = sideId(m, k);
      const verts = [lo.get(a), lo.get(b), hi.get(b), hi.get(a)];
      faces.set(sid, verts);
      made.push([sid, verts]);
    }
    if (copies) {
      const last = points.length;
      for (let q = firstNew; q < last; q++) pair(q, pushPoint(reflect(points[q]), -1));
      ids.forEach((f) => { removed.set(twinId(f), [twinId(removed.get(f)[0])]); faces.delete(twinId(f)); });
      for (const [fid, [a, b, c, d]] of made) faces.set(twinId(fid), [twin[a], twin[d], twin[c], twin[b]]);
    }
    return region ? capIds : capIds[0];
  }

  // Boundary edges in side order (Task 1's rule), numbered 0 … n-1.
  function orderedSides(loop, n) {
    const k0 = firstEdge(ptsOf(loop), n);
    return loop.map((_, k) => ({ a: loop[(k0 + k) % loop.length], b: loop[(k0 + k + 1) % loop.length], k }));
  }

  // A joined region's boundary: positive edges numbered counter-clockwise from the one
  // that leaves the plane; each far edge takes its twin's number plus `~`.
  function joinedSides(loop) {
    const n = loop.length;
    const start = loop.findIndex((p, i) => half[p] === 0 && half[loop[(i + 1) % n]] > 0);
    if (start < 0) fail("a region touching the mirror plane has no boundary edge leaving it");
    const edges = loop.map((_, i) => ({ a: loop[(start + i) % n], b: loop[(start + i + 1) % n] }));
    const number = new Map();
    for (const e of edges) if (half[e.a] > 0 || half[e.b] > 0) number.set(`${e.a}>${e.b}`, number.size);
    return edges.map((e) => {
      if (number.has(`${e.a}>${e.b}`)) return { ...e, k: `${number.get(`${e.a}>${e.b}`)}` };
      const k = number.get(`${twin[e.b]}>${twin[e.a]}`);
      if (k === undefined) fail("a region touching the mirror plane has a boundary edge on the plane");
      return { ...e, k: `${k}~` };
    });
  }

  // The region's boundary as one counter-clockwise loop of point indices (seen from
  // outside, the faces' own winding). Throws for a region that is not edge-connected,
  // whose boundary pinches at a point, or that has more than one boundary (a hole).
  function boundaryLoop(ids) {
    const edgeKey = (a, b) => `${a}>${b}`;
    const owner = new Map();
    ids.forEach((f, fi) => faces.get(f).forEach((a, k, v) => owner.set(edgeKey(a, v[(k + 1) % 4]), fi)));
    const next = new Map();
    const seen = new Set([0]);
    const queue = [0];
    while (queue.length) {
      const fi = queue.pop();
      const v = faces.get(ids[fi]);
      for (let k = 0; k < 4; k++) {
        const a = v[k], b = v[(k + 1) % 4];
        const twin = owner.get(edgeKey(b, a));
        if (twin === undefined) {
          if (next.has(a)) fail(`region [${ids.join(", ")}] has a boundary that touches itself at a point`);
          next.set(a, b);
        } else if (!seen.has(twin)) { seen.add(twin); queue.push(twin); }
      }
    }
    if (seen.size !== ids.length) fail(`region [${ids.join(", ")}] is not edge-connected`);
    if (next.size === 0) fail(`region [${ids.join(", ")}] has no boundary`);
    const start = next.keys().next().value;
    const loop = [start];
    for (let p = next.get(start); p !== start; p = next.get(p)) loop.push(p);
    if (loop.length !== next.size) fail(`region [${ids.join(", ")}] has a hole; extrude it in pieces`);
    return loop;
  }

  // A number moves along the faces' summed normal, by extrude's rule for a number `by`
  // (a region touching the mirror plane is taken joined with its reflection).
  function move(face, offset) {
    unlocked("move");
    const ids = faceList(face);
    if (!(isNum(offset) || isVec3(offset)))
      fail(`move offset must be a finite number or [x, y, z] finite numbers, not ${JSON.stringify(offset)}`);
    let delta = offset;
    if (isNum(offset)) {
      const all = mirrored && touchesPlane(ids) ? [...ids, ...ids.map(twinId)] : ids;
      const nsum = all.reduce((n, f) => add(n, newell(ptsOf(faces.get(f)))), [0, 0, 0]);
      const span = regionSpan(all);
      if (len(nsum) <= ZERO_NORMAL_REL * span * span)
        fail("move by a number, but the faces' normal sums to zero length; give [x, y, z]");
      delta = unit(nsum).map((x) => x * offset);
    }
    const next = withMirror(new Map(uniquePoints(ids).map((p) => [p, add(points[p], delta)])));
    for (const [p, q] of next) points[p] = q;
  }

  function scale(face, s, opts = {}) {
    unlocked("scale");
    const ids = faceList(face);
    const f = vec3Scale(s, "scale");
    const pts = uniquePoints(ids);
    // A region touching the plane scales about its joined region's mean, on the plane.
    const joined = mirrored && touchesPlane(ids);
    let about = opts.about;
    if (about == null && joined) {
      about = mean(uniquePoints([...ids, ...ids.map(twinId)]).map((p) => points[p]));
      about[ax] = plane;
    }
    about ??= mean(pts.map((p) => points[p]));
    if (!isVec3(about)) fail("scale about must be [x, y, z] finite numbers");
    const next = withMirror(new Map(pts.map((p) => [p, add(about, mul(sub(points[p], about), f))])));
    // Every face touching a scaled point, so a neighbour's edge is checked too.
    const touched = [...faces.values()].filter((v) => v.some((p) => next.has(p)));
    if (shortEdge(touched, (p) => next.get(p) ?? points[p]))
      fail(`scale ${JSON.stringify(s)} makes an edge shorter than ${MIN_EDGE} mm`);
    for (const [p, q] of next) points[p] = q;
  }

  // Turn the faces' points by `deg` about the line through `about` along `axis`
  // (right-handed: a positive angle about +X turns +Y toward +Z).
  const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  function rotate(face, opts = {}) {
    unlocked("rotate");
    const ids = faceList(face);
    const { axis, deg } = opts;
    const dir = typeof axis === "string" ? AXES[axis] : axis;
    if (!isVec3(dir) || !(Math.hypot(...dir) > 0))
      fail(`rotate axis must be "x", "y", "z" or a non-zero [x, y, z], not ${JSON.stringify(axis)}`);
    if (!Number.isFinite(deg)) fail(`rotate deg must be a finite number, not ${JSON.stringify(deg)}`);
    const pts = uniquePoints(ids);
    const about = opts.about ?? mean(pts.map((p) => points[p]));
    if (!isVec3(about)) fail("rotate about must be [x, y, z] finite numbers");
    const u = unit(dir);
    const t = ((deg % 360) * Math.PI) / 180, co = Math.cos(t), si = Math.sin(t);
    const turn = (q) => {
      const v = sub(q, about);
      const along = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const across = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      return add(about, [0, 1, 2].map((i) => v[i] * co + across[i] * si + u[i] * along * (1 - co)));
    };
    const next = withMirror(new Map(pts.map((p) => [p, turn(points[p])])));
    const touched = [...faces.values()].filter((v) => v.some((p) => next.has(p)));
    if (shortEdge(touched, (p) => next.get(p) ?? points[p]))
      fail(`rotate ${JSON.stringify(deg)} makes an edge shorter than ${MIN_EDGE} mm`);
    for (const [p, q] of next) points[p] = q;
  }

  // Mark the border of the face or region as a hard edge. A region touching the mirror
  // plane is taken joined with its reflection, so no crease is left on the plane.
  const edgeKey = (a, b) => (a < b ? `${a}>${b}` : `${b}>${a}`);
  // crease(face, other) marks only the edges the two share; `other` may name reflected
  // faces, which is how a crease is laid along the mirror plane.
  function crease(face, other) {
    unlocked("crease");
    const ids = faceList(face);
    const directedOf = (list) => new Set(list.flatMap((f) => faces.get(f).map((a, k, v) => `${a}>${v[(k + 1) % 4]}`)));
    const border = [];
    if (other !== undefined) {
      const others = Array.isArray(other) ? other : [other];
      if (others.length === 0) fail("no faces named");
      for (const id of others) resolve(id);
      const far = directedOf(others);
      for (const f of ids) faces.get(f).forEach((a, k, v) => {
        const b = v[(k + 1) % 4];
        if (far.has(`${b}>${a}`)) border.push([a, b]);
      });
      if (border.length === 0) fail(`[${ids.join(", ")}] and [${others.join(", ")}] share no edge`);
    } else {
      const all = mirrored && touchesPlane(ids) ? [...ids, ...ids.map(twinId)] : ids;
      const directed = directedOf(all);
      for (const f of all) faces.get(f).forEach((a, k, v) => {
        const b = v[(k + 1) % 4];
        if (!directed.has(`${b}>${a}`)) border.push([a, b]);
      });
      if (border.length === 0) fail(`[${ids.join(", ")}] has no border to crease`);
    }
    for (const [a, b] of border) {
      creases.add(edgeKey(a, b));
      if (mirrored) creases.add(edgeKey(twin[a], twin[b]));
    }
  }

  // The four edges in side order; u spans the first in-plane axis (edges 1 and 3),
  // v the second (edges 0 and 2).
  function size(id) {
    const loop = ptsOf(resolve(id));
    const k0 = firstEdge(loop, newell(loop));
    const edge = (k) => len(sub(loop[(k0 + k + 1) % 4], loop[(k0 + k) % 4]));
    return noNegZero([(edge(1) + edge(3)) / 2, (edge(0) + edge(2)) / 2]);
  }

  // Points some face still uses, in index order.
  const livePoints = () => [...new Set([...faces.values()].flat())].sort((a, b) => a - b);

  function snapshot() {
    const live = livePoints();
    const remap = new Map(live.map((p, i) => [p, i]));
    const snap = {
      points: live.map((p) => noNegZero(points[p])),
      faces: [...faces.values()].map((v) => v.map((p) => remap.get(p))),
      ids: [...faces.keys()],
    };
    if (creases.size) {
      // Only edges a face still uses, as sorted [low, high] point pairs.
      const used = new Set([...faces.values()].flatMap((v) => v.map((a, k) => edgeKey(a, v[(k + 1) % 4]))));
      const kept = [...creases].filter((key) => used.has(key))
        .map((key) => key.split(">").map((p) => remap.get(Number(p))).sort((a, b) => a - b))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      if (kept.length) snap.creases = kept;
    }
    return snap;
  }

  // Pose the cage from posed limbs (skin.js). Points move, faces never do, so the drag and
  // preview paths, which read only snapshot(), see a posed cage of the same shape. Every
  // read after this (centroid, normal, size, bounds, snapshot) returns posed values.
  function skin(limbs, options) {
    unlocked("skin");
    if (mirrored) throw new Error("skin: a mirrored cage cannot be skinned yet");
    const { bones, blend, set } = readSkinArgs(limbs, options);
    // The cage's own face check, so a face extruded away gets the cage's own error.
    for (const e of set) for (const id of e.faces) resolve(id);
    const live = livePoints();
    const rest = snapshot();
    const weights = skinWeights(rest, bones, { blend, set });
    const posed = applySkin(rest.points.map((_, i) => points[live[i]]), weights, bones);
    posed.forEach((q, i) => { points[live[i]] = q; });
    skinned = true;
    return JSON.parse(JSON.stringify(weights.report));
  }

  // A read, so it works after skin too. `facing` keeps faces whose normal is within 45° of
  // it; `near` orders the result by distance from each face's middle, nearest first.
  const FACINGS = { "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1] };
  function listFaces(prefix = "", opts = {}) {
    if (typeof prefix !== "string") fail(`faces prefix must be a string, not ${JSON.stringify(prefix)}`);
    if (opts === null || typeof opts !== "object" || Array.isArray(opts)) fail("faces options must be { facing?, near? }");
    for (const key of Object.keys(opts))
      if (key !== "facing" && key !== "near") fail(`faces has no option ${JSON.stringify(key)}`);
    const { facing, near } = opts;
    let dir;
    if (facing !== undefined) {
      dir = typeof facing === "string" ? FACINGS[facing] : isVec3(facing) && len(facing) > 0 ? unit(facing) : undefined;
      if (!dir) fail(`faces facing must be "+x", "-x", "+y", "-y", "+z", "-z" or a non-zero [x, y, z], not ${JSON.stringify(facing)}`);
    }
    if (near !== undefined && !isVec3(near)) fail("faces near must be [x, y, z] finite numbers");
    let out = [...faces.keys()].filter((id) => id.startsWith(prefix));
    if (dir) out = out.filter((id) => {
      const n = unit(newell(ptsOf(faces.get(id))));
      return n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] >= Math.SQRT1_2 - 1e-9;
    });
    if (near) {
      const dist = new Map(out.map((id) => [id, len(sub(mean(ptsOf(faces.get(id))), near))]));
      out = out.slice().sort((a, b) => dist.get(a) - dist.get(b));   // Array#sort is stable
    }
    return out;
  }

  function bounds() {
    const live = livePoints().map((p) => points[p]);
    const min = [0, 1, 2].map((a) => Math.min(...live.map((p) => p[a])));
    const max = [0, 1, 2].map((a) => Math.max(...live.map((p) => p[a])));
    return { min: noNegZero(min), max: noNegZero(max) };
  }

  return Object.freeze({
    kind: CAGE_KIND,
    extrude,
    move,
    scale,
    rotate,
    crease,
    skin,
    centroid: (id) => noNegZero(mean(ptsOf(resolve(id)))),
    normal: (id) => noNegZero(unit(newell(ptsOf(resolve(id))))),
    size,
    faces: listFaces,
    bounds,
    snapshot,
  });
}
