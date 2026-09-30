// STEP schema: every export names the same schema in its header — AP242, the one
// its body is written in. The first STEP write in a process used to say AP214
// (OCCT's default) while its entities were AP242, because the header is stamped
// when the writer is built and the schema static is set only after that. This
// file must hold the process's FIRST STEP write, so it boots OCCT alone and
// nothing before these exports writes STEP.
import { beforeAll, describe, expect, it } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

const decode = (ab) => new TextDecoder().decode(new Uint8Array(ab));
const fileSchema = (text) => text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/)[1].replace(/\s+/g, " ");
const dataSection = (text) => text.slice(text.indexOf("DATA;"));
const AP242 = /^AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF/;

describe("toSTEP schema", () => {
  it("the first export and the next write the same AP242 file", async () => {
    const box = () => [{ name: "a", solid: k.box({ size: [10, 10, 10] }) }];
    const first = decode(await k.toSTEP(box()));
    const second = decode(await k.toSTEP(box()));
    expect(fileSchema(first)).toMatch(AP242);
    expect(fileSchema(second)).toBe(fileSchema(first));
    // The body agrees with the header, and nothing else differs between the two.
    expect(first).toMatch(/APPLICATION_PROTOCOL_DEFINITION\s*\([^;]*'ap242_managed_model_based_3d_engineering'/);
    expect(dataSection(second)).toBe(dataSection(first));
  });
});
