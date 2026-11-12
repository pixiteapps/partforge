// The pin hinge AUTHORING-PARTS.md "A hinge that opens" shows: everything from the
// `// Interfaces:` lines below to the end is copied into the guide verbatim, and
// test/pin-hinge-example.test.js holds the two equal and the part clear and printable.
// Interfaces: lid×pin: bore-on-pin, moving → clearance lid×pin 0.25..0.35
// Interfaces: base×pin: bore-on-pin, push → clearance base×pin 0.10..0.20
// Interfaces: base×lid: hinge, moving → clearance base×lid >=0.15, sweep open 0..180
const W = 36, K = W / 3, R = 5, AXIS = 3.25, T = 2, PIN = 1.5, LEAF = 22, GAP = 0.2, RELIEF = 5.6;
const RAD = Math.PI / 180;
// Built as printed: leaves flat on the bed, the axis along X at height AXIS, each knuckle
// cut flat on the bed. A bore is a teardrop, its roof 40° off vertical, so no ceiling overhangs.
const bore = (k, r) => k.extrude({ h: W + 2, profile: [
  ...Array.from({ length: 53 }, (_, i) => [-r * Math.cos((50 + 5 * i) * RAD), r * Math.sin((50 + 5 * i) * RAD)]),
  [-r / Math.cos(50 * RAD), 0],
] }).rotate(90, [0, 0, 0], [0, 1, 0]).translate([-1, 0, AXIS]);
const knuckle = (k, x0, x1) => k.cylinder({ r: R, h: x1 - x0 }).along("+X").translate([x0, 0, AXIS]);
const onBed = (k, s) => s.cut(k.box({ min: [-1, -2 * LEAF, -R], max: [W + 1, 2 * LEAF, 0] }));
export default {
  meta: { title: "Pin hinge", units: "mm" },
  parameters: [{ id: "hinge", title: "Hinge", controls: [
    { key: "open", label: "Open", unit: "°", min: 0, max: 180, step: 1, description: "Folds the lid over the base." },
  ] }],
  defaults: { open: 0 },
  derive: () => ({
    lidBore: 2 * PIN + 0.35 + 0.25,  // moving fit: fdm-pla 0.35, + holeUndersize 0.25 (horizontal as printed)
    baseBore: 2 * PIN + 0.05 + 0.25, // push fit: fdm-pla 0.05, + holeUndersize 0.25: the pin stays put
  }),
  parts: {
    base: { // the two outer knuckles; a relief round the lid's knuckle
      label: "Base",
      build: (k, p, d) => onBed(k, k.box({ min: [0, -LEAF, 0], max: [W, 0, T] })
        .cut(k.box({ min: [K - GAP, -RELIEF, -1], max: [2 * K + GAP, 1, T + 1] }))
        .union(knuckle(k, 0, K - GAP)).union(knuckle(k, 2 * K + GAP, W))).cut(bore(k, d.baseBore / 2)),
      views: { assembly: (s) => s, print: (s) => s },
    },
    lid: { // the middle knuckle; reliefs round the base's
      label: "Lid",
      build: (k, p, d) => onBed(k, k.box({ min: [0, 0, 0], max: [W, LEAF, T] })
        .cut(k.box({ min: [-1, -1, -1], max: [K, RELIEF, T + 1] }))
        .cut(k.box({ min: [2 * K, -1, -1], max: [W + 1, RELIEF, T + 1] }))
        .union(knuckle(k, K, 2 * K))).cut(bore(k, d.lidBore / 2)),
      views: {
        assembly: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: [0, 0, AXIS] }),
        print: (s) => s.translate([0, R + 6, 0]),
      },
    },
    pin: { // printed standing, pushed through the knuckles after printing
      label: "Pin",
      build: (k) => k.cylinder({ r: PIN, h: W }),
      views: { assembly: (s) => s.rotate(90, [0, 0, 0], [0, 1, 0]).translate([0, 0, AXIS]), print: (s) => s.translate([W + 6, 0, 0]) },
    },
  },
  views: { assembly: { label: "Assembly" }, print: { label: "Print" } },
  collisions: {},
  handles: {
    lid: {
      point: (p) => { const a = p.open * RAD; return [W / 2, LEAF * Math.cos(a) + (AXIS - T / 2) * Math.sin(a), AXIS + LEAF * Math.sin(a) - (AXIS - T / 2) * Math.cos(a)]; },
      params: ["open"], drag: "rotary", axis: { origin: [0, 0, AXIS], direction: [1, 0, 0] }, label: "Lid", showOn: "lid",
    },
  },
  verify: {
    process: "fdm-pla",
    sweeps: { open: { param: "open", clearance: 0 } },
    expect: { _view: { overlaps: 0, sweepContacts: 0,
      clearance: { "lid×pin": "0.25..0.35", "base×pin": "0.10..0.20", "base×lid": ">=0.15" } } },
  },
};
