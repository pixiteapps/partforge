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
// Anything else (helical edges, varying dihedral, branching curves) raises
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
      for (let i = 0; i + 1 < chain.points.length; i++) {
        const a = chain.points[i], b = chain.points[i + 1];
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
function profile2D({ P, n1, n2, magnitude, mode, convex, segs, ext = 0 }) {
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
  const nArc = Math.max(2, Math.ceil((span / (2 * Math.PI)) * segs));
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
  const chains = chainEdges(detectSharpEdges(solid.toIndexedMesh(), { sharpDeg }));
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
  const pSegs = blendSegs(segs, magnitude);
  const toolsFor = (ch) =>
    ch.kind === "planar"
      ? planarTool(k, ch, magnitude, mode, segs, pSegs, endTins, flankAt)
      : ch.kind === "arc"
        ? [revolveTool(k, ch, magnitude, mode, segs, pSegs, flankAt)]
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
