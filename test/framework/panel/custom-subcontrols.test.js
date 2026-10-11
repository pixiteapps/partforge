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

// Feedback #172 (partforge-cloud): the documented widget pattern rebuilds its
// sub-panel on every update(), and a derived update lands after every build —
// including the builds a slider drag or a number box keystroke triggers. The
// rebuild tore the input the user was editing out of the DOM before its
// `change` fired; Chromium dispatches `change` on detach, WebKit does not, so
// on Safari the edit was applied to the viewer and never committed.
test("a derived update is held while a sub-control gesture is in flight and delivered on commit", () => {
  const r = root();
  const params = { tiles: [{ height: 10 }] };
  const commits = [];
  let host; let draws = 0; let stop = null;
  const draw = () => {
    draws += 1;
    stop?.();
    stop = host.controls(host.el, [{ key: "height", label: "Height", min: 0, max: 30, step: 1 }], { path: "0" });
  };
  const panel = buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; draw(); return { update: draw }; } }] }],
    params, () => {}, (keys) => commits.push(keys));
  expect(draws).toBe(1);
  const slider = host.el.querySelector('input[type="range"]');
  slider.value = "20"; slider.dispatchEvent(new Event("input"));
  expect(params.tiles[0].height).toBe(20);
  panel.refresh({ derived: { n: 1 } });                   // the build the drag triggered
  expect(draws).toBe(1);                                  // held: the slider under the pointer survives
  expect(slider.isConnected).toBe(true);
  expect(host.derived).toEqual({ n: 1 });                 // but the derived value is already readable
  slider.dispatchEvent(new Event("change"));              // the gesture ends
  expect(commits).toEqual([["tiles"]]);
  expect(draws).toBe(2);                                  // the held update is delivered once, after the commit
  expect(host.el.querySelector('input[type="range"]').value).toBe("20");
  panel.refresh({ derived: { n: 1 } });                   // unchanged derived: still no update
  expect(draws).toBe(2);
});

test("a derived update with no gesture in flight is delivered at once, as before", () => {
  const r = root();
  const params = { tiles: [{ height: 10 }] };
  let host; let draws = 0; let stop = null;
  const draw = () => { draws += 1; stop?.(); stop = host.controls(host.el, [{ key: "height", min: 0, max: 30, step: 1 }], { path: "0" }); };
  const panel = buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; draw(); return { update: draw }; } }] }], params, () => {});
  panel.refresh({ derived: { n: 1 } });
  expect(draws).toBe(2);
});

test("disposing a sub-panel commits a slider edited but not yet committed, and nothing otherwise", () => {
  const r = root();
  const params = { tiles: [{ height: 10 }] };
  const commits = [];
  let host;
  buildControls(r, [{ id: "s", controls: [{ key: "tiles", type: "custom", widget: (h) => { host = h; } }] }], params, () => {}, (keys) => commits.push(keys));
  const box = document.createElement("div");
  host.el.append(box);
  let stop = host.controls(box, [{ key: "height", min: 0, max: 30, step: 1 }], { path: "0" });
  stop();
  expect(commits).toEqual([]);                            // nothing edited: nothing committed
  stop = host.controls(box, [{ key: "height", min: 0, max: 30, step: 1 }], { path: "0" });
  const slider = box.querySelector('input[type="range"]');
  slider.value = "22"; slider.dispatchEvent(new Event("input"));
  stop();                                                 // torn down mid-gesture (a sync, a remount)
  expect(commits).toEqual([["tiles"]]);
  expect(params.tiles[0].height).toBe(22);
});
