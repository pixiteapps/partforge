// 2-D polygon helpers shared by parts that call kernel.prism().

// CCW polygon points for a circular-sector "pie" from the origin, radius tipR.
export function piePolygon(tipR, arcDeg, segs = 32) {
  const a = (arcDeg * Math.PI) / 180;
  const pts = [[0, 0]];
  const steps = Math.max(2, Math.ceil((segs * arcDeg) / 360));
  for (let i = 0; i <= steps; i++) {
    const t = (a * i) / steps;
    pts.push([tipR * Math.cos(t), tipR * Math.sin(t)]);
  }
  return pts;
}

// Vertex-up regular hexagon, circumradius r (flats facing ±X).
export function hexPolygon(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// Rectangle w×h centred at the origin with radius-r corners (r clamped to min(w,h)/2).
export function roundedRectPolygon(w, h, r, segs = 8) {
  r = Math.min(r, Math.min(w, h) / 2);
  const hw = w / 2, hh = h / 2;
  if (r <= 0) return [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
  const corners = [
    [hw - r, hh - r, 0],                 // top-right
    [-(hw - r), hh - r, Math.PI / 2],    // top-left
    [-(hw - r), -(hh - r), Math.PI],     // bottom-left
    [hw - r, -(hh - r), (3 * Math.PI) / 2], // bottom-right
  ];
  const pts = [];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (Math.PI / 2) * (i / segs);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  return pts;
}

// Regular n-gon, circumradius r. Vertex up by default; flat:true puts a flat edge up.
export function regularPolygon(n, r, { flat = false } = {}) {
  const base = Math.PI / 2 + (flat ? Math.PI / n : 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = base + (2 * Math.PI * i) / n;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// Ellipse with semi-axes rx, ry.
export function ellipsePolygon(rx, ry, segs = 48) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([rx * Math.cos(a), ry * Math.sin(a)]);
  }
  return pts;
}

// Stadium/obround slot: two r-radius semicircles whose centres are `length` apart
// (overall length = length + 2r), centred at the origin, long axis along X.
export function slotPolygon(length, r, segs = 16) {
  const hl = length / 2;
  const pts = [];
  for (let i = 0; i <= segs; i++) { const a = -Math.PI / 2 + Math.PI * (i / segs); pts.push([hl + r * Math.cos(a), r * Math.sin(a)]); }
  for (let i = 0; i <= segs; i++) { const a = Math.PI / 2 + Math.PI * (i / segs); pts.push([-hl + r * Math.cos(a), r * Math.sin(a)]); }
  return pts;
}

// Star with `points` tips, alternating outer/inner radius. First tip points up.
export function starPolygon(points, outerR, innerR) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / points;
    const rr = i % 2 === 0 ? outerR : innerR;
    pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
  }
  return pts;
}

// Annular sector as a single closed contour (outer arc, then inner arc back).
// arcDeg must be < 360 — a full annulus is a contour-with-hole; cut an inner
// cylinder from an outer one for a full ring.
export function ringSectorPolygon(innerR, outerR, arcDeg, segs = 32) {
  if (arcDeg >= 360) throw new Error("ringSectorPolygon: arcDeg must be < 360 (use a cut for a full ring)");
  const a = (arcDeg * Math.PI) / 180;
  const steps = Math.max(2, Math.ceil((segs * arcDeg) / 360));
  const pts = [];
  for (let i = 0; i <= steps; i++) { const t = (a * i) / steps; pts.push([outerR * Math.cos(t), outerR * Math.sin(t)]); }
  for (let i = steps; i >= 0; i--) { const t = (a * i) / steps; pts.push([innerR * Math.cos(t), innerR * Math.sin(t)]); }
  return pts;
}

// Per-corner rounding geometry, shared verbatim by filletPolygon (which tessellates it)
// and roundedProfile (which emits it as a symbolic arc). Given a corner p0→p1→p2 and a
// requested radius r, returns the incoming/outgoing tangent points `a`/`b`, the arc centre
// `c`, the clamped radius `rr`, the short sweep `dA`, and the incoming start angle `a0` —
// or null for a corner that must stay sharp (zero-length edge or a straight/180° corner).
// The per-corner clamp (t ≤ min(l0,l2)/2) keeps neighbouring arcs from overlapping.
// Extracting this means the two consumers can never diverge on clamping/winding.
export function cornerArc(p0, p1, p2, r) {
  let v0 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const l0 = Math.hypot(v0[0], v0[1]), l2 = Math.hypot(v2[0], v2[1]);
  if (l0 < 1e-9 || l2 < 1e-9) return null;               // zero-length edge → sharp
  v0 = [v0[0] / l0, v0[1] / l0]; v2 = [v2[0] / l2, v2[1] / l2];
  const cosA = Math.max(-1, Math.min(1, v0[0] * v2[0] + v0[1] * v2[1]));
  const half = Math.acos(cosA) / 2;                      // half the corner's interior angle
  let bis = [v0[0] + v2[0], v0[1] + v2[1]];
  const bl = Math.hypot(bis[0], bis[1]);
  if (half < 1e-6 || bl < 1e-9) return null;             // straight (180°) corner → sharp
  bis = [bis[0] / bl, bis[1] / bl];
  let rr = r, t = r / Math.tan(half);                    // tangent setback along each edge
  const tmax = Math.min(l0, l2) / 2;                     // clamp: never past an edge midpoint
  if (t > tmax) { t = tmax; rr = t * Math.tan(half); }
  const a = [p1[0] + v0[0] * t, p1[1] + v0[1] * t];      // tangent point on the incoming edge
  const b = [p1[0] + v2[0] * t, p1[1] + v2[1] * t];      // tangent point on the outgoing edge
  const c = [p1[0] + bis[0] * (rr / Math.sin(half)), p1[1] + bis[1] * (rr / Math.sin(half))]; // arc center
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let dA = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;     // sweep the SHORT arc from a to b
  while (dA <= -Math.PI) dA += 2 * Math.PI;
  while (dA > Math.PI) dA -= 2 * Math.PI;
  return { a, b, c, rr, dA, a0 };
}

// Round every corner of a CCW polygon: each vertex is replaced by a tangent circular
// arc of radius r, tessellated with `segs` segments per corner (default 8, matching
// roundedRectPolygon). Returns a plain [[x,y],…] point list usable by prism/extrude/loft
// on BOTH kernels by construction. Corners are CLAMPED per-corner: r is reduced so an
// arc's tangent points never pass the midpoint of either adjacent edge, so neighbouring
// rounded corners can never overlap (pass a very large r to fully round every corner).
// Intended for convex CCW outlines (brackets, gussets, pads, knob/star profiles); a
// reflex corner is still rounded but its arc is placed on the angle bisector.
// NOTE: bakes each arc into `segs` straight facets, so STEP export of a filletPolygon
// part has faceted (LINE) corners; for mathematically-true CIRCLE corners in STEP use
// roundedProfile, which carries the arc symbolically to both backends.
export function filletPolygon(points, r, { segs = 8 } = {}) {
  const n = points.length;
  if (n < 3) throw new Error("filletPolygon: need at least 3 points");
  if (!(r > 0)) throw new Error("filletPolygon: r must be > 0");
  const out = [];
  for (let i = 0; i < n; i++) {
    const arc = cornerArc(points[(i - 1 + n) % n], points[i], points[(i + 1) % n], r);
    if (!arc) { out.push([points[i][0], points[i][1]]); continue; } // sharp corner
    const { c, rr, dA, a0 } = arc;
    for (let s = 0; s <= segs; s++) {
      const ang = a0 + dA * (s / segs);
      out.push([c[0] + rr * Math.cos(ang), c[1] + rr * Math.sin(ang)]);
    }
  }
  return out;
}

// Fluent builder for a curve-native path contour { start, segments }. Segment kinds:
// lineTo → {to}, arcTo → {to,via} (three-point arc) or {to,via} computed from a radius
// spec, cubicTo → {to,c1,c2} (cubic Bézier). close() returns the plain contour object
// (feeds extrude/revolve/prism), not a Solid.
export function pathProfile(start) {
  const fin2 = (p, what) => {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new Error(`pathProfile: ${what} must be a finite [x,y]`);
    return [p[0], p[1]];
  };
  const s = fin2(start, "start");
  let cur = s;
  const segments = [];
  const api = {
    lineTo(to) {
      const p = fin2(to, "lineTo point");
      segments.push({ to: p });
      cur = p;
      return api;
    },
    // arcTo(to, via) is the three-point form: `via` is any point on the arc.
    // arcTo(to, { r, sweep?, large? }) is the radius form: `via` is computed here
    // from the current point, `to`, and the radius spec so the emitted segment is
    // byte-for-byte what the three-point form emits (see docs/AUTHORING-PARTS.md).
    arcTo(to, second) {
      const p1 = fin2(to, "arcTo point");
      if (Array.isArray(second)) {
        const via = fin2(second, "arcTo via");
        segments.push({ to: p1, via });
        cur = p1;
        return api;
      }
      if (second !== null && typeof second === "object") {
        const ARC_SPEC_KEYS = ["r", "sweep", "large"];
        const unknownKeys = Object.keys(second).filter((k) => !ARC_SPEC_KEYS.includes(k));
        if (unknownKeys.length > 0)
          throw new Error(
            `pathProfile: arcTo arc spec has unknown ${unknownKeys.length > 1 ? "keys" : "key"} ${unknownKeys.map((k) => JSON.stringify(k)).join(", ")} — the keys are r, sweep, large`,
          );
        const { r, sweep = "ccw", large = false } = second;
        // Cheap key/enum/boolean checks run BEFORE the numeric ones below, so a
        // typo'd sweep/large is reported on its own rather than being masked by
        // an unrelated radius complaint on the same call.
        if (sweep !== "ccw" && sweep !== "cw")
          throw new Error(`pathProfile: arcTo sweep must be "ccw" or "cw", got ${JSON.stringify(sweep)}`);
        if (typeof large !== "boolean")
          throw new Error("pathProfile: arcTo large must be a boolean");
        const [x0, y0] = cur;
        const [x1, y1] = p1;
        const dx = x1 - x0, dy = y1 - y0;
        const d = Math.hypot(dx, dy);
        if (d < 1e-9)
          throw new Error(`pathProfile: arcTo to (${x1}, ${y1}) coincides with the current point`);
        if (!(r > 0) || !Number.isFinite(r))
          throw new Error(`pathProfile: arcTo r must be > 0 and finite, got ${JSON.stringify(r)}`);
        if (r < d / 2 - 1e-9)
          throw new Error(
            `pathProfile: arcTo r=${r} is shorter than half the chord (${(d / 2).toFixed(4)}) from (${x0}, ${y0}) to (${x1}, ${y1}) — the smallest arc that can join these points has r=${(d / 2).toFixed(4)} (a semicircle)`,
          );
        const rr = Math.max(r, d / 2);                    // absorb the 1e-9 tolerance so h is never NaN
        const h = Math.sqrt(rr * rr - (d / 2) * (d / 2));  // centre's distance from the chord midpoint
        const ux = dx / d, uy = dy / d;                    // unit chord direction
        const nx = -uy, ny = ux;                           // unit LEFT normal of the direction of travel
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        const side = sweep === "ccw" ? -1 : 1;             // which side of the chord the arc bulges to
        const sgn = large ? side : -side;
        const cx = mx + nx * h * sgn, cy = my + ny * h * sgn;
        const via = [cx + nx * rr * side, cy + ny * rr * side]; // the arc's midpoint
        segments.push({ to: p1, via });
        cur = p1;
        return api;
      }
      throw new Error("pathProfile: arcTo needs a via [x,y] or an { r, sweep?, large? } arc spec");
    },
    cubicTo(to, c1, c2) {
      const p = fin2(to, "cubicTo point");
      segments.push({ to: p, c1: fin2(c1, "cubicTo c1"), c2: fin2(c2, "cubicTo c2") });
      cur = p;
      return api;
    },
    close() {
      if (segments.length < 1) throw new Error("pathProfile: need ≥1 segment before close()");
      return { start: [s[0], s[1]], segments: segments.slice() }; // snapshot — chaining after close() must not mutate the returned contour
    },
  };
  return api;
}

// Arc-aware sibling of filletPolygon: rounds the corners of a CCW polygon with the SAME
// tangent/centre/sweep math (via cornerArc), but instead of tessellating each arc into
// line facets it emits a canonical ArcContour { start, segments:[{to}|{to,via}], arc:true }
// that carries the arc SYMBOLICALLY. Feed it to prism/extrude (not loft yet): OCCT builds a
// true CIRCLE B-rep edge (exact STEP fillets) while Manifold tessellates the same spec, so
// both kernels agree by construction. `r` is a scalar (every corner) or a per-corner array
// r[] (length === points.length; a 0 or a degenerate corner stays sharp — a plain line).
export function roundedProfile(points, r) {
  const n = points.length;
  if (n < 3) throw new Error("roundedProfile: need at least 3 points");
  const radii = Array.isArray(r) ? r : null;
  if (radii && radii.length !== n)
    throw new Error("roundedProfile: r[] length must match points length");
  if (!radii && !(r >= 0)) throw new Error("roundedProfile: r must be ≥ 0 (or a per-corner r[]); 0 keeps every corner sharp");
  const segments = [];
  let start = null;
  const lineTo = (p) => { if (start === null) start = [p[0], p[1]]; else segments.push({ to: [p[0], p[1]] }); };
  for (let i = 0; i < n; i++) {
    const p1 = points[i];
    const ri = radii ? radii[i] : r;
    const arc = ri > 0 ? cornerArc(points[(i - 1 + n) % n], p1, points[(i + 1) % n], ri) : null;
    if (!arc) { lineTo(p1); continue; }                  // sharp / degenerate corner → plain vertex
    const { a, b, c, rr, dA, a0 } = arc;
    lineTo(a);                                           // straight run into the incoming tangent point
    const mid = a0 + dA / 2;                             // arc midpoint (three-point via — sign/winding-free)
    segments.push({ to: [b[0], b[1]], via: [c[0] + rr * Math.cos(mid), c[1] + rr * Math.sin(mid)] });
  }
  return { start, segments, arc: true };
}

const PATTERN_AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

// `count` copies of `solid` translated by i*step ([dx,dy,dz]) for i in 0..count-1.
// Returns a Solid[] — feed to k.union(...) (features) or s.cutAll(...) (holes).
export function linearPattern(solid, count, step) {
  const out = [];
  for (let i = 0; i < count; i++)
    out.push(solid.clone().translate([step[0] * i, step[1] * i, step[2] * i]));
  return out;
}

// `count` copies spaced angle/count degrees apart around `axis` through `center`.
// rotateCopies:true re-orients each copy to face along the circle; false places it
// at the orbital position with its original orientation (for radially symmetric tools).
export function circularPattern(solid, count, { center = [0, 0, 0], axis = "Z", angle = 360, rotateCopies = true } = {}) {
  const ax = Array.isArray(axis) ? axis : PATTERN_AXIS[axis];
  const out = [];
  for (let i = 0; i < count; i++) {
    const deg = (angle / count) * i;
    const placed = solid.clone().rotate(deg, center, ax);
    if (rotateCopies) { out.push(placed); continue; }
    // cancel the orientation change by counter-rotating about the copy's own centre
    const c = placed.boundingBox().center;
    out.push(placed.rotate(-deg, c, ax));
  }
  return out;
}

// CCW circle of radius r centered at [cx, cy]. A shared 2-D profile primitive:
// compose with the kernel's profile ops — e.g. revolve(circleProfile(minorR,
// [majorR, 0])) is a torus, prism(circleProfile(r), h) a cylinder.
export function circleProfile(r, center = [0, 0], segs = 48) {
  if (!(r > 0)) throw new Error("circleProfile: r must be > 0");
  const [cx, cy] = center;
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// --- offsetPolygon ---------------------------------------------------------

const OFFSET_EPS = 1e-9;

// Fresh copies, consecutive duplicates dropped, closing point (== first) dropped.
function dedupePoints(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > OFFSET_EPS) out.push([p[0], p[1]]);
  }
  while (out.length > 1 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= OFFSET_EPS) out.pop();
  return out;
}

function polySignedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// True where segments a-b and c-d properly cross. Shared endpoints and collinear
// touches don't count — adjacent edges always share a vertex, and the collinear
// case is degenerate input the dedupe/straight-vertex paths already absorb.
function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

// True where p lies strictly inside segment a-b (not at either endpoint) —
// a degenerate touch that segmentsCross's proper-crossing test doesn't see.
function pointOnSegment(p, a, b) {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > OFFSET_EPS) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot > OFFSET_EPS && dot < lenSq - OFFSET_EPS;
}

// O(n²) simplicity test — trivial at profile point counts (tens to hundreds).
function isSimplePolygon(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // adjacent edges share a vertex
      const [a, b] = [pts[i], pts[(i + 1) % n]], [c, d] = [pts[j], pts[(j + 1) % n]];
      if (segmentsCross(a, b, c, d)) return false;
      // A vertex landing exactly on a non-adjacent edge is also a self-touch —
      // e.g. an inset waist pinching two opposite edges together.
      if (pointOnSegment(a, c, d) || pointOnSegment(b, c, d) ||
          pointOnSegment(c, a, b) || pointOnSegment(d, a, b)) return false;
    }
  }
  return true;
}

// Intersection of two infinite lines given as point + unit direction; null if parallel.
function lineIntersect(p, dp, q, dq) {
  const denom = dp[0] * dq[1] - dp[1] * dq[0];
  if (Math.abs(denom) < OFFSET_EPS) return null;
  const t = ((q[0] - p[0]) * dq[1] - (q[1] - p[1]) * dq[0]) / denom;
  return [p[0] + dp[0] * t, p[1] + dp[1] * t];
}

// Offset a profile by `delta` mm: positive grows material outward, negative
// insets. `profile` is a CCW [[x,y],…] point list (either winding accepted,
// output always CCW) or an {outer, holes} region — regions offset as material:
// outer by +delta, holes by −delta, so a +0.2 clearance on a cut region loosens
// the whole cut. Corners where the offset edges diverge fill per `corners`:
// "round" (arc of radius |delta| about the original vertex, `segs` segments —
// the true Minkowski clearance), "chamfer" (the arc's chord), or "sharp" (true
// miter, falling back to chamfer past a miter length of 2·|delta|). Where
// offset edges cross (reflex on outset, convex on inset) they trim to their
// intersection regardless of style. Simple polygon in, simple polygon out:
// a result that self-intersects or vanishes THROWS (greppable errors below)
// rather than returning degenerate geometry — offsets that would split a
// region (dumbbell insets) are out of scope. Pure and deterministic; usable in
// derive() and build() alike. See AUTHORING-PARTS.md "Profiles & patterns".
export function offsetPolygon(profile, delta, opts = {}) {
  const { corners = "round", segs = 8 } = opts;
  if (profile !== null && typeof profile === "object" && !Array.isArray(profile)) {
    if (!Array.isArray(profile.outer)) throw new Error("offsetPolygon: profile must be a point list or {outer, holes}");
    const region = { outer: offsetPolygon(profile.outer, delta, opts) };
    if (profile.holes) region.holes = profile.holes.map((h) => offsetPolygon(h, -delta, opts));
    return region;
  }
  if (!Array.isArray(profile)) throw new Error("offsetPolygon: profile must be a point list or {outer, holes}");
  if (typeof delta !== "number" || !Number.isFinite(delta)) throw new Error("offsetPolygon: delta must be a finite number");
  if (corners !== "round" && corners !== "chamfer" && corners !== "sharp")
    throw new Error('offsetPolygon: corners must be "round" | "chamfer" | "sharp"');
  for (const p of profile)
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new Error("offsetPolygon: coordinates must be finite numbers");

  const pts = dedupePoints(profile);
  if (pts.length < 3) throw new Error("offsetPolygon: need at least 3 points");
  if (polySignedArea(pts) < 0) pts.reverse();                     // work in CCW
  if (!isSimplePolygon(pts)) throw new Error("offsetPolygon: input polygon self-intersects");
  if (delta === 0) return pts;

  // Each edge i (pts[i] → pts[i+1]): unit direction and endpoints displaced
  // along the outward normal (CCW ⇒ outward = (dy, −dx)).
  const n = pts.length, dir = [], off = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const d = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const mx = d[1] * delta, my = -d[0] * delta;
    dir.push(d);
    off.push([[p[0] + mx, p[1] + my], [q[0] + mx, q[1] + my]]);
  }

  // Join edge (i−1)'s offset to edge i's offset at each original vertex. Also
  // track each edge's start/end parameter along its own direction: a heavily
  // over-inset edge can be trimmed from both ends past its own start and still
  // trace out a simple-looking (but phantom, reflected) loop — isSimplePolygon
  // only catches crossing segments, not a reversed edge, so that case needs
  // this separate check below.
  const out = [];
  const tStart = new Array(n), tEnd = new Array(n);
  const paramOf = (i, p) => (p[0] - off[i][0][0]) * dir[i][0] + (p[1] - off[i][0][1]) * dir[i][1];
  const join = (prev, i, point) => {
    out.push(point);
    tEnd[prev] = paramOf(prev, point);
    tStart[i] = paramOf(i, point);
  };
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n, V = pts[i];
    const endPrev = off[prev][1], startNext = off[i][0];
    const cross = dir[prev][0] * dir[i][1] - dir[prev][1] * dir[i][0];

    if (Math.abs(cross) < OFFSET_EPS) { join(prev, i, endPrev); continue; }   // straight vertex

    if (cross * delta < 0) {                                             // offset edges cross → trim
      const m = lineIntersect(off[prev][0], dir[prev], off[i][0], dir[i]);
      join(prev, i, m ?? endPrev);
      continue;
    }

    // Offset edges diverge → fill the wedge per style.
    if (corners === "sharp") {
      const m = lineIntersect(off[prev][0], dir[prev], off[i][0], dir[i]);
      if (m && Math.hypot(m[0] - V[0], m[1] - V[1]) <= 2 * Math.abs(delta)) { join(prev, i, m); continue; }
      out.push(endPrev, startNext);                                      // past the miter limit → chamfer
      tEnd[prev] = paramOf(prev, endPrev); tStart[i] = paramOf(i, startNext);
    } else if (corners === "chamfer") {
      out.push(endPrev, startNext);
      tEnd[prev] = paramOf(prev, endPrev); tStart[i] = paramOf(i, startNext);
    } else {                                                             // round: short arc about V
      tEnd[prev] = paramOf(prev, endPrev); tStart[i] = paramOf(i, startNext);
      const a0 = Math.atan2(endPrev[1] - V[1], endPrev[0] - V[0]);
      let dA = Math.atan2(startNext[1] - V[1], startNext[0] - V[0]) - a0;
      while (dA <= -Math.PI) dA += 2 * Math.PI;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      const r = Math.abs(delta);
      for (let s = 0; s <= segs; s++) {
        const a = a0 + (dA * s) / segs;
        out.push([V[0] + r * Math.cos(a), V[1] + r * Math.sin(a)]);
      }
    }
  }

  for (let i = 0; i < n; i++)
    if (tEnd[i] < tStart[i] - OFFSET_EPS) throw new Error("offsetPolygon: offset collapses the polygon");

  const cleaned = dedupePoints(out);
  if (cleaned.length < 3 || polySignedArea(cleaned) <= OFFSET_EPS)
    throw new Error("offsetPolygon: offset collapses the polygon");
  if (!isSimplePolygon(cleaned))
    throw new Error("offsetPolygon: offset result self-intersects (reduce |delta| or simplify the profile)");
  return cleaned;
}

// The 2-D editing surface (transforms, corner ops, queries, cleanup, validation) lives in
// contour-ops.js; re-exported here so `partforge/geometry` stays the single import surface.
export { translateProfile, rotateProfile, scaleProfile, mirrorProfile,
  filletProfile, chamferProfile, profileCorners,
  profileLength, profilePointAt, profileTangentAt, profileNearestPoint,
  profileBounds, profileArea, profileContains,
  simplifyProfile, validateProfile } from "./contour-ops.js";
