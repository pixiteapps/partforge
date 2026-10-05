// The `inspect` job's opt-in change tracking: a caller that passes `changesKey`
// gets back `report.changes`/`report.changesSkipped` describing what moved since
// the previous inspect under that key; a caller that doesn't gets the old report,
// byte-identical.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, handle } from "../src/testing.js";
import hinged from "../src/parts/hinged-box.js";

let k;
beforeAll(async () => {
  k = await bootManifoldKernel();
});

const inspect = async (part, extra = {}) => {
  const posted = [];
  await handle(k, part, { type: "inspect", view: "box", params: {}, ...extra }, (m) => posted.push(m));
  return posted.find((m) => m.type === "report");
};

test("no changesKey: the report has no change fields", async () => {
  await inspect(hinged);
  const r = await inspect(hinged);
  expect(r).not.toHaveProperty("changes");
  expect(r).not.toHaveProperty("changesSkipped");
});

test("with changesKey: second inspect reports unchanged", async () => {
  await inspect(hinged, { changesKey: "f1" });
  const r = await inspect(hinged, { changesKey: "f1" });
  expect(r.changes).toEqual({ unchanged: true, subparts: [], unchangedSubparts: 2 });
});

test("a new changesKey has no baseline yet: no change fields on the first round", async () => {
  const r = await inspect(hinged, { changesKey: "f2-fresh" });
  expect(r).not.toHaveProperty("changes");
  expect(r).not.toHaveProperty("changesSkipped");
});

test("a non-default params inspect is never tracked", async () => {
  await inspect(hinged, { changesKey: "f3", params: { width: 80 } });
  const r = await inspect(hinged, { changesKey: "f3", params: { width: 80 } });
  expect(r).not.toHaveProperty("changes");
  expect(r).not.toHaveProperty("changesSkipped");
});
