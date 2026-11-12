// The pin hinge AUTHORING-PARTS.md "A hinge that opens" shows: everything from the
// `// Interfaces:` lines below to the end is copied into the guide verbatim, and
// test/pin-hinge-example.test.js holds the two equal and the part clear and printable.
// Interfaces: lid×pin: bore-on-pin, moving → clearance lid×pin 0.25..0.35
// Interfaces: base×pin: bore-on-pin, push (near knuckle) and press (far knuckle), head seated → contacts base×pin
// Interfaces: base×lid: hinge, moving → clearance base×lid >=0.15, sweep open 0..180
const W = 36, K = W / 3, R = 5, AXIS = 3.25, T = 2, PIN = 1.5, FLAT = 1.1, HEAD = 2.5, HL = 1.5;
const LEAF = 22, GAP = 0.2, RELIEF = 5.6, RAD = Math.PI / 180;
// Built as printed: leaves flat on the bed, the axis along X at height AXIS, each knuckle
// cut flat on the bed. A bore is a teardrop, its roof 40° off vertical, so no ceiling overhangs.
const bore = (k, r, x0, len) => k.extrude({ h: len, profile: [
  ...Array.from({ length: 53 }, (_, i) => [-r * Math.cos((50 + 5 * i) * RAD), r * Math.sin((50 + 5 * i) * RAD)]),
  [-r / Math.cos(50 * RAD), 0],
] }).rotate(90, [0, 0, 0], [0, 1, 0]).translate([x0, 0, AXIS]);
const knuckle = (k, x0, x1) => k.cylinder({ r: R, h: x1 - x0 }).along("+X").translate([x0, 0, AXIS]);
const onBed = (k, s) => s.cut(k.box({ min: [-HL - 1, -2 * LEAF, -R], max: [W + 1, 2 * LEAF, 0] }));
export default {
  meta: { title: "Pin hinge", units: "mm" },
  parameters: [{ id: "hinge", title: "Hinge", controls: [
    { key: "open", label: "Open", unit: "°", min: 0, max: 180, step: 1, description: "Folds the lid over the base." },
  ] }],
  defaults: { open: 0 },
  derive: () => ({ // every bore is horizontal as printed, so each is drawn holeUndersize (fdm-pla 0.25) larger
    lidBore: 2 * PIN + 0.35 + 0.25,  // moving fit: fdm-pla 0.35, the lid turns on the pin
    nearBore: 2 * PIN + 0.05 + 0.25, // push fit: fdm-pla 0.05, the pin slides in up to its head
    farBore: 2 * PIN - 0.10 + 0.25,  // press fit: fdm-pla -0.10, the far knuckle grips the pin's end
  }),
  parts: {
    base: { // the two outer knuckles; a relief round the lid's knuckle
      label: "Base",
      build: (k, p, d) => onBed(k, k.box({ min: [0, -LEAF, 0], max: [W, 0, T] })
        .cut(k.box({ min: [K - GAP, -RELIEF, -1], max: [2 * K + GAP, 1, T + 1] }))
        .union(knuckle(k, 0, K - GAP)).union(knuckle(k, 2 * K + GAP, W)))
        .cut(bore(k, d.nearBore / 2, -1, K + 1)).cut(bore(k, d.farBore / 2, 2 * K, K + 1)),
      views: { assembly: (s) => s, print: (s) => s },
    },
    lid: { // the middle knuckle; reliefs round the base's
      label: "Lid",
      build: (k, p, d) => onBed(k, k.box({ min: [0, 0, 0], max: [W, LEAF, T] })
        .cut(k.box({ min: [-1, -1, -1], max: [K, RELIEF, T + 1] }))
        .cut(k.box({ min: [2 * K, -1, -1], max: [W + 1, RELIEF, T + 1] }))
        .union(knuckle(k, K, 2 * K))).cut(bore(k, d.lidBore / 2, -1, W + 2)),
      views: {
        assembly: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: [0, 0, AXIS] }),
        print: (s) => s.translate([0, R + 6, 0]),
      },
    },
    pin: { // printed lying on a flat FLAT below its axis; the head seats on the near knuckle
      label: "Pin",
      build: (k) => onBed(k, k.cylinder({ r: PIN, h: W }).along("+X")
        .union(k.cylinder({ r: HEAD, h: HL }).along("+X").translate([-HL, 0, 0])).translate([0, 0, FLAT])),
      views: { assembly: (s) => s.translate([0, 0, AXIS - FLAT]), print: (s) => s.translate([HL, -LEAF - 6, 0]) },
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
    expect: { _view: { overlaps: 0, sweepContacts: 0, contacts: [["base", "pin"]],
      clearance: { "lid×pin": "0.25..0.35", "base×lid": ">=0.15" } } },
  },
};
