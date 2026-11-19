// The Cage: a coarse, closed quad mesh an author box-models from a box start with
// extrude / move / scale, read back by face id, and hands to k.subdiv as snapshot().
// Plain JavaScript, no kernel: every method changes the cage in place or throws a
// `cage: ` error naming the problem, and every change leaves the mesh closed.
//
// Storage: `points` is a growing list of [x, y, z] shared between faces (a move or scale
// changes a shared point once); `faces` maps id → four point indices, counter-clockwise
// seen from outside; `removed` maps an extruded face's id → the ids that replaced it.
//
// Face ids:
//   box faces   `${side}:${i},${j}`; ±x: i indexes Y, j indexes Z; ±y: i X, j Z;
//               ±z: i X, j Y. Indices rise with the coordinate.
//   one face    cap `${id}` (default: the face's id + ">"), sides `${id}.s0` … `.s3`.
//   a region    caps `${id}:0`, `${id}:1`, … in the order listed (default id: the first
//               face's id + ">"), sides `${id}.s0` … one per boundary edge.
//   steps = n   segment m (1-based from the base) names its sides `${id}.${m}.sK`; the
//               last segment drops the `.${m}`. Only the last ring is a cap.
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

export const MAX_CAGE_FACES = 2000;

const MIN_EDGE = 1e-6;
const TIE_EPS = 1e-9;
const MIRRORS = ["yz", "xz", "xy"];   // index = the axis reflected
const CAGES = new WeakSet();

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
  const segs = box.segs ?? [1, 1, 1];
  if (!Array.isArray(segs) || segs.length !== 3 || !segs.every((s) => Number.isInteger(s) && s > 0))
    fail(`box.segs must be three positive integers, not ${JSON.stringify(segs)}`);
  const total = 2 * (segs[0] * segs[1] + segs[1] * segs[2] + segs[0] * segs[2]);
  if (total > MAX_CAGE_FACES) fail(`box.segs make ${total} faces, more than MAX_CAGE_FACES (${MAX_CAGE_FACES})`);
  const ax = mirror === undefined ? -1 : MIRRORS.indexOf(mirror);
  if (ax >= 0 && segs[ax] % 2 !== 0)
    fail(`mirror "${mirror}" needs an even box.segs count across the plane, not ${segs[ax]}`);

  const state = { points: [], faces: new Map(), removed: new Map(), ax, plane: ax >= 0 ? center[ax] : 0,
    twin: [], half: [] };

  // Box lattice points on the surface, shared by key.
  const lattice = new Map();
  const latticePoint = (idx) => {
    const key = idx.join(",");
    if (!lattice.has(key)) {
      lattice.set(key, state.points.length);
      state.points.push(idx.map((t, a) => center[a] - box.size[a] / 2 + (box.size[a] * t) / segs[a]));
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

  const cage = makeCage(state);
  CAGES.add(cage);
  return cage;
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
  return CAGES.has(value);
}

function makeCage(state) {
  const { points, faces, removed, ax, plane, twin, half } = state;
  const mirrored = ax >= 0;
  const reflect = (p) => reflectPoint(p, ax, plane);
  const twinId = (id) => (id.endsWith("~") ? id.slice(0, -1) : `${id}~`);

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
    const ids = faceList(face);
    const region = Array.isArray(face);
    const { by, scale = 1, steps = 1, id } = opts;
    if (id !== undefined && (typeof id !== "string" || id === "")) fail("extrude id must be a non-empty string");
    if (id !== undefined && id.includes("~")) fail(`extrude id may not contain "~" (it marks reflected faces): "${id}"`);
    if (id !== undefined) assertFreeFamily(id);
    if (!Number.isInteger(steps) || steps < 1) fail(`extrude steps must be an integer >= 1, not ${JSON.stringify(steps)}`);
    if (!(isNum(by) || isVec3(by))) fail(`extrude by must be a finite number or [x, y, z], not ${JSON.stringify(by)}`);
    if ((isNum(by) ? Math.abs(by) : len(by)) === 0) fail("extrude by has zero length");
    const s = vec3Scale(scale, "extrude scale");

    // A region touching the plane extrudes joined with its reflection; any other mirrored
    // region extrudes alone and is then copied across.
    const joined = mirrored && touchesPlane(ids);
    const all = joined ? [...ids, ...ids.map(twinId)] : ids;
    const loop = boundaryLoop(all);
    const nsum = all.reduce((n, f) => add(n, newell(ptsOf(faces.get(f)))), [0, 0, 0]);
    if (isNum(by) && len(nsum) === 0)
      fail("extrude by is a number, but the faces' normal sums to zero length; give by as [x, y, z]");
    const normal = unit(nsum);
    const offset = isNum(by) ? normal.map((x) => x * by) : by.slice();

    // Cap positions: every region point moved by `offset`, then scaled about their mean.
    // Joined: computed for the positive half and the plane, then reflected.
    const regionPts = uniquePoints(all);
    const near = joined ? regionPts.filter((p) => half[p] >= 0) : regionPts;
    const moved = new Map(near.map((p) => [p, add(points[p], offset)]));
    let about = mean(joined ? regionPts.map((p) => moved.get(p) ?? reflect(moved.get(twin[p]))) : [...moved.values()]);
    if (joined) { about = about.slice(); about[ax] = plane; }
    let capPos = new Map([...moved].map(([p, q]) => [p, add(about, mul(sub(q, about), s))]));
    if (joined) capPos = withMirror(capPos);
    const capFaces = all.map((f) => faces.get(f));
    if (shortEdge(capFaces, (p) => capPos.get(p)))
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
      const at = (p) => (m === steps ? capPos.get(p).slice() : lerp(points[p], capPos.get(p), m / steps));
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

  function move(face, offset) {
    const ids = faceList(face);
    if (!isVec3(offset)) fail(`move offset must be [x, y, z] finite numbers, not ${JSON.stringify(offset)}`);
    const next = withMirror(new Map(uniquePoints(ids).map((p) => [p, add(points[p], offset)])));
    for (const [p, q] of next) points[p] = q;
  }

  function scale(face, s, opts = {}) {
    const ids = faceList(face);
    const f = vec3Scale(s, "scale");
    const pts = uniquePoints(ids);
    // A region touching the plane scales about its joined region's mean, on the plane.
    const joined = mirrored && touchesPlane(ids);
    let about = opts.about;
    if (about === undefined && joined) {
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
    return {
      points: live.map((p) => noNegZero(points[p])),
      faces: [...faces.values()].map((v) => v.map((p) => remap.get(p))),
      ids: [...faces.keys()],
    };
  }

  function bounds() {
    const live = livePoints().map((p) => points[p]);
    const min = [0, 1, 2].map((a) => Math.min(...live.map((p) => p[a])));
    const max = [0, 1, 2].map((a) => Math.max(...live.map((p) => p[a])));
    return { min: noNegZero(min), max: noNegZero(max) };
  }

  return Object.freeze({
    extrude,
    move,
    scale,
    centroid: (id) => noNegZero(mean(ptsOf(resolve(id)))),
    normal: (id) => noNegZero(unit(newell(ptsOf(resolve(id))))),
    size,
    faces: (prefix = "") => [...faces.keys()].filter((id) => id.startsWith(prefix)),
    bounds,
    snapshot,
  });
}
