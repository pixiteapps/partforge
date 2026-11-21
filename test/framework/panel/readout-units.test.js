// @vitest-environment happy-dom
// The read-only readout widget follows the display unit: a "mm" readout shows inches in
// inch mode and re-renders its last value on a switch; any other unit is unchanged.
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";
import { makeReadout } from "../../../src/framework/panel/widgets/readout.js";
import { createUnitsState } from "../../../src/framework/units.js";

test("a mm readout renders in the display unit and sync() re-renders after a switch", () => {
  const units = createUnitsState("in");
  const r = makeReadout({ label: "Length", derivedKey: "len", unit: "mm" }, { units });
  const val = r.el.querySelector(".val");
  expect(val.textContent).toBe("—");
  r.update({ len: 184 });
  expect(val.textContent).toBe("7.244 in");
  units.set("mm");
  r.sync();
  expect(val.textContent).toBe("184 mm");
  units.set("in");
  r.sync();
  expect(val.textContent).toBe("7.244 in");
});

test("a ° readout, or no units state, is unchanged", () => {
  const units = createUnitsState("in");
  const deg = makeReadout({ label: "Tilt", derivedKey: "t", unit: "°" }, { units });
  deg.update({ t: 12.5 });
  expect(deg.el.querySelector(".val").textContent).toBe("12.5 °");
  const plain = makeReadout({ label: "Length", derivedKey: "len", unit: "mm" }, {});
  plain.update({ len: 184 });
  expect(plain.el.querySelector(".val").textContent).toBe("184 mm");
  expect(() => plain.sync()).not.toThrow();
});

test("buildControls: a units switch re-renders a readout", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const units = createUnitsState("mm");
  const panel = buildControls(root, [{ id: "s", controls: [
    { key: "od", type: "slider", min: 1, max: 200, step: 1 },
    { type: "readout", label: "Length", derivedKey: "len", unit: "mm" },
  ] }], { od: 10 }, () => {}, undefined, { units });
  const val = root.querySelector(".readout .val");
  panel.refresh({ derived: { len: 184 } });
  expect(val.textContent).toBe("184 mm");
  units.set("in");
  expect(val.textContent).toBe("7.244 in");
  panel.dispose();
});
