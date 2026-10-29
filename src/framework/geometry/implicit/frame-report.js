// k.implicitFrames: where a spec's named frames and labelled nodes end up in the
// finished part, as a frame set that transforms like a Solid (the same primitives,
// the same SUGAR), so one placement function moves the solid and its report together.
// Pure: it validates and lowers the spec but never meshes. measure.js recognises a
// frame set by its plain-data `_frameSet` marker and writes out report().
import { validateSpec } from "./grammar.js";
import { lowerSpec, boxXform } from "./ir.js";
import { IDENTITY, compose, invert, translation, rotation, resolveFrames, xformPoint, xformDir } from "./frames.js";
import { SUGAR } from "../solid-sugar.js";
import { hypot3 } from "../js-math.js";

const ORIGIN = [0, 0, 0];
const PLANE_AXIS = { XY: 2, XZ: 1, YZ: 0 };   // the plane's normal, as Solid.mirror
const DISTORTING = new Set(["warp", "round", "onion", "displace"]);

const diag = (sx, sy, sz) => Float64Array.of(sx, 0, 0, 0, sy, 0, 0, 0, sz, 0, 0, 0);
const reflect = (axis) => diag(axis === 0 ? -1 : 1, axis === 1 ? -1 : 1, axis === 2 ? -1 : 1);
const about = (c, M) => compose(translation(c), compose(M, translation([-c[0], -c[1], -c[2]])));
const r3 = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };
const unit = (v) => { const l = hypot3(v[0], v[1], v[2]); return [r3(v[0] / l), r3(v[1] / l), r3(v[2] / l)]; };

// Each labelled node's box in part coordinates. A node's `box` is in its parent's space
// and its `inv` maps parent → local. Below a warp/round/onion/displace a node's own box no
// longer bounds what it becomes, so it reports the outermost such ancestor's box instead.
// A mirror visits its child twice and a repeat's refs carry each placement, so every copy
// lands in the label's box; duplicate labels union.
function labelBoxes({ nodes, root }) {
  const out = new Map();
  const add = (label, b) => {
    const prev = out.get(label);
    out.set(label, prev ? { min: prev.min.map((v, i) => Math.min(v, b.min[i])), max: prev.max.map((v, i) => Math.max(v, b.max[i])) } : b);
  };
  const walk = (id, Wp, outer) => {
    const n = nodes[id];
    const own = boxXform(n.box, Wp);
    const o = outer ?? (DISTORTING.has(n.kind) ? own : null);
    if (n.label != null) add(n.label, o ?? own);
    const W = n.inv ? compose(Wp, invert(n.inv)) : Wp;
    for (const c of n.children) {
      walk(c, W, o);
      if (n.kind === "mirror") walk(c, compose(W, reflect(n.axis)), o);
    }
  };
  walk(root, IDENTITY, null);
  return out;
}

function frameSet(base, A, mirrored) {
  const next = (T, flip = false) => frameSet(base, compose(T, A), mirrored !== flip);
  const report = () => {
    const p = [0, 0, 0], d = [0, 0, 0];
    const frames = {};
    for (const [name, M] of base.frames) {
      xformPoint(p, A, M[9], M[10], M[11]);
      const axis = (j) => { xformDir(d, A, M[j], M[3 + j], M[6 + j]); return unit(d); };
      frames[name] = { origin: p.map(r3), x: axis(0), y: axis(1), z: axis(2) };
    }
    const labels = {};
    for (const [name, b] of base.labels) {
      const { min, max } = boxXform(b, A);
      labels[name] = { min: min.map(r3), max: max.map(r3), center: min.map((v, i) => r3((v + max[i]) / 2)), approximate: true };
    }
    return { frames, labels, mirrored };
  };
  return Object.freeze(Object.assign({
    _frameSet: 1,
    translate: (v) => next(translation(v)),
    rotate: (deg, center = ORIGIN, axis = [0, 0, 1]) => next(about(center, rotation(axis, deg))),
    mirror: (plane) => {
      const axis = PLANE_AXIS[plane];
      if (axis === undefined) throw new Error(`mirror: unknown plane ${JSON.stringify(plane)} (use "XY"|"XZ"|"YZ")`);
      return next(reflect(axis), true);
    },
    scale: (factor, center = ORIGIN) => {
      if (!(factor > 0)) throw new Error("scale: factor must be > 0");
      return next(about(center, diag(factor, factor, factor)));
    },
    report,
  }, SUGAR));
}

/** The frame set of a k.implicit spec: its named frames and labelled nodes, untransformed. */
export function implicitFrames(spec, { images = new Map() } = {}) {
  validateSpec(spec, { imageNames: new Set(images.keys()) });
  const { ir } = lowerSpec(spec, { images });
  const world = resolveFrames(spec.frames ?? {});
  const frames = new Map(Object.keys(spec.frames ?? {}).map((name) => [name, world.get(name).world]));
  return frameSet({ frames, labels: labelBoxes(ir) }, IDENTITY, false);
}
