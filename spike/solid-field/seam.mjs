// SPIKE: how far the field mesh sits from the exact faces, away from the blend.
import { bootManifoldKernel } from "../../src/testing/manifold.js";
import { solidField } from "./field.js";
const k = await bootManifoldKernel({ quality: "print" });
for (const e of [0.5, 0.25]) {
  const A = k.box({ min: [-30, -20, 0], max: [30, 20, 6] }), B = k.cylinder({ r: 8, h: 26 }).at([0, 0, 4]);
  const soft = k.implicit({ resolution: e, root: { kind: "union", k: 8, children: [solidField(A), solidField(B)] } });
  const m = soft.toMesh(), P = m.positions, step = m.indices ? 3 : 3;
  let flat = 0, nFlat = 0, edge = 0, nEdge = 0;
  for (let i = 0; i < P.length; i += step) {
    const x = P[i], y = P[i + 1], z = P[i + 2], r = Math.hypot(x, y);
    // plate top, clear of the blend (r > 16.5) and of the plate's own edges
    if (r > 16.5 && Math.abs(x) < 27 && Math.abs(y) < 17 && z > 3) { flat = Math.max(flat, Math.abs(z - 6)); nFlat++; }
    // the plate's sharp top edge along +x: exact corner is (30, y, 6)
    if (x > 28.5 && z > 4.5 && Math.abs(y) < 17) { edge = Math.max(edge, 0); nEdge++; }
  }
  // corner loss: the farthest the mesh reaches toward the exact edge line (x = 30, z = 6)
  let reach = Infinity;
  for (let i = 0; i < P.length; i += step) { const x = P[i], y = P[i + 1], z = P[i + 2]; if (Math.abs(y) < 17) reach = Math.min(reach, Math.hypot(30 - x, 6 - z)); }
  console.log(JSON.stringify({ edge: e, flatSamples: nFlat, maxFlatError: +flat.toFixed(4), nearestToSharpEdge: +reach.toFixed(4) }));
}
