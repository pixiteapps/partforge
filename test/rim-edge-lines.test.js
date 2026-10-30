import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, setCoreEnabled } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// Fraction of a top-rim circle (radius `rad` at height `z`) drawn by the
// kernel's feature-edge segments.
function rimCoverage(edges, rad, z) {
  let len = 0;
  for (let i = 0; i < edges.length; i += 6) {
    if (Math.abs(edges[i + 2] - z) > 1e-3 || Math.abs(edges[i + 5] - z) > 1e-3) continue;
    if (Math.abs(Math.hypot(edges[i], edges[i + 1]) - rad) > 0.05) continue;
    if (Math.abs(Math.hypot(edges[i + 3], edges[i + 4]) - rad) > 0.05) continue;
    len += Math.hypot(edges[i] - edges[i + 3], edges[i + 1] - edges[i + 4]);
  }
  return len / (2 * Math.PI * rad);
}

// A flat cap's triangulation has thin triangles of its own (three consecutive
// rim vertices; a long fan to the bore). They lie in the cap's plane, so they
// must not gate the rim's outline the way a tilted boolean sliver does — that
// left a gap or two in nearly every cylinder's top edge.
for (const core of [true, false]) {
  test(`cylinder top rims are outlined all the way round (core ${core ? "on" : "off"})`, () => {
    setCoreEnabled(core);
    try {
      for (const [R, r] of [[10, 3], [20, 5], [12, 0], [30, 8]]) {
        let s = k.cylinder({ r: R, h: 15 });
        if (r) s = s.cut(k.cylinder({ r, h: 40, center: true }));
        const { edges } = s.toMesh();
        expect(rimCoverage(edges, R, 15)).toBeGreaterThan(0.999);
        if (r) expect(rimCoverage(edges, r, 15)).toBeGreaterThan(0.999);
      }
    } finally {
      setCoreEnabled(true);
    }
  });
}
