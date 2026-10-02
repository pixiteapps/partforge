// Mesh fillet/chamfer for the Manifold backend — the tangent-wedge CSG technique
// (independently reimplemented from the approach discussed in elalish/manifold
// #1411): for each selected sharp edge chain, build a solid whose curved wall IS
// the rolling-ball blend surface, then boolean it against the part. Convex chains
// subtract a cutter; concave chains union a filler. Because the boolean runs in
// Manifold, output is watertight by construction and the blend radius is exact to
// tessellation.
//
// Edge classes supported:
//   - straight chains with planar flanks           → lofted prism cutter
//   - circular-arc chains with revolved flanks     → revolved cutter (bore rims,
//     cylinder rims, the arcs where fillets meet a face), full circles included
//   - planar contour chains at constant dihedral   → swept cutter/filler along the
//     chain's own polyline (top/bottom rims of extruded text, offset outlines,
//     splines — see tryPlanarChain/planarTool)
//   - general chains between two curved faces       → per-vertex cross-section ring
//     (saddles, cross-hole rims, slanted cuts)          stack (buildGeneralPath /
//                                                       generalTool), tried last
// Anything a general chain also refuses (mixed convexity, knife edges, a bend tighter than the section) raises
// UnsupportedEdgeError so a caller can reroute the build to the B-rep backend.
//
// Corner treatment, by how sharp the corner is. A SHARP salient corner (turn past
// SMOOTH_MAX_DEG — the same bar that makes chainEdges call it a corner at all) keeps
// the honest MITRE: the two blends run to the vertex and cross in the classic
// intersection seam every B-rep fillet shows; the seam is a real crease, its feature
// line is correct, and the top face keeps its sharp corner (decided 2026-08-17 —
// there is provably no band that hugs both walls around a salient corner without
// creasing, and every lift-off construction strands a corner column that reads as an
// artifact). A GENTLE salient corner (CORNER_ROUND_MIN_TURN..SMOOTH_MAX_DEG) is
// steered instead — a small arc chain (radius ~1.05-1.25× the magnitude) replaces
// the mitre and a horn block shaves the corner column to band depth — because a
// shallow mitre's overlap wedge triangulates into junk lines while the steer's
// silhouette cost is sub-visible at these angles. A REFLEX corner in a common face
// plane gets the rolling-ball PIVOT (reflexPivotAt/reflexPivotTool): the ball swings
// about the corner's face-normal axis, touching the face and the vertical corner
// edge, and the face's blend boundary rounds into an arc of radius r about the
// vertex — without it the flush-ended neighbor tools leave a wedge of the original
// rim uncut and the face keeps a point AT the corner (the label-part "artifacts"
// bug). Three-or-more-chain vertices go to the spherical cornerPatches below (the
// orthogonal three-chain case).
//
// Known limits (documented, not bugs): radius feasibility is the caller's job (clamp
// like filleted-box.js does — an oversized radius self-intersects the cutters).
//
// Selector object mirrors edge-selector.js semantics ({dir, inPlane, at, near});
// `dir` only ever matches straight chains, like replicad's inDirection.
// Pure module: no DOM, no node:, no three — safe anywhere in the worker graph.
import { sweepSeedFrame } from "./sweep.js";
import { segsForSagitta } from "./circle-segs.js";

const TOL = 1e-4;            // selector / coplanarity tolerance (mm)
const WELD = 1e6;            // vertex weld quantization (1/WELD mm grid)
const COLLINEAR_DEG = 0.1;   // joints straighter than this extend a line run
const SMOOTH_MAX_DEG = 30;   // joints turning more than this are corners (chain ends)
const DEFAULT_SEGS = 116;    // full-circle tessellation density (preview quality)

export class UnsupportedEdgeError extends Error {
  constructor(message) { super(message); this.name = "UnsupportedEdgeError"; }
}

// Blend-band tessellation density: enough facets to keep the chord sagitta invisible,
// never more. The kernel's `segs` is a per-circle quality knob sized for part-scale
// circles; spending it on a blend of radius r tessellates a 0.5 mm fillet to 0.2 µm
// sagitta at preview quality — and a text rim's hundred-tool boolean then carries ~4×
// the triangles it needs (measured 12 s / 4 GB on a lettering part before this cap).
// BLEND_SAG (1 µm) is finer than preview quality's own ~4 µm sagitta at part scale;
// the 0.02·r term keeps micro-blends sane, and the floor of 12 keeps every facet
// angle (≤30°) under the viewer's 35° same-surface crease threshold.
const BLEND_SAG = 1e-3; // mm — max chord sagitta of a blend cross-section
function blendSegs(segs, r) {
  return segsForSagitta(r, Math.min(BLEND_SAG, 0.02 * r), 12, segs);
}
// One derivation for a synthetic corner arc's angular density, shared by revolveTool
// (which sweeps at it) and cornerHornTool (whose apothem bound below depends on it) —
// the horn's containment proof only holds if both compute the same number.
const cornerArcSegs = (segs, R, magnitude) => blendSegs(segs, R + magnitude);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const pivotKey = (p) => `${Math.round(p[0] * WELD)},${Math.round(p[1] * WELD)},${Math.round(p[2] * WELD)}`;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? scl(a, 1 / l) : [0, 0, 0]; };
const clamp1 = (x) => Math.max(-1, Math.min(1, x));
const rotVec = (p, k, th) => { // Rodrigues rotation about unit axis k
  const c = Math.cos(th), s = Math.sin(th);
  return add(add(scl(p, c), scl(cross(k, p), s)), scl(k, dot(k, p) * (1 - c)));
};

// Analytic shading. Each fillet tool's blend wall is a canal surface about a known
// spine (blend-surfaces.js); tell the kernel, which registers it against the tool's
// surface id so toMesh can emit the exact rolling-ball normals instead of facet
// averages. `surf` is in the tool's CURRENT (posed, world) frame. A kernel without
// the hook (or a chamfer, whose flat/conical walls facet-shade exactly already) just
// gets the tool back.
const markBlend = (k, tool, surf) => (k._markBlendSurface ? k._markBlendSurface(tool, surf) : tool);
// The ball centre's offset from the edge point, given the two unit flank normals —
// profile2D's C, in any dimension (2-D profile coordinates or 3-D world vectors).
const ballOffset = (n1, n2, r, convex) => {
  const c = clamp1(n1.reduce((acc, x, i) => acc + x * n2[i], 0));
  const f = (convex ? 1 : -1) * (-r / (1 + c));
  return n1.map((x, i) => f * (x + n2[i]));
};

// ---------------------------------------------------------------------------
// Sharp-edge extraction: weld vertices, keep edges whose two incident triangles
// meet at a dihedral sharper than sharpDeg, tag convexity and flank normals.
export function detectSharpEdges({ positions, indices }, { sharpDeg = 20 } = {}) {
  const nVert = positions.length / 3;
  const weld = new Map(), wid = new Int32Array(nVert), pts = [];
  for (let i = 0; i < nVert; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
    let id = weld.get(key);
    if (id === undefined) { id = pts.length; weld.set(key, id); pts.push([x, y, z]); }
    wid[i] = id;
  }
  const edges = new Map(); // "lo:hi" -> { u, v, faces: [{ n, w }] }
  for (let t = 0; t < indices.length; t += 3) {
    const ids = [wid[indices[t]], wid[indices[t + 1]], wid[indices[t + 2]]];
    const [a, b, c] = ids.map((i) => pts[i]);
    const n = norm(cross(sub(b, a), sub(c, a)));
    if (len(n) === 0) continue; // degenerate sliver
    for (let e = 0; e < 3; e++) {
      const u = ids[e], v = ids[(e + 1) % 3], w = pts[ids[(e + 2) % 3]];
      if (u === v) continue;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      let rec = edges.get(key);
      if (!rec) { rec = { u, v, faces: [] }; edges.set(key, rec); }
      rec.faces.push({ n, w });
    }
  }
  const cosSharp = Math.cos((sharpDeg * Math.PI) / 180);
  const out = [];
  for (const { u, v, faces } of edges.values()) {
    if (faces.length !== 2) continue;
    const [f1, f2] = faces;
    if (dot(f1.n, f2.n) > cosSharp) continue; // smooth or coplanar
    const convex = dot(sub(f2.w, pts[u]), f1.n) < -1e-9;
    out.push({ ua: u, ub: v, a: pts[u], b: pts[v], n1: f1.n, n2: f2.n, convex });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chain sharp edges into straight and circular-arc runs.
//
// Walk maximal paths through the sharp-edge graph (vertices of degree ≠ 2 and
// convexity flips end a path), classify each joint by turn angle, then split
// paths into runs: collinear-joined stretches are line chains; stretches joined
// by "circle-consistent" joints (small turn AND similar edge lengths — a long
// straight edge next to tiny arc facets fails the length test and stays its own
// line chain) are arc candidates, validated by a circumcircle fit. A loop with
// no run boundary at all is a full circle.
export function chainEdges(edges) {
  const COS_COLL = Math.cos((COLLINEAR_DEG * Math.PI) / 180);
  const COS_SMOOTH = Math.cos((SMOOTH_MAX_DEG * Math.PI) / 180);
  const adj = new Map(); // welded vid -> [edge index...]
  edges.forEach((e, i) => {
    for (const v of [e.ua, e.ub]) (adj.get(v) ?? adj.set(v, []).get(v)).push(i);
  });
  const deg = (v) => adj.get(v).length;
  const other = (e, v) => (e.ua === v ? e.ub : e.ua);
  const used = new Array(edges.length).fill(false);

  // orient edge e so it leaves vertex v: returns [from, to, dir]
  const oriented = (e, v) => {
    const from = v === e.ua ? e.a : e.b, to = v === e.ua ? e.b : e.a;
    return { from, to, dir: norm(sub(to, from)) };
  };

  const paths = []; // { members: [edgeIdx...], verts: [vid...], loop }
  const walk = (start, firstEdge) => {
    const members = [firstEdge], verts = [start];
    let v = start, e = firstEdge;
    for (;;) {
      used[e] = true;
      const nv = other(edges[e], v);
      verts.push(nv);
      if (deg(nv) !== 2) break;
      const next = adj.get(nv).find((i) => !used[i]);
      if (next === undefined) break;
      if (edges[next].convex !== edges[e].convex) break; // convexity flip ends the path
      // turn angle gate: corners end paths
      const d1 = oriented(edges[e], v).dir, d2 = oriented(edges[next], nv).dir;
      if (dot(d1, d2) < COS_SMOOTH) break;
      members.push(next);
      v = nv; e = next;
    }
    return { members, verts, loop: verts[0] === verts[verts.length - 1] };
  };
  // open paths first (seeded at non-degree-2 vertices), then leftovers: loops,
  // or open runs whose gates (turn/convexity) broke the walk mid-graph — those
  // are walked in both directions from the seed and stitched
  for (const [v, list] of adj) {
    if (deg(v) === 2) continue;
    for (const i of list) if (!used[i]) paths.push(walk(v, i));
  }
  edges.forEach((_, i) => {
    if (used[i]) return;
    const fwd = walk(edges[i].ua, i);
    if (fwd.loop) { paths.push(fwd); return; }
    // extend backward from the seed vertex if a compatible unused edge remains
    const backSeed = adj.get(edges[i].ua).find((j) => !used[j]);
    if (backSeed === undefined) { paths.push(fwd); return; }
    const back = walk(other(edges[backSeed], edges[i].ua), backSeed);
    paths.push({
      members: [...back.members.slice().reverse(), ...fwd.members],
      verts: [...back.verts.slice().reverse(), ...fwd.verts.slice(1)],
      loop: false,
    });
  });

  // split a path's member list into runs of "line" (collinear joints) and "arc"
  // (circle-consistent joints) edges
  const chains = [];
  for (const path of paths) {
    const { members, verts, loop } = path;
    const dirs = members.map((i, k) => oriented(edges[i], verts[k]).dir);
    const lens = members.map((i) => len(sub(edges[i].b, edges[i].a)));
    const nJoint = loop ? members.length : members.length - 1; // joint j is between member j and j+1 (mod)
    const jointType = []; // "coll" | "circ" | "cut"
    for (let j = 0; j < nJoint; j++) {
      const k2 = (j + 1) % members.length;
      const c = dot(dirs[j], dirs[k2]);
      const ratio = lens[j] / lens[k2];
      if (c >= COS_COLL) jointType.push("coll");
      else if (c >= COS_SMOOTH && ratio > 1 / 3 && ratio < 3) jointType.push("circ");
      else jointType.push("cut");
    }
    // rotate loops so index 0 starts right after a run boundary; a loop with no
    // boundary at all is a closed uniform curve (full circle candidate)
    let order = members.map((_, k) => k);
    let closedUniform = false;
    if (loop) {
      const boundary = jointType.findIndex((t, j) => t !== jointType[(j - 1 + nJoint) % nJoint] || t === "cut");
      const cut = jointType.indexOf("cut");
      const startAfter = cut !== -1 ? cut : boundary !== -1 ? boundary : -1;
      if (startAfter === -1 && jointType.every((t) => t === jointType[0])) closedUniform = true;
      else if (startAfter !== -1) order = order.map((k) => (startAfter + 1 + k) % members.length);
    }
    const runs = [];
    let run = null;
    for (let idx = 0; idx < order.length; idx++) {
      const k = order[idx];
      if (!run) { run = { type: null, ks: [k] }; continue; }
      const t = jointType[order[idx - 1]]; // joint j joins member j and its successor
      if (t === "cut" || (run.type !== null && run.type !== t)) { runs.push(run); run = { type: null, ks: [k] }; }
      else { if (run.type === null) run.type = t; run.ks.push(k); }
    }
    if (run) runs.push(run);
    // a run's type is the joint type joining its members; single-member runs are lines
    const runChains = [];
    for (const r of runs) {
      const type = r.ks.length === 1 || r.type === "coll" || r.type === null ? "line" : "arc";
      runChains.push(buildChain(edges, path, r.ks, type, closedUniform && runs.length === 1));
    }
    // Planar rescue is per-PATH, not per-run, and replaces the WHOLE path's chains: a rim
    // that mixes straight, curvy, and short runs must become ONE swept tool, because
    // per-run tools along the same rim continue each other nearly collinearly — their
    // overshoots then overlap surface-on-surface (not the clean perpendicular crossing of
    // a box corner) and the boolean leaves degenerate seams where identical blend
    // surfaces coincide. A path whose runs are ALL line/arc keeps its exact per-run tools
    // exactly as before — promotion only fires where the path would otherwise reroute.
    if (runChains.some((c) => c.kind === "unsupported")) {
      const rescue = buildPlanarPath(edges, path);
      if (rescue) { chains.push(rescue); continue; }
      // Last resort before a reroute: the whole path as ONE general chain, whose tool
      // builds its cross-section per vertex from that vertex's own flank normals
      // (generalTool). Runs only where every fixed-section tool has already refused,
      // so no chain any existing tool accepts can ever land here.
      const general = buildGeneralPath(edges, path);
      if (general) { chains.push(general); continue; }
    }
    chains.push(...runChains);
  }
  return stitchPlanarChains(chains);
}

// Join open planar chains that continue each other across a path junction. The edge walk
// ends a path at any degree≠2 vertex — and a real rim grows one wherever its outline
// turns past sharpDeg, because that corner puts a sharp VERTICAL edge up the wall. The
// rim's halves then arrive as separate open planar chains whose swept tools would cross
// at the junction's own shallow angle — a near-parallel surface overlap that leaves
// degenerate seams (the same disease the whole-path promotion cures within one path).
// Stitched into one chain, the junction becomes an interior vertex: the sweep miters it
// when gentle, and planarTool's fold guard splits it (with a clean, wide-angle mitre
// crossing) when sharp. Chains stitch only when they share an endpoint, the same face
// plane, and the same convexity — the same-plane test is what keeps a top rim from ever
// stitching to a bottom rim.
function stitchPlanarChains(chains, { absorbLines = false } = {}) {
  const open = [], out = [];
  for (const c of chains) (c.kind === "planar" && !c.closed ? open : out).push(c);
  const key = (p) => `${Math.round(p[0] * WELD)},${Math.round(p[1] * WELD)},${Math.round(p[2] * WELD)}`;
  // Absorb LINE chains that continue an open planar chain — apply()'s re-stitch
  // only, post-selection, so a dir/line selector still sees the line form. A
  // straight run flanking a planarized arc otherwise keeps its prism tool, and
  // the tangent junction between the two tools is exactly the overlap-seam
  // category stitching exists to remove (measured: an exact rounded-rect rim
  // with 0.5 mm corner arcs under a 0.3 mm fillet drew ~6 lines per junction).
  // Absorbed into the sweep, the straight is geometrically identical — a prism
  // IS the one-segment case of the sweep — and the junction becomes an interior
  // tangent vertex the sweep miters.
  if (absorbLines) {
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i];
      if (c.kind !== "line") continue;
      const ends = [key(c.a), key(c.b)];
      const partner = open.find((p) => p.convex === c.convex &&
        [p.points[0], p.points[p.points.length - 1]].some((q) => ends.includes(key(q))));
      if (!partner) continue;
      const face = [c.n1, c.n2].find((n) => dot(n, partner.faceN) > FLANK_COS);
      if (!face) continue;
      const wall = face === c.n1 ? c.n2 : c.n1;
      out.splice(i, 1);
      open.push({ kind: "planar", points: [[...c.a], [...c.b]], closed: false,
                  convex: c.convex, w: face, faceN: face, wallNs: [wall] });
    }
  }
  if (open.length < 2) return [...out, ...open];
  const compatible = (a, b) => a.convex === b.convex && dot(a.faceN, b.faceN) > FLANK_COS &&
    Math.abs(dot(a.points[0], a.faceN) - dot(b.points[0], a.faceN)) <= TOL;
  const rev = (c) => ({ ...c, points: [...c.points].reverse(), wallNs: [...c.wallNs].reverse() });
  let progress = true;
  while (progress) {
    progress = false;
    outer: for (let i = 0; i < open.length; i++) {
      let a = open[i];
      // Orientations: b forward/reversed against a's END covers end-start and end-end;
      // the ordered (j,i) pass covers start-end. START-START needs a itself reversed —
      // without this clause two chains seeded outward from the same junction vertex
      // (the edge walk picks its seeds by graph order, not geometry) never stitch, and
      // their tools overshoot tangentially into each other at that junction.
      if (open.some((b, j) => j !== i && compatible(a, b) &&
        (key(b.points[0]) === key(a.points[0]) || key(b.points[b.points.length - 1]) === key(a.points[0]))) &&
        !open.some((b, j) => j !== i && compatible(a, b) &&
          (key(b.points[0]) === key(a.points[a.points.length - 1]) || key(b.points[b.points.length - 1]) === key(a.points[a.points.length - 1])))) {
        a = rev(a);
      }
      const aEnd = key(a.points[a.points.length - 1]);
      for (let j = 0; j < open.length; j++) {
        if (i === j || !compatible(a, open[j])) continue;
        let b = open[j];
        if (key(b.points[b.points.length - 1]) === aEnd) b = rev(b);
        if (key(b.points[0]) !== aEnd) continue;
        const points = [...a.points, ...b.points.slice(1)];
        const closed = key(points[0]) === key(points[points.length - 1]);
        const joined = { ...a, points, wallNs: [...a.wallNs, ...b.wallNs], closed };
        open.splice(Math.max(i, j), 1);
        open.splice(Math.min(i, j), 1);
        (closed ? out : open).push(joined);
        progress = true;
        break outer;
      }
    }
  }
  return [...out, ...open];
}

// Whole-path planar rescue, called by chainEdges when any of a path's runs classified
// unsupported: rebuild the ENTIRE path (every member, in walk order) as one candidate
// planar chain. See the promotion comment at the call site for why the whole path — and
// tryPlanarChain below for what qualifies.
function buildPlanarPath(edges, path) {
  const members = path.members.map((i) => edges[i]);
  const points = [vertPos(members[0], path.verts[0])];
  members.forEach((m, i) => points.push(vertPos(m, otherVid(m, path.verts[i]))));
  return tryPlanarChain(members, points, members[0].convex, path.loop);
}

// General-chain rescue (spec 2026-10-02): an edge between two curved faces — a pipe
// tee's saddle, a cross hole's rim, an ellipse where a plane cuts a tube — fails every
// constancy test the fixed-section tools need, yet the mesh still records BOTH exact
// flank normals per member. Accept the whole path if it keeps one convexity and has
// no knife edge; generalTool builds a cross-section per vertex from those normals.
// Flanks are paired against the PREVIOUS member's pairing (continuity), never a world
// frame: over a saddle the flank normals swing far enough that world pairing swaps
// them partway round (fitArcChain's rotating-frame argument, made local).
function buildGeneralPath(edges, path) {
  const members = path.members.map((i) => edges[i]);
  if (members.length < 2) return null;
  const convex = members[0].convex;
  if (!members.every((m) => m.convex === convex)) return null;
  const points = [vertPos(members[0], path.verts[0])];
  members.forEach((m, i) => points.push(vertPos(m, otherVid(m, path.verts[i]))));
  const closed = !!path.loop;
  if (closed) points.pop(); // loop: last vertex is the first; keep one copy
  const flanks = [];
  let prev = [members[0].n1, members[0].n2];
  for (const m of members) {
    const keep = dot(m.n1, prev[0]) + dot(m.n2, prev[1]) >= dot(m.n2, prev[0]) + dot(m.n1, prev[1]);
    const pair = keep ? [m.n1, m.n2] : [m.n2, m.n1];
    if (dot(pair[0], pair[1]) < -1 + 1e-6) return null; // knife edge: no wedge to blend
    flanks.push(pair);
    prev = pair;
  }
  if (closed) {
    const f0 = flanks[0], fl = flanks[flanks.length - 1];
    if (dot(f0[0], fl[0]) + dot(f0[1], fl[1]) < dot(f0[0], fl[1]) + dot(f0[1], fl[0])) return null; // pairing cannot close
  }
  return { kind: "general", points, closed, convex, flanks };
}

// One station per path vertex, plus interior stations on members much longer than the
// median (a long facet between short ones would otherwise step the section) — at most
// MAX_MEMBER_STATIONS per member. The median is by COUNT, so a path that is mostly
// slivers has a tiny median and, uncapped, one long member between them asked for
// ceil(L / 2·median) − 1 stations: 500 003 for a sliver(1e-5)–10 mm–sliver path, which
// smoothing cannot merge and every ring of which went through ofMesh (and a zero
// median — duplicate points — asked for infinitely many). The cap sits above every
// count the fixtures and the fillet census ask for (largest: 329, on a knob; 71
// public forges + 56 eval parts, preview and print), so no real part's stations
// change; it only bounds the pathological case, which MAX_GENERAL_STATIONS then
// bounds per chain. A
// vertex's tangent bisects its two members; its flank normals average the incident
// members' (paired) normals, projected perpendicular to the tangent. `tilt` is how far
// that average sits from the incident facets — generalTool's grazing allowance.
export const MAX_MEMBER_STATIONS = 512;
export function generalStations(chain) {
  const { points, closed, flanks } = chain;
  const n = points.length;
  const nMem = closed ? n : n - 1;
  const memDir = (i) => norm(sub(points[(i + 1) % n], points[i]));
  const memLen = (i) => len(sub(points[(i + 1) % n], points[i]));
  const perp = (v, t) => norm(sub(v, scl(t, dot(v, t))));
  const angle = (a, b) => Math.acos(clamp1(dot(a, b)));
  const lens = Array.from({ length: nMem }, (_, i) => memLen(i)).sort((a, b) => a - b);
  const median = lens[lens.length >> 1];
  const vertexStation = (v) => {
    const inc = [];
    if (closed || v > 0) inc.push((v - 1 + nMem) % nMem);
    if (closed || v < n - 1) inc.push(v % nMem);
    const t = norm(inc.reduce((acc, i) => add(acc, memDir(i)), [0, 0, 0]));
    const raw1 = norm(inc.reduce((acc, i) => add(acc, flanks[i][0]), [0, 0, 0]));
    const raw2 = norm(inc.reduce((acc, i) => add(acc, flanks[i][1]), [0, 0, 0]));
    let tilt = 0;
    for (const i of inc) tilt = Math.max(tilt, angle(raw1, flanks[i][0]), angle(raw2, flanks[i][1]));
    return { p: points[v], t, n1: perp(raw1, t), n2: perp(raw2, t), tilt };
  };
  const out = [];
  for (let v = 0; v < n; v++) {
    out.push(vertexStation(v));
    if (!closed && v === n - 1) break;
    const L = memLen(v);
    const extra = Math.min(MAX_MEMBER_STATIONS, Math.ceil(L / (2 * median)) - 1);
    const t = memDir(v), [f1, f2] = flanks[v];
    for (let j = 1; j <= extra; j++) {
      const s = j / (extra + 1);
      out.push({ p: add(points[v], scl(sub(points[(v + 1) % n], points[v]), s)), t,
        n1: perp(f1, t), n2: perp(f2, t), tilt: 0 });
    }
  }
  return out;
}

// Rescue an unsupported path as a PLANAR chain: every point of the path lies in one plane,
// one flank IS that plane's face (a world-constant normal — the top of an extrusion, the
// plate around a boss), and the other flank — the wall — turns with the path at a constant
// dihedral. Top and bottom rims of extruded profiles whose outlines are neither straight
// nor circular (text, offset outlines, splines) are exactly this shape, and they used to
// be this module's most common NEEDS_OCCT reroute. The blend tool for a planar chain is a
// sweep of the same 2-D cross-section the prism and revolve tools use (planarTool below):
// in the sweep's transported frame both flanks have constant coordinates along the whole
// run — the same rotating-frame argument fitArcChain makes about surfaces of revolution —
// so one fixed profile blends the entire path.
//
// Flank pairing keys on the CANDIDATE face normal itself (each of member 0's two flanks
// in turn): every member contributes whichever of its flanks lies closer to the candidate.
// Neighbor-pairing — the trick classifyChain's line branch uses — is deliberately NOT
// reused here: over a long turning run the wall normal rotates far enough that it pairs
// against the face and scrambles both columns (measured on a 37-edge run of the wavy-rim
// fixture). Keying on the candidate is stable however far the wall turns, because the
// true face flank stays within FLANK_COS of it while the wall sits a whole dihedral away.
// A run where neither candidate yields a constant column (a helix, a saddle) returns null
// and stays unsupported — the rescue never guesses.
const FLANK_COS = 0.9986;   // ~3°, the same constancy bar the line classifier uses
function tryPlanarChain(members, points, convex, closed) {
  if (points.length < 3) return null;              // a 2-point run is a line chain's job
  for (const cand of [members[0].n1, members[0].n2]) {
    const face = [], wall = [];
    for (const m of members) {
      const [f, wl] = dot(m.n1, cand) >= dot(m.n2, cand) ? [m.n1, m.n2] : [m.n2, m.n1];
      face.push(f);
      wall.push(wl);
    }
    const meanRaw = face.reduce((s, f) => add(s, f), [0, 0, 0]);
    if (len(meanRaw) < 1e-9) continue;
    const w = norm(meanRaw);
    if (!face.every((f) => dot(f, w) > FLANK_COS)) continue;          // not world-constant
    const d0 = dot(points[0], w);
    if (!points.every((p) => Math.abs(dot(p, w) - d0) <= TOL)) continue;   // run not in the face plane
    const dots = wall.map((n) => dot(n, w));
    const meanDot = dots.reduce((s, x) => s + x, 0) / dots.length;
    if (!dots.every((x) => Math.abs(x - meanDot) <= 0.05)) continue;  // dihedral drifts (~3°)
    return { kind: "planar", points, closed, convex, w, faceN: w, wallNs: wall };
  }
  return null;
}

function buildChain(edges, path, ks, type, closed) {
  // ks are positions along the path; path.members maps them to global edge indices
  const members = ks.map((k) => edges[path.members[k]]);
  const convex = members[0].convex;
  // ordered polyline: the member at path position k runs path.verts[k] -> path.verts[k+1]
  const points = [vertPos(members[0], path.verts[ks[0]])];
  ks.forEach((k, i) => points.push(vertPos(members[i], otherVid(members[i], path.verts[k]))));
  if (type !== "arc") {
    // pair flank normals consistently against the first member (world frame is
    // fine here — straight chains have near-constant flank normals)
    const ref = members[0];
    const flanks = members.map((m) => (dot(m.n1, ref.n1) >= dot(m.n2, ref.n1) ? [m.n1, m.n2] : [m.n2, m.n1]));
    const a = points[0], b = points[points.length - 1];
    const dir = norm(sub(b, a));
    const n1 = norm(flanks.reduce((s, f) => add(s, f[0]), [0, 0, 0]));
    const n2 = norm(flanks.reduce((s, f) => add(s, f[1]), [0, 0, 0]));
    // planar-flank sanity: every member within ~3° of the mean
    const planar = flanks.every((f) => dot(f[0], n1) > 0.9986 && dot(f[1], n2) > 0.9986);
    if (!planar) return { kind: "unsupported", reason: "straight edge with non-planar flanks", points, convex };
    return { kind: "line", points, a, b, dir, length: len(sub(b, a)), n1, n2, convex };
  }
  return fitArcChain(members, points, convex, closed);
}
const vertPos = (e, vid) => (vid === e.ua ? e.a : e.b);
const otherVid = (e, vid) => (vid === e.ua ? e.ub : e.ua);

// Circumcircle fit + rotating-frame flank extraction for an arc run.
function fitArcChain(members, points, convex, closed) {
  const bad = (reason) => ({ kind: "unsupported", reason, points, convex });
  const n = points.length;
  if (n < 3) return bad("arc run too short to fit");
  const p0 = points[0], pm = points[Math.floor(n / 2)], pn = closed ? points[Math.floor((2 * n) / 3)] : points[n - 1];
  // circumcircle of three points
  const e1 = sub(pm, p0), e2 = sub(pn, p0);
  const w0 = cross(e1, e2);
  if (len(w0) < 1e-12) return bad("arc points are collinear");
  const w = norm(w0);
  const l1 = dot(e1, e1), l2 = dot(e2, e2), c12 = dot(e1, e2);
  const det = 2 * (l1 * l2 - c12 * c12);
  const alpha = (l2 * (l1 - c12)) / det, beta = (l1 * (l2 - c12)) / det;
  const O = add(p0, add(scl(e1, alpha), scl(e2, beta)));
  const R = len(sub(p0, O));
  // The fit tolerance is ABSOLUTE and tight (2 µm) on purpose, sandwiched from both
  // sides. Below: it must ACCEPT this module's own blend rims — profile2D's area-exact
  // bump parks interior arc vertices up to r·θ²/12 ≈ 1.3 µm off the true circle (the
  // sagitta bound caps θ so that ceiling is density-independent), and a true revolved
  // rim's float32 quantization is far under that. Above: it must REJECT an offset
  // outline that merely APPROXIMATES a circle after simplify() — those deviate by
  // several microns, and the revolve tool follows the FITTED circle, so accepting one
  // turns every real deviation into tangent-seam jitter along the whole run (measured:
  // a label backing drew ~450 band-edge lines from two accepted pseudo-arcs). Rejected
  // rims fall through to the planar-path rescue, whose sweep follows the true polyline
  // exactly. The old max(1e-3, 1e-3·R) relative term is what let the pseudo-arcs in.
  const rtol = 2e-3;
  for (const p of points) {
    if (Math.abs(len(sub(p, O)) - R) > rtol) return bad("edge curve is not circular");
    if (Math.abs(dot(sub(p, O), w)) > rtol) return bad("edge curve is not planar");
  }
  // Chord-dip gate: the wall facets hang on these same points, so the deepest chord
  // midpoint below the fitted circle measures how coarse the flank tessellation
  // really is. The revolve tool is the right instrument only for kernel-quality
  // surfaces of revolution — its tangent extension chases facets a few microns deep.
  // A rim whose facets dip an order deeper (a polygonal prism, a coarse offset
  // outline) must blend along its own polyline instead: the planar rescue's sweep
  // makes station-exact contact per facet, where a revolve's round tail can only
  // graze a deep flat facet (measured: 24-gon rim, 188 band lines as an arc, zero as
  // a planar chain). Bound: 3× the dip a DEFAULT_SEGS-quality wall would have, plus
  // the fit tolerance both sides of the chord ride on.
  let dip = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const q = sub(scl(add(points[i], points[i + 1]), 0.5), O);
    dip = Math.max(dip, R - len(sub(q, scl(w, dot(q, w)))));
  }
  if (dip > 3 * R * (1 - Math.cos(Math.PI / DEFAULT_SEGS)) + 2 * rtol)
    return bad("edge polyline is coarser than a kernel-quality surface of revolution");
  // frame: azimuth 0 at the first point; flip w so azimuths increase along the run
  const u0 = norm(sub(points[0], O));
  let v0 = cross(w, u0);
  const az = (p) => Math.atan2(dot(sub(p, O), v0), dot(sub(p, O), u0));
  let wS = w, v0S = v0;
  if (!closed && az(points[1]) < 0) { wS = scl(w, -1); v0S = cross(wS, u0); }
  else if (closed && az(points[1]) < 0) { wS = scl(w, -1); v0S = cross(wS, u0); }
  const azS = (p) => { const a = Math.atan2(dot(sub(p, O), v0S), dot(sub(p, O), u0)); return a < -1e-9 ? a + 2 * Math.PI : a; };
  let span = 2 * Math.PI;
  if (!closed) {
    let prev = 0;
    for (let i = 1; i < n; i++) {
      const a = azS(points[i]);
      if (a < prev - 1e-9) return bad("arc azimuths not monotonic");
      prev = a;
    }
    span = azS(points[n - 1]);
  }
  // rotating-frame flanks: constant (ρ, ζ) components, negligible azimuthal part.
  // Pairing happens HERE, in the rotating frame — a revolved wall's world-space
  // normal flips sign across the circle, so world-frame pairing would swap flanks
  // on the far side.
  const rfRaw = members.map((m) => {
    const mid = scl(add(vertPos(m, m.ua), vertPos(m, m.ub)), 0.5);
    const th = azS(mid);
    const rho = add(scl(u0, Math.cos(th)), scl(v0S, Math.sin(th)));
    const azv = cross(wS, rho);
    return [m.n1, m.n2].map((f) => {
      if (Math.abs(dot(f, azv)) > 0.2) return null; // not a surface of revolution about this axis
      const v2 = [dot(f, rho), dot(f, wS)];
      const l = Math.hypot(v2[0], v2[1]);
      return [v2[0] / l, v2[1] / l];
    });
  });
  if (rfRaw.some((pair) => pair.some((f) => f === null))) return bad("flank is not a surface of revolution about the edge axis");
  const refRf = rfRaw[0];
  const rf = rfRaw.map(([f1, f2]) =>
    f1[0] * refRf[0][0] + f1[1] * refRf[0][1] >= f2[0] * refRf[0][0] + f2[1] * refRf[0][1] ? [f1, f2] : [f2, f1]);
  const mean = (idx) => {
    const s = rf.reduce((acc, pair) => [acc[0] + pair[idx][0], acc[1] + pair[idx][1]], [0, 0]);
    const l = Math.hypot(s[0], s[1]); return [s[0] / l, s[1] / l];
  };
  const n1 = mean(0), n2 = mean(1);
  const ok = rf.every((pair) => pair[0][0] * n1[0] + pair[0][1] * n1[1] > 0.9986 && pair[1][0] * n2[0] + pair[1][1] * n2[1] > 0.9986);
  if (!ok) return bad("flank angle varies along the arc");
  return { kind: "arc", points, O, w: wS, u0, v0: v0S, R, span, closed, n1, n2, convex };
}

// ---------------------------------------------------------------------------
// Selector: the edge-selector.js object form, evaluated against a chain.
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const PLANE_AXIS = { XY: 2, XZ: 1, YZ: 0 };
export function matchesSelector(chain, sel) {
  if (sel == null) return true;
  if (typeof sel === "function")
    throw new UnsupportedEdgeError("function selectors are OCCT-specific — use the {dir, inPlane, at, near} object form");
  const { dir, inPlane, at, near } = sel;
  if (dir !== undefined) {
    if (chain.kind !== "line") return false; // like replicad inDirection: straight edges only
    const d = Array.isArray(dir) ? norm(dir) : AXIS[dir];
    if (!d) throw new Error(`mesh fillet: unknown dir ${JSON.stringify(dir)}`);
    if (Math.abs(dot(chain.dir, d)) < Math.cos((1 * Math.PI) / 180)) return false;
  }
  if (inPlane !== undefined) {
    const ax = PLANE_AXIS[inPlane];
    if (ax === undefined) throw new Error(`mesh fillet: unknown inPlane ${JSON.stringify(inPlane)}`);
    const c = at ?? 0;
    if (!chain.points.every((p) => Math.abs(p[ax] - c) <= TOL)) return false;
  }
  if (near !== undefined) {
    if (chain.kind === "arc") {
      // Select against the fitted circle, not its tessellated chords. An exact
      // design-space point between two mesh vertices sits one facet sagitta away
      // from the chord and must not spuriously miss (and reroute to OCCT).
      const q = sub(near, chain.O);
      const axial = dot(q, chain.w);
      const radial = sub(q, scl(chain.w, axial));
      if (Math.abs(axial) > TOL || Math.abs(len(radial) - chain.R) > TOL) return false;
      if (!chain.closed) {
        let az = Math.atan2(dot(radial, chain.v0), dot(radial, chain.u0));
        if (az < 0) az += 2 * Math.PI;
        const angularTol = TOL / Math.max(chain.R, TOL);
        if (az > chain.span + angularTol && 2 * Math.PI - az > angularTol) return false;
      }
    } else {
      let best = Infinity;
      // A closed general chain keeps no duplicated closing point, so its last
      // member wraps points[n-1] -> points[0]; other kinds keep the original loop.
      const pn = chain.points.length, wrap = chain.kind === "general" && chain.closed;
      for (let i = 0; wrap ? i < pn : i + 1 < pn; i++) {
        const a = chain.points[i], b = chain.points[(i + 1) % pn];
        const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(near, a), ab) / (dot(ab, ab) || 1)));
        best = Math.min(best, len(sub(near, add(a, scl(ab, t)))));
      }
      if (best > TOL) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shared 2D cross-section profile. P is the edge point, n1/n2 the unit flank
// normals, all in the cross-section plane. Fillet connects the tangent points
// with the rolling-ball arc; chamfer with a straight chord. Convex profiles
// hang off the corner (oversized past it by delta so no cutter wall is exactly
// coplanar with a flank); concave profiles tuck the corner point into the
// material so the filler welds on.
const rot2 = ([x, y], th) => [x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)];
function profile2D({ P, n1, n2, magnitude, mode, convex, segs, ext = 0, nArc: nArcFixed }) {
  const c = clamp1(n1[0] * n2[0] + n1[1] * n2[1]);
  // `knifeEdge` marks the refusal as the anti-parallel-flank degeneracy, so the
  // planar rim machinery can SKIP a noise stretch (a sliver facet's flipped
  // normal) instead of failing the whole selection on it.
  if (1 + c < 1e-6) throw Object.assign(new UnsupportedEdgeError("~180° knife edge"), { knifeEdge: true });
  const bl = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]);
  const bis = [(n1[0] + n2[0]) / bl, (n1[1] + n2[1]) / bl];
  const delta = 0.02 * magnitude;
  const sgn = convex ? 1 : -1; // +bis is outside the material at a convex corner, inside at a concave one
  const corner = [P[0] + sgn * delta * bis[0], P[1] + sgn * delta * bis[1]];
  if (mode === "chamfer") {
    // setback along each flank surface, away from the edge: perpendicular to the
    // normal, on the material side of the bisector (which points out of the
    // material at a convex corner and into the air pocket at a concave one)
    const inFace = (nv) => {
      let f = [-nv[1], nv[0]];
      if (sgn * (f[0] * bis[0] + f[1] * bis[1]) > 0) f = [-f[0], -f[1]];
      return f;
    };
    const f1 = inFace(n1), f2 = inFace(n2);
    const T1 = [P[0] + magnitude * f1[0], P[1] + magnitude * f1[1]];
    const T2 = [P[0] + magnitude * f2[0], P[1] + magnitude * f2[1]];
    if (ext > 0) {
      // revolve tools: extend the chord past both flanks so the tool's closing
      // walls clear the flank tessellation instead of hugging it (same float
      // phase-noise issue the fillet's arc extension solves); the extra polygon
      // area lies outside the material for cutters and inside it for fillers
      const ux = T1[0] - T2[0], uy = T1[1] - T2[1], ul = Math.hypot(ux, uy);
      const e = 0.02 * magnitude;
      T1[0] += (e * ux) / ul; T1[1] += (e * uy) / ul;
      T2[0] -= (e * ux) / ul; T2[1] -= (e * uy) / ul;
    }
    return [corner, T1, T2];
  }
  const r = magnitude;
  const C = [P[0] + sgn * (-r / (1 + c)) * (n1[0] + n2[0]), P[1] + sgn * (-r / (1 + c)) * (n1[1] + n2[1])];
  const phi = Math.atan2(n1[0] * n2[1] - n1[1] * n2[0], c); // signed angle n1 → n2
  // `ext` (radians) continues the arc a hair past both tangent points — used by
  // revolve cutters only. At the tangent the blend surface touches the flank
  // without crossing it; for two curved tessellations (posed revolve vs flank
  // facets) float phase noise turns that contact into a wiggle of degenerate
  // sliver triangles. Overshooting makes the cutter cross the flank decisively,
  // penetrating the material by only r·(1−cos ext) ≈ r·5e-5 mm, far below
  // visibility, and the extension curves into the material for cutters and
  // fillers alike. Prism cutters keep ext = 0: their tangent contact is
  // plane-on-plane, which the kernel resolves exactly.
  const s2 = Math.sign(phi) || 1, span = Math.abs(phi);
  // general chains pass a fixed count so every station's ring has the same size
  const nArc = nArcFixed ?? Math.max(2, Math.ceil((span / (2 * Math.PI)) * segs));
  // Area-exact tessellation: an inscribed chord polygon under-sweeps the ball arc by a
  // first-order-in-facet-angle area deficit whose RELATIVE size is radius-independent
  // (~0.23/n² of the blend cross-section) — at the sagitta-bounded density above it
  // would bias every blend's volume by ~0.2-0.3%. Interior vertices sit at
  // r·√(θ/sinθ), the radius at which the chord polygon sweeps exactly the arc's area
  // (a micron-scale outward nudge that is material-safe in both boolean directions:
  // a cutter bites a hair deeper mid-chord, a filler overlaps a hair more). The two
  // END vertices stay exactly on the ball — they are the seam with the flanks.
  const th = (span + 2 * ext) / nArc;
  const rEq = r * Math.sqrt(th / Math.sin(th));
  const pts = [corner];
  for (let i = 0; i <= nArc; i++) {
    const nv = rot2(n1, s2 * (-ext + ((span + 2 * ext) * i) / nArc));
    const ri = i === 0 || i === nArc ? r : rEq;
    pts.push([C[0] + sgn * ri * nv[0], C[1] + sgn * ri * nv[1]]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Cutter/filler solids.
function prismTool(k, chain, magnitude, mode, segs, pSegs = segs) {
  const { a, dir: e, length, n1, n2, convex } = chain;
  // pose rotation Z → e; the 2D basis is the image of X,Y under the SAME rotation
  const axisRaw = cross([0, 0, 1], e);
  const s = len(axisRaw);
  let axis = null, theta = 0;
  if (s > 1e-9) { axis = scl(axisRaw, 1 / s); theta = Math.atan2(s, e[2]); }
  else if (e[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
  const u = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
  const v = axis ? rotVec([0, 1, 0], axis, theta) : [0, 1, 0];
  const p2 = (w) => [dot(w, u), dot(w, v)];
  const poly = profile2D({ P: [0, 0], n1: p2(n1), n2: p2(n2), magnitude, mode, convex, segs: pSegs });
  // convex cutters overshoot the edge ends (sticking outside the solid is
  // harmless when subtracting, and at a rounded corner the overshoot continues
  // tangentially into the arc tool, like a stadium rim's prisms always have);
  // concave fillers must end flush — any overshoot would bulge outside the part
  // when unioned
  const over = convex ? Math.max(1e-3, 0.05 * magnitude) : 0;
  let tool = k.loft(
    [{ polygon: poly, z: -over }, { polygon: poly, z: length + over }],
    { shading: "smooth" },
  );
  if (axis) tool = tool.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
  tool = tool.translate(a);
  return mode === "fillet" ? markBlend(k, tool, { kind: "line", p: add(a, ballOffset(n1, n2, magnitude, convex)), d: e }) : tool;
}

// Centre of the circle through a, b, c (null when collinear).
function circumcentre(a, b, c) {
  const e1 = sub(b, a), e2 = sub(c, a), w = cross(e1, e2), ww = dot(w, w);
  if (ww < 1e-18) return null;
  const t = add(scl(cross(w, e1), dot(e2, e2)), scl(cross(e2, w), dot(e1, e1)));
  return add(a, scl(t, 1 / (2 * ww)));
}

// Grazing burial for general chamfers (see generalTool): GENERAL_SAG_PAD is the
// chamfer's burial pad beyond the facet-tilt sagitta (mm, capped at 2% of the
// chamfer). On the general fixtures (test/mesh-fillet-general.test.js) it does not
// bind: every fixture stays a single shell at preview AND print quality with it at 0.
// What did strand slivers was the chamfer's side walls skimming the flank — fixed by
// the chord extension in generalTool, not by deeper burial (a deeper sag made it
// worse). General FILLETS end on the measured wall instead (contactPolygon).
const GENERAL_SAG_PAD = 2e-4;

// Station smoothing. generalStations places a station at every path vertex, and on a
// mesh-boolean intersection those vertices are tessellation, not geometry: a facet
// ridge crossing kinks the polyline, and two ridges a hair apart leave a sliver
// segment whose three-point circumradius reads a 3 mm bend as 0.2 mm. Smooth before
// building rings: stations closer than MERGE_FRAC × the median spacing merge into a
// neighbour; each tangent becomes the chord between the points ~magnitude/2 of arc
// length either side (clamped at open ends), with the flank normals re-projected
// perpendicular to it; and the fold guard reads the circumcircle over that same span.
// Ring planes then turn as smoothly as the geometry, so a kink cannot fold the stack.
const MERGE_FRAC = 0.2;
function smoothStations(st0, closed, magnitude) {
  const m0 = st0.length;
  const gaps = [];
  for (let i = 0; i < (closed ? m0 : m0 - 1); i++) gaps.push(len(sub(st0[(i + 1) % m0].p, st0[i].p)));
  const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1] || 0;
  const minGap = MERGE_FRAC * median;
  const st = [st0[0]];
  for (let i = 1; i < m0; i++) {
    if (len(sub(st0[i].p, st[st.length - 1].p)) >= minGap) st.push(st0[i]);
    else if (!closed && i === m0 - 1 && st.length > 1) st[st.length - 1] = st0[i]; // open ends stay put
  }
  if (closed && st.length > 3 && len(sub(st[0].p, st[st.length - 1].p)) < minGap) st.pop();
  const m = st.length;
  const cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + len(sub(st[i].p, st[i - 1].p)));
  const L = closed ? cum[m - 1] + len(sub(st[0].p, st[m - 1].p)) : cum[m - 1];
  const pointAt = (s) => {
    if (closed) s = ((s % L) + L) % L;
    else s = Math.max(0, Math.min(L, s));
    let lo = 0, hi = m - 1;
    if (s >= cum[m - 1]) { lo = m - 1; } else { while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; } }
    const a = st[lo].p, b = st[(lo + 1) % m].p;
    const segL = (lo === m - 1 ? L : cum[lo + 1]) - cum[lo];
    return segL > 0 ? add(a, scl(sub(b, a), (s - cum[lo]) / segL)) : a;
  };
  const h = magnitude / 2;
  const perp = (v, t) => norm(sub(v, scl(t, dot(v, t))));
  return st.map((s, i) => {
    const prev = pointAt(cum[i] - h), next = pointAt(cum[i] + h);
    const chord = sub(next, prev);
    const t = len(chord) > 1e-12 ? norm(chord) : s.t;
    const interior = closed || (cum[i] - h >= 0 && cum[i] + h <= L);
    return { p: s.p, t, n1: perp(s.n1, t), n2: perp(s.n2, t), tilt: s.tilt, prev, next, interior };
  });
}

// Osculating curvature of one flank in the section plane, signed so that κ < 0 is a
// flank falling away from its tangent line into the material (a convex tube seen
// from outside) and κ > 0 one rising into the air. Probe: step `s` along the flank's
// in-face direction f from the edge point p, cast both ways along the flank normal n
// (range 2s) and take the nearest hit on a triangle facing roughly along n (the
// OTHER flank, and back-facing or far geometry, are skipped); the circle tangent to
// the flank at p through that hit has κ = 2h/(s² + h²). A miss, or a bend too tight
// to trust (|κ|·s ≥ 0.9), reads as a straight flank.
const FLANK_FACING_COS = 0.82; // ~35°
function flankCurvature(rays, p, n, f, s) {
  if (!rays) return 0;
  const S = add(p, scl(f, s));
  let best = null;
  for (const sign of [1, -1]) {
    const hit = rays.nearest(S, scl(n, sign), 2 * s, (fn) => dot(fn, n) >= FLANK_FACING_COS);
    if (hit && (!best || hit.t < best.t)) best = { t: hit.t, h: sign * hit.t };
  }
  if (!best) return 0;
  const kappa = (2 * best.h) / (s * s + best.h * best.h);
  return Math.abs(kappa) * s >= 0.9 ? 0 : kappa;
}

// Short-range ray casts against the part's own mesh, for flankCurvature. Local on
// purpose: only the triangles whose bounds come within the padded box of a general
// chain are kept. Deliberately NOT oracle/bvh.js — the cut & print kit loads this
// module and must never load the oracle (test/kit-layering.test.js). Every probe is
// short (range 2 × magnitude), so the kept triangles go into a uniform grid of
// `cell`-sized cubes (cell = the probe range: a probe's box is at most one cell
// wide plus a hair of padding, so it touches at most 3 cells per axis — usually 2)
// and a probe tests only the triangles sharing a cell with its segment's box. That set contains every triangle the segment can hit, so the nearest hit is
// exactly the brute-force one — the brute force over every kept triangle measured
// 2.6 × 10⁹ triangle tests and 65 s on a chain-mail sheet (Task 4b report). A
// triangle spanning more than GRID_BIG_CELLS cells (a long flat facet) is tested by
// every probe instead of being copied into all of them.
const GRID_BIG_CELLS = 512;
function localRays({ positions: P, indices: I }, boxes, cell) {
  const keep = [];
  for (let t = 0; t < I.length; t += 3) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let j = 0; j < 3; j++) {
      const o = I[t + j] * 3, x = P[o], y = P[o + 1], z = P[o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (boxes.some((b) => x1 >= b[0] && x0 <= b[3] && y1 >= b[1] && y0 <= b[4] && z1 >= b[2] && z0 <= b[5])) keep.push(t);
  }
  const nT = keep.length;
  const V = new Float64Array(nT * 9);
  keep.forEach((t, i) => { for (let j = 0; j < 3; j++) { const o = I[t + j] * 3; V[i * 9 + j * 3] = P[o]; V[i * 9 + j * 3 + 1] = P[o + 1]; V[i * 9 + j * 3 + 2] = P[o + 2]; } });
  // grid over the kept triangles' bounds; a cell key is ix + nx·(iy + ny·iz), exact
  // in a double for any grid this module can meet
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let b = 0; b < V.length; b += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], V[b + a]); hi[a] = Math.max(hi[a], V[b + a]); }
  const pad = 1e-6 * cell;
  const nx = Math.max(1, Math.floor((hi[0] - lo[0]) / cell) + 1), ny = Math.max(1, Math.floor((hi[1] - lo[1]) / cell) + 1);
  const ci = (x, a) => Math.floor((x - lo[a]) / cell);
  const cells = new Map(), big = [];
  for (let i = 0; i < nT; i++) {
    const b = i * 9;
    const r0 = [0, 0, 0], r1 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const v0 = V[b + a], v1 = V[b + 3 + a], v2 = V[b + 6 + a];
      r0[a] = ci(Math.min(v0, v1, v2) - pad, a); r1[a] = ci(Math.max(v0, v1, v2) + pad, a);
    }
    if ((r1[0] - r0[0] + 1) * (r1[1] - r0[1] + 1) * (r1[2] - r0[2] + 1) > GRID_BIG_CELLS) { big.push(i); continue; }
    for (let z = r0[2]; z <= r1[2]; z++) for (let y = r0[1]; y <= r1[1]; y++) for (let x = r0[0]; x <= r1[0]; x++) {
      const key = x + nx * (y + ny * z);
      const list = cells.get(key);
      if (list) list.push(i); else cells.set(key, [i]);
    }
  }
  const stamp = new Int32Array(nT);
  let probe = 0;
  // nearest hit within (0, tMax] on a triangle whose unit normal passes `accept`.
  // Möller–Trumbore with scalar temporaries, in the same operation order as the
  // vector helpers (so a hit's t is bit-identical to the brute-force form).
  const test = (i, o, d, tMax, accept, best) => {
    const b = i * 9, ax = V[b], ay = V[b + 1], az = V[b + 2];
    const e1x = V[b + 3] - ax, e1y = V[b + 4] - ay, e1z = V[b + 5] - az;
    const e2x = V[b + 6] - ax, e2y = V[b + 7] - ay, e2z = V[b + 8] - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return best;
    const tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
    const u = (tx * px + ty * py + tz * pz) / det;
    if (u < 0 || u > 1) return best;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
    if (v < 0 || u + v > 1) return best;
    const t = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (!(t > 1e-9 && t <= tMax) || (best && t >= best.t)) return best;
    const fn = norm(cross([e1x, e1y, e1z], [e2x, e2y, e2z]));
    if (!accept(fn)) return best;
    return { t, n: fn };
  };
  const nearest = (o, d, tMax, accept) => {
    let best = null;
    probe++;
    const r0 = [0, 0, 0], r1 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const e = o[a] + d[a] * tMax;
      r0[a] = Math.max(0, ci(Math.min(o[a], e) - pad, a)); r1[a] = ci(Math.max(o[a], e) + pad, a);
    }
    for (let z = r0[2]; z <= r1[2]; z++) for (let y = r0[1]; y <= r1[1]; y++) for (let x = r0[0]; x <= r1[0]; x++) {
      if (x >= nx || y >= ny) continue;
      const list = cells.get(x + nx * (y + ny * z));
      if (!list) continue;
      for (const i of list) {
        if (stamp[i] === probe) continue;
        stamp[i] = probe;
        best = test(i, o, d, tMax, accept, best);
      }
    }
    for (const i of big) best = test(i, o, d, tMax, accept, best);
    return best;
  };
  return { nearest };
}

// Rolling-ball section with curved flanks — pure 2-D, edge point at the origin. n1/n2
// are the unit flank normals, k1/k2 their section-plane curvatures (flankCurvature's
// sign convention; 0 = straight). Each flank is the circle tangent to its tangent line
// at the edge with that curvature, or the line itself. The ball centre C sits at
// distance r from both curves on the material side (convex: cutter) or the air side
// (concave: filler) — profile2D's tangent-line centre is the Newton start, and the
// solve falls back to it (straight flanks) when it does not converge nearby. Returns
// C, the contacts T1/T2, the arc's start direction m1, signed sweep phi, and the
// flank descriptions sectionPolygon needs.
function curvedBall({ n1, n2, k1, k2, magnitude: r, convex }) {
  const c = clamp1(n1[0] * n2[0] + n1[1] * n2[1]);
  if (1 + c < 1e-6) throw Object.assign(new UnsupportedEdgeError("~180° knife edge"), { knifeEdge: true });
  const sgn = convex ? 1 : -1;
  const bl = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]);
  const bis = [(n1[0] + n2[0]) / bl, (n1[1] + n2[1]) / bl];
  const inFace = (nv) => { let f = [-nv[1], nv[0]]; if (sgn * (f[0] * bis[0] + f[1] * bis[1]) > 0) f = [-f[0], -f[1]]; return f; };
  const flank = (n, kap) => ({ n, f: inFace(n), kap, O: kap ? [n[0] / kap, n[1] / kap] : null, R: kap ? 1 / Math.abs(kap) : Infinity });
  const solve = (F1, F2) => {
    // signed distance to a flank, positive on its air side, and its gradient
    const dist = (F, X) => {
      if (!F.O) return { d: X[0] * F.n[0] + X[1] * F.n[1], g: F.n };
      const dx = X[0] - F.O[0], dy = X[1] - F.O[1], D = Math.hypot(dx, dy) || 1e-12, sk = Math.sign(F.kap);
      return { d: sk * (F.R - D), g: [(-sk * dx) / D, (-sk * dy) / D] };
    };
    const foot = (F, X) => {
      if (!F.O) { const d = X[0] * F.n[0] + X[1] * F.n[1]; return [X[0] - d * F.n[0], X[1] - d * F.n[1]]; }
      const dx = X[0] - F.O[0], dy = X[1] - F.O[1], D = Math.hypot(dx, dy);
      return [F.O[0] + (F.R * dx) / D, F.O[1] + (F.R * dy) / D];
    };
    const C0 = [(-sgn * r * (n1[0] + n2[0])) / (1 + c), (-sgn * r * (n1[1] + n2[1])) / (1 + c)];
    let C = C0, ok = false;
    for (let it = 0; it < 40; it++) {
      const a = dist(F1, C), b = dist(F2, C);
      const e1 = a.d + sgn * r, e2 = b.d + sgn * r;
      if (Math.abs(e1) < 1e-12 && Math.abs(e2) < 1e-12) { ok = true; break; }
      const det = a.g[0] * b.g[1] - a.g[1] * b.g[0];
      if (Math.abs(det) < 1e-12) break;
      C = [C[0] - (e1 * b.g[1] - e2 * a.g[1]) / det, C[1] - (a.g[0] * e2 - b.g[0] * e1) / det];
    }
    if (!ok || Math.hypot(C[0] - C0[0], C[1] - C0[1]) > 2 * r) return null;
    const T1 = foot(F1, C), T2 = foot(F2, C);
    const a1 = T1[0] * F1.f[0] + T1[1] * F1.f[1], a2 = T2[0] * F2.f[0] + T2[1] * F2.f[1];
    if (!(a1 > 0 && a2 > 0)) return null; // contact behind the edge: not this corner's ball
    const m1 = norm2([sgn * (T1[0] - C[0]), sgn * (T1[1] - C[1])]);
    const m2 = norm2([sgn * (T2[0] - C[0]), sgn * (T2[1] - C[1])]);
    const phi = Math.atan2(m1[0] * m2[1] - m1[1] * m2[0], clamp1(m1[0] * m2[0] + m1[1] * m2[1]));
    return { C, T1, T2, a1, a2, m1, phi, F1, F2, bis, sgn };
  };
  return solve(flank(n1, k1), flank(n2, k2)) ?? solve(flank(n1, 0), flank(n2, 0));
}
const norm2 = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

// Measuring the wall AT the contact (refineBall). flankCurvature reads each flank at
// the EDGE, from the station's averaged facet normals; on a faceted cylinder those
// step by a facet's turn (~3° at preview), and the ball solved from them jumped by up
// to r·Δθ/2 per facet — 25 µm of spine jitter on the cross hole, lumpy bands and up
// to 7° of shading error. The ball only cares about the wall where it touches it, so
// each station re-measures both flanks there: a five-hit patch (wallPatch) around the
// current contact gives the wall's secant normal through a point ON the facets, the
// ball is re-solved tangent to the two local tangent lines, and the contacts move.
// Measured on the cross hole and tee (r = 1, 1.5, 2): a second round changes nothing
// a first one left (one round leaves the tee at r = 1 at 2.95°, two at 1.35°, three
// the same as two), and the patch half-width CONTACT_D × r is flat from 0.15 to 0.4
// in shading (1.4°) and line placement (≤ 17 µm); 0.3 keeps a probe's reach well
// inside its flank on small features while spanning several preview facets (the
// facet sag error in the normal is sag / d). A patch that cannot be measured (a
// probe off the flank, a sliver shadowing every retry) keeps the edge-measured
// solution for that station.
const CONTACT_ROUNDS = 2;
const CONTACT_D = 0.3;    // × r — patch half-width (and ray reach)
// One accepted hit on the wall below/above X along unit n: cast from X + rho·n back
// along −n over 2·rho. Returns the wall point and the hit facet's normal, or null.
function wallHit(rays, X, n, rho) {
  const hit = rays.nearest(add(X, scl(n, rho)), scl(n, -1), 2 * rho, (fn) => dot(fn, n) >= FLANK_FACING_COS);
  return hit ? { p: add(X, scl(n, rho - hit.t)), fn: hit.n } : null;
}
// wallHit at a contact point that must not miss: a boolean sliver lying exactly
// under X (rejected by the facing test) shadows the facet behind it, so retry a hair
// to either side along the edge tangent t and carry the hit facet's plane back to
// the ray through X.
function contactHit(rays, X, n, t, rho) {
  const h = wallHit(rays, X, n, rho);
  if (h) return h;
  for (const s of [1, -1]) {
    const o = wallHit(rays, add(X, scl(t, s * 0.02 * rho)), n, rho);
    const dn = o ? dot(n, o.fn) : 0;
    if (dn > 0.5) return { p: add(X, scl(n, dot(sub(o.p, X), o.fn) / dn)), fn: o.fn };
  }
  return null;
}
// The smooth wall at a contact: the snapped centre hit plus four hits ±df along the
// section's in-face direction f and ±dt along the edge tangent t. The two chords'
// cross product is the secant normal — exact at the centre for a surface of
// revolution to second order, and off by at most sag/d on facets (vs up to half a
// facet's turn for the hit facet's own normal).
function wallPatch(rays, P, n, f, t, df, dt, rho) {
  const c = contactHit(rays, P, n, t, rho);
  if (!c) return null;
  const fp = wallHit(rays, add(P, scl(f, df)), n, rho), fm = wallHit(rays, add(P, scl(f, -df)), n, rho);
  const tp = wallHit(rays, add(P, scl(t, dt)), n, rho), tm = wallHit(rays, add(P, scl(t, -dt)), n, rho);
  // a missed sample (a boolean sliver can shadow the facet behind it) falls back to
  // the one-sided chord through the centre; both of a pair missing gives up
  const chord = (a, b) => (a || b ? sub((a ?? c).p, (b ?? c).p) : null);
  const ct = chord(tp, tm), cf = chord(fp, fm);
  if (!ct || !cf) return { p: c.p, fn: c.fn, n: null };
  let nn = norm(cross(ct, cf));
  if (dot(nn, n) < 0) nn = scl(nn, -1);
  return { p: c.p, fn: c.fn, n: nn };
}
// the unit contact normals of a ball solution, pointing into the air from each wall
const contactNormals = (sol, sgn) =>
  [sol.T1, sol.T2].map((Tk) => norm2([sgn * (Tk[0] - sol.C[0]), sgn * (Tk[1] - sol.C[1])]));
function refineBall(rays, sol, frame, t3, r, convex) {
  const { p2, to3 } = frame, sgn = convex ? 1 : -1;
  if (!rays) return { ...sol, N: contactNormals(sol, sgn) };
  const vec3 = ([x, y]) => sub(to3([x, y]), to3([0, 0]));
  let { C } = sol, T = [sol.T1, sol.T2];
  let N = contactNormals(sol, sgn);
  const F = [sol.F1, sol.F2];
  let ok = false;
  for (let round = 0; round < CONTACT_ROUNDS; round++) {
    const flanks = [];
    for (let kk = 0; kk < 2; kk++) {
      const n3 = norm(vec3(N[kk])), f3 = norm(vec3([-N[kk][1], N[kk][0]]));
      const aT = T[kk][0] * F[kk].f[0] + T[kk][1] * F[kk].f[1];
      const df = Math.min(CONTACT_D * r, 0.5 * aT), rho = CONTACT_D * r;
      const w = df > 0 ? wallPatch(rays, to3(T[kk]), n3, f3, t3, df, CONTACT_D * r, rho) : null;
      if (!w || !w.n) { flanks.push(null); continue; }
      flanks.push({ Q: p2(sub(w.p, to3([0, 0]))), n: norm2(p2(w.n)) });
    }
    if (!flanks[0] || !flanks[1]) break;
    // ball tangent to both local tangent lines: n_k·(C − Q_k) = −sgn·r
    const [A, B] = flanks, det = A.n[0] * B.n[1] - A.n[1] * B.n[0];
    if (Math.abs(det) < 1e-9) break;
    const ra = dot2(A.n, A.Q) - sgn * r, rb = dot2(B.n, B.Q) - sgn * r;
    const Cn = [(ra * B.n[1] - rb * A.n[1]) / det, (A.n[0] * rb - B.n[0] * ra) / det];
    if (Math.hypot(Cn[0] - C[0], Cn[1] - C[1]) > 0.5 * r) break;
    const Tn = [A, B].map((Fk) => [Cn[0] + sgn * r * Fk.n[0], Cn[1] + sgn * r * Fk.n[1]]);
    if (!Tn.every((Tk, kk) => Tk[0] * F[kk].f[0] + Tk[1] * F[kk].f[1] > 0)) break;
    C = Cn; T = Tn; N = [A.n, B.n]; ok = true;
  }
  if (!ok) return { ...sol, N };
  const m1 = norm2([sgn * (T[0][0] - C[0]), sgn * (T[0][1] - C[1])]);
  const m2 = norm2([sgn * (T[1][0] - C[0]), sgn * (T[1][1] - C[1])]);
  const phi = Math.atan2(m1[0] * m2[1] - m1[1] * m2[0], clamp1(m1[0] * m2[0] + m1[1] * m2[1]));
  const a1 = T[0][0] * F[0].f[0] + T[0][1] * F[0].f[1], a2 = T[1][0] * F[1].f[0] + T[1][1] * F[1].f[1];
  return { ...sol, C, T1: T[0], T2: T[1], a1, a2, m1, phi, N };
}
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];

// The fillet polygon ending ON the wall. Layout: corner point (delta past the edge
// along the bisector, outside the material for a cutter, inside it for a filler),
// FLANK_SAMPLES points along flank 1 toward its contact, the point straight above
// contact 1 (along the contact normal, on the harmless side), contact 1 itself, the
// ball arc's interior (fixed nArc, area-exact radius), contact 2, the point above it,
// and flank 2's samples back toward the corner. Every call with the same nArc returns
// the same point count, so the stack stitches.
// The flank points follow each flank's circle — a straight chord would bite a lens of
// material out of a curved flank for a cutter, or add one over it for a filler — lifted
// toward the harmless side (air for a cutter, material for a filler) by delta plus
// a·sin(tilt): the station's normals are an average of the incident facets, so a real
// facet leaves the modelled flank by up to a·sin(tilt) at distance a from the edge, and
// a flank edge inside that band grazes the facets. Measured on the general fixtures
// rebuilt from 32–100-segment tubes and spheres (test/mesh-fillet-general.test.js):
// a constant lift strands shells (10 of 120 cases); a·sin(tilt) × 0.5, 1 or 1.5 leaves
// every case at its genus.
// The arc ENDS at the contacts, and the closing edge leaves each one at right angles
// to the wall. The earlier layout continued the arc past the contacts and closed the
// polygon beyond them; that arc ran within the facets' sag (~1 µm) of the wall for
// ±~0.05 mm around each contact, so every facet kept a sub-µm lens of uncut (or
// unfilled) wall there, and the overlay — which draws every seam between a blend and
// its wall — traced both edges of every lens: a staircase of two lines ~0.09 mm apart
// with a rung at each facet seam, 37 mm of line against the cross hole's 19.7 mm
// contact curve. generalTool snaps `ends` onto the faceted wall and keeps the points
// next to them strictly on the tool side, so the boolean cuts the wall along the
// contact polyline, crossing it steeply, and the band ends on one clean line.
const FLANK_SAMPLES = 4;
// The wall-side margins generalTool gives a fillet section's contacts and the arc
// points next to them (× r): CONTACT_MU is the floor — enough that a contact never
// sits exactly ON a facet, where the boolean would meet a coplanar touch instead of
// a crossing — and CONTACT_STOP the arc depth past which the wall no longer
// threatens the arc, ending the probe walk inward.
const CONTACT_MU = 2e-4;
const CONTACT_STOP = 3e-3;
// The fold allowance is a worst-case bound (the ridge midway between the two
// points) and a fold can reach ~1.2 rad under FLANK_FACING_COS (35° each side), so on a coarse
// 32-gon with 1–2 mm station spacing it asked for up to 0.39·r (slantCut, r = 0.5)
// — a step in the band, and a deeper cut than the fillet's. Fine meshes never ask
// for more than 0.03·r (every fixture, r = 0.5–2). Capped at 0.05·r the coarse
// fixtures keep their genus and move TOWARD OCCT (coarse slantCut r = 1: 9.3 →
// 6.0%; r = 0.5: 5.7%), the coarse cross hole's lines stay single, and no fine
// number moves.
const CONTACT_MU_MAX = 0.05;
function contactPolygon(sol, magnitude, nArc, tilt, ends) {
  const { C, a1, a2, m1, phi, F1, F2, bis, sgn, N } = sol;
  const r = magnitude, delta = 0.02 * magnitude;
  const onFlank = (F, a, lift) => {
    let b = 0;
    if (F.kap) { const R = 1 / F.kap; b = R - Math.sign(R) * Math.sqrt(Math.max(0, R * R - a * a)); }
    return [a * F.f[0] + (b + sgn * lift) * F.n[0], a * F.f[1] + (b + sgn * lift) * F.n[1]];
  };
  const lifted = (F, a) => onFlank(F, a, delta + a * Math.sin(tilt));
  const above = (H, Nk, a) => [H[0] + sgn * (delta + a * Math.sin(tilt)) * Nk[0], H[1] + sgn * (delta + a * Math.sin(tilt)) * Nk[1]];
  const side = (F, aT) => Array.from({ length: FLANK_SAMPLES }, (_, j) => lifted(F, (aT * (j + 1)) / (FLANK_SAMPLES + 1)));
  const s2 = Math.sign(phi) || 1, span = Math.abs(phi);
  const th = span / nArc, rEq = r * Math.sqrt(th / Math.sin(th));
  const arc = [];
  for (let i = 1; i < nArc; i++) {
    const nv = rot2(m1, (s2 * span * i) / nArc);
    arc.push([C[0] + sgn * rEq * nv[0], C[1] + sgn * rEq * nv[1]]);
  }
  return { pts: [[sgn * delta * bis[0], sgn * delta * bis[1]], ...side(F1, a1), above(ends[0], N[0], a1), ends[0],
    ...arc, ends[1], above(ends[1], N[1], a2), ...side(F2, a2).reverse()], arcStart: FLANK_SAMPLES + 2 };
}

// General-chain tool: one ring per (smoothed) station, each the section in the plane
// perpendicular to the edge, meshed as a ring stack. Fillet sections solve the
// rolling ball against each flank's measured section-plane curvature (curvedBall —
// the tangent-line profile2D section mis-sizes the spandrel by up to 1.7× where a
// flank is a tube seen side-on), then re-solve it against the wall measured at the
// contacts (refineBall) and end on the wall there (contactPolygon); chamfers keep
// profile2D, whose setbacks curvature barely moves. Every ring carries the same arc
// count — the widest station's — so the stack stitches. Grazing guard per chamfer
// station: buried by the facet-tilt sagitta plus GENERAL_SAG_PAD. A bend tighter than the section's
// reach toward its own centre would fold the stack: refuse it, which reroutes (the
// spec's policy) rather than emitting a self-intersecting tool.
function generalTool(k, chain, magnitude, mode, pSegs, rays = null, stations = null) {
  if (!k._ringStackSolid) throw new UnsupportedEdgeError("general chain: this kernel has no ring-stack builder");
  const { convex, closed } = chain;
  const st = stations ?? smoothStations(generalStations(chain), closed, magnitude);
  const frames = st.map((s) => {
    const u = s.n1, v = cross(s.t, u);
    return { u, v, p2: (w) => [dot(w, u), dot(w, v)], to3: ([x, y]) => add(s.p, add(scl(u, x), scl(v, y))) };
  });
  const sols = mode === "fillet" ? st.map((s, i) => {
    const { p2 } = frames[i], n1 = p2(s.n1), n2 = p2(s.n2);
    const flat = curvedBall({ n1, n2, k1: 0, k2: 0, magnitude, convex }); // for the in-face directions
    if (!flat) throw new UnsupportedEdgeError(`general chain: no rolling-ball section for ${mode} ${magnitude}`);
    const f3 = (f) => add(scl(frames[i].u, f[0]), scl(frames[i].v, f[1]));
    const k1 = flankCurvature(rays, s.p, s.n1, f3(flat.F1.f), magnitude);
    const k2 = flankCurvature(rays, s.p, s.n2, f3(flat.F2.f), magnitude);
    const sol = k1 || k2 ? curvedBall({ n1, n2, k1, k2, magnitude, convex }) : flat;
    return refineBall(rays, sol, frames[i], s.t, magnitude, convex);
  }) : null;
  let maxSpan = 0;
  for (let i = 0; i < st.length; i++)
    maxSpan = Math.max(maxSpan, sols ? Math.abs(sols[i].phi) : Math.acos(clamp1(dot(st[i].n1, st[i].n2))));
  const nArc = Math.max(2, Math.ceil((maxSpan / (2 * Math.PI)) * pSegs));
  const m = st.length;
  // snap every contact onto the faceted wall and keep its facet normal
  const snaps = sols ? sols.map((sol, i) => {
    const { to3 } = frames[i], { N } = sol;
    return [sol.T1, sol.T2].map((Tk, kk) => {
      const n3 = norm(sub(to3(N[kk]), to3([0, 0])));
      const h = rays ? contactHit(rays, to3(Tk), n3, st[i].t, CONTACT_D * magnitude) : null;
      return { T: h ? frames[i].p2(sub(h.p, st[i].p)) : Tk, H: h ? h.p : to3(Tk), fn: h ? h.fn : n3, n3, hit: !!h };
    });
  }) : null;
  // Fillet sections end ON the wall (contactPolygon): pass 1 lays out every station's
  // polygon and probes the wall under its contact (snapped, depth 0) and under the arc
  // points next to it, out to where the arc has left the wall by CONTACT_STOP; pass 2
  // gives each probed point its tool-side margin — the floor CONTACT_MU, plus L·fold/4
  // for the chord to the same point of each neighbouring station and to its neighbours
  // in the section, which leaves the wall by up to that much when the two sit on facets
  // turned `fold` apart. Only a fold TOWARD the tool side (a concave wall under a
  // cutter, a convex one under a filler) lifts a chord out of it; the other way the
  // chord sinks deeper on its own, and a margin there only opens a visible step
  // (measured on the coarse cross hole's tube: 12% of doubled line, and coarse slantCut
  // 3 points further from OCCT). The margin is capped at CONTACT_MU_MAX, each point is
  // pushed along the contact normal until it is that deep, and when the last probed
  // point still needed a push the walk continues inward at its margin.
  const sgn = convex ? 1 : -1;
  const lay = sols ? sols.map((sol, i) => {
    const { to3 } = frames[i];
    const { pts, arcStart } = contactPolygon(sol, magnitude, nArc, st[i].tilt, snaps[i].map((sn) => sn.T));
    const probes = [0, 1].map((kk) => {
      const { n3, H, fn, hit } = snaps[i][kk];
      const list = [{ idx: kk === 0 ? arcStart : arcStart + nArc, H, fn, depth: 0 }];
      if (!rays || !hit) return list;
      for (let j = 1; j < nArc / 2; j++) {
        const idx = kk === 0 ? arcStart + j : arcStart + nArc - j;
        const X = to3(pts[idx]), h = wallHit(rays, X, n3, 0.05 * magnitude);
        if (!h) break;
        const depth = -sgn * dot(sub(X, h.p), n3);
        list.push({ idx, H: h.p, fn: h.fn, depth });
        if (depth >= CONTACT_STOP * magnitude) break;
      }
      return list;
    });
    return { pts, probes };
  }) : null;
  const rings = [], centres = [];
  for (let i = 0; i < st.length; i++) {
    const s = st[i], { p2, to3 } = frames[i];
    let poly;
    if (mode === "fillet") {
      const sol = sols[i], { pts, probes } = lay[i];
      for (let kk = 0; kk < 2; kk++) {
        const Nk = sol.N[kk], { n3 } = snaps[i][kk];
        let need = 0;
        probes[kk].forEach((q, j) => {
          let mu = CONTACT_MU * magnitude;
          const rise = (o) => {
            // only a wall folding TOWARD the tool side lifts the chord out of it
            if (!o || sgn * (dot(q.fn, sub(o.H, q.H)) + dot(o.fn, sub(q.H, o.H))) <= 0) return;
            mu = Math.max(mu, CONTACT_MU * magnitude + (len(sub(q.H, o.H)) * Math.acos(clamp1(dot(q.fn, o.fn)))) / 4);
          };
          for (const nb of [i - 1, i + 1]) if (closed || (nb >= 0 && nb < m)) rise(lay[(nb + m) % m].probes[kk][j]);
          rise(probes[kk][j - 1]); rise(probes[kk][j + 1]);
          mu = Math.min(mu, CONTACT_MU_MAX * magnitude);
          need = mu;
          if (q.depth < mu) { const X = pts[q.idx], dd = mu - q.depth; pts[q.idx] = [X[0] - sgn * dd * Nk[0], X[1] - sgn * dd * Nk[1]]; }
        });
        // the walk stopped at CONTACT_STOP, but the last point's margin can ask for
        // more (coarse facets): keep walking inward at that margin until the arc is
        // deep enough on its own
        const last = probes[kk][probes[kk].length - 1];
        if (rays && snaps[i][kk].hit && last.depth < need) {
          for (let j = probes[kk].length; j < nArc / 2; j++) {
            const idx = kk === 0 ? FLANK_SAMPLES + 2 + j : FLANK_SAMPLES + 2 + nArc - j;
            const X = to3(pts[idx]), h = wallHit(rays, X, n3, 0.05 * magnitude);
            if (!h) break;
            const depth = -sgn * dot(sub(X, h.p), n3);
            if (depth >= need) break;
            const dd = need - depth;
            pts[idx] = [pts[idx][0] - sgn * dd * Nk[0], pts[idx][1] - sgn * dd * Nk[1]];
          }
        }
      }
      poly = pts;
      centres.push(to3(sol.C));
    } else {
      // ext > 0 selects profile2D's chord extension (2% of the chamfer past both
      // contacts, as the revolve chamfer does): it keeps the side walls corner→T in
      // the air instead of skimming the faceted flank, where the sag shift alone tucks
      // them under the facets and strands slivers of flank as separate shells. That 2%
      // only clears facets tilted under ~0.02 rad from the averaged normal; past it the
      // chord continues to tilt × magnitude in all (measured on 32–64-segment tubes,
      // where the station tilt reaches 0.05–0.1 and the 2% walls stranded a sliver per
      // facet). A station tilted under 0.02 keeps exactly profile2D's polygon, and the
      // extension lies in the air for a cutter and in the material for a filler, so it
      // moves no volume.
      poly = profile2D({ P: [0, 0], n1: p2(s.n1), n2: p2(s.n2), magnitude, mode, convex, segs: pSegs, ext: 1, nArc });
      const more = Math.max(0, s.tilt - 0.02) * magnitude;
      if (more > 0) {
        const [corner, T1, T2] = poly, ux = T1[0] - T2[0], uy = T1[1] - T2[1], ul = Math.hypot(ux, uy);
        poly = [corner, [T1[0] + (more * ux) / ul, T1[1] + (more * uy) / ul], [T2[0] - (more * ux) / ul, T2[1] - (more * uy) / ul]];
      }
      const sag = magnitude * (1 - Math.cos(s.tilt)) + Math.min(GENERAL_SAG_PAD, 0.02 * magnitude);
      const [b1, b2] = p2(add(s.n1, s.n2)), bl = Math.hypot(b1, b2) || 1;
      poly = poly.map(([x, y], j) => (j === 0 && convex ? [x, y] : [x - (sag * b1) / bl, y - (sag * b2) / bl]));
    }
    rings.push(poly.map(to3));
  }
  for (let i = 0; i < st.length; i++) {
    const s = st[i];
    if (!s.interior) continue;
    const O = circumcentre(s.prev, s.p, s.next);
    if (!O) continue;
    const rho = len(sub(O, s.p)), beta = norm(sub(O, s.p));
    let reach = 0;
    for (const q of rings[i]) reach = Math.max(reach, dot(sub(q, s.p), beta));
    if (reach > 0.9 * rho)
      throw new UnsupportedEdgeError(`general chain: bend too tight for ${mode} ${magnitude} (local radius ${rho.toFixed(2)} mm)`);
  }
  if (!closed && convex) {
    // convex cutters overshoot open ends (prismTool's rule); concave fillers end flush
    const over = Math.max(1e-3, 0.05 * magnitude);
    const t0 = st[0].t, tN = st[m - 1].t;
    rings.unshift(rings[0].map((q) => sub(q, scl(t0, over))));
    rings.push(rings[rings.length - 1].map((q) => add(q, scl(tN, over))));
  }
  const tool = k._ringStackSolid(rings, { closed });
  return mode === "fillet" ? markBlend(k, tool, { kind: "spine", pts: refineSpine(centres, closed), closed, r: magnitude }) : tool;
}

// The shading spine is nearest-point-on-polyline, so a coarse polyline tilts the
// normal by up to half a turn angle on the concave side of a bend (2.4° on a tee at
// ~3.5° per station). One interpolating 4-point subdivision pass (Dyn) quarters that;
// a vertex turning past SPINE_SMOOTH_COS, or a missing neighbour (open ends), keeps
// the plain midpoint so a real corner is never rounded or overshot.
const SPINE_SMOOTH_COS = Math.cos((25 * Math.PI) / 180);
function refineSpine(pts, closed) {
  const n = pts.length;
  if (n < 3) return pts;
  const at = (i) => (closed ? pts[((i % n) + n) % n] : pts[i]);
  const turnOk = (i) => {
    const a = at(i - 1), b = at(i), c = at(i + 1);
    if (!a || !b || !c) return false;
    return dot(norm(sub(b, a)), norm(sub(c, b))) > SPINE_SMOOTH_COS;
  };
  const out = [];
  const nSeg = closed ? n : n - 1;
  for (let i = 0; i < nSeg; i++) {
    out.push(pts[i]);
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    let mid = null;
    if (p0 && p3 && turnOk(i) && turnOk(i + 1)) {
      // the cubic through the four points at their chord-length parameters, at the
      // middle of p1→p2 — Dyn's (−1, 9, 9, −1)/16 when the spacing is even, and no
      // overshoot when a station pair sits much closer than its neighbours
      const t = [-len(sub(p1, p0)), 0, len(sub(p2, p1))];
      t.push(t[2] + len(sub(p3, p2)));
      const x = t[2] / 2, P = [p0, p1, p2, p3];
      const w = t.map((tj, j) => t.reduce((acc, tm, q) => (q === j ? acc : (acc * (x - tm)) / (tj - tm)), 1));
      if (w.every(Number.isFinite)) mid = [0, 1, 2].map((a) => P.reduce((acc, pj, j) => acc + w[j] * pj[a], 0));
    }
    out.push(mid ?? [0, 1, 2].map((a) => (p1[a] + p2[a]) / 2));
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

// `segs` is the KERNEL quality — it sizes the flank-facet guards (sag/ext) and the
// closed-revolve dephase, which are about matching the neighboring tessellation and
// must not follow the blend cap. `pSegs` is the sagitta-bounded density for the blend
// cross-section itself (blendSegs above).
function revolveTool(k, chain, magnitude, mode, segs, pSegs = segs, flankAt = () => segs) {
  const { O, w, u0, v0, R, span, closed, n1, n2, convex } = chain;
  // The count the flank's own circle was built at (see apply): the cap on a flat
  // tier, the per-radius rule on print. Every "matching the neighbouring
  // tessellation" figure below reads this, never `segs`.
  const flankSegs = flankAt(R);
  // Seam-grazing guard. The edge circle passes through the flank tessellation's
  // VERTICES (circumradius) while its facets sit at the apothem, so a revolved
  // tool built exactly at R grazes every facet seam tangentially — Manifold
  // keeps the resulting epsilon-degenerate needle triangles, and simplify()
  // cannot always collapse them. `sag` is that facet sagitta plus a roundoff pad
  // bounded relative to the requested feature, so tiny blends never inherit a
  // fixed allowance larger than their own cross-section.
  //
  // The kernel-density term is an ASSUMPTION about the flank, and it is wrong
  // whenever the wall's facets hang on a polyline coarser than kernel quality —
  // an offset outline, a polygonal prism — or when the rim rides the fit tolerance
  // off the fitted circle. The wall facets hang on the chain's own points, so the
  // real depth is measurable: the deepest chord midpoint below the fitted circle.
  // Where the assumed extension fell short of that, the crossing failed mid-facet
  // and a radial knife-fin of wall survived both cutters, drawing a line along the
  // band (the label-backing bug). A synthetic corner arc measures nothing — its two
  // points span the whole corner, and its flanks are planes, not a tessellation.
  const kernelSag = (R + magnitude) * (1 - Math.cos(Math.PI / flankSegs));
  let dip = 0;
  if (!chain.synthetic) {
    const pts = chain.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const q = sub(scl(add(pts[i], pts[i + 1]), 0.5), O);
      dip = Math.max(dip, R - len(sub(q, scl(w, dot(q, w)))));
    }
  }
  const sag = Math.max(kernelSag, dip) + Math.min(2e-4, 0.02 * magnitude);
  // Fillet: size the arc-tail extension to cross the facet planes, but cap it at
  // 0.4 rad. Below the mesh's own facet scale a larger tail wraps around the tiny
  // profile and creates one tunnel per facet; the cap bounds penetration to 8%
  // of the requested radius while the cutter's outside corner still opens into
  // free space.
  const ext = Math.min(0.4, Math.max(0.01, Math.acos(Math.max(-1, 1 - sag / magnitude))));
  let poly = profile2D({ P: [R, 0], n1, n2, magnitude, mode, convex, segs: pSegs, ext });
  if (mode === "chamfer") {
    // Chamfer: the cone itself is the cutting surface — no tail to extend, so
    // bury the whole profile by `sag` along the material-side bisector instead.
    // The chamfer lands microns deep; dimensionally invisible.
    const bl2 = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]);
    const bis2 = [(n1[0] + n2[0]) / bl2, (n1[1] + n2[1]) / bl2];
    // A convex cutter must leave its outside closure corner unburied: moving the
    // whole profile inward can close a micro-tunnel per flank facet when sag is
    // larger than a tiny chamfer. A concave filler needs every point buried so
    // it overlaps the source solid instead of leaving disconnected components.
    poly = poly.map(([x, y], i) => i === 0 && convex ? [x, y] : [x - sag * bis2[0], y - sag * bis2[1]]);
  }
  if (poly.some(([x]) => x <= 0)) throw new UnsupportedEdgeError("fillet crosses the revolve axis (radius too large for this bore)");
  // enforce CCW winding for the revolve
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) poly = poly.slice().reverse();
  const ovAng = closed || !convex ? 0 : Math.min(0.15, Math.max(1e-3, (0.05 * magnitude) / R));
  const degrees = closed ? 360 : ((span + 2 * ovAng) * 180) / Math.PI;
  // A real edge-circle arc keeps the kernel's angular density — its facets interact
  // with the flank's own tessellation of the same circle (the dephase note below).
  // A SYNTHETIC corner arc (cornerArcAt) is free-standing between planes, so its
  // angular density follows the same sagitta bound as the cross-section.
  const aSegs = chain.synthetic ? cornerArcSegs(segs, R, magnitude) : flankSegs;
  let tool = k.revolve(poly, { degrees, segs: aSegs });
  // pose: Z → w, then twist so the revolve's start azimuth (+X) lands on the
  // chain's start direction (backed off by the angular overshoot)
  const startDir = closed ? u0 : add(scl(u0, Math.cos(-ovAng)), scl(v0, Math.sin(-ovAng)));
  const axisRaw = cross([0, 0, 1], w);
  const s = len(axisRaw);
  let axis = null, theta = 0;
  if (s > 1e-9) { axis = scl(axisRaw, 1 / s); theta = Math.atan2(s, w[2]); }
  else if (w[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
  if (axis) tool = tool.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
  const xImage = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
  // Closed revolves get an extra half-facet twist: at 360° the tool's facet
  // pitch exactly matches the flank's, and phase-aligned seams graze vertex-on-
  // vertex at every step (the degenerate-needle generator). Half a step lands
  // every crossing mid-facet. Partial arcs have a slightly different pitch
  // (degrees don't divide evenly) and never align in the first place.
  const dephase = closed ? Math.PI / flankSegs : 0;
  const twist = Math.atan2(dot(w, cross(xImage, startDir)), dot(xImage, startDir)) + dephase;
  if (Math.abs(twist) > 1e-9) tool = tool.rotateAbout({ axis: w, deg: (twist * 180) / Math.PI });
  tool = tool.translate(O);
  if (mode !== "fillet") return tool;
  // spine: the ball centre's circle — profile C = [R, 0] + offset in (ρ, w)
  const C = ballOffset(n1, n2, magnitude, convex);
  return markBlend(k, tool, { kind: "circle", c: add(O, scl(w, C[1])), a: w, R: R + C[0] });
}

// ---------------------------------------------------------------------------
// Planar-chain blend tool: sweep the shared 2-D cross-section (profile2D) along the
// chain's own polyline with k.sweep — a prism IS the one-segment case of this sweep,
// generalized to a path that turns. In the sweep's transported frame the face and wall
// flanks keep constant coordinates along a planar constant-dihedral path, so ONE profile
// polygon serves every station; sweepSeedFrame gives the exact frame the sweep will seed,
// so the profile is authored in it rather than re-deriving (and drifting from) the pick.
//
// The sweep miters gently-turning joints on its own. A vertex whose miter would fold —
// a sharp corner, a reversal cusp, a segment shorter than the profile's reach — SPLITS
// the chain there instead, and each open stretch overshoots its ends the way prism
// cutters do, so adjacent stretches mitre into each other across the split. Concave
// fillers stay flush at their ends — overshoot would bulge outside the part when unioned
// (prismTool's own rule) — which can leave a hairline notch in a bead at a split; that is
// the mitred-junction limit from the module header, not a leak (the boolean stays
// watertight). Any residual sweep refusal (float-edge fold the pre-split missed) is
// converted to UnsupportedEdgeError so the caller reroutes to OCCT instead of failing
// the build. Returns an ARRAY of tools — one per stretch.
// Collapse corner features smaller than the blend into virtual sharp corners.
// A convex corner round with radius under the fold threshold (~0.37·magnitude at
// the 1.1× reach) cannot be swept — the band's top tangent contour pinches — and
// cannot be steered either (no setback room), so the fold guard breaks at EVERY
// facet joint and the band shatters into overshot micro-tools. But such a feature
// is geometrically a sharp corner blurred by less than the blend radius: replace
// each maximal run of two or more consecutive breaking joints whose connecting
// segments are shorter than the magnitude with the intersection of the flanking
// edge lines, and the ordinary corner machinery (mitre / gentle steer / reflex
// pivot) handles it downstream. The silhouette cost is bounded by the feature's
// own radius — sub-blend by construction. Runs that have no usable intersection
// (a ~180° cap, whose radius is stroke-scale and sweeps fine anyway) or whose
// intersection lands implausibly far are left untouched.
function collapseTightCorners(pts0, wallNs0, closed, magnitude) {
  let pts = pts0, wallNs = wallNs0;
  const m0 = pts.length, nSeg0 = closed ? m0 : m0 - 1;
  if (nSeg0 < 3) return { pts, wallNs };
  const reach = magnitude * 1.1, reachWall = 0.1 * magnitude;
  const breaksAt = (pp, ww) => {
    const m = pp.length, nSeg = closed ? m : m - 1;
    const dir = [], sl = [];
    for (let i = 0; i < nSeg; i++) {
      const d = sub(pp[(i + 1) % m], pp[i]), l = len(d);
      dir.push(scl(d, 1 / (l || 1))); sl.push(l);
    }
    const flags = new Array(m).fill(false);
    for (let i = closed ? 0 : 1; i < (closed ? m : m - 1); i++) {
      const iIn = (i - 1 + nSeg) % nSeg;
      const c = clamp1(dot(dir[iIn], dir[i]));
      const turn = Math.acos(c);
      const bendIn = norm(sub(dir[i], dir[iIn]));
      const reflexBend = dot(bendIn, ww[iIn]) + dot(bendIn, ww[i % nSeg]) > 0;
      const r = reflexBend ? reachWall : reach;
      flags[i] = c < -1 + 1e-6 || r * Math.tan(turn / 2) > 0.45 * Math.min(sl[iIn], sl[i]) ||
        turn > (SMOOTH_MAX_DEG * Math.PI) / 180;
    }
    return { flags, dir, sl };
  };
  let { flags, dir, sl } = breaksAt(pts, wallNs);
  // rotate a closed chain so runs never wrap; a chain breaking everywhere is left alone
  if (closed) {
    const pivot = flags.findIndex((b) => !b);
    if (pivot === -1) return { pts, wallNs };
    if (pivot > 0) {
      pts = [...pts.slice(pivot), ...pts.slice(0, pivot)];
      wallNs = [...wallNs.slice(pivot), ...wallNs.slice(0, pivot)];
      ({ flags, dir, sl } = breaksAt(pts, wallNs));
    }
  }
  const m = pts.length, nSeg = closed ? m : m - 1;
  const out = [], outWalls = [];
  let i = 0;
  const pushPoint = (p, wallIdx) => {
    out.push(p);
    if (wallIdx != null) outWalls.push(wallNs[wallIdx]);
  };
  while (i < m) {
    // maximal run of breaking joints chained by sub-magnitude segments
    let j = i;
    while (j + 1 < m && flags[j] && flags[j + 1] && sl[j] < magnitude) j++;
    if (flags[i] && j > i) {
      const iIn = (i - 1 + nSeg) % nSeg;
      const d1 = dir[iIn], d2 = dir[j % nSeg];
      const p1 = pts[i], p2 = pts[j];
      // intersect the flanking edge lines: p1 + a·d1 = p2 − b·d2 (in-plane)
      const c12 = dot(d1, d2);
      const denom = 1 - c12 * c12;
      let V = null;
      if (denom > 1e-6) {
        const w0 = sub(p2, p1);
        const a = (dot(w0, d1) - c12 * dot(w0, d2)) / denom;
        const cand = add(p1, scl(d1, a));
        let extent = 0;
        for (let t = i; t < j; t++) extent += sl[t];
        if (len(sub(cand, p1)) < 2 * magnitude + extent) V = cand;
      }
      if (V) {
        pushPoint(V, j % nSeg); // V starts the outgoing segment: wall of seg j
        i = j + 1;
        continue;
      }
    }
    pushPoint(pts[i], i < nSeg ? i : null);
    i++;
  }
  if (out.length < (closed ? 3 : 2)) return { pts: pts0, wallNs: wallNs0 };
  return { pts: out, wallNs: outWalls };
}

// Weld consecutive coincident chain points (the module's own 1/WELD vertex-identity
// grid, pivotKey's). collapseTightCorners can land a virtual corner V exactly ON a
// flanking chain point — an offset outline's micro-spike doubles back through the
// same vertex, so the flanking edge lines intersect AT it — and a coincident pair
// becomes a zero-length sweep path segment that k.sweep rejects, failing the whole
// fillet (the "Scott" offset-backing regression). Dropping the point drops the
// degenerate segment's WALL, keeping walls one-per-surviving-segment.
function weldChainPoints(pts, wallNs, closed) {
  const eps = 1 / WELD;
  const outP = [pts[0]], outW = [];
  for (let i = 1; i < pts.length; i++) {
    if (len(sub(pts[i], outP[outP.length - 1])) < eps) continue;
    outP.push(pts[i]);
    outW.push(wallNs[i - 1]);   // wall of the span arriving at pts[i]
  }
  if (closed) {
    // The closing segment's wall: the original closing span's — unless the wrap
    // itself welds (last ≈ first), where the popped point's arriving wall is the
    // span that now closes the loop.
    let closingW = wallNs[pts.length - 1];
    while (outP.length > 1 && len(sub(outP[outP.length - 1], outP[0])) < eps) {
      outP.pop();
      closingW = outW.pop();
    }
    outW.push(closingW);
  }
  return { pts: outP, wallNs: outW };
}

// The spine of a planar sweep tool, as a "path" blend surface (blend-surfaces.js).
// The sweep transports the profile about the face normal, so the wall keeps its
// face-normal component and its in-plane part turns with the path; the seed segment
// (the one sweepSeedFrame is built ⟂ to: the first, or the closing one of a loop)
// fixes which side that is. Vertex directions bisect their two segments' sides.
function planarSpine(path, closed, faceN, wallN, magnitude, convex) {
  const n = path.length, nSeg = closed ? n : n - 1;
  const tan = (i) => norm(sub(path[(i + 1) % n], path[i]));
  const tSeed = tan(closed ? n - 1 : 0);
  const wallP = norm(sub(wallN, scl(tSeed, dot(wallN, tSeed))));
  const cf = dot(wallP, faceN);
  const wIn = sub(wallP, scl(faceN, cf));
  const side = dot(wIn, cross(faceN, tSeed)) >= 0 ? 1 : -1;
  const segSide = [];
  for (let i = 0; i < nSeg; i++) segSide.push(scl(norm(cross(faceN, tan(i))), side));
  const dirs = path.map((_, i) => {
    const a = closed ? segSide[(i - 1 + nSeg) % nSeg] : segSide[Math.max(0, i - 1)];
    const b = closed ? segSide[i % nSeg] : segSide[Math.min(nSeg - 1, i)];
    const m = norm(add(a, b));
    return len(m) > 0 ? m : a;
  });
  // ballOffset(faceN, wall) = K·(faceN + wall) with wall = cf·faceN + |wIn|·dir
  const K = (convex ? 1 : -1) * (-magnitude / (1 + clamp1(cf)));
  return { kind: "path", pts: path, closed, dirs, f: faceN, kf: K * (1 + cf), kd: K * len(wIn) };
}

function planarTool(k, chain, magnitude, mode, segs, pSegs = segs, endTins = null, flankAt = () => segs) {
  const { points, closed, convex, faceN } = chain;
  let { wallNs } = chain;
  let pts = closed ? points.slice(0, -1) : points;   // drop the duplicated closure point
  // Corner features SMALLER than the blend collapse to a virtual sharp corner
  // BEFORE any tool is built (see collapseTightCorners) — a run of fold-breaking
  // joints on a sub-blend-radius corner round otherwise shatters into per-facet
  // micro-tools whose disagreements notch the band (the non-bold glyph "divot":
  // a raw letter terminal's ~0.1-0.25 mm corner rounds under a 0.3 mm fillet;
  // bold outlines never hit this because the 0.4 mm round offset pads every
  // convex radius past the fold threshold).
  if (convex) ({ pts, wallNs } = collapseTightCorners(pts, wallNs, closed, magnitude));
  ({ pts, wallNs } = weldChainPoints(pts, wallNs, closed));
  // A chain welded below the grid (a sub-micron rim loop — offset-noise islands)
  // has nothing a blend of this magnitude can attach to; skip it rather than fail.
  if (pts.length < (closed ? 3 : 2)) return [];
  const m = pts.length;
  const at = (i) => pts[((i % m) + m) % m];
  const nSeg = closed ? m : m - 1;
  const segDir = [], segLen = [];
  for (let i = 0; i < nSeg; i++) {
    const d = sub(at(i + 1), at(i)), l = len(d);
    segDir.push(scl(d, 1 / (l || 1)));
    segLen.push(l);
  }

  // Fold guard, mirrored from resolveSweepStations' miter check with a stricter factor
  // (0.45 vs 0.5) so the split fires before the sweep would throw. `reach` is a cheap
  // rigid upper bound on the profile's half-width — exact reach needs the profile, the
  // profile needs the stretch, and conservatism here only costs an extra mitred split.
  // Split at a vertex whose miter would fold (fold guard, stricter 0.45 factor so the
  // split fires before the sweep would throw) — and also at any stitched-junction
  // corner sharper than SMOOTH_MAX_DEG, whose miter crease would otherwise exceed the
  // viewer's line threshold and draw across the band. A salient split corner with room
  // for the setback gets a corner ARC (cornerArcAt — the same rounded-corner treatment
  // apply() gives two-chain junctions), the adjoining stretches trimmed to its tangent
  // points; a reflex split gets the rolling-ball PIVOT (reflexPivotTool — without it
  // the flush stretch ends leave the corner wedge uncut and the face keeps its point);
  // too-tight salient splits keep the overshoot mitre.
  // The reach bound is SIDE-aware, mirroring the sweep's own direction-aware
  // check: rings converge only on the inside of a bend, and only the profile's
  // reach TOWARD the bend center matters. The bend axis of a planar chain is
  // the face normal, so that reach is the profile's IN-PLANE extent — the
  // face-tangency inset, magnitude (+2% corner delta; the arc between the
  // tangencies never reaches past them on the corner side) — NOT the rigid
  // 1.5× diagonal bound, whose extra 50% is the AXIAL extent that a bend about
  // the face normal cannot consume. The old bound split any salient outline
  // arc under ~1.7·magnitude into per-facet micro-tools (a bold glyph's 0.4 mm
  // offset-round corners under a 0.3 mm rim fillet became a patchwork of
  // ~20 µm tools whose disagreements notched the band — the "divot" artifact);
  // with the in-plane bound those arcs ride the one continuous sweep, and
  // splitting starts only near the genuine pinch (R ≈ 1.2·magnitude, where
  // the top tangent contour is closing toward a point). A reflex bend curves
  // past the wall, where the profile reaches only the corner delta — the
  // symmetric bound there shattered concave arcs of the same radii (the
  // roundAll fast path's reflex arcs exactly).
  const reach = magnitude * 1.1;
  const reachWall = 0.1 * magnitude;
  const breaks = [];
  for (let i = closed ? 0 : 1; i < (closed ? m : m - 1); i++) {
    const iIn = (i - 1 + nSeg) % nSeg;
    const c = clamp1(dot(segDir[iIn], segDir[i]));
    const turn = Math.acos(c);
    // inside-of-bend direction ≈ change of travel; past the wall ⇒ reflex bend
    const bendIn = norm(sub(segDir[i], segDir[iIn]));
    const reflexBend = dot(bendIn, wallNs[iIn]) + dot(bendIn, wallNs[i % nSeg]) > 0;
    const r = reflexBend ? reachWall : reach;
    const fold = c < -1 + 1e-6 || r * Math.tan(turn / 2) > 0.45 * Math.min(segLen[iIn], segLen[i]);
    const sharp = turn > (SMOOTH_MAX_DEG * Math.PI) / 180;
    if (fold || sharp) breaks.push(i);
  }
  // Corner arcs per break vertex, with each side's setback budget measured along the
  // polyline to the ADJACENT break (or chain end) — a single tessellation segment says
  // nothing about the room a whole smooth stretch offers.
  const cornerArcs = new Map();   // break vertex index → { arc, t }
  const pivots = [];              // reflex break vertices → rolling-ball pivots
  if (convex && breaks.length) {
    const segSum = (from, to) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += segLen[((i % nSeg) + nSeg) % nSeg];
      return sum;
    };
    for (let j = 0; j < breaks.length; j++) {
      const i = breaks[j], iIn = (i - 1 + nSeg) % nSeg;
      const prevB = closed
        ? breaks[(j - 1 + breaks.length) % breaks.length] - (j === 0 ? m : 0)
        : (j > 0 ? breaks[j - 1] : 0);
      const nextB = closed
        ? breaks[(j + 1) % breaks.length] + (j + 1 === breaks.length ? m : 0)
        : (j + 1 < breaks.length ? breaks[j + 1] : m - 1);
      // a SHARP corner may steer only when another selected chain leaves this
      // vertex out of the face plane (see apply()'s endTins note) — otherwise
      // it keeps the honest mitre and cornerArcAt's upper gate refuses it
      const allowSharp = !!(endTins?.get(pivotKey(at(i)))?.some((t) => Math.abs(dot(t, faceN)) > 0.7));
      const got = cornerArcAt(at(i), faceN, scl(segDir[iIn], -1), segDir[i],
        wallNs[iIn], wallNs[i], segSum(prevB, i), segSum(i, nextB), magnitude, allowSharp);
      if (got) { cornerArcs.set(i, got); continue; }
      const piv = reflexPivotAt(at(i), faceN, scl(segDir[iIn], -1), segDir[i], wallNs[iIn], wallNs[i]);
      if (piv) pivots.push(piv);
    }
  }

  const over = convex ? Math.max(1e-3, 0.05 * magnitude) : 0;
  const overshoot = (path) => {
    if (!(over > 0) || path.length < 2) return path;
    const a = path[0], b = path[1], y = path[path.length - 1], x = path[path.length - 2];
    return [add(a, scl(norm(sub(a, b)), over)), ...path, add(y, scl(norm(sub(y, x)), over))];
  };
  // pull a stretch endpoint back along the polyline by t, toward a corner arc's
  // tangent point — consuming whole segments where the setback spans several
  const pullBack = (path, t, fromEnd) => {
    if (!(t > 0) || path.length < 2) return path;
    let p = fromEnd ? path.slice().reverse() : path.slice();
    let rem = t;
    while (rem > 1e-12 && p.length >= 2) {
      const seg = sub(p[1], p[0]), l = len(seg);
      if (l > rem + 1e-9) { p[0] = add(p[0], scl(seg, rem / l)); break; }
      rem -= l;
      p.shift();
    }
    return fromEnd ? p.reverse() : p;
  };

  // One tool per stretch. The profile's wall normal is the SEED member's — the segment
  // whose tangent the sweep frame is seeded ⟂ to: the closing segment for a closed loop,
  // the first segment for an open stretch (overshoot extends along that same tangent, so
  // it never changes the seed).
  // ext stays 0 for every planar sweep, cutters and fillers alike — measured both ways
  // on the fixtures. Stations sit ON the path vertices, so the profile's tangent lines
  // ride the flank facets exactly: plane-on-plane contact the kernel resolves cleanly.
  // An arc-tail extension (revolveTool's recipe for curved-vs-curved phase noise) turns
  // that exact contact into a ~2° grazing CROSSING — and a grazing crossing's float
  // wiggle carves sliver seams whether the tool is subtracted or unioned, because the
  // crossing curve is exactly where the boolean's boundary hands over, always exposed.
  const toolFor = (path3D, isClosed, wallN) => {
    const { N, B } = sweepSeedFrame(path3D, isClosed);
    const p2 = (v) => {
      const q = [dot(v, N), dot(v, B)], l = Math.hypot(q[0], q[1]) || 1;
      return [q[0] / l, q[1] / l];
    };
    const poly = profile2D({ P: [0, 0], n1: p2(faceN), n2: p2(wallN), magnitude, mode, convex, segs: pSegs });
    const tool = k.sweep(poly, path3D, { closed: isClosed });
    return mode === "fillet" ? markBlend(k, tool, planarSpine(path3D, isClosed, faceN, wallN, magnitude, convex)) : tool;
  };

  // Sweep one open stretch; when the sweep refuses a VERTEX fold the pre-split
  // guard let through — the guard classifies bends by the LOCAL wall normals,
  // and an offset outline's micro-spike facets carry noise normals that can
  // read reflex (lenient reach) where the sweep's frame-transported measure is
  // salient (full magnitude) — split at that exact vertex and sweep the pieces.
  // That is the same treatment the guard itself would have applied with the
  // right classification: adjacent stretches mitre into each other across the
  // split via their overshoots. The sweep is the oracle, so the two can never
  // disagree into a failure.
  const buildStretch = (path, wallN, depth = 0) => {
    try {
      return [toolFor(overshoot(path), false, wallN)];
    } catch (e) {
      // A knife PROFILE here means this stretch's wall is a degenerate sliver's
      // flipped normal (anti-parallel to the face) — a real rim wall is ~90° to
      // its face and cannot produce it. The rim piece is sub-resolution noise;
      // skip it rather than fail every other stretch of the selection.
      if (e?.knifeEdge) return [];
      const v = e?.foldVertex;
      // overshoot() prepended one point, so sweep index v is path index v-1
      const i = v != null ? v - (over > 0 && path.length >= 2 ? 1 : 0) : null;
      if (i == null || depth > 16 || !(i > 0 && i < path.length - 1)) throw e;
      return [
        ...buildStretch(path.slice(0, i + 1), wallN, depth + 1),
        ...buildStretch(path.slice(i), wallN, depth + 1),
      ];
    }
  };

  try {
    if (closed && breaks.length === 0) {
      const loop = pts.map((p) => [p[0], p[1], p[2]]);
      try {
        return [toolFor(loop, true, wallNs[nSeg - 1])];
      } catch (e) {
        if (e?.knifeEdge) return [];   // degenerate sliver loop — nothing to blend
        const v = e?.foldVertex;
        if (v == null) throw e;
        // the loop folds at v with no break to split on: open it there and let
        // buildStretch's splitting take over (the seam gets the overshoot mitre)
        return buildStretch([...loop.slice(v), ...loop.slice(0, v + 1)], wallNs[v % nSeg]);
      }
    }
    // Open stretches between breaks. An open chain's endpoints are implicit breaks; a
    // closed chain's stretches wrap from each break to the next.
    const bounds = closed
      ? breaks.map((b, j) => [b, breaks[(j + 1) % breaks.length] + (j + 1 === breaks.length ? m : 0)])
      : (breaks.length ? [[0, breaks[0]], ...breaks.map((b, j) => [b, j + 1 < breaks.length ? breaks[j + 1] : m - 1])] : [[0, m - 1]]);
    const tools = [];
    const arcAt = (i) => cornerArcs.get(((i % m) + m) % m);
    for (const [s, e] of bounds) {
      if (e <= s) continue;
      let path = [];
      for (let i = s; i <= e; i++) path.push(at(i));
      const aS = arcAt(s), aE = arcAt(e);
      if (aS) path = pullBack(path, aS.t, false);
      if (aE) path = pullBack(path, aE.t, true);
      tools.push(...buildStretch(path, wallNs[s % nSeg]));
    }
    for (const got of cornerArcs.values()) {
      tools.push(revolveTool(k, got.arc, magnitude, mode, segs, pSegs, flankAt));
      if (len(sub(got.vertex, got.arc.O)) - got.arc.R > 0.02 * magnitude)
        tools.push(cornerHornTool(k, got, magnitude, segs, flankAt));
    }
    for (const piv of pivots) tools.push(reflexPivotTool(k, piv, magnitude, mode, segs, pSegs));
    return tools;
  } catch (e) {
    throw new UnsupportedEdgeError(`planar sweep: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Steered corners. Where exactly TWO selected convex chains meet at a salient corner
// in a common face plane (a letter corner, a polygon corner on a rim), the two blends
// cross in a mitre — a REAL crease, 76-90° dihedral measured, the same
// intersection-and-trim seam OCCT's native fillet produces. There is no groove-free
// construction that keeps the silhouette sharp: a band tangent to both walls around a
// salient corner must crease, and a band that lifts off the walls strands the corner
// column (verified again 2026-08-17 — the reflex pivot's torus does NOT mirror to
// salient corners; the ball never touches a convex corner edge, and the mitre groove
// of the neighbor cylinders survives beyond any such patch). So the mitre IS the
// treatment for corners sharp enough to read as corners — see cornerArcAt's upper
// gate — and the steer below exists only for the GENTLE band
// (CORNER_ROUND_MIN_TURN..SMOOTH_MAX_DEG): the corner is replaced by a small
// circular ARC chain (radius ~1.05-1.25× the blend magnitude, tangent to both
// neighbors at a setback), the neighbors are trimmed to the tangent points, and the
// existing revolveTool sweeps the arc. At these angles a mitre's long shallow
// overlap wedge triangulates into >35° junk lines (measured: a 20.7° mitre still
// drew, an ~8° one does not) while the steer's silhouette cost — a sagitta of
// ρ·(1−cos(turn/2)), plus the horn's sub-visible shelf — stays microns deep, so the
// trade runs the opposite way to a sharp corner's.
//
// REFLEX corners take the rolling-ball PIVOT instead (reflexPivotAt below): steering
// the band path around a reflex corner would ADD material, but the ball itself swings
// about the corner touching the face and the vertical corner edge — see the reflex
// pivot section. A gentle salient corner whose neighbors are too short to host the
// setback (tight glyph features) falls back to the mitre — that fallback is never a
// failure.
const CORNER_ROUND_MIN_TURN = (8 * Math.PI) / 180;
const RHO_MIN = 1.05;   // × magnitude — revolve floor: the profile reaches magnitude inward of the arc
const RHO_PREF = 1.25;  // × magnitude — preferred corner radius, a hair over the floor for margin

// Corner-arc descriptor at one vertex. tin1/tin2 point from the vertex INTO each side;
// wall1/wall2 are the sides\' outward wall normals at the vertex; len1/len2 bound the
// setback. Returns { arc, t } (a synthetic kind:"arc" chain for revolveTool, plus the
// setback to trim each side by) or null when the corner keeps its mitre.
function cornerArcAt(vertex, f, tin1, tin2, wall1, wall2, len1, len2, magnitude, allowSharp = false) {
  const tIn = scl(tin1, -1), tOut = tin2;         // travel: arrive along side 1, depart into 2
  const turn = Math.acos(clamp1(dot(tIn, tOut)));
  if (turn < CORNER_ROUND_MIN_TURN) return null;
  // A corner past the chain-smoothness bar READS as a corner and keeps the honest
  // mitre (decided 2026-08-17): the two blends run to the vertex and cross in the
  // classic intersection seam every B-rep fillet shows — the seam is a real crease,
  // its feature line is correct, and the top face keeps its sharp corner. The
  // arc-steer below is only for gentle corners, where the sub-visible horn shelf is
  // a fair price for killing the shallow-overlap junk lines a gentle mitre draws.
  // Steering SHARP corners bought a clean band at the cost of a rounded in-band
  // silhouette hovering over the sharp extrude corner with a flat shelf between —
  // a mismatch no CAD user expects (the label part's non-bold letter terminals).
  // `allowSharp` is the one exception: when the corner's vertical edge is being
  // blended too (roundAll, a selector-free fillet), the column below the band is
  // itself rounded at r — the steer approximates the ball's sphere corner there
  // and nothing is left to mismatch (planarTool derives it from apply()'s endTins).
  if (!allowSharp && turn > (SMOOTH_MAX_DEG * Math.PI) / 180) return null;
  const turnS = dot(cross(tIn, tOut), f);
  const matLeft = dot(wall1, cross(tIn, f)) > 0;
  if ((turnS > 0) !== matLeft) return null;       // reflex: the crease is real — keep the mitre
  const tanH = Math.tan(turn / 2);
  if (!(tanH > 1e-6) || !Number.isFinite(tanH)) return null;
  const t = Math.min(RHO_PREF * magnitude * tanH, 0.45 * len1, 0.45 * len2);
  const rho = t / tanH;
  if (rho < RHO_MIN * magnitude) return null;     // no room: mitre fallback
  // inward bisector from the walls; O sits at distance rho from both edge lines
  const proj = (wl) => { const p = sub(scl(wl, -1), scl(f, -dot(wl, f))); const l = len(p) || 1; return scl(p, 1 / l); };
  const uA = proj(wall1), uB = proj(wall2);
  const bisRaw = add(uA, uB);
  if (len(bisRaw) < 1e-9) return null;
  const O = add(vertex, scl(norm(bisRaw), rho / Math.cos(turn / 2)));
  const pA = add(vertex, scl(tin1, t)), pB = add(vertex, scl(tin2, t));
  const u0raw = sub(pA, O), uEraw = sub(pB, O);
  const u0 = norm(u0raw), uE = norm(uEraw);
  const span = Math.acos(clamp1(dot(u0, uE)));
  if (!(span > 1e-4)) return null;
  const s = dot(cross(u0, uE), f) >= 0 ? 1 : -1;  // orient w so azimuth increases pA → pB
  const w = scl(f, s);
  // rotating-frame flanks, fitArcChain\'s convention ([ρ-component, w-component]):
  // the face flank is pure ±w, the wall is pure outward radial
  return {
    t,
    vertex,
    f,
    arc: { kind: "arc", points: [pA, pB], O, w, u0, v0: cross(w, u0), R: rho, span,
           closed: false, n1: [0, s], n2: [1, 0], convex: true, synthetic: true },
  };
}

// The horn cutter that completes a rounded corner. The arc tool blends the band around
// the corner's arc cylinder, but the SOLID still has its sharp corner: the column of
// material between that cylinder and the original vertex would poke up through the band
// untouched. This block removes it — footprint bounded by the two walls and an arc-side
// polyline held strictly INSIDE the arc tool's own cut region — from just above the
// face down to exactly band depth. What remains below is a small flat shelf at the
// corner base; its rim is a boundary line BELOW the band, the deliberate trade for a
// band with no lines across it.
//
// The arc-side vertices sit at the arc TOOL's guaranteed apothem, R·cos(π/aSegs), less
// a micron margin — not on the circle itself. Vertices on the circle only bow inside
// the SMOOTH cylinder; the tool is a polygonal revolve whose facets sit at ITS apothem,
// and whenever the horn's chords landed shallower than a tool facet (a short-span arc
// at reduced angular density), the wall between them survived both cutters as a lens
// filament — an island or a handle, decided by facet phase (measured: the arrow's
// 20.7° corner flipped genus at some densities and not others). The apothem bound makes
// containment a proof instead of a phase lottery: tool pitch ≤ 2π/aSegs by definition
// of its step count, so its apothem ≥ R·cos(π/aSegs) > every horn vertex radius. The
// cost is a micron-deep extra bite at the corner base, covered near the tangent lines
// by the neighbors' own overshoot.
function cornerHornTool(k, { vertex, f, arc }, magnitude, segs, flankAt = () => segs) {
  const { O, w, u0, R, span } = arc;
  const delta = 0.02 * magnitude;
  const rH = R * Math.cos(Math.PI / cornerArcSegs(segs, R, magnitude)) - Math.min(1e-3, 0.02 * magnitude);
  // Pose and depth run along the FACE normal f (material below the face), never the
  // arc's w — w flips sign with the arc's travel direction, and a block lofted along a
  // downward w would stand above the face and cut the top instead of the horn.
  const aRaw = cross([0, 0, 1], f);
  const s = len(aRaw);
  let axis = null, theta = 0;
  if (s > 1e-9) { axis = scl(aRaw, 1 / s); theta = Math.atan2(s, f[2]); }
  else if (f[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
  const u = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
  const v = axis ? rotVec([0, 1, 0], axis, theta) : [0, 1, 0];
  const p2 = (p) => { const q = sub(p, O); return [dot(q, u), dot(q, v)]; };
  const poly = [];
  poly.push(p2(add(vertex, scl(norm(sub(vertex, O)), delta))));      // vertex, nudged outward
  poly.push(p2(add(O, scl(u0, R + delta))));                         // tangent A, nudged past its wall
  const steps = 8;
  for (let i = 0; i <= steps; i++) poly.push(p2(add(O, scl(rotVec(u0, w, (span * i) / steps), rH))));
  poly.push(p2(add(O, scl(rotVec(u0, w, span), R + delta))));        // tangent B, nudged past its wall
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  const ring = area < 0 ? poly.slice().reverse() : poly;
  let tool = k.loft([{ polygon: ring, z: -magnitude }, { polygon: ring, z: delta }], { shading: "smooth" });
  if (axis) tool = tool.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
  return tool.translate(O);
}

// ---------------------------------------------------------------------------
// Reflex pivots. At a REFLEX corner the neighboring blend tools end flush against the
// planes through the vertex (their only overshoot is the 0.05·r anti-graze allowance),
// so the wedge of rim material between those end planes — azimuthal extent = the turn
// angle — survives both cutters and the face keeps a point essentially AT the vertex.
// The rolling ball does not stop there: it pivots about the corner, touching the face
// and the vertical corner edge, its center swinging on an arc of radius r about the
// face-normal axis through the vertex. The envelope is a horn-torus patch — the
// revolve, about that axis, of the blend cross-section running from the axis point
// r below the face to the face tangency at radius r — and the face's blend boundary
// becomes an arc of radius r about the vertex (the "rounded inside curve"). The pivot
// cross-section at each span end coincides exactly with the neighbor tool's own
// cross-section at the vertex (same circle, same plane), so the handover is G1; the
// small angular overshoot below only re-cuts band the neighbors already cut.

// Pivot descriptor at one vertex, or null (salient — cornerArcAt's case — or a turn
// too gentle to matter). Same argument convention as cornerArcAt: tin1/tin2 point
// from the vertex INTO each side, wall1/wall2 are the sides' outward wall normals.
function reflexPivotAt(vertex, f, tin1, tin2, wall1, wall2) {
  const tIn = scl(tin1, -1), tOut = tin2;
  const turn = Math.acos(clamp1(dot(tIn, tOut)));
  if (turn < CORNER_ROUND_MIN_TURN) return null;  // wedge sagitta sub-micron: keep today's behavior
  const turnS = dot(cross(tIn, tOut), f);
  const matLeft = dot(wall1, cross(tIn, f)) > 0;
  if ((turnS > 0) === matLeft) return null;       // salient: roundSalientCorners' territory
  // inward in-plane wall normals bound the uncut wedge; the pivot sweeps between them
  const proj = (wl) => { const p = sub(scl(wl, -1), scl(f, -dot(wl, f))); const l = len(p) || 1; return scl(p, 1 / l); };
  let u0 = proj(wall1), uE = proj(wall2);
  const span = Math.acos(clamp1(dot(u0, uE)));
  if (!(span > 1e-4)) return null;
  if (dot(cross(u0, uE), f) < 0) [u0, uE] = [uE, u0]; // azimuth increases u0 → uE about +f
  return { vertex, f, u0, span };
}

// The pivot cutter: revolve of the blend cross-section about the face-normal axis
// through the vertex. Cross-section in (ρ, z) with z along f (face at z = 0): the
// fillet arc runs from the axis point (0, −r) to the face tangency (r, 0) on the
// circle centered (r, −r) — extended past the tangency by revolveTool's arc-tail
// recipe, because the blend meets the face tangentially there and a tessellated
// tangency grazes — then closes above the face so the corner column goes with it.
// A chamfer takes the chord instead (a cone), which meets face and edge transversally
// and needs no tail. Interior arc vertices use profile2D's area-exact radius.
function reflexPivotTool(k, { vertex, f, u0, span }, magnitude, mode, segs, pSegs) {
  const r = magnitude;
  const delta = 0.02 * r;
  let poly;
  if (mode === "chamfer") {
    poly = [[0, -r], [r, 0], [r + delta, delta], [0, delta]];
  } else {
    const sag = Math.min(2e-4, 0.02 * r);
    const ext = Math.min(0.4, Math.max(0.01, Math.acos(Math.max(-1, 1 - sag / r))));
    const arcSpan = Math.PI / 2 + ext;
    const nArc = Math.max(2, Math.ceil((arcSpan / (2 * Math.PI)) * pSegs));
    const th = arcSpan / nArc;
    const rEq = r * Math.sqrt(th / Math.sin(th));
    poly = [];
    for (let i = 0; i <= nArc; i++) {
      const a = Math.PI - arcSpan * (i / nArc);       // 180° (axis) → past the face tangency
      const ri = i === 0 || i === nArc ? r : rEq;
      poly.push([r + ri * Math.cos(a), -r + ri * Math.sin(a)]);
    }
    poly.push([poly[poly.length - 1][0], delta], [0, delta]);
  }
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) poly = poly.slice().reverse();
  // angular overshoot past both span ends: crosses the walls (tangent contacts at the
  // ends) decisively, re-cutting only band the flush-ended neighbors already cut
  const ovAng = 0.05;
  const degrees = ((span + 2 * ovAng) * 180) / Math.PI;
  let tool = k.revolve(poly, { degrees, segs: cornerArcSegs(segs, 0, magnitude) });
  // pose: Z → f, then twist the revolve's start azimuth (+X) onto u0 backed off by ovAng
  const v0 = cross(f, u0);
  const startDir = add(scl(u0, Math.cos(-ovAng)), scl(v0, Math.sin(-ovAng)));
  const axisRaw = cross([0, 0, 1], f);
  const s = len(axisRaw);
  let axis = null, theta = 0;
  if (s > 1e-9) { axis = scl(axisRaw, 1 / s); theta = Math.atan2(s, f[2]); }
  else if (f[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
  if (axis) tool = tool.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
  const xImage = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
  const twist = Math.atan2(dot(f, cross(xImage, startDir)), dot(xImage, startDir));
  if (Math.abs(twist) > 1e-9) tool = tool.rotateAbout({ axis: f, deg: (twist * 180) / Math.PI });
  tool = tool.translate(vertex);
  // spine: the ball centre swings on a circle of radius r, r below the face
  return mode === "fillet" ? markBlend(k, tool, { kind: "circle", c: sub(vertex, scl(f, r)), a: f, R: r }) : tool;
}

function chainEndInfo(ch, end) {
  if (ch.kind === "line") {
    return end === "start"
      ? { v: ch.a, tin: ch.dir, flanks: [ch.n1, ch.n2], len: ch.length }
      : { v: ch.b, tin: scl(ch.dir, -1), flanks: [ch.n1, ch.n2], len: ch.length };
  }
  const pts = ch.points, m = pts.length;
  let plen = 0;
  for (let i = 0; i + 1 < m; i++) plen += len(sub(pts[i + 1], pts[i]));
  return end === "start"
    ? { v: pts[0], tin: norm(sub(pts[1], pts[0])), flanks: [ch.faceN, ch.wallNs[0]], len: plen }
    : { v: pts[m - 1], tin: norm(sub(pts[m - 2], pts[m - 1])), flanks: [ch.faceN, ch.wallNs[ch.wallNs.length - 1]], len: plen };
}

// Corner treatment for two chain ends meeting at one vertex: {arc} for a salient
// corner with room for the setback, {pivot} for a reflex corner, or null (no common
// face plane, gentle turn, or a too-tight salient corner keeping its mitre).
function cornerBlendBetween(E1, E2, magnitude) {
  let f = null, wall1 = null, wall2 = null;
  for (const c1 of E1.flanks) {
    for (const c2 of E2.flanks) {
      if (dot(c1, c2) <= FLANK_COS) continue;
      // the shared face is ⟂ BOTH tangents; each wall is ⟂ only its own chain\'s
      if (Math.abs(dot(c1, E1.tin)) > 0.05 || Math.abs(dot(c1, E2.tin)) > 0.05) continue;
      f = norm(add(c1, c2));
      wall1 = E1.flanks[0] === c1 ? E1.flanks[1] : E1.flanks[0];
      wall2 = E2.flanks[0] === c2 ? E2.flanks[1] : E2.flanks[0];
    }
  }
  if (!f) return null;
  const corner = cornerArcAt(E1.v, f, E1.tin, E2.tin, wall1, wall2, E1.len, E2.len, magnitude);
  if (corner) return { corner };
  const pivot = reflexPivotAt(E1.v, f, E1.tin, E2.tin, wall1, wall2);
  return pivot ? { pivot } : null;
}

// Convert a FACE-PLANE arc chain to the equivalent planar chain, or return null when
// the arc has no world-constant flank (a rim on a curved face — revolveTool's
// irreplaceable case). In-plane rims blend by sweeping their own polyline instead of
// revolving a fitted circle, for two reasons measured on a label backing. The sweep's
// stations sit ON the rim vertices, so its flank contact is plane-exact per wall facet,
// where the revolve's contact is a three-way micron contest (its own angular chords,
// the wall's facets, and the circle fit's offset) that strands radial knife-fins along
// the band whenever the margins interfere. And a planar chain STITCHES to its planar
// neighbors, so the arc↔planar junction — two tools overshooting tangentially into
// each other, which roundSalientCorners never handled because it skips arc chains —
// stops existing as a category. Selection still runs on the ARC form (near-selectors
// match the fitted circle, not its chords); conversion happens after, in apply().
function planarizeArc(ch) {
  if (ch.kind !== "arc") return null;
  // face flank = the rotating-frame flank that is axial (±w, world-constant); ~3° bar
  const pick = Math.abs(ch.n1[0]) <= 0.05 ? 0 : Math.abs(ch.n2[0]) <= 0.05 ? 1 : -1;
  if (pick === -1) return null;
  const [face, wall] = pick === 0 ? [ch.n1, ch.n2] : [ch.n2, ch.n1];
  const faceN = scl(ch.w, Math.sign(face[1]));
  const pts = ch.points;
  const wallNs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const q = sub(scl(add(pts[i], pts[i + 1]), 0.5), ch.O);
    const rho = norm(sub(q, scl(ch.w, dot(q, ch.w))));
    wallNs.push(norm(add(scl(rho, wall[0]), scl(ch.w, wall[1]))));
  }
  return { kind: "planar", points: pts.map((p) => [p[0], p[1], p[2]]), closed: ch.closed,
           convex: ch.convex, w: faceN, faceN, wallNs };
}

// Trim a chain back by tStart/tEnd (0 = untouched) toward the corner arcs that replace
// its mitred ends. Line chains shift their endpoints; planar chains walk the polyline in
// from each end, dropping consumed vertices (and their members\' wall normals) and
// planting the new endpoint mid-segment. Returns the trimmed copy, or null when nothing
// usable remains (guarded against by cornerArcAt\'s 0.45·length setback cap).
function trimChain(ch, tStart, tEnd) {
  if (!(tStart > 0) && !(tEnd > 0)) return ch;
  if (ch.kind === "line") {
    const length = ch.length - tStart - tEnd;
    if (!(length > 1e-9)) return null;
    return { ...ch, a: add(ch.a, scl(ch.dir, tStart)), b: sub(ch.b, scl(ch.dir, tEnd)), length };
  }
  let pts = ch.points.map((p) => [p[0], p[1], p[2]]);
  let walls = ch.wallNs.slice();
  const eat = (t) => {   // consume t from the FRONT of pts/walls
    while (t > 1e-12 && pts.length >= 2) {
      const seg = sub(pts[1], pts[0]), l = len(seg);
      if (l > t + 1e-12) { pts[0] = add(pts[0], scl(seg, t / l)); return true; }
      t -= l;
      pts.shift();
      walls.shift();
    }
    return pts.length >= 2;
  };
  const flip = () => { pts.reverse(); walls.reverse(); };
  if (tStart > 0 && !eat(tStart)) return null;
  if (tEnd > 0) { flip(); if (!eat(tEnd)) return null; flip(); }
  if (pts.length < 2) return null;
  return { ...ch, points: pts, wallNs: walls, closed: false };
}

// Blend the two-chain corners of a selection: salient corners round (trimmed neighbors
// substituted in place, plus the synthetic corner-arc chains and their horns); reflex
// corners get rolling-ball pivots (neighbors stay flush — the pivot owns the wedge).
function roundSalientCorners(selected, magnitude) {
  const keyOf = (p) => `${Math.round(p[0] * WELD)},${Math.round(p[1] * WELD)},${Math.round(p[2] * WELD)}`;
  const ends = new Map();
  for (const ch of selected) {
    if (ch.closed || ch.convex !== true) continue;
    if (ch.kind !== "line" && ch.kind !== "planar") continue;
    for (const end of ["start", "end"]) {
      const info = chainEndInfo(ch, end);
      const kk = keyOf(info.v);
      (ends.get(kk) ?? ends.set(kk, []).get(kk)).push({ ch, end, info });
    }
  }
  const arcs = [], horns = [], pivots = [], trims = new Map();
  const addTrim = (ch, end, t) => {
    const cur = trims.get(ch) ?? { start: 0, end: 0 };
    cur[end] = t;
    trims.set(ch, cur);
  };
  for (const list of ends.values()) {
    if (list.length !== 2 || (list[0].ch === list[1].ch && list[0].end === list[1].end)) continue;
    const blend = cornerBlendBetween(list[0].info, list[1].info, magnitude);
    if (!blend) continue;
    if (blend.pivot) { pivots.push(blend.pivot); continue; }
    const got = blend.corner;
    arcs.push(got.arc);
    // a gentle corner's horn is a sliver — depth ρ·(1/cos(turn/2) − 1), microns at
    // small turns — not worth a cutter (and thin cutters are their own noise source)
    if (len(sub(got.vertex, got.arc.O)) - got.arc.R > 0.02 * magnitude)
      horns.push({ vertex: got.vertex, f: got.f, arc: got.arc });
    addTrim(list[0].ch, list[0].end, got.t);
    addTrim(list[1].ch, list[1].end, got.t);
  }
  if (!arcs.length) return { chains: selected, arcs, horns, pivots };
  const chains = [];
  for (const ch of selected) {
    const tr = trims.get(ch);
    const eff = tr ? trimChain(ch, tr.start, tr.end) : ch;
    if (eff) chains.push(eff);
  }
  return { chains, arcs, horns, pivots };
}

// ---------------------------------------------------------------------------
// Spherical corner patches. Where exactly three selected straight convex chains
// meet at a vertex with mutually orthogonal directions (a box-like corner), the
// three edge blends are capped with a rolling-ball sphere octant instead of the
// default mitre: cutter = corner cube − sphere(C, r), the classic corner-mask
// construction, with C = V + r·(ê1+ê2+ê3) (distance r inside each face). The
// cube spans exactly [V, V + r·ê_j] — the sphere-cylinder tangent planes —
// because inside that cube the true rolling-ball surface is PURE sphere (the
// edge cylinders end at the tangent planes; extending protection cylinders in
// here would preserve their proud Steinmetz-intersection ridges instead of the
// sphere patch, and extending the cube out would gouge the edge fillets). The
// cube's outer walls land inside the material the edge cutters already remove,
// so the only new surface is the octant. Non-orthogonal corners keep the mitre
// — the safe, documented default.
function cornerPatches(k, selected, r, segs, flankAt = () => segs) {
  const byVertex = new Map();
  const push = (pt, dirOut) => {
    const key = pt.map((v) => Math.round(v * 1e4)).join(",");
    (byVertex.get(key) ?? byVertex.set(key, []).get(key)).push({ pt, dirOut });
  };
  for (const ch of selected) {
    if (ch.convex !== true) continue;
    if (ch.kind === "line") {
      push(ch.a, ch.dir);
      push(ch.b, scl(ch.dir, -1));
    } else if (ch.kind === "planar" && !ch.closed) {
      // A planar chain END whose end segment runs straight for ≥ r qualifies
      // too: inside the corner cube the sweep is the same straight cylinder a
      // line chain's prism tool would cut, so the octant construction holds
      // unchanged. This is the roundAll fast path's mixed corner — a straight
      // rim edge and a vertical edge (line chains) meeting a planar rim chain
      // whose curvature lives far from the corner. Requiring the full r of
      // straight run keeps the cube inside the cylinder-only zone.
      const p = ch.points, n = p.length;
      const d0 = sub(p[1], p[0]), dN = sub(p[n - 2], p[n - 1]);
      if (len(d0) >= r) push(p[0], scl(d0, 1 / len(d0)));
      if (len(dN) >= r) push(p[n - 1], scl(dN, 1 / len(dN)));
    }
  }
  const patches = [];
  for (const ends of byVertex.values()) {
    if (ends.length !== 3) continue;
    let [e1, e2, e3] = ends.map((e) => e.dirOut);
    const ortho = Math.abs(dot(e1, e2)) < 1e-3 && Math.abs(dot(e1, e3)) < 1e-3 && Math.abs(dot(e2, e3)) < 1e-3;
    if (!ortho) continue; // non-orthogonal trihedral: leave the mitre
    if (dot(cross(e1, e2), e3) < 0) [e2, e3] = [e3, e2]; // right-handed frame
    const V = ends[0].pt;
    const C = add(V, scl(add(add(e1, e2), e3), r));
    const dOut = 0.02 * r;
    // Bury the sphere a hair into the material (past its own facet sagitta): it
    // is tangent to each flat face at a point and meets the edge-fillet
    // cylinders tangentially at the cube walls, and tessellated tangency
    // produces the same grazing-noise creases the edge tools guard against.
    const bury = r * (1 - Math.cos(Math.PI / flankAt(r))) + 1e-3; // the kernel sphere below is built at flankAt(r)
    const inward = norm(add(add(e1, e2), e3));
    // corner block: cube spanned by the edge frame, oversized only outward
    let block = k.box({ min: [-dOut, -dOut, -dOut], max: [r, r, r] });
    // pose standard axes onto (e2, e3, e1): Z → e1, then twist X-image onto e2
    const axisRaw = cross([0, 0, 1], e1);
    const s = len(axisRaw);
    let axis = null, theta = 0;
    if (s > 1e-9) { axis = scl(axisRaw, 1 / s); theta = Math.atan2(s, e1[2]); }
    else if (e1[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
    if (axis) block = block.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
    const xImage = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
    const twist = Math.atan2(dot(e1, cross(xImage, e2)), dot(xImage, e2));
    if (Math.abs(twist) > 1e-9) block = block.rotateAbout({ axis: e1, deg: (twist * 180) / Math.PI });
    block = block.translate(V);
    const centre = add(C, scl(inward, bury));
    patches.push(block.cut(markBlend(k, k.sphere({ r }).at(centre), { kind: "point", c: centre })));
  }
  return patches;
}

// ---------------------------------------------------------------------------
// Entry points.
//   meshFillet(k, solid, { r, edges?, segs?, sharpDeg? })  → Solid
//   meshChamfer(k, solid, { d, edges?, segs?, sharpDeg? }) → Solid
export function meshFillet(k, solid, opts) { return apply(k, solid, "fillet", opts?.r, opts); }
export function meshChamfer(k, solid, opts) { return apply(k, solid, "chamfer", opts?.d, opts); }

// Chain classification and corner planning shared by apply() and meshFilletWork():
// everything up to (not including) building a single tool.
function planChains(solid, mode, magnitude, edges, sharpDeg) {
  const mesh = solid.toIndexedMesh();
  const chains = chainEdges(detectSharpEdges(mesh, { sharpDeg }));
  const selected = chains.filter((ch) => matchesSelector(ch, edges));
  if (!selected.length) throw new UnsupportedEdgeError(`${mode} selector matched no sharp edges`);
  const unsupported = selected.find((ch) => ch.kind === "unsupported");
  if (unsupported) throw new UnsupportedEdgeError(`${mode}: ${unsupported.reason}`);
  // Face-plane arc rims sweep their own polyline (see planarizeArc); re-stitch so a
  // converted arc joins its planar neighbors — chainEdges' own stitch pass ran before
  // these chains were planar, so their junctions are still open here.
  const planarized = stitchPlanarChains(selected.map((ch) => planarizeArc(ch) ?? ch), { absorbLines: true });
  // Ends of selected chains, keyed by vertex — planarTool steers a SHARP break
  // corner only when another selected chain leaves that vertex out of the face
  // plane (a vertical edge being blended too, the roundAll/trihedral case where
  // the corner column below the band is itself rounded and the steer's shelf is
  // consumed by that blend). A sharp corner with nothing else selected there
  // keeps the honest mitre — see the steered-corners section.
  const endTins = new Map();
  for (const ch of planarized) {
    if (ch.closed || (ch.kind !== "line" && ch.kind !== "planar")) continue;
    for (const end of ["start", "end"]) {
      const info = chainEndInfo(ch, end);
      const kk = pivotKey(info.v);
      (endTins.get(kk) ?? endTins.set(kk, []).get(kk)).push(info.tin);
    }
  }
  let { chains: effective, arcs, horns, pivots } = roundSalientCorners(planarized, magnitude);
  // An edge whose two flanks fold back on themselves (anti-parallel normals) is a
  // zero-thickness fin or slit rim — a self-touching offset outline extrudes these.
  // There is no wedge between the flanks for a blend to live in (profile2D's own
  // ~180° knife-edge refusal), so skip the chain rather than fail every OTHER edge
  // of the selection with it.
  // Planar variant of the same degeneracy: a zero-area sliver in the face
  // triangulation flips its facet normal, classifying as a "wall" anti-parallel
  // to the face — profile2D's projected normals then hit the same refusal.
  const knife = (ch) => ch.kind === "planar"
    ? ch.wallNs.every((wn) => dot(ch.faceN, wn) < -1 + 1e-6)
    : ch.n1 && ch.n2 && dot(ch.n1, ch.n2) < -1 + 1e-6;
  effective = effective.filter((ch) => !knife(ch));
  arcs = arcs.filter((ch) => !knife(ch));
  // every general chain's smoothed stations, computed once: blendWork charges them,
  // the station cap reads them, and generalTool builds its rings from them
  const stations = new Map();
  for (const ch of effective)
    if (ch.kind === "general") stations.set(ch, smoothStations(generalStations(ch), ch.closed, magnitude));
  return { mesh, endTins, effective, arcs, horns, pivots, stations };
}

// Work budget (Task 4b, 2026-10-02). A general chain admits sub-parts that used to
// reroute on it — and those are disproportionately thread, knurl and texture
// geometry, with thousands of OTHER sharp edges behind the general ones. Measured
// over the fillet census (71 public forges + 56 eval cases, r = 0.5, preview
// quality, one process per sub-part), the time is the booleans of the whole tool
// set, not the general tools: a chain-mail sheet spent 10 s, of which its 27
// general tools were 1.8 s and its 99 arc tools ~7 s; the larger sheets ran
// 60–130 s at 1.5–4 GB and four of them exhausted the WASM heap. So the estimate
// counts every tool, weighted by its measured relative cost (least-squares fit of
// the per-kind counts against fillet time, rounded: line 1, arc rim 5, planar run
// 11, corner horn / pivot 4, corner arc 6, general 0.1 per chain vertex), times
// √(mesh triangles) (each boolean's cost grows with the body it cuts). Its fit to
// fillet time is ~1 work unit ≈ 0.035 ms.
//   GENERAL_WORK_BUDGET = 195 000: every census sub-part with a general chain that
//   filleted OK in ≤ 5 s sits at or below 189 858 (the highest: e106d859 dibber,
//   4.9 s); the lowest one above sits at 202 231 (ffacb618 chain-mail cells,
//   10.4 s). The general-chain fixtures sit far below (see the test file).
// Only a selection CONTAINING a general chain is budgeted: before general chains
// existed every such selection rerouted, so refusing one is never a regression,
// while a selection of ordinary chains keeps its old behaviour whatever it costs.
// The count is deterministic — never wall-clock — so a build's result, and the
// solid cache keyed on it, cannot depend on how loaded the machine was. It does
// scale with √(mesh triangles), and print tessellates finer than preview, so a part
// just under the budget at preview can reroute at print: the same reroute class, with
// OCCT's result correct, only slower.
// A general chain is charged by its vertices, or by its smoothed station (ring)
// count / STATION_ALLOWANCE when that is larger. The 0.1-per-vertex weight was fitted
// on census chains carrying at most 11.4 stations per vertex (a knob; most carry 1–4),
// so with the allowance at 16 the fitted charge already covers their rings and every
// fixture and census work number is unchanged; a sliver-dominated path whose long
// members take hundreds of interior stations each (generalStations) is charged for
// its rings instead. Separately, a chain over MAX_GENERAL_STATIONS rings refuses
// outright (`too many sections`): 16 384 is 4.5× the longest census chain (3 609
// stations, a cap rim at print, which fillets OK), and bounds one chain's ring stack
// at a few hundred thousand vertices.
export const GENERAL_WORK_BUDGET = 195000;
export const MAX_GENERAL_STATIONS = 16384;
const STATION_ALLOWANCE = 16;
const WORK_WEIGHT = { line: 1, arc: 5, planar: 11, corner: 4, cornerArc: 6, generalPoint: 0.1 };
function blendWork({ mesh, effective, arcs, horns, pivots, stations }) {
  let units = WORK_WEIGHT.corner * (horns.length + pivots.length) + WORK_WEIGHT.cornerArc * arcs.length;
  let general = false, maxStations = 0;
  for (const ch of effective) {
    if (ch.kind === "general") {
      general = true;
      const m = stations.get(ch).length;
      maxStations = Math.max(maxStations, m);
      units += WORK_WEIGHT.generalPoint * Math.max(ch.points.length, m / STATION_ALLOWANCE);
    } else units += WORK_WEIGHT[ch.kind] ?? WORK_WEIGHT.line;
  }
  return { work: units * Math.sqrt(mesh.indices.length / 3), general, maxStations };
}

// The budget estimate for a fillet/chamfer, without building anything: `work` is
// what apply() compares against GENERAL_WORK_BUDGET when `general` is true. Throws
// the same UnsupportedEdgeError apply would for an empty or unsupported selection.
//   meshFilletWork(solid, { mode?, magnitude, edges?, sharpDeg? })
//     → { work, general, budget, maxStations, stationCap }
export function meshFilletWork(solid, { mode = "fillet", magnitude, edges, sharpDeg = 20 } = {}) {
  return { ...blendWork(planChains(solid, mode, magnitude, edges, sharpDeg)), budget: GENERAL_WORK_BUDGET,
    stationCap: MAX_GENERAL_STATIONS };
}

// `segs` is the kernel's per-circle CAP: it bounds the blend densities (blendSegs)
// and is what every circle was built at on a flat tier. `segsAt(r)` is what a circle
// of radius r was ACTUALLY built at — the print tier sizes circles by chord tolerance
// (circle-segs.js), so a flank's facet pitch is no longer the cap. The three places
// that reason about the neighbouring tessellation (revolveTool's seam-grazing sag and
// closed-revolve dephase, cornerHornTool's sphere burial) ask it; everything sized
// from the blend's own sagitta bound keeps the cap. Absent, it is the cap — the
// pre-print-rule behaviour, and byte-identical at preview either way.
function apply(k, solid, mode, magnitude, { edges, segs = DEFAULT_SEGS, sharpDeg = 20, segsAt = null } = {}) {
  if (!(magnitude > 0)) throw new Error(`mesh ${mode}: magnitude must be > 0`);
  const flankAt = segsAt ?? (() => segs);
  const plan = planChains(solid, mode, magnitude, edges, sharpDeg);
  const { mesh, endTins, effective, arcs, horns, pivots, stations } = plan;
  const { work, general, maxStations } = blendWork(plan);
  if (maxStations > MAX_GENERAL_STATIONS)
    throw new UnsupportedEdgeError(`general chain: too many sections for the mesh ${mode} (${maxStations} stations > ${MAX_GENERAL_STATIONS})`);
  if (general && work > GENERAL_WORK_BUDGET)
    throw new UnsupportedEdgeError(`general chain: too complex for the mesh ${mode} (work ${Math.round(work)} > budget ${GENERAL_WORK_BUDGET})`);
  const pSegs = blendSegs(segs, magnitude);
  // general fillet sections probe the flanks' section-plane curvature on the mesh
  const generals = mode === "fillet" ? effective.filter((ch) => ch.kind === "general") : [];
  const rays = generals.length ? localRays(mesh, generals.map((ch) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], pad = 3 * magnitude;
    for (const p of ch.points) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], p[a] - pad); b[a + 3] = Math.max(b[a + 3], p[a] + pad); }
    return b;
  }), 2 * magnitude) : null;
  const toolsFor = (ch) =>
    ch.kind === "planar"
      ? planarTool(k, ch, magnitude, mode, segs, pSegs, endTins, flankAt)
      : ch.kind === "arc"
        ? [revolveTool(k, ch, magnitude, mode, segs, pSegs, flankAt)]
        : ch.kind === "general"
          ? [generalTool(k, ch, magnitude, mode, pSegs, rays, stations.get(ch))]
          : [prismTool(k, ch, magnitude, mode, segs, pSegs)];
  const cutters = [...effective, ...arcs].filter((ch) => ch.convex).flatMap(toolsFor);
  cutters.push(...horns.map((h) => cornerHornTool(k, h, magnitude, segs, flankAt)));
  cutters.push(...pivots.map((p) => reflexPivotTool(k, p, magnitude, mode, segs, pSegs)));
  const fillers = effective.filter((ch) => !ch.convex).flatMap(toolsFor);
  if (mode === "fillet") cutters.push(...cornerPatches(k, effective, magnitude, segs, flankAt));
  let out = solid;
  if (cutters.length) out = out.cutAll(cutters);
  if (fillers.length) out = k.union([out, ...fillers]);
  return out;
}
