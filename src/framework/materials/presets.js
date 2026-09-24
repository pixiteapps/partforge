// src/framework/materials/presets.js
// The material library: plain data, deliberately three-free and DOM-free so lint,
// the worker's 3MF writer and the docs parity test can all read it (see
// test/lint-purity.test.js and test/worker-layering.test.js). The viewer turns a
// record into a three.js material in physical.js; nothing here knows about three.
//
// Metal base colours are measured reflectance (F0) from physicallybased.info,
// converted to sRGB. Adding a preset is one record here plus a look at the
// contact sheet (materials.html) in every environment.

export const DEFAULT_PRESET_ID = "default";

const P = (id, label, category, use, fields) => ({ id, label, category, use, tintable: false, ...fields });

export const PRESETS = {
  // The viewer's look before this library existed. Not documented as a choice:
  // it is what a sub-part with no `material` renders as.
  default: P("default", "Default", "default", "The viewer's neutral blue-grey, used when a sub-part names no material.",
    { color: 0x9fb4cc, metalness: 0.25, roughness: 0.55 }),

  "machined-aluminum": P("machined-aluminum", "Machined aluminium", "aluminium", "Bare CNC-milled aluminium, fine tool marks, satin sheen.",
    { color: 0xf5f6f6, metalness: 1, roughness: 0.32 }),
  "brushed-aluminum": P("brushed-aluminum", "Brushed aluminium", "aluminium", "Directionally brushed aluminium panels and enclosures.",
    { color: 0xf5f6f6, metalness: 1, roughness: 0.38, anisotropy: 0.7 }),
  "anodized-aluminum": P("anodized-aluminum", "Anodized aluminium", "aluminium", "Dyed anodized aluminium; tint with `color` (e.g. red, black, blue).",
    { color: 0xb9bcc0, metalness: 1, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.25, tintable: true }),
  "bead-blasted-aluminum": P("bead-blasted-aluminum", "Bead-blasted aluminium", "aluminium", "Matte, even-textured aluminium (laptop-shell finish).",
    { color: 0xe8e9ea, metalness: 1, roughness: 0.62 }),

  "brushed-stainless": P("brushed-stainless", "Brushed stainless steel", "steel", "Brushed 304 stainless: kitchen, marine and fastener hardware.",
    { color: 0xc4c5c6, metalness: 1, roughness: 0.34, anisotropy: 0.6 }),
  "polished-chrome": P("polished-chrome", "Polished chrome", "steel", "Mirror chrome plating; shows the environment strongly.",
    { color: 0xcacbcc, metalness: 1, roughness: 0.05 }),
  "black-oxide-steel": P("black-oxide-steel", "Black-oxide steel", "steel", "Blackened steel tooling and fasteners with a slight oily sheen.",
    { color: 0x2c2d30, metalness: 1, roughness: 0.45 }),
  "cast-iron": P("cast-iron", "Cast iron", "steel", "Raw sand-cast iron: dark, rough and matte.",
    { color: 0x6d6b69, metalness: 1, roughness: 0.78 }),
  titanium: P("titanium", "Titanium", "steel", "Bare titanium: slightly warm grey, satin.",
    { color: 0xc1bab1, metalness: 1, roughness: 0.35 }),

  brass: P("brass", "Brass", "warm-metal", "Yellow brass fittings and decorative hardware.",
    { color: 0xf8dc82, metalness: 1, roughness: 0.28 }),
  copper: P("copper", "Copper", "warm-metal", "Bare copper: busbars, heat sinks, decorative parts.",
    { color: 0xfad0c0, metalness: 1, roughness: 0.3 }),
  bronze: P("bronze", "Bronze", "warm-metal", "Cast bronze bushings and sculpture.",
    { color: 0xd9a86c, metalness: 1, roughness: 0.42 }),

  "powder-coat": P("powder-coat", "Powder coat", "coating", "Durable textured paint over metal; tint with `color`.",
    { color: 0x303236, metalness: 0, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.5, tintable: true }),
  "painted-metal": P("painted-metal", "Painted metal", "coating", "Glossy enamel or automotive-style paint; tint with `color`.",
    { color: 0xb3261e, metalness: 0, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08, tintable: true }),

  "pla-print": P("pla-print", "PLA print", "print", "FDM-printed PLA with visible layer lines; tint with `color`.",
    { color: 0xe8e4da, metalness: 0, roughness: 0.48, pattern: "layer-lines", textureScale: 0.2, tintable: true }),
  "petg-print": P("petg-print", "PETG print", "print", "FDM-printed PETG: glossier than PLA, visible layers; tint with `color`.",
    { color: 0x2d6cdf, metalness: 0, roughness: 0.3, pattern: "layer-lines", textureScale: 0.2, tintable: true }),
  "resin-print": P("resin-print", "Resin print", "print", "SLA/MSLA resin print: smooth, faintly waxy; tint with `color`.",
    { color: 0x8a8f96, metalness: 0, roughness: 0.35, clearcoat: 0.2, clearcoatRoughness: 0.3, tintable: true }),
  "nylon-sls": P("nylon-sls", "Nylon SLS", "print", "Powder-bed nylon: matte, grainy, usually white or dyed black.",
    { color: 0xf0eee8, metalness: 0, roughness: 0.85, pattern: "sls-grain", textureScale: 0.15, tintable: true }),

  "abs-plastic": P("abs-plastic", "ABS plastic", "plastic", "Injection-moulded ABS housings and knobs; tint with `color`.",
    { color: 0x1c1d20, metalness: 0, roughness: 0.42, tintable: true }),
  "clear-acrylic": P("clear-acrylic", "Clear acrylic", "plastic", "Transparent PMMA/polycarbonate windows and covers; tint for coloured acrylic.",
    { color: 0xffffff, metalness: 0, roughness: 0.04, transmission: 1, thickness: 3, ior: 1.49, tintable: true }),
  rubber: P("rubber", "Rubber", "plastic", "Matte elastomer: gaskets, feet, grips; tint with `color`.",
    { color: 0x1a1a1a, metalness: 0, roughness: 0.9, tintable: true }),

  oak: P("oak", "Oak", "natural", "Light oak with open grain.",
    { color: 0xb88a5a, metalness: 0, roughness: 0.6, pattern: "wood", textureScale: 80 }),
  walnut: P("walnut", "Walnut", "natural", "Dark oiled walnut.",
    { color: 0x5d3a24, metalness: 0, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, pattern: "wood", textureScale: 80 }),
  "carbon-fiber": P("carbon-fiber", "Carbon fibre", "natural", "2x2 twill carbon fibre under clear coat.",
    { color: 0x1b1c1e, metalness: 0.2, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05, pattern: "carbon", textureScale: 12 }),
};
