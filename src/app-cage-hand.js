// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/cage-hand.js";
import { mount } from "./framework/index.js";

// Example app for the cage hand (parts/cage-hand.js), the reference part for Pose mode on a
// subdivision cage. `npm run dev`, then open /cage-hand.html. The runtime and the part are
// stashed on window, and every onParamsCommit is counted, so a script can drive a drag and
// check it commits once.
window.__pfPart = part;
window.__pfCommits = [];
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./cage-hand-worker.js", import.meta.url), { type: "module", name }),
  onParamsCommit: (commit) => { window.__pfCommits.push(commit); },
});
