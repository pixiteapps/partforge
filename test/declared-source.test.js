// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { declaredSourceLookup } from "../src/framework/panel/declared-source.js";

// A part keeps its bundled default in the `images`/`vectors` DECLARATION, not in
// the param — an author cannot put it in `defaults`, because the allow list only
// passes https and a bundled asset is a file:/dev URL. So the control opens empty
// while the part is in fact using an image. This resolves what the part is
// ACTUALLY using for a key, so the tile can show it.
describe("declaredSourceLookup", () => {
  const part = {
    images: (p) => ({ relief: p.relief || new URL("file:///repo/assets/d.png") }),
    vectors: (p) => ({ art: p.art || "https://cdn.test/a.vector.json", plate: "https://cdn.test/p.json" }),
  };

  test("resolves the declared source for a key whose param is empty", () => {
    const look = declaredSourceLookup(part, { relief: "", art: "" });
    expect(String(look("image", "relief"))).toBe("file:///repo/assets/d.png");
    expect(look("vector", "art")).toBe("https://cdn.test/a.vector.json");
  });

  test("returns nothing when the param already holds a value — the param wins", () => {
    const look = declaredSourceLookup(part, { relief: "https://cdn.test/own.png", art: "" });
    expect(look("image", "relief")).toBeUndefined();
  });

  test("returns nothing for a key the declaration does not mention", () => {
    expect(declaredSourceLookup(part, {})("image", "nope")).toBeUndefined();
  });

  test("a part with no declaration at all resolves to nothing, never throws", () => {
    expect(() => declaredSourceLookup({}, {})("image", "relief")).not.toThrow();
    expect(declaredSourceLookup({}, {})("image", "relief")).toBeUndefined();
  });

  test("a declaration function that throws is swallowed — a broken part must not kill the panel", () => {
    const bad = { images: () => { throw new Error("boom"); } };
    expect(() => declaredSourceLookup(bad, {})("image", "relief")).not.toThrow();
    expect(declaredSourceLookup(bad, {})("image", "relief")).toBeUndefined();
  });

  test("resolves a static (non-function) declaration too", () => {
    const look = declaredSourceLookup({ images: { relief: "https://cdn.test/s.png" } }, { relief: "" });
    expect(look("image", "relief")).toBe("https://cdn.test/s.png");
  });
});

describe("displayable URLs", () => {
  test("a URL instance and a string both become something an <img> can load", async () => {
    const { declaredImageUrl } = await import("../src/framework/panel/declared-source.js");
    expect(await declaredImageUrl(new URL("file:///a/b.png"))).toBe("file:///a/b.png");
    expect(await declaredImageUrl("https://cdn.test/x.png")).toBe("https://cdn.test/x.png");
  });

  test("a Vite thunk is called and unwrapped", async () => {
    const { declaredImageUrl } = await import("../src/framework/panel/declared-source.js");
    expect(await declaredImageUrl(() => Promise.resolve({ default: "https://cdn.test/t.png" })))
      .toBe("https://cdn.test/t.png");
  });

  test("a thunk that rejects yields nothing rather than propagating", async () => {
    const { declaredImageUrl } = await import("../src/framework/panel/declared-source.js");
    await expect(declaredImageUrl(() => Promise.reject(new Error("nope")))).resolves.toBeUndefined();
  });
});

describe("the control's key need not be the asset's name", () => {
  // emblem.js declares `vectors: (p) => ({ emblem: p.art || bundled })` — the
  // control's param key is `art`, the asset is named `emblem`. Assuming they
  // match works for relief.js (both "relief") and fails here, which is exactly
  // what the browser showed. The lint rules already solve this by probing the
  // declaration with a sentinel; the same trick finds the mapping.
  const part = {
    vectors: (p) => ({ emblem: p.art || "https://cdn.test/bundled.json", plate: "https://cdn.test/p.json" }),
  };

  test("finds the declared source through a renamed key", () => {
    expect(declaredSourceLookup(part, { art: "" })("vector", "art")).toBe("https://cdn.test/bundled.json");
  });

  test("does not mistake an unrelated asset for the control's own", () => {
    // `plate` is declared but no control feeds it, so a control keyed `nope`
    // must resolve to nothing rather than grabbing the first entry it sees.
    expect(declaredSourceLookup(part, { nope: "" })("vector", "nope")).toBeUndefined();
  });

  test("still works when key and asset name DO match", () => {
    const same = { images: (p) => ({ relief: p.relief || "https://cdn.test/r.png" }) };
    expect(declaredSourceLookup(same, { relief: "" })("image", "relief")).toBe("https://cdn.test/r.png");
  });
});

