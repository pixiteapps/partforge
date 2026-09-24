// test/framework/materials-print-bed.test.js
import * as THREE from "three";
import { expect, test } from "vitest";
import { BED_SIZES_MM, bedSizeFor, createPrintBed, drawBedMarkings } from "../../src/framework/materials/print-bed.js";

// A 2D context that records what was written, enough to read the markings back.
function fakeCanvas() {
  const texts = [];
  const ctx = new Proxy({ texts }, {
    get: (t, k) => (k in t ? t[k] : k === "fillText" ? (s) => texts.push(s) : () => {}),
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => ctx, texts };
}

test("the bed is the smallest standard size that leaves a margin round the footprint", () => {
  expect(bedSizeFor(40)).toBe(BED_SIZES_MM[0]);
  expect(bedSizeFor(200)).toBe(256);
  expect(bedSizeFor(300)).toBe(350);
  // past the last standard size it rounds up to the next 50 mm
  expect(bedSizeFor(400)).toBe(450);
});

test("the markings name the plate's actual size, carry the wordmark in both front corners, and a ruler", () => {
  let canvas;
  expect(drawBedMarkings(256, () => (canvas = fakeCanvas()))).toBe(canvas);
  expect(canvas.texts).toContain("256 × 256 mm");
  expect(canvas.texts.filter((t) => t === "partforge")).toHaveLength(2);
  expect(canvas.texts).toEqual(expect.arrayContaining(["50", "100", "150", "200", "250"]));
});

test("without a 2D canvas the plate is unmarked, not broken", () => {
  expect(drawBedMarkings(256, () => null)).toBeNull();
  const pei = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const bed = createPrintBed({ pei, tileMm: 128, createCanvas: () => null });
  bed.place({ y: -5, centerX: 2, centerZ: 3, footprintMm: 60 });
  expect(bed.sizeMm).toBe(180);
  expect(bed.object.position.toArray().map((v) => +v.toFixed(2))).toEqual([2, -5.01, 3]);
  const [plate, ink] = bed.object.children;
  expect(ink.visible).toBe(false);
  // the plate's top sits flush with the bed's origin and spans the chosen size
  plate.geometry.computeBoundingBox();
  expect(plate.geometry.boundingBox.max.y).toBeCloseTo(0);
  expect(plate.geometry.boundingBox.max.x - plate.geometry.boundingBox.min.x).toBeCloseTo(180);
  // PEI UVs are millimetres, so one texture repeat covers tileMm
  expect(pei.map.repeat.x).toBeCloseTo(1 / 128);
  bed.dispose();
});

test("a bigger part gets a bigger plate, with the markings redrawn for it", () => {
  const sizes = [];
  const pei = new THREE.MeshStandardMaterial();
  const bed = createPrintBed({ pei, tileMm: 128, createCanvas: () => { const c = fakeCanvas(); sizes.push(c); return c; } });
  bed.place({ y: 0, footprintMm: 60 });
  bed.place({ y: 0, footprintMm: 60 }); // same size: nothing redrawn
  bed.place({ y: 0, footprintMm: 200 });
  expect(sizes).toHaveLength(2);
  expect(sizes[1].texts).toContain("256 × 256 mm");
  expect(bed.object.children[1].visible).toBe(true);
  bed.dispose();
});
