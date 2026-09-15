import { expect, test } from "vitest";
import { desugar } from "../../../src/framework/panel/legacy.js";
import { authoredSection } from "../../../src/framework/panel/author.js";

test("a controls section normalizes controls, nested groups and presets in authored order", () => {
  const [sec] = desugar([{
    id: "body", title: "Body",
    controls: [
      { type: "preset", presets: { A: { od: 5 } } },
      { key: "profile", type: "select", label: "Profile",
        options: [{ value: "round", label: "Round" }, { value: "faceted", label: "Faceted" }] },
      { key: "od", type: "slider", label: "OD", min: 1, max: 10, step: 1 },
      { type: "group", title: "Wall", collapsed: true,
        controls: [{ key: "wall", type: "slider", min: 0.8, max: 4, step: 0.1 }] },
    ],
  }]);
  expect(sec).toMatchObject({ kind: "group", id: "body", title: "Body", collapsed: "auto" });
  expect(sec.children.map((c) => c.kind)).toEqual(["preset", "control", "control", "group"]);
  expect(sec.children[1]).toMatchObject({ key: "profile", type: "select", marksCustom: true });
  expect(sec.children[3]).toMatchObject({ kind: "group", title: "Wall", collapsed: true });
  expect(sec.children[3].children[0]).toMatchObject({ key: "wall", type: "slider" });
});

test("type defaults to slider; when/whenFalse/hidden are copied through", () => {
  const sec = authoredSection({ id: "s", controls: [
    { key: "a", min: 0, max: 1, step: 1, when: { mode: "x" }, whenFalse: "disable", hidden: true },
  ] });
  expect(sec.children[0]).toMatchObject({
    kind: "control", type: "slider", when: { mode: "x" }, whenFalse: "disable", hidden: true,
  });
});

test("groups nest recursively and carry when conditions", () => {
  const sec = authoredSection({ id: "s", controls: [
    { type: "group", title: "Outer", when: { on: { gt: 0 } }, controls: [
      { type: "group", title: "Inner", bare: true, controls: [{ key: "x", min: 0, max: 1, step: 1 }] },
    ] },
  ] });
  const outer = sec.children[0];
  expect(outer).toMatchObject({ kind: "group", when: { on: { gt: 0 } } });
  expect(outer.children[0]).toMatchObject({ kind: "group", bare: true });
  expect(outer.children[0].children[0].key).toBe("x");
});

test("an authored checkbox is preserveOn:false with on defaulting to 1", () => {
  const sec = authoredSection({ id: "s", controls: [
    { key: "show", type: "checkbox", label: "Show" },
    { key: "big", type: "checkbox", on: 16 },
  ] });
  expect(sec.children[0]).toMatchObject({ type: "checkbox", on: 1, preserveOn: false });
  expect(sec.children[1]).toMatchObject({ on: 16 });
});

test("every control in a controls section marks Custom — uniform rule", () => {
  const sec = authoredSection({ id: "s", controls: [
    { key: "a", min: 0, max: 1, step: 1 },
    { key: "b", type: "checkbox" },
    { type: "group", controls: [{ key: "c", min: 0, max: 1, step: 1 }] },
  ] });
  expect(sec.children[0].marksCustom).toBe(true);
  expect(sec.children[1].marksCustom).toBe(true);
  expect(sec.children[2].children[0].marksCustom).toBe(true);
});

test("an empty or missing presets object drops the preset entry", () => {
  const sec = authoredSection({ id: "s", controls: [
    { type: "preset", presets: {} },
    { type: "preset" },
    { key: "a", min: 0, max: 1, step: 1 },
  ] });
  expect(sec.children.map((c) => c.kind)).toEqual(["control"]);
});

test("null entries are skipped, never a throw — lint walks broken parts", () => {
  expect(() => authoredSection({ id: "s", controls: [null, { key: "a" }] })).not.toThrow();
  expect(authoredSection({ id: "s", controls: [null, { key: "a" }] }).children).toHaveLength(1);
});

test("desugar routes a controls section through authoredSection and ignores legacy arrays beside it", () => {
  const [sec] = desugar([{
    id: "m", controls: [{ key: "a", min: 0, max: 1, step: 1 }],
    advanced: [{ key: "z", min: 0, max: 1, step: 1 }],
    toggles: [{ key: "t" }], presets: { P: {} },
  }]);
  // mixed-section-shape (Task 5) errors on this; desugar must still survive it:
  // `controls` wins, the legacy arrays contribute nothing.
  expect(sec.children).toHaveLength(1);
  expect(sec.children[0]).toMatchObject({ kind: "control", key: "a" });
});

test("a legacy section is untouched by the new path", () => {
  const [sec] = desugar([{ id: "m", toggles: [{ key: "show", label: "S" }] }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["control"]); // exactly as 0.47.0
});

test("a readout entry becomes a display node, not a control", () => {
  const sec = authoredSection({ id: "s", controls: [
    { type: "readout", label: "Inner ø", derivedKey: "innerDia", unit: "mm" },
  ] });
  expect(sec.children[0]).toMatchObject({
    kind: "display", type: "readout", derivedKey: "innerDia", unit: "mm",
  });
  expect(sec.children[0].key).toBeUndefined();
});

test("a custom control keeps its widget function and keys list", () => {
  const widget = () => {};
  const [node] = authoredSection({ title: "T", controls: [
    { key: "tiles", type: "custom", label: "Tiles", widget, keys: ["tileSize"] },
  ] }).children;
  expect(node.kind).toBe("control");
  expect(node.type).toBe("custom");
  expect(node.widget).toBe(widget);
  expect(node.keys).toEqual(["tileSize"]);
});
