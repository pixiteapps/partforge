// The fixture hand (test/fixtures/implicit-trees.js), rebuilt with limb(): the limb writes the
// fixture's own frame data (the same numbers in the same places, up to how an axis and a
// one-step rotate are spelled), those frames resolve bit for bit to the fixture's, and each
// digit's flesh() and attach() are the fixture's own capsule chain and attach entry.
import { describe, it, expect } from "vitest";
import { resolveFrames } from "../src/framework/geometry/implicit/frames.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { FINGERS, THUMB, FAN, HAND_DEFAULTS, HAND_POSES, handSpec } from "./fixtures/implicit-trees.js";

const params = (pose) => ({ ...HAND_DEFAULTS, ...pose, flex: { ...HAND_DEFAULTS.flex, ...pose.flex } });

// Rebuild the fixture hand's digits with limb(), using the fixture's own formulas. Returns
// the frames and each digit's posed limb, with the scaled radii flesh() takes.
function limbHand(pose) {
  const p = params(pose);
  const s = p.handLength / 190, curl = p.curl / 100;
  const flexOf = (pct) => [pct * 0.85, pct * 1.0, pct * 0.75].map((d) => d * curl);
  const frames = { palm: { at: [0, 0, 0] } };
  const digits = {};
  for (const [name, spec] of Object.entries(FINGERS)) {
    const f = limb(name, {
      parent: "palm", at: spec.mcp.map((v) => v * s),
      rotate: [{ axis: "z", deg: FAN[name] * p.spread }],
      joints: ["mcp", "pip", "dip"].map((n) => ({ name: n, range: [-180, 180] })),
      lengths: spec.len.map((v) => v * s), r: spec.r.map((v) => v * s * p.slender),
    });
    digits[name] = f.pose({ bend: flexOf(p.flex[name]) }, frames);
    Object.assign(frames, digits[name].frames);
  }
  const tf = flexOf(p.flex.thumb);
  const t = limb("thumb", {
    parent: "palm", at: THUMB.cmc.map((v) => v * s),
    rotate: [{ axis: "z", deg: 55 + p.spread * 0.5 }, { axis: "x", deg: -(12 + p.oppose * 0.4) }, { axis: "y", deg: -(45 + p.oppose) }],
    joints: ["cmc", "mcp", "ip"].map((n) => ({ name: n, range: [-180, 180] })),
    lengths: THUMB.len.map((v) => v * s), r: THUMB.r.map((v) => v * s * p.slender),
  });
  digits.thumb = t.pose({ bend: [0, tf[1] * 0.6, tf[2]] }, frames);
  Object.assign(frames, digits.thumb.frames);
  return { frames, digits, s, p };
}

// One spelling for a rotate: a list of steps, each axis a vector. A zero-degree step is dropped
// (the thumb's cmc joint does not bend, and the fixture writes no step for it).
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const spelled = (frames) => Object.fromEntries(Object.entries(frames).map(([name, f]) => {
  const steps = (f.rotate == null ? [] : [f.rotate].flat())
    .map(({ axis, deg }) => ({ axis: AXES[axis] ?? axis, deg }))
    .filter(({ deg }) => deg !== 0);
  const out = { ...f };
  delete out.rotate;
  return [name, steps.length ? { ...out, rotate: steps } : out];
}));

// The fixture's contact root, and the digit union labelled `name` under it.
const digitUnion = (spec, name) => spec.root.children.find((c) => c.label === name);
const unlabelled = (node) => { const { label, ...rest } = node; return rest; };

describe("fixture hand port", () => {
  for (const [label, pose] of [["default", {}], ["fist", HAND_POSES.fist], ["nearMiss", HAND_POSES.nearMiss]]) {
    it(`${label}: the limb writes the fixture's frame data`, () => {
      expect(spelled(limbHand(pose).frames)).toEqual(spelled(handSpec(pose).frames));
    });
    it(`${label}: limb frames resolve to the fixture's, bit for bit`, () => {
      const want = resolveFrames(handSpec(pose).frames), got = resolveFrames(limbHand(pose).frames);
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [name, { world }] of want) {
        const g = got.get(name).world;
        for (let i = 0; i < 12; i++) expect(g[i] === world[i], `${name}[${i}]: ${g[i]} vs ${world[i]}`).toBe(true);
      }
    });
  }

  it("each digit's flesh() is the fixture's capsule chain", () => {
    const spec = handSpec({});
    const { digits, p } = limbHand({});
    for (const [name, posed] of Object.entries(digits)) {
      const want = digitUnion(spec, name);
      const got = posed.flesh({ blend: p.fingerBlend });
      expect({ kind: got.kind, k: got.k, label: got.label }, name).toEqual({ kind: want.kind, k: want.k, label: want.label });
      // The fixture's union lists the three bone capsules first, then its knuckle ellipsoids.
      expect(got.children.map(unlabelled), name).toEqual(want.children.slice(0, 3));
    }
  });

  it("each finger's attach() is the fixture's attach entry", () => {
    const spec = handSpec({});
    const { digits, s, p } = limbHand({});
    for (const name of Object.keys(FINGERS)) {
      const want = spec.root.attach.find((e) => e.a === name);
      // radius takes the limb's default (a third of the first segment); band is the fixture's
      // fixed 3 mm, scaled, not the default that follows the finger's base radius.
      const got = digits[name].attach("palm", { k: p.palmBlend * s, band: 3 * s });
      expect({ ...got, radius: 0 }, name).toEqual({ ...want, radius: 0 });
      expect(got.radius, name).toBeCloseTo(want.radius, 12);
    }
  });
});
