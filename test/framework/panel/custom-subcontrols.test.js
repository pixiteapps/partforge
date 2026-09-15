// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const root = () => { document.body.innerHTML = '<div id="root"></div>'; return document.getElementById("root"); };

test("host.controls mounts a built-in slider bound inside the owned value; edits commit the owning key", () => {
  const r = root();
  const params = { tiles: [{ q: 0, height: 10 }, { q: 1, height: 14 }] };
  let dirty = 0; const commits = [];
  let host;
  buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; } }] }],
    params, () => dirty++, (keys) => commits.push(keys));
  const box = document.createElement("div");
  host.el.append(box);
  const stop = host.controls(box, [{ key: "height", label: "Height", min: 0, max: 30, step: 1 }], { path: "1" });
  expect(box.querySelector(".section .sec-header")).toBeNull();      // bare: no header
  expect(box.querySelector(".row label").textContent).toBe("Height");
  const slider = box.querySelector('input[type="range"]');
  expect(slider.value).toBe("14");
  slider.value = "20"; slider.dispatchEvent(new Event("input"));
  expect(params.tiles[1].height).toBe(20);
  expect(params.tiles[0].height).toBe(10);
  expect(dirty).toBeGreaterThan(0);
  expect(commits).toEqual([]);
  slider.dispatchEvent(new Event("change"));
  expect(commits).toEqual([["tiles"]]);
  stop();
  expect(box.querySelector('input[type="range"]')).toBeNull();
});

test("`when` inside a sub-panel evaluates against the scoped values", () => {
  const r = root();
  const params = { tiles: [{ kind: "flat", height: 3 }] };
  let host;
  buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; } }] }], params, () => {});
  const box = document.createElement("div");
  host.controls(box, [
    { key: "kind", type: "radio", options: ["flat", "tall"] },
    { key: "height", label: "H", min: 0, max: 30, step: 1, when: { kind: "tall" } },
  ], { path: "0" });
  const heightWrap = box.querySelector('input[type="range"]').closest(".slider");
  expect(heightWrap.classList.contains("hidden")).toBe(true);
  box.querySelectorAll(".seg button")[1].click();
  expect(params.tiles[0].kind).toBe("tall");
  expect(heightWrap.classList.contains("hidden")).toBe(false);
});

test("a sub-control write that pushes the owned value past the JSON cap is refused, not thrown", () => {
  const r = root();
  const params = { tiles: { note: "x".repeat(16300) } };
  let host;
  const panel = buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", label: "Tiles", widget: (h) => { host = h; } }] }],
    params, () => {});
  const box = document.createElement("div");
  host.el.append(box);
  host.controls(box, [{ key: "note", type: "text", label: "Note" }], { path: "" });
  const field = box.querySelector(".text-input");
  field.value = "x".repeat(17000);
  expect(() => field.dispatchEvent(new Event("input"))).not.toThrow();
  expect(params.tiles).toEqual({ note: "x".repeat(16300) });    // the edit is refused; unchanged
  expect(panel.errors()).toEqual([expect.objectContaining({ phase: "event" })]);
  expect(panel.errors()[0].message).toMatch(/bytes serialized/);
});

test("a bare sub-panel's body gets no section id — nothing to point aria-controls at", () => {
  const r = root();
  const params = { tiles: [{ h: 1 }] };
  let host;
  buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; } }] }], params, () => {});
  const box = document.createElement("div");
  host.el.append(box);
  host.controls(box, [{ key: "h", label: "H", min: 0, max: 9, step: 1 }], { path: "0" });
  expect(document.querySelectorAll('[id^="pf-sec-"]')).toHaveLength(1);   // only the outer section's
});

test("a custom control inside host.controls is dropped and reported; sub-panels die with the widget", () => {
  const r = root();
  const params = { tiles: [{ h: 1 }] };
  let host;
  const panel = buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", label: "Tiles", widget: (h) => { host = h; } }] }], params, () => {});
  const box = document.createElement("div");
  host.el.append(box);
  host.controls(box, [
    { key: "h", label: "H", min: 0, max: 9, step: 1 },
    { key: "inner", type: "custom", widget: () => {} },
  ], { path: "0" });
  expect(box.querySelectorAll('input[type="range"]')).toHaveLength(1);
  expect(box.querySelector(".pf-custom")).toBeNull();
  expect(panel.errors()).toEqual([{ key: "tiles", label: "Tiles", phase: "create", message: 'custom control "inner" cannot be nested inside "tiles"' }]);
  panel.dispose();
  expect(box.querySelector('input[type="range"]')).toBeNull();
});
