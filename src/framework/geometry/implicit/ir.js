// src/framework/geometry/implicit/ir.js
// Spec → IR. Resolves frames, placements (plan decision 2), warps' bases, repeat
// and tube expansion, expr lowering and texture slots; computes each node's box
// (in its parent's coordinates), Lipschitz factor L, thinnest feature and growth
// bound G. The IR is the single input to the reference evaluator, the interval pass
// and the emitter.
//
// G (0 < G ≤ 1) is a lower bound on how fast a node's field grows with distance
// outside its box. Pads that move a surface outward by some amount (blend, round,
// onion, displace) cover it only when the child's field grows at least at rate 1, so
// they pad by amount / G: an ellipsoid grows at min(r)/max(r), an upscaling taper at
// 1/scale, a twist and a bend slower toward their rims. An `expr` node's declared
// box is its bound (its author owns it), so it counts as G = 1.
import { resolveFrames, compose, invert, translation, rotation, axisVector, xformPoint, IDENTITY } from "./frames.js";
import { compileExprSource } from "./expr-lower.js";
import { makeTexture, checkTextureBudget } from "./textures.js";
import { PRIM, WARP, roundConeParams, primLipschitz } from "./primitives.js";
import { BULGE_DEFAULT, ATTACH_STRIDE, MAX_OWNER_K } from "./contact.js";
import { contactRegions, regionDigest } from "./regions.js";
import { ImplicitSpecError } from "./errors.js";

const INF = Infinity;
const AXIS_INDEX = { yz: 0, xz: 1, xy: 2 };
const box = (min, max) => ({ min, max });
const boxUnion = (a, b) => box(a.min.map((v, i) => Math.min(v, b.min[i])), a.max.map((v, i) => Math.max(v, b.max[i])));
const boxInter = (a, b) => box(a.min.map((v, i) => Math.max(v, b.min[i])), a.max.map((v, i) => Math.min(v, b.max[i])));
export const boxPad = (b, d) => box(b.min.map((v) => v - d), b.max.map((v) => v + d));
const finite = (b) => b.min.every(Number.isFinite) && b.max.every(Number.isFinite);
export function boxXform(b, M) {
  if (!finite(b)) return box([-INF, -INF, -INF], [INF, INF, INF]);
  const out = box([INF, INF, INF], [-INF, -INF, -INF]), p = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    xformPoint(p, M, c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]);
    for (let i = 0; i < 3; i++) { out.min[i] = Math.min(out.min[i], p[i]); out.max[i] = Math.max(out.max[i], p[i]); }
  }
  return out;
}
const isIdentity = (M) => M.every((v, i) => v === IDENTITY[i]);

/** Basis taking `axis` to z and `toward` to x (rows x̂, ŷ, ẑ); null when it is the identity. */
function warpBasis(axis = "z", toward) {
  const z = axisVector(axis);
  let t = toward != null ? axisVector(toward) : Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = t[0] * z[0] + t[1] * z[1] + t[2] * z[2];
  t = [t[0] - d * z[0], t[1] - d * z[1], t[2] - d * z[2]];
  const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
  if (!(tl > 1e-9)) throw new ImplicitSpecError("bend `toward` must not be parallel to `axis`");
  const x = [t[0] / tl, t[1] / tl, t[2] / tl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const B = Float64Array.of(...x, ...y, ...z, 0, 0, 0);
  return isIdentity(B) ? null : B;
}

export function lowerSpec(spec, { images = new Map() } = {}) {
  const frames = resolveFrames(spec.frames ?? {});
  const nodes = [];
  const textures = [], slotOf = new Map();
  const slot = (imageName) => {
    if (slotOf.has(imageName)) return slotOf.get(imageName);
    const img = images.get(imageName);
    if (!img) throw new ImplicitSpecError(`unknown image "${imageName}" — declare it in the part's \`images\` field`);
    textures.push(makeTexture(img));
    slotOf.set(imageName, textures.length - 1);
    return textures.length - 1;
  };
  const lowerSource = (src, uniforms, texMap, path) => {
    const textureSlots = {};
    for (const [name, t] of Object.entries(texMap ?? {})) textureSlots[name] = slot(t.image);
    try { return compileExprSource(src, { uniforms: uniforms ?? {}, textureSlots }); }
    catch (e) { if (e.name === "ExprError") throw new ImplicitSpecError(`${path}: ${e.message}`); throw e; }
  };

  const add = (n) => { nodes.push(n); return nodes.length - 1; };
  let hasExpr = false, hasContact = false;
  const warnings = [];
  const placeOf = (node, Wparent) => {
    const base = node.frame != null ? frames.get(node.frame).world : Wparent;
    return node.at ? compose(base, translation(node.at)) : base;
  };
  const localInv = (W, Wparent) => { const M = compose(invert(W), Wparent); return isIdentity(M) ? null : M; };

  // Returns the node id. Wparent: world transform of the parent's local space.
  function lower(node, Wparent, path) {
    const W = placeOf(node, Wparent);
    const inv = localInv(W, Wparent);
    const toParent = inv ? invert(inv) : null;
    const finish = (n, localBox, thin, G = 1) => {
      n.inv = inv; n.label = node.label ?? null; n.path = path; n.G = G;
      n.box = toParent ? boxXform(localBox, toParent) : localBox;
      n.thin = thin;
      return add(n);
    };
    const prim = (code, P, localBox, thin, G = 1) => finish({ kind: "prim", prim: { code, P }, children: [], L: primLipschitz(code, P) }, localBox, thin, G);
    const minG = (ids) => Math.min(...ids.map((i) => nodes[i].G));
    const kids = (list, key = "children") => list.map((c, i) => lower(c, W, `${path}.${key}[${i}]`));
    const child = (c) => lower(c, W, `${path}.child`);
    switch (node.kind) {
      case "sphere": { const r = node.r; return prim(PRIM.SPHERE, Float64Array.of(r), box([-r, -r, -r], [r, r, r]), 2 * r); }
      case "ellipsoid": { const [a, b, c] = node.r; return prim(PRIM.ELLIPSOID, Float64Array.of(a, b, c), box([-a, -b, -c], [a, b, c]), 2 * Math.min(a, b, c), Math.min(a, b, c) / Math.max(a, b, c)); }
      case "capsule": {
        const a = node.a ?? [0, 0, 0], b = node.b;
        const [r1, r2] = Array.isArray(node.r) ? node.r : [node.r, node.r];
        const R = Math.max(r1, r2);
        const lb = boxPad(box(a.map((v, i) => Math.min(v, b[i])), a.map((v, i) => Math.max(v, b[i]))), R);
        if (r1 === r2) return prim(PRIM.CAPSULE, Float64Array.of(...a, ...b, r1), lb, 2 * r1);
        return prim(PRIM.ROUNDCONE, roundConeParams(a, b, r1, r2), lb, 2 * Math.min(r1, r2));
      }
      case "box": {
        const [hx, hy, hz] = node.size.map((v) => v / 2);
        return prim(PRIM.BOX, Float64Array.of(hx, hy, hz, node.round ?? 0), box([-hx, -hy, -hz], [hx, hy, hz]), 2 * Math.min(hx, hy, hz));
      }
      case "cylinder": case "torus": {
        // Authored about `axis` (default z): an inner basis rotation maps it to z.
        const B = warpBasis(node.axis ?? "z");
        const inner = node.kind === "cylinder"
          ? { code: PRIM.CYLINDER, P: Float64Array.of(node.h / 2, node.r, node.round ?? 0), lb: box([-node.r, -node.r, -node.h / 2], [node.r, node.r, node.h / 2]), thin: 2 * Math.min(node.r, node.h / 2) }
          : { code: PRIM.TORUS, P: Float64Array.of(node.R, node.r), lb: box([-node.R - node.r, -node.R - node.r, -node.r], [node.R + node.r, node.R + node.r, node.r]), thin: 2 * node.r };
        if (!B) return prim(inner.code, inner.P, inner.lb, inner.thin);
        const id = add({ kind: "prim", prim: { code: inner.code, P: inner.P }, children: [], L: primLipschitz(inner.code, inner.P), inv: B, label: null, path, box: boxXform(inner.lb, invert(B)), thin: inner.thin, G: 1 });
        return finish({ kind: "union", k: 0, children: [id], L: nodes[id].L }, nodes[id].box, inner.thin);
      }
      case "halfspace": {
        const n = axisVector(node.normal);
        return prim(PRIM.HALFSPACE, Float64Array.of(n[0], n[1], n[2], node.offset ?? 0), box([-INF, -INF, -INF], [INF, INF, INF]), INF);
      }
      case "tube": {
        const pts = node.points, radii = Array.isArray(node.r) ? node.r : pts.map(() => node.r);
        const segs = [];
        for (let i = 0; i + 1 < pts.length; i++) segs.push({ kind: "capsule", a: pts[i], b: pts[i + 1], r: radii[i] === radii[i + 1] ? radii[i] : [radii[i], radii[i + 1]] });
        const ids = kids(segs, "segments");
        return finish({ kind: "union", k: 0, children: ids, L: Math.max(...ids.map((i) => nodes[i].L)) }, ids.map((i) => nodes[i].box).reduce(boxUnion), Math.min(...ids.map((i) => nodes[i].thin)), minG(ids));
      }
      case "union": case "intersect": case "subtract": {
        const ids = kids(node.children);
        const k = node.k ?? 0, bs = ids.map((i) => nodes[i].box), G0 = minG(ids);
        const lb = node.kind === "union" ? boxPad(bs.reduce(boxUnion), ((ids.length - 1) * k) / 4 / G0)
          : node.kind === "intersect" ? bs.reduce(boxInter) : bs[0];
        // The child bounds are per-axis (L-infinity), so min-of-children growth holds
        // only per axis: a rotation above an intersect/subtract can turn the box so the
        // straight-line growth is up to sqrt(3) slower. Union's box is the union itself.
        const G = node.kind === "union" ? G0 : G0 / Math.sqrt(3);
        return finish({ kind: node.kind, k, children: ids, L: Math.max(...ids.map((i) => nodes[i].L)) }, lb, Math.min(...ids.map((i) => nodes[i].thin)), G);
      }
      case "contact": {
        // A contact group splits the surface into pieces its children own (the owner stages
        // read them off the root), so it must be the spec's root.
        if (path !== "root") throw new ImplicitSpecError(`${path}: a contact group must be the top of its k.implicit (it is the root's job to split the surface into pieces) — make it the spec's root and add the other shapes as its children, or build them as separate k.implicit calls and join them with k.union`);
        const ids = kids(node.children);
        const gap = node.gap ?? 0, bulge = node.bulge ?? BULGE_DEFAULT;
        const labelSlot = (l) => node.children.findIndex((c) => c.label === l);
        // `att` holds each anchor in the node's own frame, where the field (CONTACT) reads it;
        // `attWorld` the same table with the anchor in world space, where the owner stages
        // (crease cut, seam fade — both engines) test mesh positions. Frames are rigid, so the
        // two give the same weights; a moved root is what tells them apart.
        const att = new Float64Array((node.attach?.length ?? 0) * ATTACH_STRIDE), attWorld = new Float64Array(att.length);
        let maxK = 0;
        (node.attach ?? []).forEach((e, i) => {
          const wp = [0, 0, 0], an = [0, 0, 0];
          xformPoint(wp, frames.get(e.near).world, 0, 0, 0);
          xformPoint(an, invert(W), wp[0], wp[1], wp[2]);
          att.set([labelSlot(e.a), labelSlot(e.b), an[0], an[1], an[2], e.radius, e.band ?? e.radius / 2, e.k], i * ATTACH_STRIDE);
          attWorld.set([labelSlot(e.a), labelSlot(e.b), wp[0], wp[1], wp[2], e.radius, e.band ?? e.radius / 2, e.k], i * ATTACH_STRIDE);
          maxK = Math.max(maxK, e.k);
        });
        const G0 = minG(ids), Lk = Math.max(...ids.map((i) => nodes[i].L));
        if (ids.length > MAX_OWNER_K) throw new ImplicitSpecError(`${path}: a contact group takes at most ${MAX_OWNER_K} children (got ${ids.length})`);
        const n = { kind: "contact", children: ids, gap, bulge, att, attWorld };
        // The contact regions (regions.js), from the lowered children: per slot, the bulge
        // regions (BULGE_STRIDE each).
        const found = contactRegions({ ir: { nodes }, textures }, n, path);
        n.regions = found.regions; n.L = Lk + found.Lb;
        warnings.push(...found.warnings);
        hasContact = true;
        // A bulged piece's surface moves out by at most its Σ A (found.pad) over its growth G.
        // The attachments' unions dip k/4 below their pieces.
        const dip = maxK / 4;
        n.pad = (found.pad + dip) / G0;   // how far a piece's surface can leave its own box (frame-report.js)
        const lb = boxPad(ids.map((i) => nodes[i].box).reduce(boxUnion), n.pad);
        return finish(n, lb, Math.min(...ids.map((i) => nodes[i].thin)), G0);
      }
      case "mirror": {
        const id = child(node.child), axis = AXIS_INDEX[node.plane ?? "yz"], cb = nodes[id].box;
        const mb = box(cb.min.slice(), cb.max.slice());
        mb.min[axis] = -cb.max[axis]; mb.max[axis] = -cb.min[axis];
        return finish({ kind: "mirror", axis, children: [id], L: nodes[id].L }, boxUnion(cb, mb), nodes[id].thin, nodes[id].G);
      }
      case "round": { const id = child(node.child), G = nodes[id].G; return finish({ kind: "round", r: node.r, children: [id], L: nodes[id].L }, boxPad(nodes[id].box, node.r / G), nodes[id].thin + 2 * node.r, G); }
      case "onion": { const id = child(node.child), G = nodes[id].G; return finish({ kind: "onion", t: node.t, children: [id], L: nodes[id].L }, boxPad(nodes[id].box, node.t / G), 2 * node.t, G); }
      case "displace": {
        const id = child(node.child);
        const by = lowerSource(node.by.expr, node.by.uniforms, node.by.textures, `${path}.by.expr`);
        const G = nodes[id].G;
        return finish({ kind: "displace", amount: node.amount, by, children: [id], L: nodes[id].L }, boxPad(nodes[id].box, node.amount / G), nodes[id].thin, G);
      }
      case "twist": case "bend": case "taper": {
        const id = child(node.child);
        const B = warpBasis(node.axis ?? "z", node.kind === "bend" ? node.toward : undefined);
        const Bt = B ? invert(B) : null;
        const cb = B ? boxXform(nodes[id].box, B) : nodes[id].box;   // child box in basis coords
        let wb, W, G = nodes[id].G;
        if (node.kind === "twist") {
          W = { kind: WARP.TWIST, W: Float64Array.of((node.degPerMm * Math.PI) / 180) };
          const rho = Math.max(...[0, 1, 2, 3].map((c) => Math.hypot(c & 1 ? cb.max[0] : cb.min[0], c & 2 ? cb.max[1] : cb.min[1])));
          wb = box([-rho, -rho, cb.min[2]], [rho, rho, cb.max[2]]);
          G /= 1 + Math.abs(W.W[0]) * rho;   // the rotation's sweep stretches distances by up to |rate|·ρ
        } else if (node.kind === "taper") {
          const [z0, s0] = node.from, [z1, s1] = node.to;
          if (z0 === z1) throw new ImplicitSpecError(`${path}: taper from/to positions must differ`);
          W = { kind: WARP.TAPER, W: Float64Array.of(z0, s0, z1, s1) };
          const s = Math.max(s0, s1);
          wb = box([cb.min[0] * s, cb.min[1] * s, cb.min[2]], [cb.max[0] * s, cb.max[1] * s, cb.max[2]]);
          G /= Math.max(1, s);   // child(x/s, y/s, z): an upscale slows growth by 1/s
        } else {
          const R = node.radius;
          if (cb.max[0] >= R * 0.95) throw new ImplicitSpecError(`${path}.radius: bend radius ${R} must exceed the child's extent toward the bend (${cb.max[0].toFixed(3)} mm)`);
          if (Math.max(Math.abs(cb.min[2]), Math.abs(cb.max[2])) >= Math.PI * R * 0.9) throw new ImplicitSpecError(`${path}.radius: the child is too long to bend at radius ${R} (it would wrap past half a turn)`);
          W = { kind: WARP.BEND, W: Float64Array.of(R) };
          // Forward-map a lattice through the child box: (x', y', z') → (R − ρ cos θ, y', ρ sin θ).
          wb = box([INF, INF, INF], [-INF, -INF, -INF]);
          for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) for (let l = 0; l <= 16; l++) {
            const xp = cb.min[0] + ((cb.max[0] - cb.min[0]) * i) / 2, yp = cb.min[1] + ((cb.max[1] - cb.min[1]) * j) / 2, zp = cb.min[2] + ((cb.max[2] - cb.min[2]) * l) / 16;
            const th = zp / R, rho = R - xp, q = [R - rho * Math.cos(th), yp, rho * Math.sin(th)];
            for (let a = 0; a < 3; a++) { wb.min[a] = Math.min(wb.min[a], q[a]); wb.max[a] = Math.max(wb.max[a], q[a]); }
          }
          wb = boxPad(wb, 0.02 * Math.hypot(...wb.max.map((v, a) => v - wb.min[a])));
          G *= R / (R + Math.max(Math.abs(cb.min[0]), Math.abs(cb.max[0])));   // arc length shrinks toward the outer side
        }
        const lb = Bt ? boxXform(wb, Bt) : wb;
        return finish({ kind: "warp", warp: { kind: W.kind, W: W.W, B, Bt }, children: [id], L: nodes[id].L }, lb, nodes[id].thin, G);
      }
      case "repeat": {
        const id = child(node.child);
        const placements = [];
        if (node.linear) for (let i = 0; i < node.linear.count; i++) placements.push(translation(node.linear.step.map((s) => s * i)));
        else for (let i = 0; i < node.polar.count; i++) placements.push(rotation(node.polar.axis ?? "z", (360 * i) / node.polar.count));
        const refs = placements.map((P, i) => add({
          kind: "ref", inv: isIdentity(P) ? null : invert(P), children: [id], L: nodes[id].L,
          box: boxXform(nodes[id].box, P), thin: nodes[id].thin, G: nodes[id].G, label: null, path: `${path}.instance[${i}]`,
        }));
        return finish({ kind: "union", k: 0, children: refs, L: nodes[id].L }, refs.map((r) => nodes[r].box).reduce(boxUnion), nodes[id].thin, nodes[id].G);
      }
      case "expr": {
        hasExpr = true;
        const lowered = lowerSource(node.sdf, node.uniforms, node.textures, `${path}.sdf`);
        return finish({ kind: "expr", expr: lowered, children: [], L: node.lipschitz ?? 1 }, box(node.box[0].slice(), node.box[1].slice()), INF);
      }
      default: throw new ImplicitSpecError(`${path}.kind: unknown kind ${JSON.stringify(node.kind)}`);
    }
  }

  const root = lower(spec.root, IDENTITY, "root");
  const rb = nodes[root].box;
  if (!finite(rb)) throw new ImplicitSpecError("root: the shape is unbounded — intersect or subtract a `halfspace` from a bounded shape instead of using it alone");
  const detail = (spec.detail ?? []).map((d, i) => lowerDetail(d, i, frames, slot, lowerSource));
  for (const e of detail) if (e.kind === "texture") {
    const t = textures[e.slot];   // refine to about one texel
    e.target = Math.max(e.size[0] / t.width, e.size[1] / t.height);
  }
  checkTextureBudget(textures);
  const digests = textures.map((t) => t.digest);
  if (hasContact) digests.push(regionDigest(nodes));   // regions are part of the content hash
  // The root-reachable contact node (through refs alone), whose children own the surface.
  let ownerRoot = root;
  while (nodes[ownerRoot].kind === "ref") ownerRoot = nodes[ownerRoot].children[0];
  if (nodes[ownerRoot].kind !== "contact") ownerRoot = -1;
  const ownerK = ownerRoot >= 0 ? nodes[ownerRoot].children.length : 0;
  return { ir: { nodes, root }, ownerRoot, ownerK, textures, bounds: rb, thin: nodes[root].thin, hasExpr, detail, digests, warnings };
}

const AXIS_OF = { x: 0, y: 1, z: 2 };
function lowerDetail(d, i, frames, slot, lowerSource) {
  const path = `detail[${i}]`;
  let W = d.frame != null ? frames.get(d.frame).world : IDENTITY;
  if (d.at) W = compose(W, translation(d.at));
  const inv = isIdentity(W) ? null : invert(W);
  const side = d.side != null ? axisVector(d.side) : null;
  const e = { kind: d.kind, inv, radius: d.radius ?? null, side, amplitude: d.amplitude ?? 0, wavelength: d.wavelength ?? null,
    axis: AXIS_OF[d.axis ?? "z"], slot: -1, projection: d.projection ?? "planar", size: d.size ?? null, height: null, target: Infinity };
  if (d.kind === "creases" || d.kind === "noise") e.target = d.wavelength / 3;
  if (d.kind === "texture") e.slot = slot(d.image);
  if (d.kind === "expr") {
    e.height = lowerSource(d.height, d.uniforms, d.textures, `${path}.height`);
    e.target = d.wavelength != null ? d.wavelength / 3 : Infinity;   // Infinity: detail.js uses edge / 2
  }
  return e;
}
