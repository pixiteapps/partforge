// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";
import { createUnitsState } from "../../../src/framework/units.js";

// The legacy feature check/reveal path (controls.js on main, buildFeatureSection):
// ticking a feature's checkbox writes `on` into params AND re-syncs the sliders
// it reveals, so they display the just-written value rather than a stale one.
// min is 0 (not 1) so the "off" value of 0 is in-range: a real <input
// type="range"> clamps `.value` to `min` on assignment, and a min above the
// off-state would make the "starts at 0" baseline below fail for reasons
// unrelated to what this test actually covers (the reveal re-sync).
const featureSec = () => ({ id: "f", title: "Flange", features: [
  { label: "Flange", key: "flange_d", on: 16,
    sliders: [{ key: "flange_d", label: "D", min: 0, max: 50, step: 1 }] },
] });

test("ticking a feature checkbox reveals its group with freshly synced sliders", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  let dirty = 0;
  const params = { flange_d: 0 };
  buildControls(root, [featureSec()], params, () => dirty++);

  const box = root.querySelector('input[type="checkbox"]');
  const group = root.querySelector(".feat-group");
  const slider = root.querySelector('input[type="range"]');
  expect(group.classList.contains("hidden")).toBe(true);  // off to start
  expect(slider.value).toBe("0");

  box.checked = true; box.dispatchEvent(new Event("change"));
  expect(params.flange_d).toBe(16);
  expect(group.classList.contains("hidden")).toBe(false);
  expect(slider.value).toBe("16");                        // re-synced on reveal, not stale
  expect(dirty).toBe(1);
});

test("unticking writes 0 and hides the group; re-ticking restores `on`", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { flange_d: 16 };
  buildControls(root, [featureSec()], params, () => {});

  const box = root.querySelector('input[type="checkbox"]');
  const group = root.querySelector(".feat-group");
  expect(box.checked).toBe(true);
  expect(group.classList.contains("hidden")).toBe(false);

  box.checked = false; box.dispatchEvent(new Event("change"));
  expect(params.flange_d).toBe(0);
  expect(group.classList.contains("hidden")).toBe(true);

  box.checked = true; box.dispatchEvent(new Event("change"));
  expect(params.flange_d).toBe(16);
  expect(root.querySelector('input[type="range"]').value).toBe("16");
});

test("the Advanced fold's toggle keeps aria-expanded in sync with clicks", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }], { od: 5 }, () => {});
  const toggle = root.querySelector(".adv-toggle");
  const body = root.querySelector(".adv");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");   // 1 section → auto-open
  toggle.click();
  expect(body.classList.contains("hidden")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

const twoPickerSec = () => ({ id: "body", title: "Body", controls: [
  { type: "preset", presets: { Small: { od: 3 }, Large: { od: 9 } } },
  { key: "od", type: "slider", label: "OD", min: 1, max: 10, step: 1 },
  { type: "preset", presets: { Tall: { h: 20 } } },
  { key: "h", type: "slider", label: "H", min: 1, max: 30, step: 1 },
] });

test("a section renders every preset node, in authored order, among the controls", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [twoPickerSec()], { od: 5, h: 10 }, () => {});
  const kids = [...root.querySelectorAll(".sec-body > *")];
  const kinds = kids.map((el) => el.matches("select.preset") ? "preset" : "control");
  expect(kinds).toEqual(["preset", "control", "preset", "control"]);
});

test("applying a preset from the second picker syncs its keys and self-Customs nothing", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 5, h: 10 };
  buildControls(root, [twoPickerSec()], params, () => {});
  const [first, second] = root.querySelectorAll("select.preset");
  second.value = "Tall";
  second.dispatchEvent(new Event("change"));
  expect(params.h).toBe(20);
  expect([...root.querySelectorAll('input[type="range"]')][1].value).toBe("20");
  expect(second.value).toBe("Tall");           // no self-Custom
  expect(first.value).toBe("Small");           // other pickers untouched
});

test("editing any control drops the FIRST picker to Custom (first-picker-wins)", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 5, h: 10 };
  buildControls(root, [twoPickerSec()], params, () => {});
  const [first, second] = root.querySelectorAll("select.preset");
  const box = root.querySelector("input.num");
  box.value = "7"; box.dispatchEvent(new Event("input"));
  expect(first.value).toBe("Custom");
  expect(second.value).toBe("Tall");   // other pickers untouched (first-picker-wins)
});

test("disclosure buttons carry aria-controls naming their body element", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }], { od: 5 }, () => {});
  const secBtn = root.querySelector("button.sec-title");
  const secBody = root.querySelector(".sec-body");
  expect(secBody.id).toBeTruthy();
  expect(secBtn.getAttribute("aria-controls")).toBe(secBody.id);
  const advBtn = root.querySelector(".adv-toggle");
  const advBody = root.querySelector(".adv");
  expect(advBody.id).toBeTruthy();
  expect(advBtn.getAttribute("aria-controls")).toBe(advBody.id);
});

test("a condition-hidden control and section carry .hidden, and a disabled preset select gets the attribute", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { mode: 0, od: 5 };
  const panel = buildControls(root, [
    { id: "a", title: "A", controls: [
      { key: "mode", type: "checkbox", label: "Mode" },
      { key: "od", type: "slider", label: "OD", min: 1, max: 10, step: 1, when: { mode: { gt: 0 } } },
      { type: "preset", presets: { P: { od: 5 } }, when: { mode: { gt: 0 } }, whenFalse: "disable" },
      { key: "shape", type: "radio", label: "Shape", options: ["round", "square"],
        description: "Tick Mode first.", when: { mode: { gt: 0 } }, whenFalse: "disable" },
    ] },
    { id: "b", title: "B", when: { mode: { gt: 0 } }, controls: [
      { key: "od2", type: "slider", min: 1, max: 10, step: 1 },
    ] },
  ], { ...params, od2: 3, shape: "round" }, () => {});
  const odWrap = [...root.querySelectorAll(".slider")].find((w) => w.querySelector("label")?.textContent === "OD");
  expect(odWrap.classList.contains("hidden")).toBe(true);
  const sections = [...root.querySelectorAll(".section")];
  expect(sections[1].classList.contains("hidden")).toBe(true);
  const preset = root.querySelector("select.preset");
  expect(preset.classList.contains("disabled")).toBe(true);
  expect(preset.disabled).toBe(true);                       // the ATTRIBUTE, not just the class
  // A radio's options are <button>s, not inputs — they need the attribute too,
  // or the control only LOOKS disabled and stays keyboard-focusable.
  const segButtons = [...root.querySelectorAll(".seg button")];
  expect(segButtons.length).toBe(2);
  expect(segButtons.every((b) => b.disabled)).toBe(true);
  // ...but the ⓘ glyph on that same disabled control stays reachable — its
  // popover is where the author says what has to be enabled first.
  expect(root.querySelector(".seg").closest(".slider").querySelector("button.info").disabled).toBe(false);
  const box = root.querySelector('input[type="checkbox"]');
  box.checked = true; box.dispatchEvent(new Event("change"));   // the file's established idiom
  expect(odWrap.classList.contains("hidden")).toBe(false);
  expect(preset.disabled).toBe(false);
  expect(segButtons.some((b) => b.disabled)).toBe(false);
  panel.dispose();
});

test("only: draws the named controls in schema order and nothing else", () => {
  const parameters = [{ id: "c", title: "Cabinet", controls: [
    { key: "width", label: "Width", type: "slider", min: 1, max: 10 }, { key: "depth", label: "Depth", type: "slider", min: 1, max: 10 }, { key: "height", label: "Height", type: "slider", min: 1, max: 10 }] }];
  const root = document.createElement("div");
  const panel = buildControls(root, parameters, { width: 2, depth: 3, height: 4 }, () => {}, () => {}, { bare: true, only: new Set(["height", "width"]) });
  expect([...root.querySelectorAll("input[type=range]")].map((i) => i.closest(".slider").querySelector("label").textContent)).toEqual(["Width", "Height"]);
  expect(root.querySelector(".sec-header")).toBeNull();
  panel.dispose();
});

test("only: a control inside a titled group is drawn bare — no group header, no fold", () => {
  const parameters = [{ id: "c", title: "Cabinet", controls: [
    { key: "width", label: "Width", type: "slider", min: 1, max: 10 },
    { type: "group", title: "Advanced", controls: [{ key: "lip", label: "Lip", type: "slider", min: 0, max: 5 }] }] }];
  const root = document.createElement("div");
  const panel = buildControls(root, parameters, { width: 2, lip: 1 }, () => {}, () => {}, { bare: true, only: new Set(["lip"]) });
  expect([...root.querySelectorAll("input[type=range]")].map((i) => i.closest(".slider").querySelector("label").textContent)).toEqual(["Lip"]);
  expect(root.querySelector(".adv-header")).toBeNull();
  expect(root.querySelector(".adv-wrap")).toBeNull();
  expect(root.querySelector(".feat-group")).not.toBeNull();
  panel.dispose();
});

// --- display units: the mm/in switch ------------------------------------------
const lengthSec = () => [{ id: "u", title: "Size", controls: [
  { key: "w", label: "Width", type: "slider", unit: "mm", min: 10, max: 50, step: 0.5 }] }];

test("units: the switch renders once, first, for a tree with an mm control", () => {
  const root = document.createElement("div");
  const units = createUnitsState("mm");
  const panel = buildControls(root, lengthSec(), { w: 12.5 }, () => {}, () => {}, { units, unitsSwitch: true });
  const switches = root.querySelectorAll(".pf-units");
  expect(switches).toHaveLength(1);
  expect(root.firstElementChild).toBe(switches[0]);
  expect(switches[0].getAttribute("role")).toBe("group");
  expect(switches[0].getAttribute("aria-label")).toBe("Units");
  const buttons = [...switches[0].querySelectorAll("button")];
  expect(buttons.map((b) => [b.type, b.dataset.units, b.textContent, b.getAttribute("aria-pressed")]))
    .toEqual([["button", "mm", "mm", "true"], ["button", "in", "in", "false"]]);
  panel.dispose();
});

test("units: a host slot in the rail takes the switch, and dispose empties and re-hides it", () => {
  const rail = document.createElement("div");
  rail.className = "pf-rail";
  const root = document.createElement("div");
  const slot = document.createElement("div");
  slot.setAttribute("data-pf-units-slot", "");
  slot.hidden = true;
  rail.append(root, slot);
  const units = createUnitsState("mm");
  const panel = buildControls(root, lengthSec(), { w: 12.5 }, () => {}, () => {}, { units, unitsSwitch: true });
  expect(root.querySelector(".pf-units")).toBeNull();
  expect(slot.hidden).toBe(false);
  expect(slot.querySelectorAll(".pf-units")).toHaveLength(1);
  slot.querySelector('[data-units="in"]').click();
  expect(units.get()).toBe("in");
  expect(root.querySelector("input.num").value).toBe("0.492");
  panel.dispose();
  expect(slot.hidden).toBe(true);
  expect(slot.childElementCount).toBe(0);
});

test("units: a slot stays hidden when the tree has nothing to convert", () => {
  const rail = document.createElement("div");
  rail.className = "pf-rail";
  const root = document.createElement("div");
  const slot = document.createElement("div");
  slot.setAttribute("data-pf-units-slot", "");
  slot.hidden = true;
  rail.append(root, slot);
  const parameters = [{ id: "a", controls: [{ key: "a", label: "Angle", type: "slider", unit: "°", min: 0, max: 90, step: 1 }] }];
  const panel = buildControls(root, parameters, { a: 45 }, () => {}, () => {}, { units: createUnitsState("mm"), unitsSwitch: true });
  expect(slot.hidden).toBe(true);
  expect(slot.childElementCount).toBe(0);
  panel.dispose();
});

test("units: a readout with an mm unit, nested in a group, also earns the switch", () => {
  const root = document.createElement("div");
  const parameters = [{ id: "u", title: "Size", controls: [
    { type: "group", title: "More", controls: [{ type: "readout", label: "Inner", derivedKey: "d", unit: "mm" }] }] }];
  const panel = buildControls(root, parameters, {}, () => {}, () => {}, { units: createUnitsState("mm"), unitsSwitch: true });
  expect(root.querySelectorAll(".pf-units")).toHaveLength(1);
  panel.dispose();
});

test("units: no switch for a tree of only ° controls", () => {
  const root = document.createElement("div");
  const parameters = [{ id: "a", controls: [{ key: "a", label: "Angle", type: "slider", unit: "°", min: 0, max: 90, step: 1 }] }];
  const panel = buildControls(root, parameters, { a: 45 }, () => {}, () => {}, { units: createUnitsState("mm"), unitsSwitch: true });
  expect(root.querySelector(".pf-units")).toBeNull();
  panel.dispose();
});

test("units: no switch without opts.units, and none without unitsSwitch", () => {
  const a = document.createElement("div");
  buildControls(a, lengthSec(), { w: 12.5 }, () => {}, () => {}, { unitsSwitch: true });
  expect(a.querySelector(".pf-units")).toBeNull();
  const b = document.createElement("div");
  buildControls(b, lengthSec(), { w: 12.5 }, () => {}, () => {}, { units: createUnitsState("mm") });
  expect(b.querySelector(".pf-units")).toBeNull();
});

test("units: clicking in sets the state, flips aria-pressed and re-syncs the box without a change", () => {
  const root = document.createElement("div");
  const units = createUnitsState("mm");
  let dirty = 0; const commits = [];
  const params = { w: 12.5 };
  const panel = buildControls(root, lengthSec(), params, () => dirty++, (k) => commits.push(k), { units, unitsSwitch: true });
  const box = root.querySelector("input.num");
  expect(box.value).toBe("12.5");
  root.querySelector('[data-units="in"]').click();
  expect(units.get()).toBe("in");
  expect(root.querySelector('[data-units="in"]').getAttribute("aria-pressed")).toBe("true");
  expect(root.querySelector('[data-units="mm"]').getAttribute("aria-pressed")).toBe("false");
  expect(box.value).toBe("0.492");
  expect(root.querySelector(".row .unit").textContent).toBe("in");
  expect(params.w).toBe(12.5);
  expect(dirty).toBe(0);
  expect(commits).toEqual([]);
  units.set("mm");                                     // an outside change follows too
  expect(box.value).toBe("12.5");
  expect(root.querySelector('[data-units="mm"]').getAttribute("aria-pressed")).toBe("true");
  panel.dispose();
  units.set("in");                                     // unsubscribed: the old box is not touched
  expect(box.value).toBe("12.5");
});

test("units: a nested sub-panel renders no second switch but follows the units", () => {
  const root = document.createElement("div");
  const units = createUnitsState("mm");
  let host;
  const params = { tiles: [{ w: 12.5 }] };
  const parameters = [{ id: "s", controls: [
    { key: "len", label: "Len", type: "slider", unit: "mm", min: 0, max: 10, step: 1 },
    { key: "tiles", type: "custom", widget: (h) => { host = h; } }] }];
  const panel = buildControls(root, parameters, { len: 1, ...params }, () => {}, () => {}, { units, unitsSwitch: true });
  host.controls(host.el, [{ key: "w", label: "W", type: "slider", unit: "mm", min: 10, max: 50, step: 0.5 }], { path: "0" });
  expect(root.querySelectorAll(".pf-units")).toHaveLength(1);
  const inner = host.el.querySelector("input.num");
  expect(inner.value).toBe("12.5");
  units.set("in");
  expect(inner.value).toBe("0.492");
  panel.dispose();
});
