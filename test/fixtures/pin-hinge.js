// The pin hinge AUTHORING-PARTS.md "A hinge that opens" shows: everything from the
// `const` line below to the end is copied into the guide verbatim, and
// test/pin-hinge-example.test.js holds the two equal and the part clear.
const W = 30, R = 3, PIN = 1, BORE = 1.2, GAP = 0.2, LEAF = 20, RELIEF = 3.5;
const leaf = (k, y0, y1) => k.box({ min: [0, y0, -R], max: [W, y1, -R + 2] }); // under the axis
export default {
  meta: { title: "Pin hinge", units: "mm" },
  parameters: [{ id: "hinge", title: "Hinge", controls: [
    { key: "open", label: "Open", unit: "°", min: 0, max: 180, step: 1, description: "Folds the lid over the base." },
  ] }],
  defaults: { open: 0 },
  parts: {
    base: { // two outer knuckles and the pin, printed in place; a relief round the lid's knuckle
      label: "Base",
      build: (k) => leaf(k, -LEAF, 0).cut(k.box({ min: [W / 3 - GAP, -RELIEF, -R - 1], max: [2 * W / 3 + GAP, 1, 0] }))
        .union(k.cylinder({ r: R, h: W / 3 - GAP }).along("+X"))
        .union(k.cylinder({ r: R, h: W / 3 - GAP }).along("+X").translate([2 * W / 3 + GAP, 0, 0]))
        .union(k.cylinder({ r: PIN, h: W }).along("+X")),
      views: { assembly: (s) => s },
    },
    lid: { // the middle knuckle, bored BORE - PIN larger than the pin; reliefs round the base's
      label: "Lid",
      build: (k) => leaf(k, 0, LEAF)
        .cut(k.box({ min: [-1, -1, -R - 1], max: [W / 3, RELIEF, 0] }))
        .cut(k.box({ min: [2 * W / 3, -1, -R - 1], max: [W + 1, RELIEF, 0] }))
        .union(k.cylinder({ r: R, h: W / 3 }).along("+X").translate([W / 3, 0, 0]))
        .cut(k.cylinder({ r: BORE, h: W + 2 }).along("+X").translate([-1, 0, 0])),
      views: { assembly: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: [0, 0, 0] }) },
    },
  },
  views: { assembly: { label: "Assembly" } },
  collisions: {},
  handles: {
    lid: {
      point: (p) => { const a = (p.open * Math.PI) / 180; return [W / 2, LEAF * Math.cos(a) + 2 * Math.sin(a), LEAF * Math.sin(a) - 2 * Math.cos(a)]; },
      params: ["open"], drag: "rotary", axis: { origin: [0, 0, 0], direction: [1, 0, 0] }, label: "Lid", showOn: "lid",
    },
  },
  verify: {
    sweeps: { open: { param: "open", clearance: 0 } },
    expect: { _view: { overlaps: 0, clearance: { "base×lid": ">=0.15" }, sweepContacts: 0 } },
  },
};
