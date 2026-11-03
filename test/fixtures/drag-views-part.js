// A handle shown only in the part's second view: `measure --drag` without a view must name
// the view that shows it (test/cli.test.js, test/oracle-drag.test.js).
export default {
  meta: { title: "Drag views fixture", units: "mm" },
  parameters: [{ id: "s", title: "Slide", controls: [{ key: "x", label: "X", min: 0, max: 50, step: 0.1 }] }],
  defaults: { x: 10 },
  derive: () => ({}),
  parts: { body: { label: "Body", build: (k, p) => k.box({ min: [0, 0, 0], max: [p.x + 5, 5, 5] }) } },
  views: { print: { label: "Print" }, assembly: { label: "Assembly" } },
  handles: {
    slide: { point: (p) => [p.x, 0, 0], params: ["x"], drag: "axis", direction: [1, 0, 0], views: ["assembly"] },
  },
};
