import { describe, it, expect } from "vitest";
import { detectFormat, resolveImports } from "../src/framework/imports.js";

const enc = (s) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("detects by extension from a URL", () => {
    expect(detectFormat(new URL("file:///a/scan.STEP"), null)).toBe("step");
    expect(detectFormat("https://x/y/part.stl?sig=abc", null)).toBe("stl");
    expect(detectFormat(new URL("file:///a/b.3mf"), null)).toBe("3mf");
  });
  it("falls back to magic bytes for byte sources", () => {
    expect(detectFormat(null, enc("ISO-10303-21;\nHEADER;"))).toBe("step");
    expect(detectFormat(null, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("3mf");
    expect(detectFormat(null, enc("solid cube\nfacet normal 0 0 1"))).toBe("stl");
    expect(detectFormat(null, new Uint8Array(100))).toBe("stl"); // binary STL default
  });
  it("throws on an unrecognizable empty source", () => {
    expect(() => detectFormat(null, new Uint8Array(0))).toThrow(/unrecognized import format/);
  });
});

describe("resolveImports", () => {
  it("resolves bytes and thunks, stamps digest + format", async () => {
    const stl = enc("solid t\nendsolid t\n");
    const m = await resolveImports({ a: stl, b: () => stl.slice() });
    expect(m.get("a").format).toBe("stl");
    expect(m.get("a").digest).toMatch(/^[0-9a-f]{64}$/);
    expect(m.get("a").digest).toBe(m.get("b").digest); // same content, same digest
  });
  it("memoizes by source identity", async () => {
    let calls = 0;
    const src = () => { calls++; return enc("solid m\nendsolid m\n"); };
    await resolveImports({ x: src });
    await resolveImports({ x: src });
    expect(calls).toBe(1);
  });
  it("returns an empty map for a missing decl", async () => {
    expect((await resolveImports(undefined)).size).toBe(0);
  });
  it("names the HTTP status when a URL source's fetch is not ok (e.g. an expired signed Storage URL)", async () => {
    const g = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden" });
    try {
      await expect(resolveImports({ a: "https://storage.example.com/scan.step?sig=expired" }))
        .rejects.toThrow(/403/);
    } finally { globalThis.fetch = g; }
  });
});

// Cloud feedback #148: a TTF declared as an import used to fall through to the
// STL fallback and fail as a truncated binary STL. It names the real mistake now.
it("detectFormat refuses a font file declared as an import, by extension or by bytes", () => {
  const ttf = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x01, 0x00]);
  expect(() => detectFormat("https://x/face.ttf", ttf)).toThrow(/declare it under `fonts`/);
  expect(() => detectFormat("pfc-tree://abc", ttf)).toThrow(/font file/);
  expect(() => detectFormat(null, new TextEncoder().encode("OTTO....")))
    .toThrow(/font file/);
  expect(detectFormat(null, new TextEncoder().encode("solid x\n"))).toBe("stl");
});
