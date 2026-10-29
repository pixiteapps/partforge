// The fixture hand (test/fixtures/implicit-trees.js), its frames rebuilt with limb(): the
// limb's frames resolve bit for bit to the hand-written ones, and the hand meshes the same.
import { describe, it, expect } from "vitest";
import { resolveFrames } from "../src/framework/geometry/implicit/frames.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { FINGERS, THUMB, FAN, HAND_DEFAULTS, HAND_POSES, handSpec } from "./fixtures/implicit-trees.js";

// Rebuild the fixture hand's frames with limb(), using the fixture's own formulas.
function limbFrames(pose) {
  const p = { ...HAND_DEFAULTS, ...pose, flex: { ...HAND_DEFAULTS.flex, ...pose.flex } };
  const s = p.handLength / 190, curl = p.curl / 100;
  const flexOf = (pct) => [pct * 0.85, pct * 1.0, pct * 0.75].map((d) => d * curl);
  const frames = { palm: { at: [0, 0, 0] } };
  for (const [name, spec] of Object.entries(FINGERS)) {
    const f = limb(name, {
      parent: "palm", at: spec.mcp.map((v) => v * s),
      rotate: [{ axis: "z", deg: FAN[name] * p.spread }],
      joints: ["mcp", "pip", "dip"].map((n) => ({ name: n, range: [-180, 180] })),
      lengths: spec.len.map((v) => v * s),
    });
    Object.assign(frames, f.pose({ bend: flexOf(p.flex[name]) }, frames).frames);
  }
  const tf = flexOf(p.flex.thumb);
  const t = limb("thumb", {
    parent: "palm", at: THUMB.cmc.map((v) => v * s),
    rotate: [{ axis: "z", deg: 55 + p.spread * 0.5 }, { axis: "x", deg: -(12 + p.oppose * 0.4) }, { axis: "y", deg: -(45 + p.oppose) }],
    joints: ["cmc", "mcp", "ip"].map((n) => ({ name: n, range: [-180, 180] })),
    lengths: THUMB.len.map((v) => v * s),
  });
  Object.assign(frames, t.pose({ bend: [0, tf[1] * 0.6, tf[2]] }, frames).frames);
  return frames;
}

describe("fixture hand port", () => {
  for (const [label, pose] of [["default", {}], ["fist", HAND_POSES.fist], ["nearMiss", HAND_POSES.nearMiss]]) {
    it(`${label}: limb frames equal the fixture's, bit for bit`, () => {
      const want = resolveFrames(handSpec(pose).frames), got = resolveFrames(limbFrames(pose));
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [name, { world }] of want) {
        const g = got.get(name).world;
        for (let i = 0; i < 12; i++) expect(g[i] === world[i], `${name}[${i}]: ${g[i]} vs ${world[i]}`).toBe(true);
      }
    });
  }
  it("the default hand meshes identically with limb frames", () => {
    const spec = handSpec({});
    const a = meshImplicit(compileImplicit(spec), 1.5, { tier: "preview" }).positions;
    const b = meshImplicit(compileImplicit({ ...spec, frames: limbFrames({}) }), 1.5, { tier: "preview" }).positions;
    expect(b.length).toBe(a.length);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBe(0);
  });
});
