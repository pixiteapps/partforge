// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/hand.js";
import { mount } from "./framework/index.js";

// Example app for the hand (parts/hand.js), the angles-mode Pose reference part.
// `npm run dev`, then open /hand.html. The handle is stashed on window so
// scripts/check-app.mjs and scripts/check-pose.mjs can drive it; the part is exposed for
// its defaults, and every onParamsCommit is counted so check-pose can assert one commit
// per drag.
window.__pfPart = part;
window.__pfCommits = [];
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./hand-worker.js", import.meta.url), { type: "module", name }),
  onParamsCommit: (commit) => { window.__pfCommits.push(commit); },
});
