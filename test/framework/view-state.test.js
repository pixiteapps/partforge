// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { loadProjection, saveProjection, loadFeatureLinesPrefs, saveFeatureLinesPrefs, sanitizeFeatureLinesPrefs } from "../../src/framework/view-state.js";

beforeEach(() => localStorage.clear());

describe("projection persistence", () => {
  it("defaults to perspective, matching the viewer's own default", () => {
    expect(loadProjection()).toBe("perspective");
  });

  it("round-trips orthographic", () => {
    saveProjection("orthographic");
    expect(loadProjection()).toBe("orthographic");
  });

  it("ignores a value that is neither", () => {
    saveProjection("isometric");
    expect(loadProjection()).toBe("perspective");
  });
});

it("sanitizeFeatureLinesPrefs keeps known styles with boolean values only", () => {
  expect(sanitizeFeatureLinesPrefs({ cad: "false", moon: true, studio: true, outdoor: false })).toEqual({ studio: true, outdoor: false });
  expect(sanitizeFeatureLinesPrefs(null)).toEqual({});
  expect(sanitizeFeatureLinesPrefs([true])).toEqual({});
  expect(sanitizeFeatureLinesPrefs("cad")).toEqual({});
});

it("feature-lines prefs round-trip, dropping unknown styles and non-booleans", () => {
  saveFeatureLinesPrefs({ cad: false, studio: true });
  expect(loadFeatureLinesPrefs()).toEqual({ cad: false, studio: true });
  localStorage.setItem("partforge:featureLines", JSON.stringify({ moon: true, workshop: "yes", outdoor: true }));
  expect(loadFeatureLinesPrefs()).toEqual({ outdoor: true });
  localStorage.setItem("partforge:featureLines", "{not json");
  expect(loadFeatureLinesPrefs()).toEqual({});
});
