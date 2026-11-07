import { describe, it, expect } from "vitest";
import { openingParams, createFilePlacer } from "../src/framework/preview-pose.js";
import { previewHandles, PREVIEW_HANDLE_SAMPLES } from "../src/framework/preview-pose.js";
import { handlesShownInView } from "../src/framework/pose/handle-views.js";
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

describe("previewHandles", () => {
  const all = (part, file = {}) => {
    const view = defaultView(part);
    const fileParams = { ...part.defaults, ...file };
    return previewHandles(part, view, fileParams, viewSubParts(part, view, fileParams));
  };
  it("samples 0/25/50/75/100 % of a key's range", () => {
    expect(PREVIEW_HANDLE_SAMPLES).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it("shows every robot-arm, hand and gearbox handle", () => {
    for (const part of [robotArm, hand, gearbox]) {
      const out = all(part);
      expect(out.hidden).toEqual({});
      expect(out.shown).toEqual(handlesShownInView(part, defaultView(part), part.defaults));
    }
  });
  it("hides the drawer box's corner handle (width/depth rebuild the carcass) and shows its drawers", () => {
    const out = all(drawerBox);
    expect(out.shown).toEqual(["drawer1", "drawer2", "drawer3"]);
    expect(out.hidden.corner).toMatch(/^(width|depth) rebuilds /);
  });
  it("a view sub-part missing from the file hides only a handle whose key would give it geometry", () => {
    const view = defaultView(drawerBox);
    const names = viewSubParts(drawerBox, view, drawerBox.defaults).filter((n) => n !== "drawer2");
    const out = previewHandles(drawerBox, view, drawerBox.defaults, names);
    expect(out.shown).toEqual(["drawer1", "drawer2", "drawer3"]); // drawer2's slide is still place-only
  });
  it("a sub-part that comes and goes with a key hides the handle", () => {
    const part = { ...drawerBox, parts: { ...drawerBox.parts, flag: { ...drawerBox.parts.drawer1, enabled: (p) => p.drawer1Open > 50 } } };
    expect(all(part).hidden.drawer1).toBe("drawer1Open changes which sub-parts the view shows");
  });
  it("a querying build hides the handles that touch it", () => {
    const part = { ...gearbox, parts: { ...gearbox.parts, plate: { ...gearbox.parts.plate,
      build: (k, p, d) => { const s = gearbox.parts.plate.build(k, p, d); s.volume(); return s; } } } };
    const out = all(part);
    expect(out.shown).toEqual([]);
    expect(Object.values(out.hidden).every((r) => r === "plate's build cannot be read")).toBe(true);
  });
  it("a part without handles answers empty", () => {
    expect(previewHandles(hingedBox, "box", hingedBox.defaults, ["base", "lid"])).toEqual({ shown: [], hidden: {} });
  });
});
