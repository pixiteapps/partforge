import { expect, test, vi } from "vitest";
import opentype from "opentype.js";
import { handle, FONT_SOURCE_CACHE_MAX } from "../src/framework/jobs.js";
import { fontsFor, resolveFonts } from "../src/framework/fonts.js";

// Two distinguishable synthetic fonts: same glyph, different advance width, so
// a stale registration is visible in the parsed font's own metrics.
function synthFont(advance) {
  const p = new opentype.Path();
  p.moveTo(50, 0); p.lineTo(50, 700); p.lineTo(650, 700); p.lineTo(650, 0); p.close();
  const notdef = new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: advance, path: new opentype.Path() });
  const H = new opentype.Glyph({ name: "H", unicode: 72, advanceWidth: advance, path: p });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H] });
  font.kerningPairs = {};
  return font.toArrayBuffer();
}

const job = { type: "generate", subparts: [], view: "iso", params: {} };

test("a second part reusing a font NAME with different bytes wins", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700), b = synthFont(300);

  await handle(kernel, { fonts: { face: a }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(700);

  await handle(kernel, { fonts: { face: b }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(300);
});

test("the same source is parsed once even across names and jobs", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700);
  const parseSpy = vi.spyOn(opentype, "parse");
  await handle(kernel, { fonts: { face: a }, parts: {}, defaults: {} }, job, () => {});
  const after = parseSpy.mock.calls.length;
  const parsed = kernel._fonts.get("face");
  await handle(kernel, { fonts: { other: a }, parts: {}, defaults: {} }, job, () => {});
  expect(parseSpy.mock.calls.length).toBe(after);        // same bytes → memo hit
  expect(kernel._fonts.get("other")).toBe(parsed);       // same parsed object…
  // …read from BEFORE the second job: "face" is no longer declared, so it is
  // pruned (see the cleared-pick test below) rather than left pointing at a
  // font this part never asked for.
  expect(kernel._fonts.has("face")).toBe(false);
  parseSpy.mockRestore();
});

test("fontsFor calls the function form with resolved params", () => {
  const part = { defaults: { face: "A" }, fonts: (p) => ({ face: p.face }) };
  expect(fontsFor(part, { face: "B" })).toEqual({ face: "B" });
});

test("fontsFor passes a static object through untouched", () => {
  const decl = { face: "A" };
  expect(fontsFor({ fonts: decl }, {})).toBe(decl);
  expect(fontsFor({}, {})).toBeUndefined();
});

test("resolveFonts refuses a function — it has no params to call it with", async () => {
  await expect(resolveFonts(() => ({}))).rejects.toThrow(/fontsFor/);
});

test("handle resolves a function-form fonts against the job's params", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700), b = synthFont(300);
  const part = {
    defaults: { face: "a" },
    fonts: (p) => ({ face: p.face === "b" ? b : a }),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { face: "a" } }, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(700);
  await handle(kernel, part, { ...job, params: { face: "b" } }, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(300);
});

test("a throwing derive() errors before any font is fetched", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const fontsSpy = vi.fn(() => ({}));
  const part = { defaults: {}, derive: () => { throw new Error("boom"); }, fonts: fontsSpy, parts: {} };
  const posts = [];
  await handle(kernel, part, job, (m) => posts.push(m));
  const err = posts.find((m) => m.type === "error");
  expect(err).toBeTruthy();
  expect(fontsSpy).not.toHaveBeenCalled();
  // Two different bugs both satisfy "posted an error and never called
  // fontsSpy": a correctly-reordered resolveParams-throws-first (what we want
  // to prove), or an unreordered jobs.js still handing the raw function to
  // resolveFonts, which throws its own guard error before ever calling
  // fontsSpy. Pin the message to tell them apart.
  expect(err.message).toContain("boom");        // derive threw first…
  expect(err.message).not.toMatch(/fontsFor/);  // …not the resolveFonts guard
});

// ── the cleared-pick regression (the §5 bug, one step narrower) ─────────────
// The doc's own snippet is `fonts: (p) => ({ face: p.face })` with an
// unconditional k.text2d(s, { font: "face" }). Pick a face, then CLEAR the
// picker: the declaration now supplies nothing for that name, so the name must
// go too. Leave it and the build silently keeps rendering the previous face
// while the panel says there is none — a kernel outlives many jobs.
test("clearing a picked font drops the name instead of leaving the old face registered", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font" }] }],
    defaults: { face: "" },
    fonts: (p) => ({ face: p.face }),
    parts: {},
  };
  const url = "https://cdn.example.test/cleared-pick.ttf";
  const a = synthFont(700);
  const g = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => a });
  try {
    await handle(kernel, part, { ...job, params: { face: url } }, () => {});
    expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(700);   // picked
    await handle(kernel, part, { ...job, params: { face: "" } }, () => {});      // cleared
  } finally { globalThis.fetch = g; }
  expect(kernel._fonts.has("face"), "a cleared pick must not stay registered").toBe(false);
});

// The prune is scoped to parts that DECLARE fonts. A part with no `fonts` field
// never owned kernel._fonts, and a host or test harness may have seeded it
// directly (bootManifoldKernel({ fonts })) — pruning there would delete a font
// this part never claimed to manage.
test("a part with no `fonts` field leaves a host-seeded kernel._fonts alone", async () => {
  const seeded = { marker: true };
  const kernel = { _fonts: new Map([["heading", seeded]]), cleanup() {} };
  await handle(kernel, { parts: {}, defaults: {} }, job, () => {});
  expect(kernel._fonts.get("heading")).toBe(seeded);
});

// A part that declares OTHER names still prunes the ones it no longer supplies,
// and keeps the ones it does.
test("a renamed font declaration prunes only the name it dropped", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700), b = synthFont(300);
  await handle(kernel, { fonts: { one: a, two: b }, parts: {}, defaults: {} }, job, () => {});
  expect([...kernel._fonts.keys()].sort()).toEqual(["one", "two"]);
  await handle(kernel, { fonts: { two: b }, parts: {}, defaults: {} }, job, () => {});
  expect([...kernel._fonts.keys()]).toEqual(["two"]);
});

// The parse memo's key. Bytes and source agree TODAY only because fonts.js's
// memo is unbounded and returns the identical ArrayBuffer every time; key on the
// bytes and the memo degrades to per-fetch identity the day that gains eviction,
// with nothing failing. Spec §5 specifies the source.
test("the parse memo is keyed on the source, not on the resolved bytes", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const url = "https://cdn.example.test/source-keyed.ttf";
  const a = synthFont(700);
  const g = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => a });
  try {
    await handle(kernel, { fonts: { face: url }, parts: {}, defaults: {} }, job, () => {});
  } finally { globalThis.fetch = g; }
  expect([...kernel._fontsBySource.keys()]).toEqual([url]);
});

// Spec 2026-10-01 §3: auditioning fonts must not grow the worker's memory with N.
async function buildWith(kernel, url, fetchStub) {
  const g = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    await handle(kernel, { fonts: { face: url }, parts: {}, defaults: {} }, job, () => {});
  } finally { globalThis.fetch = g; }
}

test("the parsed-font cache keeps at most FONT_SOURCE_CACHE_MAX sources, newest kept", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const bytes = synthFont(700);
  const stub = async () => ({ ok: true, arrayBuffer: async () => bytes });
  let lastUrl;
  for (let i = 0; i < FONT_SOURCE_CACHE_MAX + 2; i++) {
    lastUrl = `https://cdn.example.test/lru-${i}.ttf`;
    await buildWith(kernel, lastUrl, stub);
  }
  expect(kernel._fontsBySource.size).toBe(FONT_SOURCE_CACHE_MAX);
  expect([...kernel._fontsBySource.keys()].at(-1)).toBe(lastUrl);
});

test("a source already parsed is not fetched again on the next build", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const bytes = synthFont(700);
  const stub = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
  const url = "https://cdn.example.test/parsed-once.ttf";
  await buildWith(kernel, url, stub);
  await buildWith(kernel, url, stub);
  expect(stub).toHaveBeenCalledTimes(1);
});

test("a parsed source's raw bytes are released from the resolver", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const bytes = synthFont(700);
  const stub = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
  const url = "https://cdn.example.test/released.ttf";
  await buildWith(kernel, url, stub);
  expect(stub).toHaveBeenCalledTimes(1);
  const g = globalThis.fetch;
  globalThis.fetch = stub;
  try { await resolveFonts({ x: url }); } finally { globalThis.fetch = g; }
  expect(stub).toHaveBeenCalledTimes(2);
});
