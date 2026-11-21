// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { makeNumeric } from "../../../src/framework/panel/widgets/numeric.js";
import { createUnitsState } from "../../../src/framework/units.js";

const lengthNode = () => ({ id: "0/0", key: "w", type: "slider", label: "Width", unit: "mm", min: 10, max: 50, step: 0.5 });

function setup({ node = lengthNode(), units = createUnitsState("in"), value = 12.5 } = {}) {
  const params = { [node.key]: value };
  const calls = { change: 0, commit: 0 };
  const widget = makeNumeric(node, params, {
    onChange: () => { calls.change += 1; },
    onCommit: () => { calls.commit += 1; },
    units,
  });
  const box = widget.el.querySelector("input.num");
  const slider = widget.el.querySelector('input[type="range"]');
  const unit = widget.el.querySelector(".unit");
  return { params, calls, widget, box, slider, unit, units };
}

const fire = (input, type, value) => {
  if (value !== undefined) input.value = value;
  input.dispatchEvent(new Event(type));
};

describe("numeric widget in inches", () => {
  it("shows in as the unit, 0.492 in a decimal text box", () => {
    const { box, unit } = setup();
    expect(unit.textContent).toBe("in");
    expect(box.value).toBe("0.492");
    expect(box.type).toBe("text");
    expect(box.inputMode).toBe("decimal");
    expect(box.hasAttribute("step")).toBe(false);
  });

  it("leaves the slider's min, max and step in millimetres", () => {
    const { slider } = setup();
    expect(slider.min).toBe("10");
    expect(slider.max).toBe("50");
    expect(slider.step).toBe("0.5");
  });

  it("typing 3/4 then change sets 19.05 mm and commits once", () => {
    const { box, params, calls } = setup();
    fire(box, "input", "3/4");
    fire(box, "change");
    expect(params.w).toBe(19.05);
    expect(calls.commit).toBe(1);
  });

  it("a change with the text untouched writes nothing and calls neither callback", () => {
    const { box, params, calls } = setup();
    fire(box, "change");
    expect(params.w).toBe(12.5);
    expect(calls).toEqual({ change: 0, commit: 0 });
  });

  it("unparseable typing leaves params alone and change reverts the box", () => {
    const { box, params } = setup();
    fire(box, "input", "3/");
    expect(params.w).toBe(12.5);
    fire(box, "input", "abc");
    expect(params.w).toBe(12.5);
    fire(box, "change");
    expect(params.w).toBe(12.5);
    expect(box.value).toBe("0.492");
  });

  it("typing 3 (76.2 mm) paints the box as out of range", () => {
    const { box, params } = setup();
    fire(box, "input", "3");
    expect(params.w).toBe(76.2);
    expect(box.classList.contains("warn")).toBe(true);
  });

  it("a slider input to 20 sets 20 mm and shows 0.787", () => {
    const { slider, box, params } = setup();
    fire(slider, "input", "20");
    expect(params.w).toBe(20);
    expect(box.value).toBe("0.787");
  });

  it("a drag interrupted by a unit switch still commits exactly once", () => {
    const { slider, box, widget, calls, units } = setup();
    fire(slider, "input", "20");
    units.set("mm");
    widget.sync();
    fire(slider, "change");
    expect(calls.commit).toBe(1);
    expect(box.value).toBe("20");
  });

  it("switching back to mm and syncing restores the number box and fires nothing", () => {
    const { box, widget, calls, units, unit } = setup();
    units.set("mm");
    widget.sync();
    expect(calls).toEqual({ change: 0, commit: 0 });
    expect(box.type).toBe("number");
    expect(box.value).toBe("12.5");
    expect(box.getAttribute("step")).toBe("0.5");
    expect(unit.textContent).toBe("mm");
  });

  it("a ° node in inch mode keeps its unit, number box and value text", () => {
    const node = { id: "0/0", key: "a", type: "slider", label: "Angle", unit: "°", min: 0, max: 90, step: 1 };
    const { box, unit } = setup({ node, value: 45 });
    expect(unit.textContent).toBe("°");
    expect(box.type).toBe("number");
    expect(box.value).toBe("45");
  });

  it("with no units option the widget matches today's output", () => {
    const node = lengthNode();
    const plain = makeNumeric(node, { w: 12.5 }, {});
    const box = plain.el.querySelector("input.num");
    expect(box.type).toBe("number");
    expect(box.value).toBe("12.5");
    expect(box.getAttribute("step")).toBe("0.5");
    expect(box.hasAttribute("inputmode")).toBe(false);
    expect(plain.el.querySelector(".unit").textContent).toBe("mm");
    const mm = makeNumeric(lengthNode(), { w: 12.5 }, { units: createUnitsState("mm") });
    expect(mm.el.outerHTML).toBe(plain.el.outerHTML);
  });
});

describe("numeric widget in inches: typing back to the shown text", () => {
  it("restores the shown millimetres and commits the edit", () => {
    const { box, params, calls } = setup();
    fire(box, "input", "1");
    expect(params.w).toBe(25.4);
    fire(box, "input", "0.492");
    fire(box, "change", "0.492");
    expect(params.w).toBe(12.5);
    expect(calls.commit).toBe(1);
  });
});
