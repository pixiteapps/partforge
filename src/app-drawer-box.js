// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/drawer-box.js";
import { mount } from "./framework/index.js";

// Dev/CI-only app for the drawer box (parts/drawer-box.js), the reference part for shape
// and motion handles on one part. `npm run dev`, then open /drawer-box.html. Not in
// vite.config.js's rollupOptions.input. The handle is stashed on window so
// scripts/check-pose.mjs can drive it; the part is exposed for its defaults, every
// onParamsCommit is counted (one commit per drag) and so is every onBuild (a corner drag
// rebuilds live, and the host must still see exactly one build, at release).
window.__pfPart = part;
window.__pfCommits = [];
window.__pfBuilds = [];
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./drawer-box-worker.js", import.meta.url), { type: "module", name }),
  onParamsCommit: (commit) => { window.__pfCommits.push(commit); },
  onBuild: (build) => { window.__pfBuilds.push({ status: build.status, at: performance.now() }); },
});
