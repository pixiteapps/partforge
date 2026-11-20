// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "../test/fixtures/cage-creature.js";
import { mount } from "./framework/index.js";

// Dev-only app for the cage creature (test/fixtures/cage-creature.js), the demo of shape
// handles on a subdivision cage. `npm run dev`, then open /cage-creature.html. Not in
// vite.config.js's rollupOptions.input. The runtime, the part, every onParamsCommit, every
// onBuild and every build time are stashed on window for poking at from the console.
window.__pfPart = part;
window.__pfCommits = [];
window.__pfBuilds = [];
window.__pfBuildMs = [];
window.__pfRuntime = mount(part, {
  // Demo only: show every build's own time (the worker's `ms`), mid-drag builds included,
  // so the cost of re-smoothing the cage is visible while a handle moves.
  createWorker: (name) => {
    const worker = new Worker(new URL("./cage-creature-worker.js", import.meta.url), { type: "module", name });
    worker.addEventListener("message", (e) => {
      const ms = e.data?.ms;
      if (typeof ms !== "number" || e.data?.cache?.misses === 0) return;
      window.__pfBuildMs.push(ms);
      const el = document.getElementById("build-ms");
      if (el) el.textContent = `last build ${ms.toFixed(0)} ms · ${window.__pfBuildMs.length} builds`;
    });
    return worker;
  },
  // Click a piece: the selection popover, with the clicked piece's controls under its head row.
  onPick: (pick) => { window.__pfLastPick = pick; },
  selectionPopover: { slot: false },
  onParamsCommit: (commit) => { window.__pfCommits.push(commit); },
  onBuild: (build) => { window.__pfBuilds.push({ status: build.status, at: performance.now() }); },
});
