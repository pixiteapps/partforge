// A box that refuses to build past w = 40: `measure --ranges` must list exactly the poses
// past it and count the cage faces the error names (test/cli.test.js).
export default {
  meta: { title: "Ranges fixture", units: "mm" },
  parameters: [{ id: "s", title: "Size", controls: [
    { key: "w", label: "Width", min: 5, max: 50, step: 0.1 },
    { key: "h", label: "Height", min: 2, max: 8, step: 0.1 },
    { key: "lid", label: "Lid", type: "checkbox" },
  ] }],
  defaults: { w: 10, h: 4, lid: 0 },
  parts: { body: { label: "Body", build: (k, p) => {
    if (p.w > 40) throw new Error("subdiv: the body passes through itself between top and side.s1");
    return k.box({ min: [0, 0, 0], max: [p.w, 5, p.h] });
  }, views: { main: true } } },
  views: { main: { label: "Main" } },
};
