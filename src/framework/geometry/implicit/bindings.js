// src/framework/geometry/implicit/bindings.js
// Pose bindings: which frames move each preview vertex while a pose slider drags (the viewer
// deforms the last exact mesh by linear blend skinning until the exact rebuild lands —
// docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md §1). Preview only, pure JS.
//
// A UNIT is an IR node a frame places rigidly (ir.js `unit`: its effective frame differs from
// its parent's, and no warp, mirror or repeat lies above it). Each unit's subtree, less any
// nested unit's (unitDecision), is emitted as one program and evaluated at the vertices near it (inside its world box padded by
// band + 2·edge; a vertex near no unit tries every unit). A vertex binds to the frame of the
// nearest unit (A) and, when the nearest unit of ANOTHER frame (B) is within `band` of it,
// blends toward B: weight (A's share) = clamp(0.5 + (d_B − d_A) / (2·band), 0.5, 1). Frames are
// rigid, so a unit's distance in its parent's space is its distance in the world.
import { compose, invert, xformPoint } from "./frames.js";
import { emitProgram, evalBatch } from "./program.js";

/** The blend band, in preview cells. */
export const BIND_BAND_CELLS = 3;
/** The most frames a binding can name (a frame index is 1 + its place in frameNames; 0 is unbound). */
export const MAX_BIND_FRAMES = 1023;

// A unit's own geometry: its subtree LESS every descendant unit's subtree (a nested unit
// binds its own vertices; left in, the outer unit's union would tie it everywhere — a hard
// union gives d_outer = d_inner — and every inner vertex would blend 50/50). A dropped kid is
// null, which emitProgram skips in a union / intersect / contact. A node left with no
// geometry is null itself: a wrapper (round, onion, displace, …) whose kid was dropped, an
// n-ary node whose kids all were, a subtract whose base was. A unit whose decision is null
// has no geometry of its own and gets no program. (Mirror, warp and repeat subtrees hold no
// units — ir.js clears `rigid` below them — so they are never cut.)
function unitDecision(nodes, id, top = true) {
  const n = nodes[id];
  if (!top && n.unit) return null;
  if (n.children.length === 0) return { id };
  if (n.kind === "mirror") {
    const k = unitDecision(nodes, n.children[0], false);
    return k ? { id, kids: [k, unitDecision(nodes, n.children[0], false)] } : null;
  }
  const kids = n.children.map((c) => unitDecision(nodes, c, false));
  if (kids.every((k) => k === null)) return null;
  if (n.kind === "subtract" && kids[0] === null) return null;
  if (kids.length === 1 && kids[0] === null) return null;
  return { id, kids };
}

/**
 * @param compiled  compileImplicit's result (its IR carries `frame`, `world`, `worldBox`, `unit`)
 * @param positions Float32Array|Float64Array, xyz per vertex, world (model) frame
 * @param edge      the preview grid edge the mesh was built at
 * @returns {{ frameA: Uint16Array, frameB: Uint16Array, weight: Float32Array }}
 */
export function bindVertices(compiled, positions, edge, { band = BIND_BAND_CELLS * edge } = {}) {
  const nV = Math.floor(positions.length / 3);
  const frameA = new Uint16Array(nV), frameB = new Uint16Array(nV), weight = new Float32Array(nV).fill(1);
  const names = compiled.frameNames ?? [];
  if (nV === 0 || names.length === 0 || names.length > MAX_BIND_FRAMES) return { frameA, frameB, weight };
  const nodes = compiled.ir.nodes;
  const units = [], decisions = [];
  for (let id = 0; id < nodes.length; id++) {
    if (!nodes[id].unit) continue;
    const dec = unitDecision(nodes, id);
    if (dec) { units.push(id); decisions.push(dec); }   // a unit with no geometry of its own binds nothing
  }
  if (units.length === 0) return { frameA, frameB, weight };

  // Candidates: per unit, the vertices inside its padded world box.
  const pad = band + 2 * edge;
  const lists = units.map(() => []);
  const claimed = new Uint8Array(nV);
  for (let u = 0; u < units.length; u++) {
    const { min, max } = nodes[units[u]].worldBox;
    const x0 = min[0] - pad, y0 = min[1] - pad, z0 = min[2] - pad, x1 = max[0] + pad, y1 = max[1] + pad, z1 = max[2] + pad;
    const list = lists[u];
    for (let v = 0, o = 0; v < nV; v++, o += 3) {
      const x = positions[o], y = positions[o + 1], z = positions[o + 2];
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) { list.push(v); claimed[v] = 1; }
    }
  }
  const orphans = [];
  for (let v = 0; v < nV; v++) if (!claimed[v]) orphans.push(v);
  if (orphans.length) for (const list of lists) for (const v of orphans) list.push(v);

  // Per vertex: the nearest unit's frame (f1, d1) and the nearest unit of another frame (f2, d2).
  // Streaming in unit order with strict `<` is a stable sort by value: a tie goes to the earlier unit.
  const d1 = new Float64Array(nV).fill(Infinity), d2 = new Float64Array(nV).fill(Infinity);
  const f1 = new Uint16Array(nV), f2 = new Uint16Array(nV);
  const p = [0, 0, 0];
  for (let u = 0; u < units.length; u++) {
    const list = lists[u];
    if (list.length === 0) continue;
    const n = nodes[units[u]], f = 1 + names.indexOf(n.frame);
    const Wparent = n.inv ? compose(n.world, n.inv) : n.world, toParent = invert(Wparent);
    const m = list.length, X = new Float64Array(m), Y = new Float64Array(m), Z = new Float64Array(m), out = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const o = list[i] * 3;
      xformPoint(p, toParent, positions[o], positions[o + 1], positions[o + 2]);
      X[i] = p[0]; Y[i] = p[1]; Z[i] = p[2];
    }
    evalBatch(emitProgram(compiled, decisions[u]), compiled.textures, X, Y, Z, out);
    for (let i = 0; i < m; i++) {
      const v = list[i], d = out[i];
      if (f1[v] === 0) { f1[v] = f; d1[v] = d; }
      else if (f === f1[v]) { if (d < d1[v]) d1[v] = d; }
      else if (d < d1[v]) { f2[v] = f1[v]; d2[v] = d1[v]; f1[v] = f; d1[v] = d; }
      else if (d < d2[v]) { f2[v] = f; d2[v] = d; }
    }
  }
  for (let v = 0; v < nV; v++) {
    frameA[v] = f1[v];
    const gap = d2[v] - d1[v];
    if (f2[v] !== 0 && gap < band) {
      frameB[v] = f2[v];
      const w = 0.5 + gap / (2 * band);
      weight[v] = w < 0.5 ? 0.5 : w > 1 ? 1 : w;
    }
  }
  return { frameA, frameB, weight };
}
