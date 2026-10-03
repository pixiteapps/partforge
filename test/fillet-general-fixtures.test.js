import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { FIXTURES, GENUS, CASES } from "./fixtures/fillet-general-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

describe("general-chain fixtures", () => {
  it("build with the stated genus", () => {
    for (const [name, make] of Object.entries(FIXTURES)) expect(make(k).genus(), name).toBe(GENUS[name]);
  });
  it("have an OCCT reference entry for every case", () => {
    const ref = JSON.parse(readFileSync(new URL("./fixtures/fillet-general-reference.json", import.meta.url), "utf8"));
    for (const name of Object.keys(FIXTURES))
      for (const [mode, m] of CASES) expect(ref[name], name).toHaveProperty(`${mode}${m}`);
  });
});
