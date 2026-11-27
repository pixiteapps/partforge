// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/capstan-joint.js";
import { mount } from "./framework/index.js";

// Dev/CI-only app for the capstan joint (parts/capstan-joint.js), the reference part for
// lines: the rope is drawn as a tube that follows the drum. `npm run dev`, then open
// /capstan-joint.html. Not in vite.config.js's rollupOptions.input. The handle is stashed
// on window for a smoke check or a console session to drive.
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./capstan-joint-worker.js", import.meta.url), { type: "module", name }),
});
