// The kit's per-section option contract (export/kit/options.js): each section's options
// are validated on their own, with defaults filled in, before anything is built. Every
// refusal starts with KIT_OPTIONS_ERROR and names the section, because partforge-cloud
// routes that prefix back to the section's settings.
import { describe, expect, test } from "vitest";
import {
  SECTION_FOLDERS, SECTION_LABELS, cutSectionIds, validateSectionOptions, validateSets, sectionOptionSchema,
} from "../src/framework/export/kit/options.js";
import { EXPORTER_LOADERS } from "../src/framework/process/exporters.js";

const refuses = (id, o, message) => expect(() => validateSectionOptions(id, o)).toThrow(message);

describe("sections", () => {
  test("cut sections are the exporters that have a folder, in registry order", () => {
    expect(SECTION_FOLDERS).toEqual({ laser: "laser", "cnc-router": "cnc" });
    expect(cutSectionIds()).toEqual(Object.keys(EXPORTER_LOADERS).filter((id) => Object.hasOwn(SECTION_FOLDERS, id)));
    expect(cutSectionIds()).toEqual(["laser", "cnc-router"]);
    expect(SECTION_LABELS).toEqual({ "3d": "3D files", laser: "Laser-cut parts", "cnc-router": "CNC-routed parts" });
  });

  test("an unknown section is refused", () => {
    refuses("pdf", {}, 'cut kit options: unknown section "pdf" — the sections are 3d, laser, cnc-router');
    expect(() => sectionOptionSchema("pdf")).toThrow('cut kit options: unknown section "pdf"');
  });
});

describe("defaults", () => {
  test("no options means every default, fresh each time", () => {
    expect(validateSectionOptions("3d")).toEqual({ format: "stl" });
    expect(validateSectionOptions("laser", {})).toEqual({ destination: "own-laser", kerf: 0, colors: "lightburn", stock: null, margin: 5, spacing: 3 });
    expect(validateSectionOptions("cnc-router", undefined)).toEqual({ stock: null, margin: 5, spacing: 3, flip: "left-right", twoSided: "one-file" });
    expect(validateSectionOptions("3d")).not.toBe(validateSectionOptions("3d"));
  });

  test("valid values come back copied", () => {
    const stock = [{ group: "*", size: [600, 400] }];
    const out = validateSectionOptions("laser", { destination: "service", kerf: 0.2, stock, margin: 0, spacing: 1 });
    expect(out).toEqual({ destination: "service", kerf: 0.2, colors: "lightburn", stock, margin: 0, spacing: 1 });
    expect(out.stock).not.toBe(stock);
    expect(validateSectionOptions("3d", { format: "step" })).toEqual({ format: "step" });
    expect(validateSectionOptions("cnc-router", { flip: "end-over-end", twoSided: "two-files" }))
      .toMatchObject({ flip: "end-over-end", twoSided: "two-files" });
  });

  test("sets: 1 by default, a whole number from 1 to 20", () => {
    expect(validateSets(undefined)).toBe(1);
    expect(validateSets(20)).toBe(20);
    expect(() => validateSets(0)).toThrow("cut kit options: sets must be a whole number from 1 to 20, got 0");
    expect(() => validateSets(21)).toThrow("cut kit options: sets must be a whole number from 1 to 20, got 21");
    expect(() => validateSets(1.5)).toThrow("cut kit options: sets must be a whole number from 1 to 20, got 1.5");
  });
});

describe("refusals name the section", () => {
  test("not an object, or an unknown key", () => {
    refuses("laser", null, "cut kit options: Laser-cut parts: options must be an object");
    refuses("3d", [], "cut kit options: 3D files: options must be an object");
    refuses("laser", { printFormat: "stl" },
      'cut kit options: Laser-cut parts: unknown option "printFormat" — the options are destination, kerf, colors, stock, margin, spacing');
    refuses("cnc-router", { kerf: 0 },
      'cut kit options: CNC-routed parts: unknown option "kerf" — the options are stock, margin, spacing, flip, twoSided');
    refuses("3d", { sets: 2 }, 'cut kit options: 3D files: unknown option "sets" — the options are format');
  });

  test("each key's bad value", () => {
    refuses("3d", { format: "obj" }, 'cut kit options: 3D files: format must be "stl", "3mf" or "step", got "obj"');
    refuses("laser", { destination: "cnc-router" }, 'cut kit options: Laser-cut parts: destination must be "own-laser" or "service", got "cnc-router"');
    refuses("laser", { kerf: 0.6 }, "cut kit options: Laser-cut parts: kerf must be a number from 0 to 0.5 mm, got 0.6");
    refuses("laser", { kerf: "0.2" }, 'cut kit options: Laser-cut parts: kerf must be a number from 0 to 0.5 mm, got "0.2"');
    refuses("laser", { colors: "glowforge" }, 'cut kit options: Laser-cut parts: colors must be "lightburn", got "glowforge"');
    refuses("laser", { stock: { group: "*" } }, "cut kit options: Laser-cut parts: stock must be an array of { group, size: [w, h] }");
    refuses("cnc-router", { stock: [{ group: "*", size: [5, 300] }] },
      'cut kit options: CNC-routed parts: stock "*" size must be two numbers from 10 to 3000 mm, got [5,300]');
    refuses("laser", { margin: 51 }, "cut kit options: Laser-cut parts: margin must be a number from 0 to 50 mm, got 51");
    refuses("cnc-router", { spacing: 0.5 }, "cut kit options: CNC-routed parts: spacing must be a number from 1 to 50 mm, got 0.5");
    refuses("cnc-router", { flip: "vertical" }, 'cut kit options: CNC-routed parts: flip must be "left-right" or "end-over-end", got "vertical"');
    refuses("cnc-router", { twoSided: true }, 'cut kit options: CNC-routed parts: twoSided must be "one-file" or "two-files", got true');
  });
});

describe("sectionOptionSchema", () => {
  test("plain data a host can check shape against", () => {
    expect(sectionOptionSchema("3d")).toEqual({ format: { values: ["stl", "3mf", "step"], default: "stl" } });
    expect(sectionOptionSchema("laser")).toEqual({
      destination: { values: ["own-laser", "service"], default: "own-laser" },
      kerf: { range: [0, 0.5], default: 0 },
      colors: { values: ["lightburn"], default: "lightburn" },
      stock: { default: null },
      margin: { range: [0, 50], default: 5 },
      spacing: { range: [1, 50], default: 3 },
    });
    expect(sectionOptionSchema("cnc-router")).toEqual({
      stock: { default: null },
      margin: { range: [0, 50], default: 5 },
      spacing: { range: [1, 50], default: 3 },
      flip: { values: ["left-right", "end-over-end"], default: "left-right" },
      twoSided: { values: ["one-file", "two-files"], default: "one-file" },
    });
    expect(JSON.parse(JSON.stringify(sectionOptionSchema("laser")))).toEqual(sectionOptionSchema("laser"));
  });

  test("a fresh copy each call", () => {
    const a = sectionOptionSchema("laser");
    a.kerf.range.push(9);
    expect(sectionOptionSchema("laser").kerf.range).toEqual([0, 0.5]);
  });
});
