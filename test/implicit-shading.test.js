// k.implicit surfaces shade ORGANIC: one smooth skin, so detail grooves (creases,
// texture relief) draw no feature lines in the CAD overlay and shade smoothly.
import { expect, test } from "vitest";
import { bootManifoldKernel, buildView } from "../src/testing.js";

const part = (build) => ({
  meta: { title: "implicit shading", units: "mm" }, parameters: [], defaults: {},
  parts: { body: { label: "Body", views: ["main"], build } }, views: { main: { label: "Main" } },
});

test("creased implicit skin draws no same-surface feature lines", async () => {
  const k = await bootManifoldKernel();
  const p = part((kk) => kk.implicit({
    root: { kind: "box", size: [30, 30, 10], round: 3 },
    detail: [{ kind: "creases", amplitude: 0.5, wavelength: 1.5, axis: "x", side: [0, 0, 1] }],
    preview: 1,
  }));
  const [{ mesh }] = buildView(k, p, "main");
  expect(mesh.triangles).toBeGreaterThan(0);
  expect(mesh.edges?.length ?? 0).toBe(0);
});

// Fingernails are their own fine-grid k.implicit, unioned onto the hand. Both sides
// of that seam are organic skin: no outline traces each nail (the user saw one).
test("seams between two organic surfaces draw no feature lines", async () => {
  const { handSpec, nailSpecs } = await import("./fixtures/implicit-trees.js");
  const k = await bootManifoldKernel();
  const p = part((kk) => kk.union([kk.implicit(handSpec()), ...nailSpecs().map((s) => kk.implicit(s))]));
  const [{ mesh }] = buildView(k, p, "main");
  expect(mesh.triangles).toBeGreaterThan(0);
  expect(mesh.edges?.length ?? 0).toBe(0);
}, 120_000);

test("seams between an organic surface and a mechanical one still draw", async () => {
  const k = await bootManifoldKernel();
  const p = part((kk) => kk.union([
    kk.implicit({ root: { kind: "sphere", r: 8 }, preview: 1 }),
    kk.box({ size: [10, 10, 10] }).translate([0, 0, -12]),
  ]));
  const [{ mesh }] = buildView(k, p, "main");
  expect(mesh.edges?.length ?? 0).toBeGreaterThan(0);
  // The lines run along the seam itself: segments with both ends on the sphere (within the
  // 1 mm preview grid's chord error) and on the box's surface (x, y in ±5, z in [−12, −2]).
  const boxDist = (x, y, z) => {
    const q = [Math.abs(x) - 5, Math.abs(y) - 5, Math.abs(z + 7) - 5];
    const out = Math.hypot(...q.map((v) => Math.max(v, 0)));
    return out > 0 ? out : -Math.max(...q);
  };
  const onSeam = (e, o) => Math.abs(Math.hypot(e[o], e[o + 1], e[o + 2]) - 8) < 0.5 && Math.abs(boxDist(e[o], e[o + 1], e[o + 2])) < 0.05;
  const E = mesh.edges;
  let seam = 0, seamLength = 0;
  for (let o = 0; o < E.length; o += 6) {
    if (!onSeam(E, o) || !onSeam(E, o + 3)) continue;
    seam++; seamLength += Math.hypot(E[o + 3] - E[o], E[o + 4] - E[o + 1], E[o + 5] - E[o + 2]);
  }
  // The seam: on each side face (x or y = ±5) the circle of radius √39 the sphere cuts,
  // over |y| ≤ 5 — the box's top lies inside the sphere. Its lines trace most of it.
  const R = Math.sqrt(39), seamTotal = 4 * 2 * Math.asin(5 / R) * R;
  expect(seam).toBeGreaterThanOrEqual(20);
  expect(seamLength).toBeGreaterThan(0.75 * seamTotal);
});

// A contact hand is one ID per piece (seam spec §6): the crease between a finger and the palm
// shades hard at any bend, the smooth attachment-zone seam between sibling IDs stays smooth
// (bent under SIBLING_SEAM_ANGLE), and neither draws a line.
test("crease shades hard, zone seam smooth", async () => {
  const { handSpec, HAND_POSES } = await import("./fixtures/implicit-trees.js");
  const { creasedNormals } = await import("../src/framework/geometry/creased-normals.js");
  const { SIBLING_SEAM_ANGLE } = await import("../src/framework/geometry/shading-policy.js");
  const k = await bootManifoldKernel({ exactContact: true });
  const g = k.implicit(handSpec({ ...HAND_POSES.fist, contactGap: 0 }))._m.getMesh();
  const policies = new Map([...new Set(g.runOriginalID)].map((id) => [id, k._shadingPolicy(id)]));
  const r = creasedNormals(g, { policies });
  expect(r.edges.length).toBe(0);   // no line at a crease or a zone seam

  // Triangles, their run IDs and facet normals; welded neighbours through shared vertex index.
  const nTri = g.triVerts.length / 3, oid = new Uint32Array(nTri);
  for (let q = 0; q < g.runOriginalID.length; q++) for (let t = g.runIndex[q] / 3; t < g.runIndex[q + 1] / 3; t++) oid[t] = g.runOriginalID[q];
  const P = g.vertProperties, np = g.numProp, V = g.triVerts;
  const fn = new Float64Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = [0, 1, 2].map((i) => V[3 * t + i] * np);
    const u = [0, 1, 2].map((i) => P[b + i] - P[a + i]), w = [0, 1, 2].map((i) => P[c + i] - P[a + i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n) || 1;
    for (let i = 0; i < 3; i++) fn[3 * t + i] = n[i] / l;
  }
  const dot = (s, t) => fn[3 * s] * fn[3 * t] + fn[3 * s + 1] * fn[3 * t + 1] + fn[3 * s + 2] * fn[3 * t + 2];
  const incident = new Map();
  for (let t = 0; t < nTri; t++) for (let i = 0; i < 3; i++) { const v = V[3 * t + i]; (incident.get(v) ?? incident.set(v, []).get(v)).push(t); }
  const corner = (t, v) => { const i = [0, 1, 2].find((c) => V[3 * t + c] === v); return [0, 1, 2].map((c) => r.normals[(3 * t + i) * 3 + c]); };
  const ndot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cosSib = Math.cos((SIBLING_SEAM_ANGLE * Math.PI) / 180);
  const edgeTris = new Map();   // seam edges (different IDs): [t1, t2, v] with v an end of the edge
  for (let t = 0; t < nTri; t++) for (let i = 0; i < 3; i++) {
    const a = V[3 * t + i], b = V[3 * t + (i + 1) % 3];
    const key = Math.min(a, b) * 4294967296 + Math.max(a, b);
    (edgeTris.get(key) ?? edgeTris.set(key, []).get(key)).push([t, a, b]);
  }
  let hard = 0, smooth = 0;
  for (const list of edgeTris.values()) {
    if (list.length !== 2 || oid[list[0][0]] === oid[list[1][0]]) continue;
    const [t1, t2] = [list[0][0], list[1][0]], v = list[0][1], bend = dot(t1, t2);
    if (bend < cosSib) {
      // A crease: each side keeps its own normal at the shared vertex (they split).
      if (ndot(corner(t1, v), corner(t2, v)) < dot(t1, t2) + 1e-6) hard++;
      expect(ndot(corner(t1, v), corner(t2, v))).toBeLessThan(1 - 1e-4);
    } else if ([t1, t2].every((t) => [list[0][1], list[0][2]].every((w) => incident.get(w).every((u) => dot(t, u) >= cosSib)))) {
      // A zone seam whose whole neighbourhood is flatter than the sibling angle: one shared normal.
      expect(ndot(corner(t1, v), corner(t2, v))).toBeGreaterThan(1 - 1e-5);
      smooth++;
    }
  }
  g.delete?.();
  expect(hard).toBeGreaterThan(20);
  expect(smooth).toBeGreaterThan(20);
}, 120_000);
