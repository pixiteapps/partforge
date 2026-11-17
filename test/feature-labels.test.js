// Manifold-side feature labels: .label() marks a solid; after booleans, toMesh()
// attributes each surviving triangle of that solid's surface to the label.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, handle } from "../src/testing.js";
import planter from "../src/parts/planter.js";
import { resolveParams, buildPosed } from "../src/framework/part-model.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("unlabeled build produces no feature fields", () => {
  const m = k.box({ min: [0, 0, 0], max: [4, 4, 4] }).toMesh();
  expect(m.featureIds).toBeUndefined();
  expect(m.features).toBeUndefined();
});

test("label() attributes a cut tool's surviving surface", () => {
  const s = k.box({ min: [0, 0, 0], max: [10, 10, 10] })
    .cut(k.cylinder({ r: 2, h: 12 }).at([5, 5, -1]).label("Bore"));
  const m = s.toMesh();
  expect(m.features).toEqual(["Bore"]);
  expect(m.featureIds).toBeInstanceOf(Uint16Array);
  expect(m.featureIds.length).toBe(m.triangles);
  const boreTris = [];
  m.featureIds.forEach((v, t) => { if (v === 1) boreTris.push(t); });
  expect(boreTris.length).toBeGreaterThan(0);
  // every bore triangle's vertices lie on the r=2 cylinder around (5,5)
  for (const t of boreTris) {
    for (let v = 0; v < 3; v++) {
      const x = m.positions[t * 9 + v * 3] - 5, y = m.positions[t * 9 + v * 3 + 1] - 5;
      expect(Math.hypot(x, y)).toBeCloseTo(2, 1);
    }
  }
  // and unlabeled triangles (the box faces) exist too
  expect(m.featureIds.some((v) => v === 0)).toBe(true);
});

test("labels survive transforms applied after label()", () => {
  const tool = k.cylinder({ r: 2, h: 12 }).label("Bore").at([5, 5, -1]); // label BEFORE at()
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).cut(tool).toMesh();
  expect(m.features).toEqual(["Bore"]);
  expect(m.featureIds.some((v) => v === 1)).toBe(true);
});

test("label() keeps the mesh's runs: same triangle count as unlabeled, one new id per old id", () => {
  const make = () => k.box({ min: [0, 0, 0], max: [10, 10, 10] }).cut(k.cylinder({ r: 2, h: 12 }).translate([5, 5, -1]));
  const plain = make(), labeled = make().label("Body");
  expect(labeled.toMesh().triangles).toBe(plain.toMesh().triangles);
  expect(labeled._idMap.size).toBe(2);
  expect(new Set(labeled._runs().map((r) => r.id)).size).toBe(2);
  expect(labeled.toMesh().features).toEqual(["Body"]);
});

test("same label string merges into one feature (patterned features)", () => {
  const holes = [
    k.cylinder({ r: 1, h: 12 }).at([3, 3, -1]).label("Mounting holes"),
    k.cylinder({ r: 1, h: 12 }).at([7, 7, -1]).label("Mounting holes"),
  ];
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).cutAll(holes).toMesh();
  expect(m.features).toEqual(["Mounting holes"]);
});

test("two distinct labels produce two feature entries", () => {
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] })
    .cut(k.cylinder({ r: 1, h: 12 }).at([3, 3, -1]).label("Bore A"))
    .cut(k.cylinder({ r: 1, h: 12 }).at([7, 7, -1]).label("Bore B"))
    .toMesh();
  expect([...m.features].sort()).toEqual(["Bore A", "Bore B"]);
  const ids = new Set(m.featureIds.filter((v) => v > 0));
  expect(ids.size).toBe(2);
});

test("generate jobs pass featureIds/features through to the mesh payload", async () => {
  const part = {
    defaults: { bore: 4 },
    parts: {
      body: {
        views: ["v"],
        build: (k, p) => k.box({ min: [0, 0, 0], max: [10, 10, 10] })
          .cut(k.cylinder({ r: p.bore / 2, h: 12 }).at([5, 5, -1]).label("Bore")),
      },
    },
    views: { v: {} },
  };
  const posted = [];
  await handle(k, part, { type: "generate", subparts: ["body"], view: "v", params: {} }, (m) => posted.push(m));
  const meshes = posted.find((m) => m.type === "meshes").meshes;
  expect(meshes[0].features).toEqual(["Bore"]);
  expect(meshes[0].featureIds).toBeInstanceOf(Uint16Array);
});

test("planter's build exposes its authored feature names", () => {
  const { p, d } = resolveParams(planter, {});
  const m = buildPosed(k, planter, "planter", { purpose: "display", view: "planter", p, d }).toMesh();
  expect([...m.features].sort()).toEqual(["Cavity", "Drainage hole", "Faceted wall"]);
});
