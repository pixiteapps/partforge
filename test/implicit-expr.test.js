// test/implicit-expr.test.js
import { describe, test, expect } from "vitest";
import { compileExprSource, evalExprScalar } from "../src/framework/geometry/implicit/expr-lower.js";
import { ExprError } from "../src/framework/geometry/implicit/expr-parse.js";
import { pfSin, pfCos } from "../src/framework/geometry/js-math.js";

const run = (src, p = [0, 0, 0], opts = {}, textures = [], sample = () => 0) =>
  evalExprScalar(compileExprSource(src, opts), p[0], p[1], p[2], textures, sample);
const err = (src, opts) => { try { compileExprSource(src, opts); return null; } catch (e) { expect(e).toBeInstanceOf(ExprError); return e.message; } };

describe("expr language", () => {
  test("arithmetic, precedence, uniforms", () => {
    expect(run("return 1.0 + 2.0 * 3.0;")).toBe(7);
    expect(run("return (1.0 + 2.0) * 3.0;")).toBe(9);
    expect(run("return -p.x + k;", [2, 0, 0], { uniforms: { k: 5 } })).toBe(3);
  });
  test("vectors, swizzles, built-ins", () => {
    expect(run("return length(p) - 1.0;", [3, 4, 0])).toBe(4);
    expect(run("vec3 q = p.zyx; return q.x;", [1, 2, 3])).toBe(3);
    expect(run("vec2 a = vec2(3.0, 4.0); return length(a);")).toBe(5);
    expect(run("return dot(vec3(1.0, 2.0, 3.0), p);", [1, 1, 1])).toBe(6);
    expect(run("return cross(vec3(1.0,0.0,0.0), vec3(0.0,1.0,0.0)).z;")).toBe(1);
    expect(run("return clamp(p.x, 0.0, 1.0);", [5, 0, 0])).toBe(1);
    expect(run("return mix(2.0, 4.0, 0.25);")).toBe(2.5);
    expect(run("return mod(-1.0, 3.0);")).toBe(2);
    expect(run("return step(0.5, p.x);", [0.4, 0, 0])).toBe(0);
    expect(run("return smoothstep(0.0, 1.0, 0.5);")).toBe(0.5);
    expect(run("return fract(2.75);")).toBe(0.75);
    expect(run("return sin(p.x) + cos(p.y);", [0.3, 0.4, 0])).toBe(pfSin(0.3) + pfCos(0.4));
    expect(run("return smin(1.0, 1.0, 2.0);")).toBe(0.5);
    expect(run("return p.x > 0.0 && p.y > 0.0 ? 1.0 : -1.0;", [1, 1, 0])).toBe(1);
  });
  test("for loops unroll with a literal bound", () => {
    expect(run("float s = 0.0; for (int i = 0; i < 4; i++) { s += float(i); } return s;")).toBe(6);
    expect(err("float s = 0.0; for (int i = 0; i < 17; i++) { s += 1.0; } return s;")).toMatch(/at most 16 iterations/);
  });
  test("texture() calls the sampler with the slot and uv", () => {
    const seen = [];
    const v = run("return texture(skin, p.xy);", [0.25, 0.75, 0], { textureSlots: { skin: 3 } }, ["t0", "t1", "t2", "T3"],
      (t, u, w) => { seen.push([t, u, w]); return 0.5; });
    expect(v).toBe(0.5);
    expect(seen).toEqual([["T3", 0.25, 0.75]]);
  });
  test("errors name the line and the problem", () => {
    expect(err("float a = 1.0;\nreturn b;")).toMatch(/line 2: unknown name 'b'/);
    expect(err("return vec3(1.0);")).toMatch(/line 1: return must be a float, got vec3/);
    expect(err("return 1.0")).toMatch(/expected ';'/);
    expect(err("return texture(nope, p.xy);")).toMatch(/unknown texture 'nope'/);
    expect(err("return texture(constructor, p.xy);")).toMatch(/unknown texture 'constructor'/);
    expect(err("float a = 1.0;")).toMatch(/must end with a return/);
    expect(err("return 1.0; return 2.0;")).toMatch(/code after return/);
    expect(err("return p.w;")).toMatch(/swizzle/);
    expect(err("return length(1.0, 2.0);")).toMatch(/length expects 1 argument/);
  });
});
