// OCCT only; never boot manifold here. Holds kernel-error.js's heap read against
// the INSTALLED replicad-opencascadejs glue: an OCCT call that throws reaches
// JavaScript as a bare number, and `_throwEvidence` must name its C++ type from
// that number. A replicad-opencascadejs bump that changes Emscripten's
// ExceptionInfo layout fails here, which is the signal to re-pin the offsets.
import { describe, it, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import * as replicad from "replicad";
import { describeKernelThrow } from "../src/framework/kernel-error.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

describe("kernel throws out of the exception-less OCCT build", () => {
  it("an uncaught OCCT exception arrives as a number, and the heap names its type", () => {
    const oc = replicad.getOC();
    let thrown;
    try { new oc.gp_Dir_4(0, 0, 0); } catch (e) { thrown = e; }
    expect(typeof thrown).toBe("number");
    const evidence = k._throwEvidence(thrown);
    expect(evidence.typeName).toBe("Standard_ConstructionError");
    expect(evidence.heapBytes).toBeGreaterThan(0);
    const err = describeKernelThrow(thrown, { evidence });
    expect(err.message).toMatch(/^the geometry kernel raised an internal error it could not describe \(C\+\+ exception Standard_ConstructionError, kernel heap [\d.]+ MB\)$/);
  });

  it("a STEP the reader parses but cannot transfer fails labelled with the import's name and size", async () => {
    const box = k.box({ size: [10, 10, 10] });
    const good = new Uint8Array(await k.toSTEP([{ name: "box", solid: box }]));
    const text = new TextDecoder().decode(good).replace("#10", "#99999"); // one dangling entity reference
    const bad = new TextEncoder().encode(text);
    let thrown;
    try { await k._registerImport({ name: "frame", digest: "dangling", step: bad }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(/^STEP import of "frame" \(\d+ KB\) failed: /);
    expect(thrown.cause).toBeInstanceOf(Error);
    // Nothing was registered under the name, so a later build is told the import is unknown.
    expect(() => k.import("frame")).toThrow(/unknown import "frame"/);
  });
});
