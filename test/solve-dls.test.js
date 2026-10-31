import { describe, it, expect } from "vitest";
import { solveDLS } from "../src/framework/solve/dls.js";

const L1 = 100;
const L2 = 80;
const tip = (x) => [
  L1 * Math.cos(x[0]) + L2 * Math.cos(x[0] + x[1]),
  L1 * Math.sin(x[0]) + L2 * Math.sin(x[0] + x[1]),
];
const reach = (target) => (x) => {
  const t = tip(x);
  return Float64Array.of(t[0] - target[0], t[1] - target[1]);
};
const base = { x0: [0.3, 0.5], lo: [-Math.PI, -Math.PI], hi: [Math.PI, Math.PI] };

describe("solveDLS", () => {
  it("planar two-link reaches an in-range point", () => {
    const target = [120, 60];
    const r = solveDLS({ ...base, residuals: reach(target), iterations: 40 });
    expect(r.error).toBeLessThan(1e-6);
    const t = tip(r.x);
    expect(t[0]).toBeCloseTo(120, 5);
    expect(t[1]).toBeCloseTo(60, 5);
  });

  it("respects bounds", () => {
    const r = solveDLS({ ...base, hi: [10, 10], residuals: reach([120, 60]), iterations: 40 });
    for (const v of r.x) expect(v).toBeLessThanOrEqual(10);
  });

  it("deterministic", () => {
    const run = () => solveDLS({ ...base, residuals: reach([120, 60]), iterations: 40 });
    const a = run();
    const b = run();
    a.x.forEach((v, i) => expect(Object.is(v, b.x[i])).toBe(true));
  });

  it("unreachable target stays put", () => {
    const res = reach([500, 0]);
    const a = solveDLS({ ...base, residuals: res, iterations: 40 });
    const b = solveDLS({ ...base, residuals: res, iterations: 80 });
    expect(b.error).toBeLessThanOrEqual(a.error);
    a.x.forEach((v, i) => expect(Math.abs(v - b.x[i])).toBeLessThan(0.02));
    const t = tip(b.x);
    expect(Math.abs(Math.atan2(t[1], t[0]))).toBeLessThan(0.02);
    const r = res(b.x);
    expect(Math.abs(b.error - Math.sqrt(r[0] * r[0] + r[1] * r[1]))).toBeLessThan(1e-12);
  });

  it("warm start is continuous", () => {
    let x = [0.3, 0.5];
    for (let i = 0; i <= 100; i++) {
      const ang = (i / 100) * 1.2;
      const target = [150 * Math.cos(ang), 150 * Math.sin(ang)];
      const r = solveDLS({ ...base, x0: x, residuals: reach(target), iterations: 10 });
      if (i > 0) r.x.forEach((v, k) => expect(Math.abs(v - x[k])).toBeLessThan(0.2));
      x = Array.from(r.x);
    }
  });

  it("tol stops once the residual is met, and changes nothing when off", () => {
    let evals = 0;
    const counted = (target) => { const f = reach(target); return (x) => { evals++; return f(x); }; };
    const a = solveDLS({ ...base, residuals: counted([120, 60]), iterations: 40 });
    const full = evals;
    evals = 0;
    const b = solveDLS({ ...base, residuals: counted([120, 60]), iterations: 40, tol: 1e-6 });
    expect(evals).toBeLessThan(full);
    expect(b.error).toBeLessThanOrEqual(1e-6);
    b.x.forEach((v, i) => expect(Math.abs(v - a.x[i])).toBeLessThan(1e-6));
    // tol: 0 is the default: bit for bit the same solve
    const c = solveDLS({ ...base, residuals: reach([120, 60]), iterations: 40, tol: 0 });
    a.x.forEach((v, i) => expect(Object.is(v, c.x[i])).toBe(true));
  });
});
