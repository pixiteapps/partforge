// SPIKE: render the STL files sharpen.mjs wrote. node spike/exact-faces/render-stl.mjs <dir>
import { writeFileSync } from "node:fs";
import { bootManifoldKernel } from "../../src/testing/manifold.js";
import { renderViewImages } from "../../src/testing/render.js";
const dir = process.argv[2];
for (const name of ["plate-edge", "bracket-corner", "cylinder-side"]) {
  const imports = { m: new URL(`file://${dir}/${name}.stl`) };
  const k = await bootManifoldKernel({ imports });
  const part = { meta: { title: name, units: "mm", backend: "manifold" }, imports, parameters: [], defaults: {},
    parts: { body: { label: name, views: ["main"], build: (kk) => kk.import("m") } }, views: { main: { label: name } } };
  const imgs = await renderViewImages(k, part, "main", { views: ["iso"], size: [1100, 850] });
  for (const im of imgs) writeFileSync(`${dir}/${name}-sharp.png`, im.png);
  console.log(name, "ok");
}
