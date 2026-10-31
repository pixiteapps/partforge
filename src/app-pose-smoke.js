import part from "../test/fixtures/ik-hand-smoke.js";
import { mount } from "./framework/index.js";

// Dev/CI-only app for Pose mode — see test/fixtures/ik-hand-smoke.js. The handle is
// stashed for scripts/check-pose.mjs, like the other smoke apps, and every
// onParamsCommit is counted so the check can assert one commit per drag; the part is
// exposed for its defaults; and every onPick is counted, so the check can assert that a
// plain click on the model still picks while a click or drag on a pose handle never does.
window.__pfPart = part;
window.__pfCommits = [];
window.__pfPicks = [];
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./pose-smoke-worker.js", import.meta.url), { type: "module", name }),
  onParamsCommit: (commit) => { window.__pfCommits.push(commit); },
  onPick: (pick) => { window.__pfPicks.push(pick.token); },
});
