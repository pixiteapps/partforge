// A STEP export with no organic sub-parts writes exactly the DATA section it did before
// tessellated STEP existed (fixtures/step/solids-baseline.data.step, recorded from that
// code). Its own file, and its one export, on purpose: OCCT numbers its shared context
// entities differently on the second export in a process (#345 one time, #457 the next),
// so a byte comparison only holds for a process's first export. OCCT boots alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";

const BASELINE = readFileSync(fileURLToPath(new URL("./fixtures/step/solids-baseline.data.step", import.meta.url)), "utf8");

it("a part with no organic sub-parts writes the same DATA section as before", async () => {
  const k = await bootOcctKernel();
  const part = {
    meta: { title: "Baseline" }, defaults: {},
    parts: {
      plate: { views: ["all"], build: (kk) => kk.box({ size: [10, 10, 2] }), display: { color: "#3366cc" } },
      boss: { views: ["all"], build: (kk) => kk.cylinder({ r: 3, h: 8 }).translate([0, 0, 2]) },
    },
    views: { all: { label: "All" } },
  };
  const posts = [];
  await handle(k, part, { type: "export-step", view: "all", params: {}, jobId: 1 }, (m) => posts.push(m));
  const dl = posts.find((m) => m.type === "download");
  expect(dl, JSON.stringify(posts.find((m) => m.type === "error"))).toBeTruthy();
  const text = new TextDecoder().decode(dl.data);
  expect(text.slice(text.indexOf("DATA;"))).toBe(BASELINE);
}, 120000);
