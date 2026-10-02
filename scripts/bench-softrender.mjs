#!/usr/bin/env node
// scripts/bench-softrender.mjs — dev tool, not a test. Times renderStyled on a
// synthetic ~200k-triangle sphere (no kernel, so it measures the renderer
// alone) for the cad look at 1024² and the thumbnail at 640². Prints the
// median of 5 runs each. Rendering is single-threaded, so a Sandbox vCPU's
// speed (not its count) is what matters there; see the target in the plan.
import { renderStyled } from "../src/framework/softrender/index.js";

function sphere(seg, r = 20) {
  const pos = [], nor = [];
  const at = (i, j) => {
    const th = (i / seg) * Math.PI, ph = (j / seg) * 2 * Math.PI;
    const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
    return { p: n.map((c) => c * r), n };
  };
  for (let i = 0; i < seg; i++) for (let j = 0; j < seg; j++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    for (const v of [a, b, c, a, c, d]) { pos.push(...v.p); nor.push(...v.n); }
  }
  const edges = [];
  for (let i = 0; i < seg; i += 16) for (let j = 0; j < seg; j++) edges.push(...at(i, j).p, ...at(i, j + 1).p);
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), edges: new Float32Array(edges) };
}

const mesh = sphere(316);
console.log(`triangles: ${mesh.positions.length / 9}`);
const time = (opts) => {
  const ms = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); renderStyled([{ name: "s", mesh }], opts); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[2].toFixed(0);
};
console.log(`cad 1024² (median ms): ${time({ view: "iso", style: "cad", size: [1024, 1024] })}`);
console.log(`thumbnail 640² (median ms): ${time({ style: "thumbnail", size: [640, 640] })}`);
