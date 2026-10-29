// Dev-only demo of Solid.offset: a constant-thickness skin cut from a body by
// body.cut(body.offset(-t)), or a cage grown around it. A quarter is cut away so
// the wall is visible. Not a reference part; no verify block.
export default {
  meta: { title: "Offset skin", units: "mm" },
  parameters: [
    {
      id: "body",
      title: "Body",
      controls: [
        { key: "shape", type: "radio", label: "Body",
          options: [{ value: 0, label: "Blob" }, { value: 1, label: "Sphere" }, { value: 2, label: "Box" }],
          description: "The solid to offset. Blob is a sphere unioned with a box and a cylinder." },
      ],
    },
    {
      id: "offset",
      title: "Offset",
      controls: [
        { key: "mode", type: "radio", label: "Result",
          options: [
            { value: 0, label: "Skin (inward)" }, { value: 1, label: "Cage (outward)" },
            { value: 2, label: "Grown" }, { value: 3, label: "Shrunk" },
          ],
          description: "**Skin**: `body.cut(body.offset(-t))`. **Cage**: `body.offset(t).cut(body)`. **Grown**/**Shrunk**: the offset solid alone." },
        { key: "t", type: "slider", label: "Thickness", unit: "mm", min: 0.5, max: 6, step: 0.5,
          description: "Offset distance." },
        { key: "open", type: "radio", label: "Cut open",
          options: [{ value: 1, label: "Quarter removed" }, { value: 0, label: "Closed" }],
          description: "Remove one quarter so the wall shows." },
      ],
    },
  ],
  defaults: { shape: 0, mode: 0, t: 2, open: 1 },
  parts: {
    shell: {
      label: "Shell",
      views: ["main"],
      export: { name: "offset-shell" },
      build: (k, p) => {
        let body;
        if (p.shape === 1) body = k.sphere(20);
        else if (p.shape === 2) body = k.box({ min: [-20, -15, -10], max: [20, 15, 10] });
        else body = k.sphere(16)
          .union(k.box({ min: [-8, -8, -22], max: [8, 8, 0] }))
          .union(k.cylinder({ r: 6, h: 44 }).rotateY(90).at([-22, 0, 4]));
        let out;
        if (p.mode === 0) out = body.cut(body.offset(-p.t));
        else if (p.mode === 1) out = body.offset(p.t).cut(body);
        else if (p.mode === 2) out = body.offset(p.t);
        else out = body.offset(-p.t);
        if (p.open) out = out.cut(k.box({ min: [0, -60, 0], max: [60, 0, 60] }));
        return out;
      },
    },
  },
  views: { main: { label: "Offset" } },
};
