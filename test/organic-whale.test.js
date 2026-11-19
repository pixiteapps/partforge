// The organic domain's k.subdiv reference part (src/parts/organic-whale.js): it lints clean,
// builds at both tiers on Manifold, verifies, is as long as its `length` says, and its
// tailLift moves the tail without touching the front half.
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { verify } from "../src/oracle.js";
import { lintPart } from "../src/lint.js";
import part from "../src/parts/organic-whale.js";

let wasm;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
const kernelAt = (quality) => createManifoldKernel(wasm, { quality });
const build = (k, params = {}) => part.parts.whale.build(k, { ...part.defaults, ...params });

// Mesh vertices as [x, y, z] triples.
function vertices(solid) {
  const { positions } = solid.toMesh();
  const out = [];
  for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1], positions[i + 2]]);
  return out;
}

test("lints with no errors or warnings", () => {
  const { errors, warnings } = lintPart(part);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});

test("builds watertight at preview and at print, with no build warnings", () => {
  for (const quality of ["preview", "print"]) {
    const k = kernelAt(quality);
    k.takeBuildWarnings();
    const whale = build(k);
    expect(whale.volume(), quality).toBeGreaterThan(0);
    expect(k.takeBuildWarnings(), quality).toEqual([]);
  }
});

test("verify passes", () => {
  expect(verify(kernelAt("preview"), part).ok).toBe(true);
});

test("its length is the length param, within 2%", () => {
  const { min, max } = build(kernelAt("preview")).boundingBox();
  expect(Math.abs((max[0] - min[0]) - part.defaults.length) / part.defaults.length).toBeLessThan(0.02);
  const { min: a, max: b } = build(kernelAt("preview"), { length: 160 }).boundingBox();
  expect(Math.abs((b[0] - a[0]) - 160) / 160).toBeLessThan(0.02);
});

test("tailLift raises the tail and leaves the front half alone", () => {
  const k = kernelAt("preview");
  const low = build(k), high = build(k, { tailLift: part.defaults.tailLift + 6 });
  const { min, max } = low.boundingBox();
  const mid = (min[0] + max[0]) / 2;
  const tailTop = (s) => Math.max(...vertices(s).filter(([x]) => x > max[0] - 0.25 * (max[0] - min[0])).map((v) => v[2]));
  expect(tailTop(high) - tailTop(low)).toBeGreaterThan(3);
  // Every vertex ahead of the midpoint has a twin within 0.5 mm in the other build.
  const front = (s) => vertices(s).filter(([x]) => x < mid);
  const a = front(low), b = front(high);
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) best = Math.min(best, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
    worst = Math.max(worst, Math.sqrt(best));
  }
  expect(worst).toBeLessThan(0.5);
});

test("preview and print agree on the bounding box within 0.2 mm", () => {
  const a = build(kernelAt("preview")).boundingBox(), b = build(kernelAt("print")).boundingBox();
  for (let axis = 0; axis < 3; axis++) {
    expect(Math.abs(a.min[axis] - b.min[axis]), `min[${axis}]`).toBeLessThan(0.2);
    expect(Math.abs(a.max[axis] - b.max[axis]), `max[${axis}]`).toBeLessThan(0.2);
  }
});
