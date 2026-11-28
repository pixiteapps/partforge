import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import robotArm from "./parts/robot-arm.js";
import hand from "./parts/hand.js";
import cageHand from "./parts/cage-hand.js";
import capstanJoint from "./parts/capstan-joint.js";
import { mount, mountPreview } from "./index.js";

// Dev/CI-only app for Pose mode on a cached preview (mountPreview's `part` option). It
// builds the part in an off-screen editor (mount), waits for its first build, encodes the
// view with runtime.exportPreview(), disposes the editor, and mounts the file into #app
// with the part module — so every drag below runs with no kernel and no worker.
// `?part=hand` swaps the robot arm for the hand, `?part=cage-hand` for the cage hand (whose
// file carries its ties, so a fingertip drag re-poses the body with no kernel), `?part=capstan-joint`
// for the capstan (its rope rides in the file and is re-solved as the drum turns). Hooks for scripts/check-pose.mjs:
// window.__pfPart (the part, for its defaults), window.__pfPreview (the preview handle),
// window.__pfWorkersAfterPreview (Worker constructions after the preview mount — must
// stay 0) and window.__pfDragEnds (every pose.onDragEnd payload).
const asked = new URLSearchParams(location.search).get("part");
const which = ["hand", "cage-hand", "capstan-joint"].includes(asked) ? asked : "robot-arm";
const part = which === "hand" ? hand : which === "cage-hand" ? cageHand : which === "capstan-joint" ? capstanJoint : robotArm;
window.__pfPart = part;
window.__pfDragEnds = [];

// The new Worker(new URL(...)) calls stay inline and literal, or Vite will not bundle them.
const createWorker = (name) => (which === "hand"
  ? new Worker(new URL("./hand-worker.js", import.meta.url), { type: "module", name })
  : which === "cage-hand"
    ? new Worker(new URL("./cage-hand-worker.js", import.meta.url), { type: "module", name })
    : which === "capstan-joint"
      ? new Worker(new URL("./capstan-joint-worker.js", import.meta.url), { type: "module", name })
      : new Worker(new URL("./robot-arm-worker.js", import.meta.url), { type: "module", name }));

async function start() {
  const editorEl = document.getElementById("editor");
  let built, failed;
  const firstBuild = new Promise((resolve, reject) => { built = resolve; failed = reject; });
  const runtime = mount(part, {
    createWorker,
    elements: {
      viewer: editorEl,
      controls: document.getElementById("editor-controls"),
      tabs: document.getElementById("editor-tabs"),
      status: {
        status: document.getElementById("editor-status"),
        busy: document.getElementById("editor-busy"),
        phase: document.getElementById("editor-phase"),
      },
      // a button of its own, so the editor never wires the preview's #theme
      chrome: { theme: document.createElement("button") },
    },
    onBuild: (build) => {
      if (build.status === "success") built();
      else failed(new Error(`the editor's build failed: ${build.error}`));
    },
  });
  await runtime.ready;
  await firstBuild;
  const glb = await runtime.exportPreview();
  runtime.dispose();
  editorEl.remove();

  // Count every Worker made from here on: the preview must make none.
  window.__pfWorkersAfterPreview = 0;
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(...args) { super(...args); window.__pfWorkersAfterPreview++; }
  };
  const preview = mountPreview(document.getElementById("app"), {
    glb, part, elements: { chrome: { theme: document.getElementById("theme") } },
  });
  preview.pose.onDragEnd((e) => { window.__pfDragEnds.push(e); });
  window.__pfPreview = preview;
}

start().catch((error) => {
  console.error("preview-pose:", error, ...(error?.errors ?? []));
  window.__pfPreviewError = String(error?.message ?? error);
});
