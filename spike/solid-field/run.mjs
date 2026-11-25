// SPIKE runner: node spike/solid-field/run.mjs <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootManifoldKernel } from "../../src/testing/manifold.js";
import { renderViewImages } from "../../src/testing/render.js";
import { buildBVH } from "../../src/framework/oracle/bvh.js";
import { solidField, stats } from "./field.js";

const out = process.argv[2]; mkdirSync(out, { recursive: true });
const only = process.argv[3]?.split(",");
const k0 = await bootManifoldKernel({ quality: "print" });
const log = [];
const timed = (name, f) => { const t = performance.now(); const r = f(); log.push([name, performance.now() - t]); return r; };
const tris = (s) => { const m = s.toMesh(); return (m.indices ? m.indices.length : m.positions.length / 3) / 3; };

const plate = (k) => k.box({ min: [-30, -20, 0], max: [30, 20, 6] });
const boss = (k) => k.cylinder({ r: 8, h: 26 }).at([0, 0, 4]);
const blob = (k) => k.sphere(16).union(k.box({ min: [-8, -8, -22], max: [8, 8, 0] })).union(k.cylinder({ r: 6, h: 44 }).rotateY(90).at([-22, 0, 4]));
const creature = (k) => {
  const c = k.cage({ box: { size: [44, 24, 22], segs: [2, 1, 1] } });
  c.extrude("+x:0,0", { by: 14, scale: 0.55 });
  return k.subdiv(c).at([0, 0, 24]);
};
const GYROID = "float s = 6.2831853 / cell; vec3 q = p * s; float g = sin(q.x) * cos(q.y) + sin(q.y) * cos(q.z) + sin(q.z) * cos(q.x); return (abs(g) - w) / s / 1.5;";

const CASES = {
  // A: rounded join between two explicit solids, whole body remeshed.
  "a-join-plain": (k) => plate(k).union(boss(k)),
  "a-join-field": (k, e) => k.implicit({ resolution: e, root: { kind: "union", k: 8, children: [solidField(plate(k)), solidField(boss(k))] } }),
  // A2: the same, but only a box around the join is taken from the implicit body.
  "a-join-local": (k, e) => {
    const A = plate(k), B = boss(k);
    const soft = k.implicit({ resolution: e, root: { kind: "union", k: 8, children: [solidField(A), solidField(B)] } });
    const win = k.box({ min: [-17, -17, 2], max: [17, 17, 15] });
    return A.union(B).cut(win).union(soft.intersect(win));
  },
  // B: a cage body grown smoothly out of an explicit base and post.
  "b-cage-plain": (k) => creature(k).union(k.cylinder({ r: 5, h: 22 }).at([-6, 0, 0])).union(k.cylinder({ r: 20, h: 4 })),
  "b-cage-field": (k, e) => k.implicit({ resolution: e, root: { kind: "union", k: 7, children: [
    solidField(creature(k)), solidField(k.cylinder({ r: 5, h: 22 }).at([-6, 0, 0])), solidField(k.cylinder({ r: 20, h: 4 }))] } }),
  // C: offsets. Minkowski (today) against the field.
  "c-grow-minkowski": (k) => blob(k).offset(2),
  "c-grow-field": (k, e) => k.implicit({ resolution: e, root: { kind: "round", r: 2, child: solidField(blob(k)) } }),
  "c-shrink-minkowski": (k) => blob(k).offset(-2),
  "c-shrink-field": (k, e) => k.implicit({ resolution: e, root: solidField(blob(k), { shift: 2 }) }),
  "c-skin-field": (k, e) => { const b = blob(k); return b.cut(k.implicit({ resolution: e, root: solidField(b, { shift: 2 }) })).cut(k.box({ min: [0, -60, 0], max: [60, 0, 60] })); },
  // D: texture on an explicit solid and on a cage body.
  "d-knurl": (k, e) => k.implicit({ resolution: e, root: { kind: "displace", amount: 0.7, child: solidField(k.cylinder({ r: 12, h: 30 })),
    by: { expr: "vec2 z = normalize(p.xy); for (int i = 0; i < 4; i++) { z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y); } float c = cos(p.z * 1.3); float s = sin(p.z * 1.3); return max(z.x * c - z.y * s, z.x * c + z.y * s);" } } }),
  "d-cage-noise": (k, e) => k.implicit({ resolution: e, root: solidField(creature(k)), detail: [{ kind: "noise", amplitude: 0.5, wavelength: 3 }] }),
  // E: a gyroid fill clipped to a solid, inside a 1.6 mm skin.
  "e-lattice": (k, e) => {
    const b = blob(k);
    const fill = k.implicit({ resolution: e, root: { kind: "union", children: [
      { kind: "subtract", children: [solidField(b), solidField(b, { shift: 1.6 })] },
      { kind: "intersect", children: [solidField(b), { kind: "expr", sdf: GYROID, uniforms: { cell: 10, w: 0.35 }, lipschitz: 1, box: [[-45, -20, -24], [20, 20, 20]] }] },
    ] } });
    return fill.cut(k.box({ min: [0, -60, 0], max: [60, 0, 60] }));
  },
};
const EDGE = { default: 0.5, "e-lattice": 0.4, "d-knurl": 0.35 };

const rows = [];
for (const [name, build] of Object.entries(CASES)) {
  if (only && !only.some((o) => name.startsWith(o))) continue;
  Object.assign(stats, { calls: 0, rays: 0, buildMs: 0, tris: 0 });
  const e = EDGE[name] ?? EDGE.default;
  let row = { name, edge: e };
  const part = { meta: { title: name, units: "mm", backend: "manifold" }, parameters: [], defaults: {},
    parts: { body: { label: name, views: ["main"], build: (k) => {
      const t = performance.now();
      const s = build(k, e);
      const n = tris(s);
      Object.assign(row, { ms: Math.round(performance.now() - t), tris: n, volume: +s.volume().toFixed(1), fieldCalls: stats.calls, rays: stats.rays, inTris: stats.tris, bvhMs: Math.round(stats.buildMs) });
      return s;
    } } }, views: { main: { label: name } } };
  try {
    const imgs = await renderViewImages(k0, part, "main", { views: ["iso", "front"], size: [900, 700] });
    for (const im of imgs) writeFileSync(join(out, `${name}-${im.angle}.png`), im.png);
  } catch (err) { row.error = String(err?.message ?? err).slice(0, 300); }
  rows.push(row); console.log(JSON.stringify(row));
}
writeFileSync(join(out, "rows.json"), JSON.stringify(rows, null, 1));
