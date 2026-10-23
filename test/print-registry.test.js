import { expect, test } from "vitest";
import { PRINT_PROCESSES, PRINT_PROCESS_IDS, ALL_PROCESSES, PROCESSES, PRINT_PROFILES, printProcessFor } from "../src/framework/process/registry.js";
import { PROFILES } from "../src/framework/oracle/dfm-profiles.js";
import { FDM } from "../src/framework/process/fdm/descriptor.js";

test("print processes are their own list and never join the sheet list", () => {
  expect(PRINT_PROCESS_IDS).toEqual(["fdm", "resin"]);
  expect(PROCESSES.map((d) => d.id)).toEqual(["laser", "cnc-router"]);
  expect(ALL_PROCESSES.map((d) => d.id)).toEqual(["laser", "cnc-router", "fdm", "resin"]);
});
test("the DFM profiles are the descriptors' profiles", () => {
  expect(PROFILES).toBe(PRINT_PROFILES);
  expect(Object.keys(PROFILES)).toEqual(["fdm-pla", "fdm-petg", "resin"]);
  expect(PROFILES["fdm-pla"].footprint).toBe(5);
  expect(PROFILES.resin.footprint).toBeUndefined();
});
test("printProcessFor resolves a string, an inline base, and nothing else", () => {
  expect(printProcessFor("fdm-petg")).toBe(FDM);
  expect(printProcessFor({ base: "fdm-pla", overhang: null })).toBe(FDM);
  expect(printProcessFor("laser")).toBeNull();
  expect(printProcessFor({ bed: [1, 1, 1] })).toBeNull();
  expect(printProcessFor(undefined)).toBeNull();
});
test("a print descriptor carries no sheet-only fields and no exporter", () => {
  for (const d of PRINT_PROCESSES) {
    expect(d.docId).toBe("printed-parts");
    expect(d.metrics).toEqual({});
    expect(d.lintRules).toEqual([]);
    expect(d.destinations).toBeUndefined();
  }
  expect(FDM.costs).toEqual({ supports: "overhangArea", footprint: "footprintPct" });
});
