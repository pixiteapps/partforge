import { expect, test } from "vitest";
import { resolveSpotKeys, faceKeysOf } from "../src/framework/selection/spot-keys.js";

test("face keys win, undrawable keys drop before the cap, more reflects what was cut", () => {
  const r = resolveSpotKeys({ faceKeys: ["y", "x", "d", "w"], pieceKeys: ["d", "w", "x", "y", "z"], drawable: new Set(["y", "d", "w", "z"]) });
  expect(r).toEqual({ keys: ["y", "d", "w"], source: "face", more: true });
});
test("piece fallback keeps the panel's order; nothing left hides the region", () => {
  expect(resolveSpotKeys({ faceKeys: null, pieceKeys: ["a", "b"], drawable: new Set(["a", "b"]) })).toEqual({ keys: ["a", "b"], source: "piece", more: false });
  expect(resolveSpotKeys({ faceKeys: ["a"], pieceKeys: ["a"], drawable: new Set() })).toEqual({ keys: [], source: null, more: false });
});
test("faceKeysOf refuses a section cap, a missing hit and an unknown origin", () => {
  const origins = { originIds: new Uint16Array([0, 1]), origins: [["w"]] };
  expect(faceKeysOf(origins, { triIndex: 1 })).toEqual(["w"]);
  expect(faceKeysOf(origins, { triIndex: 1, onCutPlane: true })).toBeNull();
  expect(faceKeysOf(origins, { triIndex: 0 })).toBeNull();
  expect(faceKeysOf(null, { triIndex: 1 })).toBeNull();
});
