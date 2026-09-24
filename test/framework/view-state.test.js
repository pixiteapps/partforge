// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { loadProjection, saveProjection } from "../../src/framework/view-state.js";

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
