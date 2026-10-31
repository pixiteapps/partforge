import { defineConfig } from "vite";

// partforge dev harness + showcase build. `npm run dev` serves the example pages at
// root; `npm run build` emits the landing gallery + all three demo pages for GitHub
// Pages under the repo subpath (/partforge/). The published package is plain ESM
// source — this config is only for developing/testing the framework and the showcase.
// Replicad ships OpenCASCADE as a large WASM module; keep Vite from pre-bundling it,
// and build workers as ES modules so they can import replicad.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/partforge/" : "/",
  optimizeDeps: {
    exclude: ["replicad", "replicad-opencascadejs"],
  },
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        spacer: "demo.html",
        filletedBox: "filleted-box.html",
        planter: "planter.html",
        facetedVase: "faceted-vase.html",
        nameplate: "nameplate.html",
        bracket: "bracket.html",
        hullSweep: "hull-sweep.html",
        hingedBox: "hinged-box.html",
        screw: "screw.html",
        emblem: "emblem.html",
        relief: "relief.html",
        robotArm: "robot-arm.html",
      },
    },
  },
}));
