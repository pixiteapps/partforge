// The collision world: how far apart are these pieces when placed by these matrices?
// Meshes stay in each sub-part's own frame; a placement is a column-major mat4 handed in
// per query, so a pose change never rebuilds a BVH. Pose mode and the sweep checker both
// read it. Pure (no DOM, three or node:), and loaded lazily by the worker.
import { buildBVH, disposeBVHs } from "../oracle/bvh.js";
import { isAllowed } from "./declaration.js";
import { CANONICAL, probeSubPartPose } from "../pose-probe-core.js";
import { viewSubParts, resolveParams } from "../part-model.js";
import { composePose, isRigid, mulMat4, invertRigid } from "../geometry/pose.js";

/** One sub-part's place() as a rigid mat4, or null when it is not a trusted rigid motion. */
export function placeMatrix(sp, view, p, d) {
  const probe = probeSubPartPose(sp, { view, purpose: "display", p, d }, { scope: "place" });
  if (!probe?.trusted || probe.baseHash !== CANONICAL) return null;
  const m = Array.from(composePose(probe.pose));
  return isRigid(m) ? m : null;
}

/** placeMatrix for every in-view sub-part at an already-resolved (p, d); never derives. */
export function poseMatrices(part, view, p, d, { deltas } = {}) {
  const out = new Map();
  for (const name of viewSubParts(part, view, p)) {
    const m = placeMatrix(part.parts[name], view, p, d);
    const delta = deltas?.get(name);
    out.set(name, m && delta ? mulMat4(delta, m) : m);
  }
  return out;
}

/**
 * For meshes built posed at (startP, startD): returns (p, d) → Map of the matrices that
 * carry each mesh from its start pose to the pose at (p, d).
 */
export function relativeMatsAt(part, view, startP, startD) {
  const inverses = new Map();
  for (const [name, m] of poseMatrices(part, view, startP, startD)) inverses.set(name, m ? invertRigid(m) : null);
  return (p, d) => {
    const out = new Map();
    for (const [name, m] of poseMatrices(part, view, p, d)) {
      const inv = inverses.get(name);
      out.set(name, m && inv ? mulMat4(m, inv) : null);
    }
    return out;
  };
}

function boxOf(positions) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = positions[i + j];
      if (v < b[j]) b[j] = v;
      if (v > b[j + 3]) b[j + 3] = v;
    }
  }
  return b;
}

const cornersOf = (b) => {
  const out = [];
  for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) out.push([x, y, z]);
  return out;
};

const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

function movedBox(box, m) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const c of cornersOf(box)) {
    const q = m ? apply(m, c) : c;
    for (let j = 0; j < 3; j++) {
      if (q[j] < out[j]) out[j] = q[j];
      if (q[j] > out[j + 3]) out[j + 3] = q[j];
    }
  }
  return out;
}

function boxGap(a, b) {
  let s = 0;
  for (let j = 0; j < 3; j++) {
    const g = Math.max(a[j] - b[j + 3], b[j] - a[j + 3], 0);
    s += g * g;
  }
  return Math.sqrt(s);
}

export function createCollisionWorld({ meshes, decl = null }) {
  const names = [...meshes.keys()];
  const bvhs = new Map();
  const boxes = new Map();
  for (const [name, mesh] of meshes) {
    bvhs.set(name, buildBVH(mesh));
    boxes.set(name, boxOf(mesh.positions));
  }
  const matOf = (mats, name) => mats.get(name); // undefined = identity, null = excluded

  return {
    boundsOf: (name) => boxes.get(name) ?? null,

    distances(mats, { names: only, within = Infinity, limit = Infinity } = {}) {
      const wanted = only ? new Set(only) : null;
      const live = names.filter((n) => matOf(mats, n) !== null);
      const moved = new Map(live.map((n) => [n, movedBox(boxes.get(n), matOf(mats, n))]));
      const out = [];
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i], b = live[j];
          if (wanted && !wanted.has(a) && !wanted.has(b)) continue;
          if (isAllowed(decl, a, b)) continue;
          if (boxGap(moved.get(a), moved.get(b)) > within) continue;
          const r = bvhs.get(a).distanceToPosed(bvhs.get(b), matOf(mats, a) ?? null, matOf(mats, b) ?? null);
          if (!(r.distance <= within)) continue;
          let normal = null;
          if (r.distance > 0) {
            const v = [0, 1, 2].map((k) => r.pointA[k] - r.pointB[k]);
            const len = Math.hypot(...v);
            if (len > 0) normal = v.map((x) => x / len);
          }
          out.push({ a, b, distance: r.distance, at: r.at, pointA: r.pointA, pointB: r.pointB, normal });
        }
      }
      out.sort((x, y) => x.distance - y.distance);
      return out.length > limit ? out.slice(0, limit) : out;
    },

    inside(mats, a, b) {
      const ma = matOf(mats, a) ?? null, mb = matOf(mats, b) ?? null;
      return bvhs.get(a).insideOf(bvhs.get(b), ma, mb) || bvhs.get(b).insideOf(bvhs.get(a), mb, ma);
    },

    travel(matsA, matsB, travelNames) {
      let worst = 0;
      for (const name of travelNames) {
        const box = boxes.get(name);
        if (!box) continue;
        const ma = matOf(matsA, name) ?? null, mb = matOf(matsB, name) ?? null;
        for (const c of cornersOf(box)) {
          const p = ma ? apply(ma, c) : c, q = mb ? apply(mb, c) : c;
          worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        }
      }
      return worst;
    },

    dispose() { disposeBVHs(bvhs.values()); bvhs.clear(); },
  };
}
