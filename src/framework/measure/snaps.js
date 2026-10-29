// Pure snap engine for measure mode: drawn edges -> corners + edge chains, and
// the per-hover ranking of snap candidates. No three.js — plain typed arrays,
// like feature-dims.js. Everything is in the delivered geometry's own frame.
//
// buildSnapIndex runs once per geometry (the caller caches it in a WeakMap
// keyed on the geometry); findSnap runs on every pointer move and touches only
// the corner hash cells near the hit and the chains of the hit feature.
//
//   SnapIndex  { corners: Float32Array xyz…, cornerGrid: Map<"ix,iy,iz", number[]>,
//                chains: Chain[], chainsByFeature: Map<featureId, Chain[]>, cellSize }
//   Chain      { points: number[3][], straight, length, mid: number[3]|null,
//                centroid: number[3], owners: number[] (named feature ids) }
//   SnapTarget { kind: "corner"|"midpoint"|"circle"|"edge"|"face"|"point",
//                point: number[3], featureId (0 when unnamed), chain?, circle? }
//
// Chains (and their points arrays) are shared by every target that names
// them: treat them as READ-ONLY. A `circle` target always carries
// `circle: { centre, axis (unit), radius }` — the rim the snap marker draws as
// a 48-point loop when no drawn chain matches it. `chain` rides a circle only
// when an owned chain's centroid lies within RIM_MATCH × radius of the chosen
// rim centre, so an undrawn rim never borrows the other rim's chain.

export const SNAP_PX = 12;
export const CURVE_TURN_DEG = 20;
export const COLLINEAR_TURN_DEG = 0.5;

const KEY_EPS = 1e-4;
const RIM_MATCH = 0.25; // × cylinder radius: how near a chain's centroid must sit to the rim centre
const CIRCLE_SAMPLES = 32;
const KIND_RANK = { corner: 0, midpoint: 1, circle: 2, edge: 3 };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const vkey = (x, y, z) => `${Math.round(x / KEY_EPS)},${Math.round(y / KEY_EPS)},${Math.round(z / KEY_EPS)}`;
const segKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Angle (degrees) between the incoming direction a->v and the outgoing v->b.
function turnDeg(a, v, b) {
  const d1 = sub(v, a), d2 = sub(b, v);
  const l = len(d1) * len(d2);
  if (l === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(d1, d2) / l))) * 180) / Math.PI;
}

// vertex key -> Set of named feature ids whose triangles touch it.
function vertexOwners(positions, indices, featureIds) {
  const owners = new Map();
  if (!positions || !featureIds) return owners;
  const indexed = indices && indices.length > 0;
  for (let t = 0; t < featureIds.length; t++) {
    const id = featureIds[t];
    if (!(id > 0)) continue;
    for (let v = 0; v < 3; v++) {
      const i = (indexed ? indices[t * 3 + v] : t * 3 + v) * 3;
      const k = vkey(positions[i], positions[i + 1], positions[i + 2]);
      let s = owners.get(k);
      if (!s) owners.set(k, (s = new Set()));
      s.add(id);
    }
  }
  return owners;
}

function bboxDiagonal(...arrays) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const arr of arrays) {
    if (!arr) continue;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        const x = arr[i + c];
        if (x < min[c]) min[c] = x;
        if (x > max[c]) max[c] = x;
      }
    }
  }
  return min[0] === Infinity ? 0 : len(sub(max, min));
}

const cellOf = (p, cs) => [Math.floor(p[0] / cs), Math.floor(p[1] / cs), Math.floor(p[2] / cs)];

function polylineLength(points) {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += len(sub(points[i], points[i - 1]));
  return l;
}

export function buildSnapIndex({ positions, indices, featureIds, edgePositions }) {
  const edges = edgePositions ?? new Float32Array(0);

  // 1. Dedupe drawn-edge vertices (at KEY_EPS) and segments (an edge drawn twice counts once).
  const keyToId = new Map();
  const verts = []; // representative coordinates, first seen
  const adj = []; // vertex id -> neighbour vertex ids
  const idOf = (x, y, z) => {
    const k = vkey(x, y, z);
    let id = keyToId.get(k);
    if (id === undefined) {
      id = verts.length;
      keyToId.set(k, id);
      verts.push([x, y, z]);
      adj.push([]);
    }
    return id;
  };
  const seen = new Set();
  for (let s = 0; s + 5 < edges.length; s += 6) {
    const a = idOf(edges[s], edges[s + 1], edges[s + 2]);
    const b = idOf(edges[s + 3], edges[s + 4], edges[s + 5]);
    if (a === b) continue; // zero-length segment
    const sk = segKey(a, b);
    if (seen.has(sk)) continue;
    seen.add(sk);
    adj[a].push(b);
    adj[b].push(a);
  }

  // 2. Corners: incident-segment count != 2, or a turn sharper than CURVE_TURN_DEG.
  //    A fine curve's tessellation vertices (degree 2, small turns) never qualify.
  const isCorner = verts.map((p, v) => {
    const n = adj[v];
    if (n.length === 0) return false; // touched only by zero-length segments
    if (n.length !== 2) return true;
    return turnDeg(verts[n[0]], p, verts[n[1]]) > CURVE_TURN_DEG;
  });

  // 3. Chains: walk from each corner through non-corner vertices to the next
  //    corner; then the leftover loops made only of non-corner vertices.
  const used = new Set();
  const walk = (start, next) => {
    const ids = [start];
    let prev = start, cur = next;
    used.add(segKey(prev, cur));
    for (;;) {
      ids.push(cur);
      if (isCorner[cur] || cur === start) break;
      const nxt = adj[cur][0] === prev ? adj[cur][1] : adj[cur][0];
      const sk = segKey(cur, nxt);
      if (used.has(sk)) break;
      used.add(sk);
      prev = cur;
      cur = nxt;
    }
    return ids;
  };
  const rawChains = [];
  for (let v = 0; v < verts.length; v++) {
    if (!isCorner[v]) continue;
    for (const n of adj[v]) if (!used.has(segKey(v, n))) rawChains.push(walk(v, n));
  }
  for (let v = 0; v < verts.length; v++) {
    for (const n of adj[v]) if (!used.has(segKey(v, n))) rawChains.push(walk(v, n));
  }

  const owners = vertexOwners(positions, indices, featureIds);
  const chains = rawChains.map((ids) => {
    const points = ids.map((i) => verts[i]);
    const closed = ids[0] === ids[ids.length - 1];
    let straight = !closed;
    for (let i = 1; i + 1 < points.length && straight; i++) {
      if (turnDeg(points[i - 1], points[i], points[i + 1]) >= COLLINEAR_TURN_DEG) straight = false;
    }
    const a = points[0], b = points[points.length - 1];
    const oa = owners.get(vkey(...a)), ob = owners.get(vkey(...b));
    const own = oa && ob ? [...oa].filter((id) => ob.has(id)).sort((x, y) => x - y) : [];
    return {
      points,
      straight,
      length: polylineLength(points),
      mid: straight ? scale(add(a, b), 0.5) : null,
      // a closed chain repeats its first point at the end; count it once
      centroid: (() => {
        const pts = closed ? points.slice(0, -1) : points;
        return scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
      })(),
      owners: own,
    };
  });
  const chainsByFeature = new Map();
  for (const c of chains) {
    for (const id of c.owners) {
      let list = chainsByFeature.get(id);
      if (!list) chainsByFeature.set(id, (list = []));
      list.push(c);
    }
  }

  // 4. Corner spatial hash.
  const cornerIds = [];
  for (let v = 0; v < verts.length; v++) if (isCorner[v]) cornerIds.push(v);
  const corners = new Float32Array(cornerIds.length * 3);
  cornerIds.forEach((v, i) => corners.set(verts[v], i * 3));
  const cellSize = Math.max(bboxDiagonal(positions, edges) / 128, 1e-3);
  const cornerGrid = new Map();
  cornerIds.forEach((v, i) => {
    const k = cellOf(verts[v], cellSize).join(",");
    let list = cornerGrid.get(k);
    if (!list) cornerGrid.set(k, (list = []));
    list.push(i);
  });

  return { corners, cornerGrid, chains, chainsByFeature, cellSize };
}

// Corner indices within radiusWorld of p. Falls back to a linear scan when the
// search box covers more cells than there are corners (a zoomed-out view).
function cornersNear(index, p, r) {
  const { corners, cornerGrid, cellSize } = index;
  const count = corners.length / 3;
  const lo = cellOf(sub(p, [r, r, r]), cellSize), hi = cellOf(add(p, [r, r, r]), cellSize);
  const cells = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
  const candidates = [];
  if (cells > count) {
    for (let i = 0; i < count; i++) candidates.push(i);
  } else {
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) {
          const list = cornerGrid.get(`${x},${y},${z}`);
          if (list) candidates.push(...list);
        }
  }
  const r2 = r * r;
  return candidates.filter((i) => {
    const dx = corners[i * 3] - p[0], dy = corners[i * 3 + 1] - p[1], dz = corners[i * 3 + 2] - p[2];
    return dx * dx + dy * dy + dz * dz <= r2;
  });
}

function nearestOnChain(points, p) {
  let best = points[0], bestD = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], ab = sub(points[i], a);
    const l2 = dot(ab, ab);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    const q = add(a, scale(ab, t));
    const d = len(sub(q, p));
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

const pxDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The rim centre nearer the hit, and the pixel distance from the pointer to
// the nearest of CIRCLE_SAMPLES projected rim samples.
function circleCandidate(spec, query) {
  const { top, bottom, axis } = spec.anchors;
  const centre = len(sub(top, query.hitPoint)) <= len(sub(bottom, query.hitPoint)) ? top : bottom;
  const r = spec.values.diameter / 2;
  const ax = scale(axis, 1 / (len(axis) || 1));
  const helper = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = cross(ax, helper);
  u = scale(u, 1 / len(u));
  const v = cross(ax, u);
  let d = Infinity;
  for (let i = 0; i < CIRCLE_SAMPLES; i++) {
    const a = (2 * Math.PI * i) / CIRCLE_SAMPLES;
    const s = add(centre, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
    d = Math.min(d, pxDist(query.project(s), query.pointerPx));
  }
  return { point: [...centre], px: d, circle: { centre: [...centre], axis: ax, radius: r } };
}

export function findSnap(index, query) {
  if (!index || !query?.hitPoint) return null;
  const { hitPoint, hitFeatureId, featureSpec, project, pointerPx, radiusWorld, snapPx } = query;
  const named = hitFeatureId > 0;
  const featureId = named ? hitFeatureId : 0;
  let best = null;
  const consider = (kind, point, px, chain, circle) => {
    if (!(px <= snapPx)) return;
    if (best && (KIND_RANK[kind] > KIND_RANK[best.kind]
      || (KIND_RANK[kind] === KIND_RANK[best.kind] && px >= best.px))) return;
    best = { kind, point, px, chain, circle };
  };

  const { corners } = index;
  for (const i of cornersNear(index, hitPoint, radiusWorld)) {
    const p = [corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]];
    consider("corner", p, pxDist(project(p), pointerPx));
  }

  // Unnamed geometry offers corners only (then the bare point).
  if (named) {
    const owned = index.chainsByFeature?.get(hitFeatureId) ?? [];
    for (const c of owned) {
      if (c.mid) consider("midpoint", [...c.mid], pxDist(project(c.mid), pointerPx), c);
      const e = nearestOnChain(c.points, hitPoint);
      consider("edge", e, pxDist(project(e), pointerPx), c);
    }
    if (featureSpec?.kind === "cylinder") {
      const circ = circleCandidate(featureSpec, query);
      // The rim to highlight: the owned chain whose centroid is nearest the
      // chosen rim centre — and only if it is near enough to BE that rim.
      let rim, rimD = RIM_MATCH * circ.circle.radius;
      for (const c of owned) {
        const d = len(sub(c.centroid, circ.point));
        if (d <= rimD) { rimD = d; rim = c; }
      }
      consider("circle", circ.point, circ.px, rim, circ.circle);
    }
  }

  if (best) {
    const out = { kind: best.kind, point: best.point, featureId };
    if (best.chain) out.chain = best.chain;
    if (best.circle) out.circle = best.circle;
    return out;
  }
  return { kind: named ? "face" : "point", point: [...hitPoint], featureId };
}
