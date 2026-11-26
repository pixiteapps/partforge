// test/helpers/implicit-stages.js
// The JS mesher's stages run one by one, as meshImplicit's JS branch runs them
// (src/framework/geometry/implicit/index.js), stopping before untangle and detail, so a
// test can run a stage of its own on the cleaned mesh. And the checks every stage keeps.
import { compileImplicit } from "../../src/framework/geometry/implicit/compile.js";
import { planLeaves, evaluateLeaves } from "../../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../../src/framework/geometry/implicit/mesher.js";
import { meshStoreOwners } from "../../src/framework/geometry/implicit/mesher-owners.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "../../src/framework/geometry/implicit/cleanup.js";
import { cutCreases } from "../../src/framework/geometry/implicit/crease.js";
import { buildMeshField } from "../../src/framework/geometry/implicit/mesh-field-build.js";

// One mesh field per solid hash, for every call in the test run.
const fields = new Map();
export const meshFieldOf = (solid) => {
  let f = fields.get(solid._hash);
  if (!f) fields.set(solid._hash, (f = buildMeshField(solid.toMesh())));
  return f;
};

/**
 * Compile `spec` and run the JS stages at grid `edge`: plan, evaluate, mesh (the owner mesher
 * for a contact root), clean up, and on the owner path cut the creases. A spec with `solid` leaves
 * needs a kernel booted with `meshFields: true` first (its mesh field builder loaded).
 * Returns `{ store, cleaned, compiled }`.
 */
export function jsStages(spec, edge, { tier = "preview" } = {}) {
  const compiled = compileImplicit(spec, { meshFieldOf });
  const opts = tier === "preview" ? PREVIEW_CLEANUP : CLEANUP;
  const plan = planLeaves(compiled, edge, { anchor: false });
  const store = evaluateLeaves(plan, {});
  const ownerPath = compiled.ownerRoot >= 0;
  const node = ownerPath ? compiled.ir.nodes[compiled.ownerRoot] : null;
  const raw = ownerPath ? meshStoreOwners(store, { gap: node.gap }) : meshStore(store);
  let cleaned = cleanupMesh(store, raw, opts);
  if (ownerPath) cleaned = cutCreases(store, cleaned, node.attWorld);
  return { store, cleaned, compiled };
}

/**
 * The fold edges of a mesh: edges whose two triangles have unit normals with a dot below -0.5.
 * Returns each one's midpoint, as [x, y, z]; the count is the array's length. A triangle with no
 * area has no normal and makes no fold edge.
 */
export function foldEdges(mesh) {
  const P = mesh.positions, T = mesh.indices, nt = T.length / 3, nv = P.length / 3;
  const N = new Float64Array(3 * nt), first = new Map(), out = [];
  for (let t = 0; t < nt; t++) {
    const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.sqrt(x * x + y * y + z * z);
    if (l > 0) { N[3 * t] = x / l; N[3 * t + 1] = y / l; N[3 * t + 2] = z / l; }
  }
  for (let t = 0; t < nt; t++) for (let j = 0; j < 3; j++) {
    const a = T[3 * t + j], b = T[3 * t + (j + 1) % 3], key = Math.min(a, b) * nv + Math.max(a, b);
    const o = first.get(key);
    if (o === undefined) { first.set(key, t); continue; }
    if (N[3 * t] * N[3 * o] + N[3 * t + 1] * N[3 * o + 1] + N[3 * t + 2] * N[3 * o + 2] < -0.5) {
      out.push([(P[3 * a] + P[3 * b]) / 2, (P[3 * a + 1] + P[3 * b + 1]) / 2, (P[3 * a + 2] + P[3 * b + 2]) / 2]);
    }
  }
  return out;
}

const H = 1e-4;

const NEAR = 1e-6;

// Pairs of vertices used by a triangle that lie closer than NEAR mm: sorted on x, swept.
function coincidentPairs(P, T) {
  const used = new Uint8Array(P.length / 3);
  for (const v of T) used[v] = 1;
  const vs = [];
  for (let v = 0; v < used.length; v++) if (used[v]) vs.push(v);
  vs.sort((a, b) => P[3 * a] - P[3 * b] || a - b);
  let n = 0;
  for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length && P[3 * vs[j]] - P[3 * vs[i]] < NEAR; j++) {
    const a = 3 * vs[i], b = 3 * vs[j];
    const dx = P[a] - P[b], dy = P[a + 1] - P[b + 1], dz = P[a + 2] - P[b + 2];
    if (dx * dx + dy * dy + dz * dz < NEAR * NEAR) n++;
  }
  return n;
}

/**
 * `open`: directed edges without their reverse exactly once. `coincident`: pairs of vertices used
 * by a triangle that lie closer than 1e-6 mm (two such may weld when the kernel builds the solid). `nonManifold`: vertices whose
 * triangle fan is not one cycle (the pinch a shared vertex can make). `flips`: triangles whose normal has
 * a negative dot with the field's gradient at their centre. `slivers`: triangles whose shortest
 * altitude is under 0.001 mm. `field(x, y, z)` is the full field (implicitDistance). `only(t)`,
 * when given, picks the triangles (by index) that `flips` and `slivers` count.
 */
export function meshChecks(mesh, field, { only = null } = {}) {
  const P = mesh.positions, T = mesh.indices, nv = P.length / 3;
  const dir = new Map();
  for (let t = 0; t < T.length; t += 3) for (let j = 0; j < 3; j++) {
    const key = T[t + j] * nv + T[t + (j + 1) % 3];
    dir.set(key, (dir.get(key) ?? 0) + 1);
  }
  let open = 0, flips = 0, slivers = 0, nonManifold = 0;
  for (const [key, n] of dir) {
    const a = Math.floor(key / nv), b = key % nv;
    if (n !== 1 || dir.get(b * nv + a) !== 1) open++;
  }
  // Each vertex's fan: for each triangle at v, the step from its next corner to the one after.
  const next = new Map();
  for (let t = 0; t < T.length; t += 3) for (let j = 0; j < 3; j++) {
    const v = T[t + j], m = next.get(v) ?? next.set(v, new Map()).get(v);
    const from = T[t + (j + 1) % 3], to = T[t + (j + 2) % 3];
    if (m.has(from)) m.set(from, -1); else m.set(from, to);
  }
  for (const m of next.values()) {
    let bad = [...m.values()].includes(-1);
    if (!bad) {
      const start = m.keys().next().value;
      let u = start, steps = 0;
      do { u = m.get(u); steps++; } while (u !== undefined && u !== start && steps <= m.size);
      bad = u !== start || steps !== m.size;
    }
    if (bad) nonManifold++;
  }
  for (let t = 0; t < T.length; t += 3) {
    if (only && !only(t / 3)) continue;
    const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const wx = P[c] - P[b], wy = P[c + 1] - P[b + 1], wz = P[c + 2] - P[b + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const longest = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz));
    if (!(longest > 0) || area2 / longest < 1e-3) slivers++;
    const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const gx = field(x + H, y, z) - field(x - H, y, z), gy = field(x, y + H, z) - field(x, y - H, z), gz = field(x, y, z + H) - field(x, y, z - H);
    if (nx * gx + ny * gy + nz * gz < 0) flips++;
  }
  return { open, nonManifold, flips, slivers, coincident: coincidentPairs(P, T) };
}
