import { describe, it, expect, vi, afterEach } from "vitest";
import { convertsUnit, toDisplay, fromDisplay, formatLength, parseLength, unitLabel, createUnitsState, isUnitId, loadUnits, saveUnits } from "../../src/framework/units.js";

describe("units", () => {
  it("converts only the exact unit mm", () => {
    expect(convertsUnit("mm")).toBe(true);
    for (const u of ["°", "%", "mm²", "MM", " mm", "", undefined, null]) expect(convertsUnit(u)).toBe(false);
  });
  it("stores exact millimetres for inch values", () => {
    expect(fromDisplay(1.5, "in")).toBe(38.1);
    expect(fromDisplay(0.75, "in")).toBe(19.05);
    expect(fromDisplay(12.5, "mm")).toBe(12.5);
  });
  it("round-trips the half-millimetre grid", () => {
    for (let mm = 0; mm <= 300; mm += 0.5) expect(fromDisplay(toDisplay(mm, "in"), "in")).toBe(mm);
  });
  it("formats inches to 3 decimals, trimmed", () => {
    expect(formatLength(12.5, "in")).toBe("0.492");
    expect(formatLength(25.4, "in")).toBe("1");
    expect(formatLength(19.05, "in")).toBe("0.75");
    expect(formatLength(20.299999999999955, "mm")).toBe("20.3");
  });
  it("parses decimals, fractions and mixed numbers in inches", () => {
    expect(parseLength("3/4", "in")).toBe(19.05);
    expect(parseLength("1 1/2", "in")).toBe(38.1);
    expect(parseLength("1/3", "in")).toBe(8.4667);
    expect(parseLength(" 0.75 ", "in")).toBe(19.05);
    expect(parseLength("0,75", "in")).toBe(19.05);
    expect(parseLength("-1/4", "in")).toBe(-6.35);
    expect(parseLength('2"', "in")).toBe(50.8);
  });
  it("refuses what is not a length", () => {
    for (const t of ["", "abc", "3/", "1/0", "1 2", "1/2/3", "1.5.2", "1,5,2"]) expect(parseLength(t, "in")).toBeNull();
    expect(parseLength("3/4", "mm")).toBeNull();
    expect(parseLength("12,5", "mm")).toBe(12.5);
  });
  it("labels a converting unit with the active unit", () => {
    expect(unitLabel("mm", "in")).toBe("in");
    expect(unitLabel("°", "in")).toBe("°");
    expect(unitLabel(undefined, "in")).toBeUndefined();
  });
  it("holds one unit and reports real changes only", () => {
    const s = createUnitsState("ft");
    expect(s.get()).toBe("mm");
    const cb = vi.fn();
    const off = s.onChange(cb);
    expect(s.set("mm")).toBe(false);
    expect(s.set(5)).toBe(false);
    expect(s.set("in")).toBe(true);
    expect(cb).toHaveBeenCalledExactlyOnceWith("in");
    off(); s.set("mm");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(isUnitId("in")).toBe(true);
  });
  it("a throwing subscriber does not stop the others, and set() does not throw", () => {
    const s = createUnitsState("mm");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    s.onChange(() => { throw new Error("boom"); });
    s.onChange(second);
    let changed;
    expect(() => { changed = s.set("in"); }).not.toThrow();
    expect(changed).toBe(true);
    expect(second).toHaveBeenCalledExactlyOnceWith("in");
    expect(s.get()).toBe("in");
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("unit persistence", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (store) => vi.stubGlobal("localStorage", store);
  it("round-trips a saved unit and ignores junk", () => {
    const data = {};
    stub({ getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } });
    expect(loadUnits()).toBeNull();
    saveUnits("in");
    expect(data["partforge:units"]).toBe("in");
    expect(loadUnits()).toBe("in");
    saveUnits("ft");
    expect(loadUnits()).toBe("in");
    data["partforge:units"] = "junk";
    expect(loadUnits()).toBeNull();
  });
  it("never throws when storage does", () => {
    const boom = () => { throw new Error("denied"); };
    stub({ getItem: boom, setItem: boom });
    expect(loadUnits()).toBeNull();
    expect(() => saveUnits("in")).not.toThrow();
  });
});
