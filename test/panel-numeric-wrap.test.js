// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { reduceWrapped, sameTurn } from "../src/framework/panel/widgets/numeric.js";

describe("reduceWrapped", () => {
  test("reduces into [min, max)", () => {
    expect(reduceWrapped(720, 0, 360)).toBe(0);
    expect(reduceWrapped(-10, 0, 360)).toBe(350);
    expect(reduceWrapped(725, 0, 360)).toBe(5);
    expect(reduceWrapped(360, 0, 360)).toBe(0);
    expect(reduceWrapped(-170, -180, 180)).toBe(-170);
    expect(reduceWrapped(190, -180, 180)).toBe(-170);
  });
});

describe("sameTurn", () => {
  test("picks the turn nearest the stored value", () => {
    expect(sameTurn(725, 10, 0, 360)).toBe(730);
    expect(sameTurn(725, 350, 0, 360)).toBe(710);
    expect(sameTurn(5, 5, 0, 360)).toBe(5);
    expect(sameTurn(-725, 350, 0, 360)).toBe(-730);
  });
});

describe("wrapped slider widget", () => {
  test("shows the reduced value and writes the same turn", async () => {
    const { makeNumeric } = await import("../src/framework/panel/widgets/numeric.js");
    const node = { type: "slider", key: "a", label: "A", min: 0, max: 360, step: 1, wrap: true };
    const params = { a: 725 };
    const w = makeNumeric(node, params, { onChange() {}, onCommit() {} });
    const slider = w.el.querySelector("input[type=range]");
    const box = w.el.querySelector("input.num");
    expect(+slider.value).toBe(5);
    expect(box.value).toBe("725");
    slider.value = "10";
    slider.dispatchEvent(new Event("input"));
    expect(params.a).toBe(730);
    expect(box.classList.contains("warn")).toBe(false);
  });
});
