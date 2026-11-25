import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import hingedBox from "./parts/hinged-box.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the hinged-box part (the animation reference part).
// `npm run dev`, then open /hinged-box.html. The worker URL must stay inline
// so Vite bundles it. The handle is stashed for the check scripts, and every
// onPick is counted in `window.__pfPicks` so scripts/check-frames.mjs can assert
// that runtime.picking switches click-to-select off and on.
window.__pfPicks = [];
window.__pfRuntime = mount(hingedBox, {
  createWorker: (name) =>
    new Worker(new URL("./hinged-box-worker.js", import.meta.url), { type: "module", name }),
  onPick: (pick) => { window.__pfPicks.push(pick.token); },
});
