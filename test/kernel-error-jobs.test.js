// The job loop's error post for a build that throws something that is not an
// Error. Manifold-booting only — OCCT must never boot in the same process.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const partThrowing = (value) => ({
  meta: { title: "t" },
  defaults: {},
  views: { main: {} },
  parts: { body: { views: ["main"], build: () => { throw value; } } },
});

const run = async (part, msg) => {
  const posts = [];
  await handle(kernel, part, msg, (m) => posts.push(m), {});
  return posts;
};

describe("jobs.js error post", () => {
  it("gives a thrown number words instead of posting the number", async () => {
    const posts = await run(partThrowing(154591824), { type: "generate", subparts: ["body"], view: "main", params: {}, jobId: 3 });
    const err = posts.find((p) => p.type === "error");
    expect(err.jobId).toBe(3);
    expect(err.message).toBe("the geometry kernel raised an internal error it could not describe (the kernel reported only an exception address, 154591824)");
  });
  it("posts a real Error's own message, as before", async () => {
    const posts = await run(partThrowing(new Error("my build failed")), { type: "generate", subparts: ["body"], view: "main", params: {} });
    expect(posts.find((p) => p.type === "error").message).toBe("my build failed");
  });
});
