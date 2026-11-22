// test/ghost-offset.test.js
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildCadMaterial, buildPhysicalMaterial } from "../src/framework/materials/physical.js";

const base = () => new THREE.MeshStandardMaterial();

describe("ghost surfaces lose the depth tie", () => {
  it("a translucent CAD material is pushed back", () => {
    const ghost = buildCadMaterial({ color: 0xff0000, opacity: 0.35 }, base());
    expect(ghost.polygonOffset).toBe(true);
    expect(ghost.polygonOffsetFactor).toBe(2);
    expect(ghost.polygonOffsetUnits).toBe(2);
  });
  it("a translucent physical material is pushed back", () => {
    const ghost = buildPhysicalMaterial({ material: "pla-print", opacity: 0.35 });
    expect(ghost.polygonOffset).toBe(true);
    expect(ghost.polygonOffsetFactor).toBe(2);
    expect(ghost.polygonOffsetUnits).toBe(2);
  });
  it("opaque materials are not", () => {
    const cad = buildCadMaterial({ color: 0xff0000 }, base());
    const phys = buildPhysicalMaterial({ material: "pla-print" });
    expect(cad.polygonOffsetFactor ?? 0).not.toBe(2);
    expect(phys.polygonOffsetFactor ?? 0).not.toBe(2);
  });
});
