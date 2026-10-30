import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/offset-demo.js";
import { mount } from "./framework/index.js";

// Dev-only page for Solid.offset. `npm run dev`, then open /offset-demo.html.
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./offset-demo-worker.js", import.meta.url), { type: "module", name }),
});
