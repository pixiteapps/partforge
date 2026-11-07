import { describe, it, expect } from "vitest";
import { validatePresentation } from "../src/framework/mount-preview.js";

describe("mountPreview presentation options", () => {
  it("accepts the three render modes and rejects anything else", () => {
    expect(validatePresentation({ renderMode: "cel" }).renderMode).toBe("cel");
    expect(validatePresentation({}).renderMode).toBeNull();
    expect(() => validatePresentation({ renderMode: "celshaded" })).toThrow(TypeError);
  });
  it("allows a transparent background and contactShadow with cel (cel ignores contactShadow)", () => {
    const o = validatePresentation({ renderMode: "cel", background: "transparent", contactShadow: true });
    expect(o.transparent).toBe(true); expect(o.contactShadow).toBe(true);
  });
});
