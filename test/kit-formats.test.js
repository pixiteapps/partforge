// The kit's option contract (export/formats.js): every refusal is an options error that
// starts with KIT_OPTIONS_ERROR — partforge-cloud routes that prefix to "Back to options"
// — and the messages are pinned verbatim because the export dialog shows them as-is.
import { describe, expect, test } from "vitest";
import {
  EXPORT_FORMATS, KIT_OPTIONS_ERROR, KIT_DEFAULTS, DEFAULT_STOCK_SIZE, DESTINATIONS, KIT_LIMITS,
  validateKitOptions, resolveStock,
} from "../src/framework/export/formats.js";
import { LASER } from "../src/framework/process/laser/descriptor.js";

const refuses = (o, message) => expect(() => validateKitOptions(o)).toThrow(message);

describe("tables", () => {
  test("the four export formats, bundle last and the only one that needs a sheet", () => {
    expect(EXPORT_FORMATS).toEqual([
      { id: "stl", label: "STL", ext: "stl", mime: "model/stl", needsSheet: false },
      { id: "step", label: "STEP", ext: "step", mime: "application/step", needsSheet: false },
      { id: "3mf", label: "3MF", ext: "3mf", mime: "model/3mf", needsSheet: false },
      { id: "bundle", label: "Cut and print kit", ext: "zip", mime: "application/zip", needsSheet: true },
    ]);
    expect(Object.isFrozen(EXPORT_FORMATS) && EXPORT_FORMATS.every(Object.isFrozen)).toBe(true);
  });

  test("DESTINATIONS is the laser descriptor's destinations — one fact, two spellings", () => {
    expect(Object.entries(DESTINATIONS)).toEqual(LASER.destinations.map((d) => [d.id, d.cutFormat]));
  });

  test("the prefix, defaults and limits", () => {
    expect(KIT_OPTIONS_ERROR).toBe("cut kit options:");
    expect(DEFAULT_STOCK_SIZE).toEqual([300, 300]);
    expect(KIT_DEFAULTS).toEqual({ destination: "own-laser", kerf: 0, colors: "lightburn", stock: null, margin: 5, spacing: 3, printFormat: "stl", sets: 1 });
    expect(KIT_LIMITS).toEqual({ kerf: [0, 0.5], margin: [0, 50], spacing: [1, 50], sets: [1, 20], stockEntries: 20, stockSide: [10, 3000], sheetsPerGroup: 50, pieces: 200 });
  });
});

describe("validateKitOptions", () => {
  test("no options at all means every default, cutFormat derived", () => {
    expect(validateKitOptions(undefined)).toEqual({
      destination: "own-laser", cutFormat: "svg", kerf: 0, colors: "lightburn", stock: null,
      margin: 5, spacing: 3, printFormat: "stl", sets: 1,
    });
    expect(validateKitOptions({})).toEqual(validateKitOptions(undefined));
  });

  test("a service kit writes dxf, and a matching cutFormat is accepted", () => {
    expect(validateKitOptions({ destination: "service" }).cutFormat).toBe("dxf");
    expect(validateKitOptions({ destination: "service", cutFormat: "dxf" }).cutFormat).toBe("dxf");
  });

  test("a full, valid option set comes back normalized and copied", () => {
    const stock = [{ group: "birch plywood|3.00", size: [400, 300] }, { group: "*", size: [300, 200] }];
    const out = validateKitOptions({ destination: "own-laser", kerf: 0.2, colors: "lightburn", stock, margin: 0, spacing: 1, printFormat: "3mf", sets: 20 });
    expect(out).toEqual({ destination: "own-laser", cutFormat: "svg", kerf: 0.2, colors: "lightburn", stock, margin: 0, spacing: 1, printFormat: "3mf", sets: 20 });
    expect(out.stock).not.toBe(stock);
    expect(out.stock[0].size).not.toBe(stock[0].size);
  });

  test("every refusal carries the prefix and says what is wrong, verbatim", () => {
    refuses(null, "cut kit options: options must be an object");
    refuses([], "cut kit options: options must be an object");
    refuses("svg", "cut kit options: options must be an object");
    refuses({ foo: 1 }, 'cut kit options: unknown option "foo" — the options are destination, cutFormat, kerf, colors, stock, margin, spacing, printFormat, sets');
    refuses({ destination: "laser" }, 'cut kit options: destination must be "own-laser" or "service", got "laser"');
    refuses({ destination: "toString" }, 'cut kit options: destination must be "own-laser" or "service", got "toString"');
    refuses({ cutFormat: "dxf" }, 'cut kit options: cutFormat "dxf" does not match destination "own-laser" (which writes svg)');
    refuses({ kerf: 0.6 }, "cut kit options: kerf must be a number from 0 to 0.5 mm, got 0.6");
    refuses({ kerf: -0.1 }, "cut kit options: kerf must be a number from 0 to 0.5 mm, got -0.1");
    refuses({ kerf: "0.2" }, 'cut kit options: kerf must be a number from 0 to 0.5 mm, got "0.2"');
    refuses({ kerf: NaN }, "cut kit options: kerf must be a number from 0 to 0.5 mm, got null");
    refuses({ colors: "glowforge" }, 'cut kit options: colors must be "lightburn", got "glowforge"');
    refuses({ margin: 51 }, "cut kit options: margin must be a number from 0 to 50 mm, got 51");
    refuses({ spacing: 0.5 }, "cut kit options: spacing must be a number from 1 to 50 mm, got 0.5");
    refuses({ printFormat: "step" }, 'cut kit options: printFormat must be "stl" or "3mf", got "step"');
    refuses({ sets: 1.5 }, "cut kit options: sets must be a whole number from 1 to 20, got 1.5");
    refuses({ sets: 21 }, "cut kit options: sets must be a whole number from 1 to 20, got 21");
  });

  test("stock entries are checked for shape, range and duplicates", () => {
    refuses({ stock: { group: "*", size: [300, 300] } }, "cut kit options: stock must be an array of { group, size: [w, h] }");
    refuses({ stock: Array.from({ length: 21 }, (_, i) => ({ group: `g${i}`, size: [300, 300] })) }, "cut kit options: stock has 21 entries — at most 20");
    refuses({ stock: [{ group: "*", size: [300, 300] }, { size: [300, 300] }] }, "cut kit options: stock entry 2 needs a group and a size [w, h] in mm");
    refuses({ stock: [{ group: "", size: [300, 300] }] }, "cut kit options: stock entry 1 needs a group and a size [w, h] in mm");
    refuses({ stock: [{ group: "*", size: [300] }] }, "cut kit options: stock entry 1 needs a group and a size [w, h] in mm");
    refuses({ stock: [{ group: "*", size: [300, 300], grain: "x" }] }, "cut kit options: stock entry 1 needs a group and a size [w, h] in mm");
    refuses({ stock: [{ group: "*", size: [5, 300] }] }, 'cut kit options: stock "*" size must be two numbers from 10 to 3000 mm, got [5,300]');
    refuses({ stock: [{ group: "*", size: [300, 3001] }] }, 'cut kit options: stock "*" size must be two numbers from 10 to 3000 mm, got [300,3001]');
    refuses({ stock: [{ group: "*", size: [300, 300] }, { group: "*", size: [200, 200] }] }, 'cut kit options: stock names "*" twice');
  });
});

describe("resolveStock", () => {
  const groups = [{ group: "birch plywood|3.00", label: "birch plywood 3 mm" }, { group: "acrylic|2.00", label: "acrylic 2 mm" }];

  test("no stock means 300 × 300 for every group", () => {
    expect([...resolveStock(null, groups)]).toEqual([["birch plywood|3.00", [300, 300]], ["acrylic|2.00", [300, 300]]]);
  });

  test("a group's own entry wins over the \"*\" default", () => {
    const stock = validateKitOptions({ stock: [{ group: "*", size: [600, 400] }, { group: "acrylic|2.00", size: [300, 200] }] }).stock;
    expect([...resolveStock(stock, groups)]).toEqual([["birch plywood|3.00", [600, 400]], ["acrylic|2.00", [300, 200]]]);
  });

  test("an entry naming no group, or a group with no size, is an options error — never a silent fallback", () => {
    expect(() => resolveStock([{ group: "mdf|3.00", size: [300, 300] }], groups))
      .toThrow('cut kit options: stock names "mdf|3.00", which no checked sheet part uses — the kit\'s groups are "birch plywood|3.00", "acrylic|2.00"');
    expect(() => resolveStock([{ group: "birch plywood|3.00", size: [300, 300] }], groups))
      .toThrow('cut kit options: no stock size for "acrylic|2.00" (acrylic 2 mm) — add a stock entry for it or a "*" default');
    expect(() => resolveStock([], groups))
      .toThrow('cut kit options: no stock size for "birch plywood|3.00" (birch plywood 3 mm) — add a stock entry for it or a "*" default');
  });
});
