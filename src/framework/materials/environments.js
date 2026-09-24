// src/framework/materials/environments.js
// Environment records — plain data like presets.js. `hdr` and the ground textures
// are FILE NAMES under ./assets/, resolved to URLs by assets.js (which is the only
// module that may use `new URL(..., import.meta.url)`, so this one stays importable
// by lint and the worker).
//
// ground.sizeMm is the smallest the ground disc ever gets (and the shadow's
// starting size); ground.tileMm, when set, is how many millimetres one repeat of
// the ground texture covers — defaulting to sizeMm. rotationDeg, when set, turns
// the environment (lighting and backdrop together) about the vertical axis.
// ground.roughnessTexture and ground.normalTexture are optional data maps
// (normal maps OpenGL-format, +Y up) tiled the same way as the colour map;
// ground.roughness (default 1) scales the roughness map.

export const DEFAULT_ENVIRONMENT_ID = "studio";

export const ENVIRONMENTS = {
  studio: {
    id: "studio", label: "Studio", exposure: 0.8,
    hdr: "env-studio.jpg",
    ground: { texture: "ground-paper.jpg", sizeMm: 400, tileMm: 200, tint: 0xf2f2f2 },
    // Turns the studio photo so its two octagonal softboxes glow behind the part
    // from the viewer's default camera, the classic product-shot backdrop.
    rotationDeg: 300,
    blurriness: 0.3,
  },
  workshop: {
    id: "workshop", label: "Workshop", exposure: 0.88,
    hdr: "env-workshop.jpg",
    // Unfinished maple: Poly Haven "Oak Veneer 01" lightened and desaturated
    // at bake time, with its normal map at a gentle strength and NO roughness
    // map — a flat, fully matte roughness, so the floor never shows a glossy
    // spot. Tiled at 600 mm (finer grain than the 1.83 m scan, as maple is).
    ground: {
      texture: "ground-maple-color.jpg", normalTexture: "ground-maple-normal.jpg",
      sizeMm: 600, tileMm: 600, roughness: 0.92, normalScale: 0.8, tint: 0xffffff,
    },
  },
  "print-bed": {
    id: "print-bed", label: "Print bed", exposure: 0.8,
    hdr: "env-print-bed.jpg",
    ground: { texture: "ground-pei.jpg", roughnessTexture: "ground-pei-rough.jpg", sizeMm: 256, tint: 0xffffff },
  },
  outdoor: {
    id: "outdoor", label: "Outdoor", exposure: 0.72,
    hdr: "env-outdoor.jpg",
    // Tinted to a warm mid-grey: the overcast sky lights an untinted concrete
    // map near-white and blue.
    ground: { texture: "ground-concrete.jpg", roughnessTexture: "ground-concrete-rough.jpg", sizeMm: 800, tint: 0x9e9282 },
  },
};
