// resolveDefaultView is public as of 0.147.0: a host that builds a part headlessly
// (partforge-cloud's preview job) must open the same view mount() does, or the
// cached preview and the live build disagree and the swap visibly jumps.
import { expect, test } from "vitest";
import { resolveDefaultView as fromMain } from "../src/index.js";
import { resolveDefaultView as fromTesting } from "../src/testing.js";
import { resolveDefaultView } from "../src/framework/default-view.js";

const part = {
  defaults: {},
  views: { lid: { label: "Lid" }, assembly: { label: "Assembly" } },
  parts: {
    base: { views: ["assembly"], build: () => null },
    lid: { views: ["lid", "assembly"], build: () => null },
  },
};

test("both entries export the rule mount() itself uses", () => {
  expect(fromMain).toBe(resolveDefaultView);
  expect(fromTesting).toBe(resolveDefaultView);
});

test("it names the view placing the most sub-parts, unless one is flagged default", () => {
  expect(fromMain(part)).toBe("assembly");
  expect(fromTesting({ ...part, views: { ...part.views, lid: { label: "Lid", default: true } } })).toBe("lid");
  expect(fromMain({ parts: {} })).toBeNull();
});
