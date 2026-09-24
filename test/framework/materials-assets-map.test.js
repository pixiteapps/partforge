// A minimal check on the assets.js name→URL map: every file name that
// environments.js or PATTERN_TEXTURES references resolves to a URL string
// ending in that file name, and an unknown name throws (the map has no
// silent fallback — a typo must fail a test, not a render).
import { expect, test } from "vitest";
import { ENVIRONMENTS } from "../../src/framework/materials/environments.js";
import { assetUrl, PATTERN_TEXTURES } from "../../src/framework/materials/assets.js";

const referencedNames = () => {
  const names = new Set(Object.values(PATTERN_TEXTURES));
  for (const env of Object.values(ENVIRONMENTS)) {
    names.add(env.hdr);
    names.add(env.ground.texture);
    if (env.ground.roughnessTexture) names.add(env.ground.roughnessTexture);
  }
  return [...names];
};

test("assetUrl resolves every referenced asset name to a URL ending in that name", () => {
  for (const name of referencedNames()) {
    const url = assetUrl(name);
    expect(typeof url, name).toBe("string");
    expect(url.endsWith(name), url).toBe(true);
  }
});

test("assetUrl throws on an unknown name", () => {
  expect(() => assetUrl("nope.jpg")).toThrow();
});
