import { beforeAll, expect, test } from "vitest";
import hingedBox from "../src/parts/hinged-box.js";
import { buildView } from "../src/framework/oracle/build.js";
import { newReadSink, expandReads } from "../src/framework/read-recorder.js";
import { bootManifoldKernel } from "../src/testing.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

test("readsBySubPart holds each sub-part's BUILD reads and none of its place() reads", () => {
  const readsBySubPart = new Map();
  buildView(kernel, hingedBox, "box", {}, { readsBySubPart });
  expect(readsBySubPart.get("lid")).toEqual(["depth", "wall", "width"]);   // build: k.box(width, depth, wall)
  expect(readsBySubPart.get("lid")).not.toContain("lidAngle");            // place() reads stay out
  expect(readsBySubPart.get("base")).toEqual(["depth", "height", "wall", "width"]);
});

test("the view-level reads sink still sees place() reads", () => {
  const reads = newReadSink();
  buildView(kernel, hingedBox, "box", {}, { reads });
  expect(expandReads(reads)).toContain("lidAngle");
});

test("both options together: per-sub-part sinks exclude place() reads, the view sink keeps them", () => {
  const reads = newReadSink();
  const readsBySubPart = new Map();
  buildView(kernel, hingedBox, "box", {}, { reads, readsBySubPart });
  expect(readsBySubPart.get("lid")).toEqual(["depth", "wall", "width"]);
  expect(expandReads(reads)).toContain("lidAngle");
});
