// The kit's entry model (export/kit/entries.js): a kit is a list of { path, kind, data }
// that a host zips, and a kit with one model in it is saved as that bare file.
import { describe, expect, test } from "vitest";
import { KIT_KINDS, MODEL_KINDS, makeEntry, assertEntries, bareEntry } from "../src/framework/export/kit/entries.js";

const bytes = new Uint8Array([1]);
const e = (path, kind) => makeEntry(path, kind, bytes);

describe("patterns", () => {
  test("accept today's names", () => {
    expect(KIT_KINDS["drawing-svg"].pattern.test("laser/sheets/plywood-3mm/sheet-1-of-2.svg")).toBe(true);
    expect(KIT_KINDS["drawing-dxf"].pattern.test("cnc/parts/side-x2-far.dxf")).toBe(true);
    expect(KIT_KINDS["drawing-svg"].pattern.test("laser/parts/lid-marks.svg")).toBe(true);
    expect(KIT_KINDS["model-stl"].pattern.test("print/lid.stl")).toBe(true);
    expect(KIT_KINDS["model-3mf"].pattern.test("print/lid.3mf")).toBe(true);
    expect(KIT_KINDS["model-step"].pattern.test("print/lid.step")).toBe(true);
    expect(KIT_KINDS.text.pattern.test("README.txt")).toBe(true);
    expect(KIT_KINDS.table.pattern.test("parts.csv")).toBe(true);
  });
  test("refuse the rest", () => {
    expect(KIT_KINDS["model-stl"].pattern.test("print/../x.stl")).toBe(false);
    expect(KIT_KINDS["drawing-svg"].pattern.test("laser/parts/_a.svg")).toBe(false);
    expect(KIT_KINDS["model-stl"].pattern.test("print/lid.svg")).toBe(false);
    expect(KIT_KINDS.text.pattern.test("README.md")).toBe(false);
  });
  test("kinds carry ext and mime, frozen", () => {
    expect(KIT_KINDS["drawing-dxf"]).toMatchObject({ ext: "dxf", mime: "image/vnd.dxf" });
    expect(Object.isFrozen(KIT_KINDS)).toBe(true);
    expect(Object.isFrozen(KIT_KINDS.text)).toBe(true);
    expect([...MODEL_KINDS].sort()).toEqual(["model-3mf", "model-step", "model-stl"]);
  });
});

describe("assertEntries", () => {
  test("passes a good list", () => {
    expect(() => assertEntries([e("README.txt", "text"), e("print/lid.stl", "model-stl")])).not.toThrow();
  });
  test("throws on a duplicate path, a mismatch, an unknown kind and ..", () => {
    expect(() => assertEntries([e("print/a.stl", "model-stl"), e("print/a.stl", "model-stl")])).toThrow('cut kit: bad entry name "print/a.stl"');
    expect(() => assertEntries([e("print/a.stl", "drawing-svg")])).toThrow("cut kit: bad entry name");
    expect(() => assertEntries([{ path: "x", kind: "nope", data: bytes }])).toThrow("cut kit: bad entry name");
    expect(() => assertEntries([e("print/a..b.stl", "model-stl")])).toThrow("cut kit: bad entry name");
  });
});

describe("bareEntry", () => {
  const readme = e("README.txt", "text");
  const csv = e("parts.csv", "table");
  test("the one model beside the text and table", () => {
    const stl = e("print/lid.stl", "model-stl");
    expect(bareEntry([readme, csv, stl])).toBe(stl);
  });
  test("null for two models, one drawing, nothing", () => {
    expect(bareEntry([readme, e("print/a.stl", "model-stl"), e("print/b.stl", "model-stl")])).toBeNull();
    expect(bareEntry([readme, e("laser/parts/a.svg", "drawing-svg")])).toBeNull();
    expect(bareEntry([])).toBeNull();
  });
});
