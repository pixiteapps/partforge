import { describe, it, expect } from "vitest";
import { openingParams, createFilePlacer } from "../src/framework/preview-pose.js";
import { relativeMatsAt } from "../src/framework/collide/world.js";
import { resolveParams, viewSubParts } from "../src/framework/part-model.js";
import gearbox from "../src/parts/gearbox.js";
import hand from "../src/parts/hand.js";
import robotArm from "../src/parts/robot-arm.js";
import drawerBox from "../src/parts/drawer-box.js";
import hingedBox from "../src/parts/hinged-box.js";

const near = (a, b, tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < tol);
const defaultView = (part) => Object.keys(part.views)[0];

describe("openingParams", () => {
  it("layers the autoplay animation's t = 0 values over the live params", () => {
    expect(openingParams(gearbox, defaultView(gearbox), { driveAngle: 90 }).driveAngle).toBe(0);
    expect(openingParams(hingedBox, "box", { lidAngle: 50 }).lidAngle).toBe(0);
  });
  it("is defaults + params for a view without an autoplay animation", () => {
    const view = defaultView(drawerBox);
    expect(openingParams(drawerBox, view, { drawer1Open: 40 })).toEqual({ ...drawerBox.defaults, drawer1Open: 40 });
  });
});

describe("createFilePlacer", () => {
  for (const [label, part, file] of [
    ["robot-arm", robotArm, {}], ["hand", hand, {}], ["gearbox", gearbox, { driveAngle: 37 }], ["drawer-box", drawerBox, { drawer2Open: 60 }],
  ]) {
    it(`${label}: matricesAt equals relativeMatsAt from the file params`, () => {
      const view = defaultView(part);
      const fileParams = { ...part.defaults, ...file };
      const names = viewSubParts(part, view, fileParams);
      const placer = createFilePlacer(part, view, fileParams, names);
      const r0 = resolveParams(part, fileParams);
      const rel = relativeMatsAt(part, view, r0.p, r0.d);
      const moved = { ...fileParams };
      for (const k of Object.keys(file).length ? Object.keys(file) : Object.keys(part.defaults).filter((k) => typeof part.defaults[k] === "number").slice(0, 2)) moved[k] = fileParams[k] + 5;
      const r1 = resolveParams(part, moved);
      const got = placer.matricesAt(r1.p, r1.d), want = rel(r1.p, r1.d);
      for (const n of names) {
        if (want.get(n) == null) expect(got.get(n)).toBeNull();
        else expect(near(got.get(n), want.get(n))).toBe(true);
      }
    });
  }
  it("at the file params every matrix is the identity", () => {
    const view = defaultView(gearbox);
    const fileParams = { ...gearbox.defaults, driveAngle: 37 };
    const names = viewSubParts(gearbox, view, fileParams);
    const placer = createFilePlacer(gearbox, view, fileParams, names);
    const { p, d } = resolveParams(gearbox, fileParams);
    for (const m of placer.matricesAt(p, d).values()) expect(near(m, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])).toBe(true);
  });
  it("a mesh name the part lacks is not placed; a view sub-part the file lacks is not asked for", () => {
    const view = defaultView(gearbox);
    const placer = createFilePlacer(gearbox, view, gearbox.defaults, ["gear1", "ghost"]);
    expect(placer.base.has("ghost")).toBe(false);
    const { p, d } = resolveParams(gearbox, { ...gearbox.defaults, driveAngle: 10 });
    expect([...placer.matricesAt(p, d).keys()]).toEqual(["gear1"]);
  });
  it("apply sends only changed matrices, never null, and reports the names sent", () => {
    const view = defaultView(gearbox);
    const names = viewSubParts(gearbox, view, gearbox.defaults);
    const placer = createFilePlacer(gearbox, view, gearbox.defaults, names);
    const sent = [];
    const viewer = { setSubPose: (n, m) => sent.push([n, m]) };
    expect(placer.apply(viewer, { ...gearbox.defaults })).toEqual([]);          // identity: nothing to send
    const moved = placer.apply(viewer, { ...gearbox.defaults, driveAngle: 30 });
    expect(moved.length).toBeGreaterThan(0);
    expect(sent.every(([, m]) => Array.isArray(m) && m.length === 16)).toBe(true);
    expect(placer.apply(viewer, { ...gearbox.defaults, driveAngle: 30 })).toEqual([]); // unchanged: not re-sent
  });
});
