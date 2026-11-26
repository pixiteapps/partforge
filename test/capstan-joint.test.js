// The lines reference part (src/parts/capstan-joint.js), and the worked example of the
// capstan section of docs/domains/mechanisms.md: a motor drum and an output pulley placed
// by one capstan in derive, the rope declared in `lines`, a motorAngle sweep gated by
// lineDrift and sweepContacts.
import { beforeAll, describe, expect, it } from "vitest";
import part from "../src/parts/capstan-joint.js";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { lintPart } from "../src/lint.js";
import { resolveParams } from "../src/framework/part-model.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

describe("capstan-joint", () => {
  it("lints with no errors and no line warnings", () => {
    const r = lintPart(part);
    expect(r.errors).toEqual([]);
    expect([...r.warnings, ...r.notes].map((f) => f.rule).filter((id) => id.startsWith("line-"))).toEqual([]);
  });
  it("turns the pulley the other way, by the pitch-radius ratio", () => {
    const { d } = resolveParams(part, { motorAngle: 100 });
    expect(d.drive.angleOf("pulley")).toBeCloseTo((-100 * (6 + 0.6)) / (30 + 0.6), 9);
  });
  it("reads the rope at the pose and along the sweep, and verifies", () => {
    const r = measure(k, part, "assembly", {}, { now: () => 0 });
    const [rope] = r.lines;
    expect(rope).toMatchObject({ name: "rope", on: "drive", mode: "taut" });
    expect(rope.bendRatio).toBeCloseTo(10, 9);
    const [row] = r.sweeps;
    expect(row.name).toBe("drive");
    expect(row.lines[0].drift).toBeLessThan(0.2);
    expect(row.contacts).toEqual([]);
    expect(verify(k, part, { deadline: Infinity }).ok).toBe(true);
  });
});
