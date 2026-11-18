import { describe, expect, test } from "vitest";
import hingedBox from "../src/parts/hinged-box.js";
import { listViewAnimations } from "../src/framework/view-catalog.js";
import * as main from "../src/index.js";
import * as oracle from "../src/oracle.js";

const box = (name) => ({ label: name, views: ["assembly", "print"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }) });
const twoViews = {
  meta: { title: "Two views" },
  defaults: { a: 0, b: 0 },
  parameters: [],
  parts: { base: { ...box("Base"), views: ["assembly"] }, lid: box("Lid"), clip: box("Clip") },
  views: {
    print: { label: "Print layout" }, // declared first, but assembly places more sub-parts
    assembly: {
      label: "Assembly",
      animations: {
        open: { label: "Open", duration: 1, tracks: { a: [[0, 0], [1, 1]] } },
        spin: { duration: 2, autoplay: true, tracks: { b: [[0, 0], [1, 360]] } },
      },
    },
    detail: {},
  },
};

describe("listViewAnimations", () => {
  test("listViewAnimations lists every view and animation in order with defaultView", () => {
    expect(listViewAnimations(twoViews)).toEqual({
      defaultView: "assembly",
      views: [
        { name: "print", label: "Print layout", animations: [] },
        {
          name: "assembly", label: "Assembly", animations: [
            { name: "open", label: "Open", autoplay: false },
            { name: "spin", label: "spin", autoplay: true },
          ],
        },
        { name: "detail", label: "detail", animations: [] },
      ],
    });
  });
  test("the hinged box: one view, three animations, cycle the autoplay one", () => {
    expect(listViewAnimations(hingedBox)).toEqual({
      defaultView: "box",
      views: [{
        name: "box", label: "Box", animations: [
          { name: "open", label: "Open lid", autoplay: false },
          { name: "cycle", label: "Open / close", autoplay: true },
          { name: "assemble", label: "Assemble", autoplay: false },
        ],
      }],
    });
  });
  test("a part with no views lists nothing and has no default view", () => {
    expect(listViewAnimations({ parts: {} })).toEqual({ defaultView: null, views: [] });
    expect(listViewAnimations(null)).toEqual({ defaultView: null, views: [] });
  });
  test("is exported from partforge and partforge/oracle", () => {
    expect(main.listViewAnimations).toBe(listViewAnimations);
    expect(oracle.listViewAnimations).toBe(listViewAnimations);
  });
});
