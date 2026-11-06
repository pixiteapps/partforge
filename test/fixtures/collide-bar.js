// The collision tests' bar-and-slab parts. A fixed `palm` slab, top face at z = 0, and
// a `bar` hinged on a pin at [0, 0, PIN] along Y. At angle 0 the bar points +X; `place()`
// rotates it about the pin by p.angle, so it swings down toward the slab, and the lower
// corner of its far end first touches the slab top at 60° (PIN = L·sin60 + h·cos60).
//
// Three variants, exported by name:
// - collideBar: a 20 mm bar 4 mm thick over a 10 mm slab. 0 → 60° is ~21 mm of tip
//   travel, inside one frame's sub-step cap.
// - collideBarThrough: a short thin bar (3 mm thick, from 36 to 40 mm out) over a 50 mm
//   slab: at 90° it sits WHOLLY inside the slab, where an unsigned distance reads clear.
//   0 → 60° is ~42 mm of travel, more than one frame's sub-step cap.
// - collideBarTwo: collideBar's geometry with two params: `b` swings the bar (the old
//   `angle`), `a` slides it along Y, parallel to the slab, so only `b` closes the pair.
//
// barMeshes(part) returns the same boxes as plain meshes, each in its sub-part's own
// frame (before place()), so a test needs no kernel: pair them with poseMatrices.
const variants = new Map();

function boxMesh({ min, max }) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return { positions: new Float64Array(v.flat()), indices: new Uint32Array(f.flat()) };
}

function barPart({ title, L, r0, h, slab, two = false }) {
  const pin = L * Math.sin(Math.PI / 3) + h * Math.cos(Math.PI / 3);
  const boxes = {
    palm: { min: [-60, -100, -slab], max: [60, 100, 0] },
    bar: { min: [r0, -5, pin - h], max: [L, 5, pin + h] },
  };
  const angleOf = (p) => (two ? p.b : p.angle);
  const swing = (s, p) => {
    const turned = s.rotate(angleOf(p), [0, 0, pin], [0, 1, 0]);
    return two ? turned.translate([0, p.a, 0]) : turned;
  };
  const control = (key, label, min, max, description) => ({ key, label, unit: key === "a" ? "mm" : "°", min, max, step: 0.1, description });
  const controls = two
    ? [control("a", "Slide", 0, 20, "Slides the bar along the slab; never closes on it."),
       control("b", "Swing", 0, 180, "Swings the bar down about its pin; touches the slab at 60°.")]
    : [control("angle", "Swing", 0, 180, "Swings the bar down about its pin; touches the slab at 60°.")];
  const part = {
    meta: { title, units: "mm" },
    parameters: [{ id: "bar", title: "Bar", description: "The bar's pose.", controls }],
    defaults: two ? { a: 0, b: 0 } : { angle: 0 },
    parts: {
      palm: { label: "Palm", build: (k) => k.box(boxes.palm), views: { assembly: (s) => s } },
      bar: { label: "Bar", build: (k) => k.box(boxes.bar), views: { assembly: swing } },
    },
    views: { assembly: { label: "Assembly" } },
    collisions: {},
  };
  variants.set(part, { boxes, pin });
  return part;
}

export const collideBar = barPart({ title: "Collide bar", L: 20, r0: 0, h: 2, slab: 10 });
export const collideBarThrough = barPart({ title: "Collide bar through", L: 40, r0: 36, h: 1.5, slab: 50 });
export const collideBarTwo = barPart({ title: "Collide bar two", L: 20, r0: 0, h: 2, slab: 10, two: true });

/** The variant's sub-part meshes, each in its own (pre-place) frame. */
export function barMeshes(part) {
  const { boxes } = variants.get(part);
  return new Map(Object.entries(boxes).map(([name, box]) => [name, boxMesh(box)]));
}

/** The pin's height above the slab top, for tests that need the exact geometry. */
export const pinHeight = (part) => variants.get(part).pin;

// The base variant, for the CLI (lint/measure read a default export).
export default collideBar;
