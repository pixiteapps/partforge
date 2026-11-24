import { beforeAll, describe, expect, it } from "vitest";
import { sectionAt, limbFacts } from "../src/framework/oracle/limb-sections.js";
import { measure } from "../src/framework/oracle/measure.js";
import * as oracle from "../src/oracle.js";
import * as testing from "../src/testing.js";
import { bootManifoldKernel } from "../src/testing.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import cageHand from "../src/parts/cage-hand.js";
import gapPart from "./fixtures/gap-part.js";

// A closed rectangular prism along Z: `w` along X, `dp` along Y, centred on [cx, cy], with a
// ring of four vertices at every z in `zs` (so a plane can pass exactly through a ring).
function prism(w, dp, zs, [cx, cy] = [0, 0], into = { positions: [], indices: [] }) {
  const base = into.positions.length / 3;
  const corners = [[-w / 2, -dp / 2], [w / 2, -dp / 2], [w / 2, dp / 2], [-w / 2, dp / 2]];
  for (const z of zs) for (const [x, y] of corners) into.positions.push(cx + x, cy + y, z);
  const v = (ring, c) => base + ring * 4 + c;
  for (let r = 0; r < zs.length - 1; r++) {
    for (let c = 0; c < 4; c++) {
      const a = v(r, c), b = v(r, (c + 1) % 4), a2 = v(r + 1, c), b2 = v(r + 1, (c + 1) % 4);
      into.indices.push(a, b, b2, a, b2, a2);
    }
  }
  const top = zs.length - 1;
  into.indices.push(v(0, 0), v(0, 2), v(0, 1), v(0, 0), v(0, 3), v(0, 2));
  into.indices.push(v(top, 0), v(top, 1), v(top, 2), v(top, 0), v(top, 2), v(top, 3));
  return into;
}

const box = prism(20, 10, [-20, 20]);
const frame = (origin, x = [1, 0, 0], z = [0, 1, 0], y = [0, 0, 1]) => ({ origin, x, y, z });

describe("sectionAt", () => {
  it("measures the outline round the origin along x and z", () => {
    const s = sectionAt(box, frame([0, 0, 0]));
    expect(s.width).toBeCloseTo(20, 9);
    expect(s.depth).toBeCloseTo(10, 9);
  });

  it("swaps width and depth when the frame turns 90° about Z", () => {
    const s = sectionAt(box, frame([0, 0, 0], [0, 1, 0], [-1, 0, 0]));
    expect(s.width).toBeCloseTo(10, 9);
    expect(s.depth).toBeCloseTo(20, 9);
  });

  it("is null when no outline goes round the origin", () => {
    expect(sectionAt(box, frame([30, 0, 0]))).toBeNull();
    expect(sectionAt(box, frame([0, 0, 25]))).toBeNull();
  });

  it("measures the outline the origin is in, not the union of every outline", () => {
    const two = prism(6, 4, [-20, 20], [50, 0], prism(20, 10, [-20, 20]));
    const s = sectionAt(two, frame([50, 0, 0]));
    expect(s.width).toBeCloseTo(6, 9);
    expect(s.depth).toBeCloseTo(4, 9);
  });

  it("finds one closed outline when the plane passes exactly through a ring of vertices", () => {
    const stacked = prism(20, 10, [-20, 0, 20]);
    const s = sectionAt(stacked, frame([0, 0, 0]));
    expect(s.width).toBeCloseTo(20, 9);
    expect(s.depth).toBeCloseTo(10, 9);
  });
});

describe("limbFacts", () => {
  const straight = () => limb("finger", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: ["a", "b", "c"], lengths: [10, 20, 30] })
    .pose({ bend: { a: 0, b: 0, c: 0 } });
  const rod = prism(20, 10, [-5, 65]);
  // The prism's extent along a direction: 20 along X, 10 along Y.
  const along = (u) => Math.abs(u[0]) * 20 + Math.abs(u[1]) * 10;

  it("reports each joint's position, bone length and the body's section there", () => {
    const posed = straight();
    const f = limbFacts({ finger: posed }, [{ name: "rod", mesh: rod, matrix: null }]);
    const joints = posed.bones.joints;
    expect(f.finger.joints.map((j) => j.name)).toEqual(["finger.a", "finger.b", "finger.c"]);
    expect(f.finger.joints.map((j) => j.length)).toEqual([10, 20, 30]);
    expect(f.finger.joints.map((j) => j.at)).toEqual([[0, 0, 0], [0, 0, 10], [0, 0, 30]]);
    f.finger.joints.forEach((j, i) => {
      expect(j.part).toBe("rod");
      expect(j.width).toBeCloseTo(along(joints[i].posed.x), 6);
      expect(j.depth).toBeCloseTo(along(joints[i].posed.z), 6);
    });
    expect(f.finger.tip).toEqual([0, 0, 60]);
  });

  it("is undefined when derive returns no posed limb", () => {
    expect(limbFacts({ n: 3, s: "x" }, [{ name: "rod", mesh: rod, matrix: null }])).toBeUndefined();
    expect(limbFacts(undefined, [])).toBeUndefined();
  });

  it("skips a limb with a parent", () => {
    const child = limb("tip", { parent: "palm", toward: [0, 0, 1], bendToward: [1, 0, 0], joints: ["a"], lengths: [5] }).pose({});
    expect(child.bones.parent).toBe(true);
    expect(limbFacts({ child }, [{ name: "rod", mesh: rod, matrix: null }])).toBeUndefined();
  });

  it("finds limbs in an array one level down, named by their bones' name", () => {
    const f = limbFacts({ digits: [straight()] }, [{ name: "rod", mesh: rod, matrix: null }]);
    expect(Object.keys(f)).toEqual(["finger"]);
    expect(f.finger.joints).toHaveLength(3);
  });

  it("carries the frame into a sub-part's display pose", () => {
    const moved = prism(20, 10, [-5, 65], [100, 0]);
    // column-major translation by [100, 0, 0]
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
    const f = limbFacts({ finger: straight() }, [{ name: "rod", mesh: moved, matrix }]);
    expect(f.finger.joints[0].part).toBe("rod");
    expect(f.finger.joints[0].width).toBeCloseTo(along(straight().bones.joints[0].posed.x), 6);
    // positions stay in part coordinates
    expect(f.finger.joints[0].at).toEqual([0, 0, 0]);
  });

  it("leaves part, width and depth off a joint no outline goes round", () => {
    const far = prism(20, 10, [-5, 65], [500, 0]);
    const f = limbFacts({ finger: straight() }, [{ name: "rod", mesh: far, matrix: null }]);
    expect(f.finger.joints[0]).toEqual({ name: "finger.a", at: [0, 0, 0], length: 10 });
  });
});

describe("measure's limbs", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel({ quality: "preview" }); }, 120_000);

  it("is exported from partforge/oracle and partforge/testing", () => {
    expect(oracle.limbFacts).toBe(limbFacts);
    expect(oracle.sectionAt).toBe(sectionAt);
    expect(testing.limbFacts).toBe(limbFacts);
    expect(testing.sectionAt).toBe(sectionAt);
  });

  it("reports the cage hand's bones and the body's size at each joint", () => {
    const r = measure(k, cageHand, undefined, {}, { handles: false });
    const d = cageHand.derive({ ...cageHand.defaults });
    expect(r.limbs.index.joints).toHaveLength(3);
    expect(r.limbs.thumb.joints).toHaveLength(4);
    for (const [name, l] of Object.entries(r.limbs)) {
      const bones = d[name].bones;
      const pts = bones.joints.map((j) => j.posed.origin).concat([bones.tip.posed]);
      l.joints.forEach((j, i) => {
        const [a, b] = [pts[i], pts[i + 1]];
        expect(Math.abs(j.length - Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))).toBeLessThan(0.2);
      });
    }
    const [mcp, pip] = r.limbs.index.joints;
    expect(mcp.width).toBeGreaterThan(80);
    expect(mcp.width).toBeLessThan(92);
    expect(pip.width).toBeGreaterThan(15);
    expect(pip.width).toBeLessThan(21);
    expect(mcp.part).toBe("hand");
  }, 120_000);

  it("has no limbs key on a part whose derive returns no limb", () => {
    const r = measure(k, gapPart);
    expect(r).not.toHaveProperty("limbs");
  });
});
