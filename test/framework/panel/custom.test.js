// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const root = () => { document.body.innerHTML = '<div id="root"></div>'; return document.getElementById("root"); };
const sec = (control, extra = []) => [{ id: "s", title: "S", controls: [control, ...extra] }];

test("the widget draws into host.el and the slot is registered like any control", () => {
  const r = root();
  const params = { tiles: [{ q: 0, h: 10 }], od: 8 };
  const widget = vi.fn((host) => { host.el.append(host.h("div", { class: "drawn" }, "hi")); });
  buildControls(r, sec({ key: "tiles", type: "custom", label: "Tiles", widget, when: { od: { gt: 10 } } }), params, () => {});
  expect(widget).toHaveBeenCalledTimes(1);
  const wrap = r.querySelector(".pf-custom");
  expect(wrap.querySelector(".pf-custom-slot .drawn").textContent).toBe("hi");
  expect(wrap.querySelector(".row label").textContent).toBe("Tiles");
  expect(wrap.classList.contains("hidden")).toBe(true);   // `when` applies to the wrapper
});

test("host.get clones; host.set stores a clone, marks dirty and commits the owning key", () => {
  const r = root();
  const params = { tiles: [{ q: 0, h: 10 }] };
  let dirty = 0; const commits = [];
  let host;
  buildControls(r, sec({ key: "tiles", type: "custom", widget: (h) => { host = h; } }), params, () => dirty++, (keys) => commits.push(keys));
  const got = host.get();
  expect(got).toEqual(params.tiles);
  expect(got).not.toBe(params.tiles);
  got[0].h = 99;
  expect(params.tiles[0].h).toBe(10);                     // the clone is the widget's, not the panel's
  const next = [{ q: 0, h: 12 }];
  host.set(next);
  expect(params.tiles).toEqual(next);
  expect(params.tiles).not.toBe(next);
  expect(dirty).toBe(1);
  expect(commits).toEqual([["tiles"]]);
});

test("commit: false defers; host.commit fires once for what changed and is a no-op otherwise", () => {
  const r = root();
  const params = { tiles: [], n: 1 };
  const commits = [];
  let host;
  buildControls(r, sec({ key: "tiles", type: "custom", keys: ["n"], widget: (h) => { host = h; } }), params, () => {}, (keys) => commits.push(keys));
  host.set([{ q: 1 }], { commit: false });
  host.set(2, { key: "n", commit: false });
  expect(commits).toEqual([]);
  host.commit(["tiles", "n"]);
  expect(commits).toEqual([["tiles", "n"]]);
  host.commit();
  expect(commits).toEqual([["tiles", "n"]]);              // nothing pending: no second commit
});

test("host.set refuses keys the control does not own and values outside the contract", () => {
  const r = root();
  const params = { tiles: [], n: 1, other: 3 };
  let host;
  buildControls(r, sec({ key: "tiles", type: "custom", keys: ["n"], widget: (h) => { host = h; } }), params, () => {});
  expect(() => host.set(1, { key: "other" })).toThrow(/may not write "other"/);
  expect(() => host.set(null)).toThrow(/is null/);
  expect(() => host.set({ f() {} })).toThrow(/is a function/);
  expect(() => host.set([1], { key: "n" })).toThrow(/finite number, string or boolean/);
  expect(params).toEqual({ tiles: [], n: 1, other: 3 });
});

test("an external change syncs the widget; a derived change updates it; its own set does not", () => {
  const r = root();
  const params = { tiles: [] };
  const update = vi.fn();
  let host;
  const panel = buildControls(r, sec({ key: "tiles", type: "custom", widget: (h) => { host = h; return { update }; } }), params, () => {});
  host.set([{ q: 1 }]);
  expect(update).not.toHaveBeenCalled();
  params.tiles = [{ q: 2 }];
  panel.syncValues(["tiles"]);
  expect(update).toHaveBeenLastCalledWith({ reason: "sync", disabled: false });
  panel.refresh({ derived: { count: 1 } });
  expect(host.derived).toEqual({ count: 1 });
  expect(update).toHaveBeenLastCalledWith({ reason: "derived", disabled: false });
  panel.refresh({ derived: { count: 1 } });               // unchanged: no update
  expect(update).toHaveBeenCalledTimes(2);
});

test("a widget that throws on create gets an error card, is recorded, and leaves its siblings alive", () => {
  const r = root();
  const params = { tiles: [], od: 8 };
  const errors = [];
  const panel = buildControls(r, sec(
    { key: "tiles", type: "custom", label: "Tiles", widget: () => { throw new Error("boom"); } },
    [{ key: "od", label: "OD", min: 0, max: 20, step: 1 }],
  ), params, () => {}, undefined, { onPanelError: (e) => errors.push(e) });
  const card = r.querySelector(".pf-custom-error");
  expect(card.textContent).toContain("Tiles");
  expect(card.textContent).toContain("boom");
  expect(r.querySelector('input[type="range"]')).not.toBeNull();
  expect(panel.errors()).toEqual([{ key: "tiles", label: "Tiles", phase: "create", message: "boom" }]);
  expect(errors).toEqual(panel.errors());
});

test("a listener installed through host.h that throws retires the widget with phase event", () => {
  const r = root();
  const params = { tiles: [] };
  const update = vi.fn();
  const panel = buildControls(r, sec({ key: "tiles", type: "custom", label: "Tiles", widget: (h) => {
    h.el.append(h.h("button", { onclick: () => { throw new Error("click boom"); } }, "go"));
    return { update };
  } }), params, () => {});
  r.querySelector(".pf-custom-slot button").click();
  expect(panel.errors()[0]).toMatchObject({ phase: "event", message: "click boom" });
  expect(r.querySelector(".pf-custom-error")).not.toBeNull();
  panel.syncValues(["tiles"]);
  expect(update).not.toHaveBeenCalled();                  // retired: no more calls into widget code
});

test("host.h builds SVG in the SVG namespace, passes class/style through, and flattens children", () => {
  const r = root();
  let host;
  buildControls(r, sec({ key: "t", type: "custom", widget: (h) => { host = h; } }), { t: [] }, () => {});
  const svg = host.h("svg", { viewBox: "0 0 10 10", width: "100%", class: "pic" }, [
    host.h("polygon", { points: "0,0 1,1 2,0", class: "pf-hit selected", "data-i": 0 }),
    null, "text",
  ]);
  expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(svg.getAttribute("class")).toBe("pic");
  expect(svg.firstElementChild.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(svg.firstElementChild.getAttribute("data-i")).toBe("0");
  expect(svg.textContent).toBe("text");
  const div = host.h("div", { hidden: true, title: false });
  expect(div.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  expect(div.hasAttribute("hidden")).toBe(true);
  expect(div.hasAttribute("title")).toBe(false);
});

test("host.svg parses an svg string and refuses anything else; host.svgFromVector renders a document", () => {
  const r = root();
  let host;
  buildControls(r, sec({ key: "t", type: "custom", widget: (h) => { host = h; } }), { t: [] }, () => {});
  const el = host.svg('<svg viewBox="0 0 4 4"><rect id="w1" width="2" height="2"/></svg>');
  expect(el.tagName.toLowerCase()).toBe("svg");
  expect(el.querySelector("#w1")).not.toBeNull();
  expect(host.svg("<div>no</div>")).toBeNull();
  expect(host.svg(42)).toBeNull();
  const doc = { units: "mm", shapes: { a: { role: "add", regions: [{ outer: { kind: "polygon", points: [[0, 0], [10, 0], [10, 10]] }, holes: [] }] } } };
  expect(host.svgFromVector(doc)?.tagName.toLowerCase()).toBe("svg");
  expect(host.svgFromVector({})).toBeNull();
});

test("host.file reads the part's own files by path or pfc-tree token, else null", () => {
  const r = root();
  let host;
  const files = { "part.js": "export default {}", "assets/a.svg": "<svg/>" };
  buildControls(r, sec({ key: "t", type: "custom", widget: (h) => { host = h; } }), { t: [] }, () => {}, undefined, { files });
  expect(host.file("assets/a.svg")).toBe("<svg/>");
  expect(host.file("./assets/a.svg")).toBe("<svg/>");
  expect(host.file("pfc-tree://assets/a.svg?v=abc123")).toBe("<svg/>");
  expect(host.file("missing.svg")).toBeNull();
  expect(host.file(3)).toBeNull();
  let noFiles;
  buildControls(root(), sec({ key: "t", type: "custom", widget: (h) => { noFiles = h; } }), { t: [] }, () => {});
  expect(noFiles.file("part.js")).toBeNull();
});

test("panel state restores into host.state, fires update(restore), and reads back through getState", () => {
  const r = root();
  const update = vi.fn();
  let host;
  const panel = buildControls(r, sec({ key: "tiles", type: "custom", widget: (h) => { host = h; return { update }; } }), { tiles: [] }, () => {}, undefined,
    { panelState: { tiles: { selected: 3 }, other: { x: 1 } } });
  expect(host.state).toEqual({ selected: 3 });
  expect(update).toHaveBeenCalledWith({ reason: "restore", disabled: false });
  host.setState({ hover: 1 });
  expect(panel.getState()).toEqual({ tiles: { selected: 3, hover: 1 } });
  expect(panel.getState().tiles).not.toBe(host.state);   // a clone
});

test("getState skips empty state, drops oversize state with a recorded error", () => {
  const r = root();
  let a, b;
  const panel = buildControls(r, [{ id: "s", controls: [
    { key: "a", type: "custom", label: "A", widget: (h) => { a = h; } },
    { key: "b", type: "custom", label: "B", widget: (h) => { b = h; } },
  ] }], { a: [], b: [] }, () => {});
  expect(panel.getState()).toEqual({});
  a.setState({ big: "x".repeat(70000) });
  b.setState({ ok: true });
  expect(panel.getState()).toEqual({ b: { ok: true } });
  expect(panel.errors()).toEqual([{ key: "a", label: "A", phase: "state", message: expect.stringMatching(/exceeds the 65536-byte budget/) }]);
});

test("dispose calls the widget's dispose once and records a throw without propagating", () => {
  const r = root();
  const dispose = vi.fn(() => { throw new Error("bye"); });
  const panel = buildControls(r, sec({ key: "t", type: "custom", label: "T", widget: () => ({ dispose }) }), { t: [] }, () => {});
  expect(() => panel.dispose()).not.toThrow();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(panel.errors()).toEqual([{ key: "t", label: "T", phase: "dispose", message: "bye" }]);
});

test("a widget that is not a function is a create error, not a crash", () => {
  const r = root();
  const panel = buildControls(r, sec({ key: "t", type: "custom", label: "T", widget: "nope" }), { t: [] }, () => {});
  expect(panel.errors()[0]).toMatchObject({ phase: "create", message: expect.stringMatching(/widget/) });
});
