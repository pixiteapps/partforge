// src/framework/materials/environments.js
// Environment records — plain data like presets.js. `hdr` and the ground textures
// are FILE NAMES under ./assets/, resolved to URLs by assets.js (which is the only
// module that may use `new URL(..., import.meta.url)`, so this one stays importable
// by lint and the worker).

export const DEFAULT_ENVIRONMENT_ID = "studio";

export const ENVIRONMENTS = {
  studio: {
    id: "studio", label: "Studio", exposure: 0.8,
    hdr: "env-studio.jpg",
    ground: { texture: "ground-paper.jpg", sizeMm: 400, tint: 0xf2f2f2 },
    backdrop: "gradient", gradient: [0xf4f5f7, 0xc9ccd1],
  },
  workshop: {
    id: "workshop", label: "Workshop", exposure: 0.88,
    hdr: "env-workshop.jpg",
    ground: { texture: "ground-oak.jpg", roughnessTexture: "ground-oak-rough.jpg", sizeMm: 600, tint: 0xffffff },
    backdrop: "blurred",
  },
  "print-bed": {
    id: "print-bed", label: "Print bed", exposure: 1.0,
    hdr: "env-print-bed.jpg",
    ground: { texture: "ground-pei.jpg", roughnessTexture: "ground-pei-rough.jpg", sizeMm: 256, tint: 0xffffff },
    backdrop: "blurred",
  },
  outdoor: {
    id: "outdoor", label: "Outdoor", exposure: 0.9,
    hdr: "env-outdoor.jpg",
    // Tinted to a warm mid-grey: the overcast sky lights an untinted concrete
    // map near-white and blue.
    ground: { texture: "ground-concrete.jpg", roughnessTexture: "ground-concrete-rough.jpg", sizeMm: 800, tint: 0x9e9282 },
    backdrop: "blurred",
  },
};
