import { expect, test } from "vitest";
import { STYLES, styleFor, createThumbnailCache } from "../../src/framework/view-style-state.js";

test("styles are CAD first, then every environment in order", () => {
  expect(STYLES.map((s) => s.id)).toEqual(["cad", "studio", "workshop", "print-bed", "outdoor"]);
  expect(STYLES[0].label).toBe("CAD");
  expect(STYLES[3].label).toBe("Print bed");
});

test("the current style is cad in CAD and the environment in realistic", () => {
  expect(styleFor("cad", "workshop")).toBe("cad");
  expect(styleFor("realistic", "workshop")).toBe("workshop");
});

test("the thumbnail cache starts stale and a part change makes it stale again", () => {
  const c = createThumbnailCache();
  expect(c.isStale()).toBe(true);
  c.markFresh();
  c.set("cad", "data:x");
  expect(c.isStale()).toBe(false);
  expect(c.get("cad")).toBe("data:x");
  c.invalidate();
  expect(c.isStale()).toBe(true);
  expect(c.get("cad")).toBe("data:x"); // old image stays until replaced
});
