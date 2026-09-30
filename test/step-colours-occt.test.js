// STEP export colours: every body in a .step file carries its sub-part's display
// colour, and a body with none gets the viewer's neutral drafting colour — never
// replicad's default red. Read back from the STEP text itself, body by body, since
// a colour that lands on the wrong body is as wrong as red. OCCT boots alone.
import { beforeAll, describe, expect, it } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";
import { PRESETS } from "../src/framework/materials/presets.js";
import { NO_MATERIAL_COLOR } from "../src/framework/materials/resolve.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

// `#12 = FOO(...);` → Map(12 → "FOO(...)"), whitespace collapsed (OCCT wraps long
// entities across lines).
function stepEntities(text) {
  const data = text.slice(text.indexOf("DATA;"));
  const out = new Map();
  for (const m of data.matchAll(/#(\d+)\s*=\s*([\s\S]*?);\s*(?=#\d+\s*=|ENDSEC)/g)) {
    out.set(Number(m[1]), m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}
const refs = (body) => [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
const typeOf = (body) => body.match(/^\(?\s*([A-Z0-9_]+)/)?.[1];

// OCCT writes the eight pure colours as named entities rather than COLOUR_RGB.
const PREDEFINED = {
  red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00,
  magenta: 0xff00ff, cyan: 0x00ffff, black: 0x000000, white: 0xffffff,
};

// First entity of one of `types` reachable by following references down from `start`.
function findDown(ents, start, types) {
  const seen = new Set();
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const body = ents.get(id);
    if (!body) continue;
    if (types.includes(typeOf(body))) return body;
    queue.push(...refs(body));
  }
  return null;
}

function colourValue(body) {
  if (typeOf(body) === "DRAUGHTING_PRE_DEFINED_COLOUR") return PREDEFINED[body.match(/'([^']*)'/)[1]];
  const [r, g, b] = body.match(/COLOUR_RGB\s*\(\s*'[^']*'\s*,(.*)\)/)[1].split(",").map(Number);
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

// { productName: [0xRRGGBB, …] } — every STYLED_ITEM traced to the product whose
// shape representation holds the styled solid, and to the colour its style names.
function coloursByProduct(text) {
  const ents = stepEntities(text);
  const out = {};
  for (const body of ents.values()) {
    if (typeOf(body) !== "STYLED_ITEM") continue;
    const ids = refs(body);
    const item = ids.at(-1);
    const colour = findDown(ents, ids.slice(0, -1), ["COLOUR_RGB", "DRAUGHTING_PRE_DEFINED_COLOUR"]);
    const repId = [...ents].find(([, b]) => /SHAPE_REPRESENTATION$/.test(typeOf(b)) && refs(b).includes(item))?.[0];
    const sdr = [...ents.values()].find((b) => typeOf(b) === "SHAPE_DEFINITION_REPRESENTATION" && refs(b)[1] === repId);
    const product = sdr && findDown(ents, [refs(sdr)[0]], ["PRODUCT"]);
    const name = product?.match(/'([^']*)'/)?.[1] ?? `?item#${item}`;
    (out[name] ??= []).push(colour ? colourValue(colour) : null);
  }
  return out;
}

// The two spellings of the old default: OCCT folds pure red into the named entity.
const RED = /DRAUGHTING_PRE_DEFINED_COLOUR\s*\(\s*'red'\s*\)|COLOUR_RGB\s*\(\s*'[^']*'\s*,\s*1\.?0*\s*,\s*0\.?0*\s*,\s*0\.?0*\s*\)/;

const decode = (ab) => new TextDecoder().decode(new Uint8Array(ab));

describe("toSTEP colours", () => {
  it("writes each body in its own colour", async () => {
    const text = decode(await k.toSTEP([
      { name: "a", solid: k.box({ size: [10, 10, 10] }), color: 0x3366cc },
      { name: "b", solid: k.box({ size: [5, 5, 5] }).translate([20, 0, 0]), color: 0xb5a642 },
      // Near-black sits on the sRGB curve's linear segment — the other branch of
      // the gamma conversion a colour now makes on its way into the file.
      { name: "c", solid: k.box({ size: [4, 4, 4] }).translate([40, 0, 0]), color: 0x0a0a0a },
    ]));
    expect(coloursByProduct(text)).toEqual({ a: [0x3366cc], b: [0xb5a642], c: [0x0a0a0a] });
    expect(text).not.toMatch(RED);
  });

  it("a body with no colour is the viewer's neutral drafting colour, not red", async () => {
    const text = decode(await k.toSTEP([
      { name: "bare", solid: k.box({ size: [10, 10, 10] }) },
      { name: "nulled", solid: k.box({ size: [5, 5, 5] }).translate([20, 0, 0]), color: null },
    ]));
    expect(coloursByProduct(text)).toEqual({ bare: [NO_MATERIAL_COLOR], nulled: [NO_MATERIAL_COLOR] });
    expect(text).not.toMatch(RED);
  });

  it("a deliberately red body is still red", async () => {
    const text = decode(await k.toSTEP([{ name: "r", solid: k.box({ size: [10, 10, 10] }), color: 0xff0000 }]));
    expect(coloursByProduct(text)).toEqual({ r: [0xff0000] });
  });
});

describe("export-step job colours", () => {
  const part = {
    meta: { title: "Colours" },
    defaults: {},
    parts: {
      tinted: { label: "Tinted", views: ["all"], display: { color: 0x2e7d32 },
        build: (kk) => kk.box({ size: [10, 10, 10] }) },
      brass: { label: "Brass", views: ["all"], display: { material: "brass" }, export: { name: "bushing" },
        build: (kk) => kk.box({ size: [8, 8, 8] }).translate([20, 0, 0]) },
      plain: { label: "Plain", views: ["all"],
        build: (kk) => kk.box({ size: [6, 6, 6] }).translate([40, 0, 0]) },
    },
    views: { all: { label: "All" } },
  };

  it("colours every body from its sub-part's display block", async () => {
    const posts = [];
    await handle(k, part, { type: "export-step", view: "all", params: {}, jobId: 1 }, (m) => posts.push(m));
    const dl = posts.find((m) => m.type === "download");
    expect(dl, JSON.stringify(posts.find((m) => m.type === "error"))).toBeTruthy();
    const text = decode(dl.data);
    expect(coloursByProduct(text)).toEqual({
      tinted: [0x2e7d32],
      bushing: [PRESETS.brass.color],
      plain: [NO_MATERIAL_COLOR],
    });
    expect(text).not.toMatch(RED);
  });
});
