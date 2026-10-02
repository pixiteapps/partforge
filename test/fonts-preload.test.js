import { expect, test, vi } from "vitest";
import opentype from "opentype.js";
import { resolveFonts, forgetFontSource } from "../src/framework/fonts.js";
import { handle } from "../src/framework/jobs.js";

function synthFont() {
  const g = (name, unicode, adv, draw) => {
    const p = new opentype.Path(); draw(p);
    return new opentype.Glyph({ name, unicode, advanceWidth: adv, path: p });
  };
  const notdef = g(".notdef", 0, 650, () => {});
  // 'H' — sets cap height 700 (fallback path when os2.sCapHeight is absent)
  const H = g("H", 72, 700, (p) => { p.moveTo(50,0);p.lineTo(50,700);p.lineTo(150,700);p.lineTo(150,400);
    p.lineTo(550,400);p.lineTo(550,700);p.lineTo(650,700);p.lineTo(650,0);p.lineTo(550,0);p.lineTo(550,300);
    p.lineTo(150,300);p.lineTo(150,0);p.close(); });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H] });
  font.kerningPairs = {};
  return font;
}

test("resolveFonts normalizes bytes, thunks, and URLs to ArrayBuffers", async () => {
  const bytes = synthFont().toArrayBuffer();
  const g = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));   // stub URL fetch
  try {
    const map = await resolveFonts({
      a: bytes,                               // inline bytes
      b: () => Promise.resolve({ default: bytes }),   // dynamic-import shape
      c: "https://example.com/font.ttf",      // URL
    });
    expect(map.get("a").byteLength).toBe(bytes.byteLength);
    expect(map.get("b").byteLength).toBe(bytes.byteLength);
    expect(opentype.parse(map.get("c"))).toBeTruthy();   // fetched bytes parse
  } finally { globalThis.fetch = g; }
});

test("resolveFonts memoizes a repeated source (fetch once)", async () => {
  const bytes = synthFont().toArrayBuffer();
  const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
  globalThis.fetch = fetchMock;
  const url = "https://example.com/same.ttf";
  await resolveFonts({ x: url }); await resolveFonts({ y: url });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("resolveFonts handles a partial Uint8Array view (byteOffset > 0)", async () => {
  const bytes = new Uint8Array(synthFont().toArrayBuffer());
  const big = new Uint8Array(bytes.length + 100);   // pad so the view has byteOffset>0
  big.set(bytes, 50);
  const view = big.subarray(50, 50 + bytes.length);  // byteOffset 50, exact length
  const map = await resolveFonts({ f: view });
  expect(map.get("f").byteLength).toBe(bytes.length);           // exact range, not the padded buffer
  expect(opentype.parse(map.get("f"))).toBeTruthy();            // parses (not corrupted)
});

// Integration: the jobs.js `handle` preload — declared fonts land in kernel._fonts
// PARSED (before any build), and a second turn does not re-parse an already-present
// font. Uses a minimal fake kernel; the job errors out after preload (no real geometry),
// which is fine — we only assert the preload side effect on kernel._fonts.
test("handle preloads part.fonts into kernel._fonts (parsed, once)", async () => {
  const bytes = synthFont().toArrayBuffer();
  const parseSpy = vi.spyOn(opentype, "parse");
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = { fonts: { body: bytes }, parts: {}, defaults: {} };
  const msg = { type: "generate", subparts: [], view: "iso", params: {} };
  await handle(kernel, part, msg, () => {});
  expect(kernel._fonts.has("body")).toBe(true);
  expect(kernel._fonts.get("body").tables).toBeTruthy();       // a real parsed opentype.Font
  const afterFirst = parseSpy.mock.calls.length;
  await handle(kernel, part, msg, () => {});                   // second turn, same kernel
  expect(parseSpy.mock.calls.length).toBe(afterFirst);         // already present → not re-parsed
  parseSpy.mockRestore();
});

// A single unreadable font must fail as a NAMED, actionable error rather than an opaque
// opentype.js parse throw (a RangeError deep in the TrueType reader that names neither the
// font nor the fix). This is the dead end a variable font or a WOFF/WOFF2 upload lands in —
// opentype.js 2.x reads neither — and the reason a whole part "just won't build".
test("handle surfaces an unreadable font as a named, actionable error", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const badBytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4, 5, 6, 7, 8]).buffer; // 'wOF2'…, not a TTF/OTF
  const part = { fonts: { greatVibes: badBytes }, parts: {}, defaults: {} };
  const msg = { type: "generate", subparts: [], view: "iso", params: {} };
  const posts = [];
  await handle(kernel, part, msg, (m) => posts.push(m));
  const err = posts.find((m) => m.type === "error");
  expect(err).toBeTruthy();
  expect(err.message).toContain('"greatVibes"');               // names the offending font
  expect(err.message).toMatch(/TTF|OTF/);                      // says what to provide instead
  expect(kernel._fonts.has("greatVibes")).toBe(false);         // nothing half-registered
});

test("forgetFontSource drops the memo, so the next resolve fetches again", async () => {
  const url = "https://example.test/forget.ttf";
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  fetchSpy.mockClear(); // an earlier test leaves a vi.fn on globalThis.fetch; count only our calls
  try {
    await resolveFonts({ a: url });
    forgetFontSource(url);
    await resolveFonts({ a: url });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally { fetchSpy.mockRestore(); }
});
