import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/solid-leaf-demo.js";
import { mount } from "./framework/index.js";

// Dev-only page for the k.implicit `solid` leaf. `npm run dev`, then open /solid-leaf-demo.html.
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./solid-leaf-demo-worker.js", import.meta.url), { type: "module", name }),
});
