// The cnc-router process is registered beside the laser: in the registry, in the
// exporter table, with its own doc id and keys.
import { expect, test } from "vitest";
import { PROCESSES, PROCESS_IDS, processById } from "../src/framework/process/registry.js";
import { EXPORTER_LOADERS, loadExporter } from "../src/framework/process/exporters.js";
import { ROUTER } from "../src/framework/process/cnc-router/descriptor.js";
import { ROUTED_DOC_ID, ROUTED_KEYS } from "../src/framework/sheet/constants.js";

test("cnc-router is the second registered process", () => {
  expect(PROCESS_IDS).toEqual(["laser", "cnc-router"]);
  expect(processById("cnc-router")).toBe(ROUTER);
  expect(PROCESSES[1]).toBe(ROUTER);
});

test("the descriptor's data", () => {
  expect(ROUTER.id).toBe("cnc-router");
  expect(ROUTER.stock).toBe("sheet");
  expect(ROUTER.docId).toBe(ROUTED_DOC_ID);
  expect(ROUTED_DOC_ID).toBe("routed-parts");
  expect(ROUTER.keys).toEqual(ROUTED_KEYS);
  expect(ROUTED_KEYS).toEqual(["pockets", "drills", "extra", "reference"]);
  expect(ROUTER.destinations).toEqual([{ id: "cnc-router", cutFormat: "dxf" }]);
  expect(ROUTER.layers).toEqual({ profile: "region", reference: "line", pockets: "region", drills: "region", extra: "region" });
});

test("the exporter table has a loader for it, in registry order", async () => {
  expect(Object.keys(EXPORTER_LOADERS)).toEqual(PROCESS_IDS);
  const exporter = await loadExporter("cnc-router");
  expect(typeof exporter.drawing).toBe("function");
});
