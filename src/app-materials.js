// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import materialSwatchesPart from "./parts/material-swatches.js";
import { mount } from "./framework/index.js";

// Dev-only contact sheet app for the material library (parts/material-swatches.js).
// Identical wiring to app.js — the only thing that differs per part is which
// definition you import and which worker entry you point at. `npm run dev`, then
// open /materials.html. Not part of the production build — check materials.html
// by eye after any preset or shader change (see AGENTS.md "Architecture").
// Dev-only: the handle is stashed on window so scripts/check-app.mjs can drive
// the embedding contract (runtime.captureCurrent) the way an embedder would.
window.__pfRuntime = mount(materialSwatchesPart, {
  createWorker: (name) =>
    new Worker(new URL("./materials-worker.js", import.meta.url), { type: "module", name }),
  onAnnotationSend: (payload) => {
    window.__pfLastAnnotation = payload;
    console.log("annotation payload", payload);
  },
});
