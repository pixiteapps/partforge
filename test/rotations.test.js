import { describe, it, expect } from "vitest";
import { IDENTITY, compose, rotation, translation } from "../src/framework/geometry/xform.js";
import { SpecError } from "../src/framework/geometry/errors.js";
import { deg, rad, euler, toEuler, applyRotation, stepsMatrix, axisAngle } from "../src/framework/geometry/rotations.js";

const near = (A, B, tol) => { for (let i = 0; i < 12; i++) expect(Math.abs(A[i] - B[i])).toBeLessThan(tol); };
const ORDERS = ["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"];

describe("rotations", () => {
  it("converts deg and rad", () => {
    expect(deg(Math.PI)).toBe(180);
    expect(rad(180)).toBe(Math.PI);
  });

  it("intrinsic XYZ equals extrinsic ZYX with reversed angles", () => {
    const a = stepsMatrix(euler({ order: "XYZ", frame: "intrinsic", angles: [10, 20, 30] }));
    const b = stepsMatrix(euler({ order: "ZYX", frame: "extrinsic", angles: [30, 20, 10] }));
    near(a, b, 1e-12);
  });

  it("angles[i] turns about order[i]", () => {
    expect(euler({ order: "ZYX", frame: "intrinsic", angles: [10, 0, 0] })[0]).toEqual({ axis: "z", deg: 10 });
    near(stepsMatrix(euler({ order: "ZYX", frame: "intrinsic", angles: [10, 0, 0] })), rotation("z", 10), 1e-12);
  });

  it("URDF rpy is extrinsic XYZ", () => {
    const [r, p, y] = [0.3, -0.5, 1.1];
    const M = stepsMatrix(euler({ order: "XYZ", frame: "extrinsic", angles: [r, p, y], units: "rad" }));
    near(M, compose(rotation("z", deg(y)), compose(rotation("y", deg(p)), rotation("x", deg(r)))), 1e-12);
  });

  it("round-trips every order and frame", () => {
    for (const order of ORDERS) for (const frame of ["intrinsic", "extrinsic"]) {
      const out = toEuler(euler({ order, frame, angles: [25, -40, 70] }), { order, frame });
      [25, -40, 70].forEach((v, i) => expect(Math.abs(out[i] - v)).toBeLessThan(1e-9));
      const r = toEuler(euler({ order, frame, angles: [0.4, -0.7, 1.2], units: "rad" }), { order, frame, units: "rad" });
      [0.4, -0.7, 1.2].forEach((v, i) => expect(Math.abs(r[i] - v)).toBeLessThan(1e-9));
    }
  });

  it("handles gimbal lock", () => {
    for (const order of ORDERS) for (const frame of ["intrinsic", "extrinsic"]) for (const mid of [90, -90]) {
      const angles = [33, mid, 17];
      const steps = euler({ order, frame, angles });
      const out = toEuler(steps, { order, frame });
      near(stepsMatrix(euler({ order, frame, angles: out })), stepsMatrix(steps), 1e-9);
      // the third angle (last intrinsic axis) is zero
      expect(out[frame === "intrinsic" ? 2 : 0]).toBe(0);
    }
  });

  it("reports bad arguments", () => {
    expect(() => euler({ angles: [1, 2, 3], frame: "intrinsic" })).toThrow("euler: order is required (one of XYZ, XZY, YXZ, YZX, ZXY, ZYX)");
    expect(() => euler({ order: "ZXZ", angles: [1, 2, 3], frame: "intrinsic" })).toThrow("euler: order is required (one of XYZ, XZY, YXZ, YZX, ZXY, ZYX)");
    expect(() => euler({ order: "XYZ", angles: [1, 2, 3] })).toThrow('euler: frame is required ("intrinsic" or "extrinsic")');
    expect(() => euler({ order: "XYZ", frame: "intrinsic", angles: [1, 2, 3], units: "grad" })).toThrow('euler: units must be "deg" or "rad"');
  });

  it("axisAngle round-trips", () => {
    for (const d of [0.001, 90, 179.9, 180]) {
      const M = rotation([1, 2, 3], d);
      const aa = axisAngle(M);
      near(stepsMatrix([aa]), M, 1e-9);
      expect(aa.deg).toBeGreaterThan(0);
      expect(aa.deg).toBeLessThanOrEqual(180);
    }
    expect(axisAngle(IDENTITY)).toBeNull();
    near(stepsMatrix([axisAngle(compose(translation([1, 2, 3]), rotation("x", 40)))]), rotation("x", 40), 1e-9);
  });

  it("applyRotation matches frame steps and calls rotate in reverse", () => {
    const steps = [{ axis: "z", deg: 30 }, { axis: [1, 1, 0], deg: -50 }, { axis: "x", deg: 70 }];
    const center = [1, 2, 3];
    const calls = [];
    const fake = {
      M: IDENTITY,
      rotate(d, c, axis) {
        calls.push(axis);
        const about = compose(translation(c), compose(rotation(axis, d), translation([-c[0], -c[1], -c[2]])));
        const n = { M: compose(about, this.M), rotate: fake.rotate };
        Object.setPrototypeOf(n, fake);
        return n;
      },
    };
    const res = applyRotation(fake, steps, center);
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([1, 0, 0]);
    expect(calls[2]).toEqual([0, 0, 1]);
    const expected = compose(translation(center), compose(stepsMatrix(steps), translation([-1, -2, -3])));
    near(res.M, expected, 1e-12);
  });

  it("euler validates angles", () => {
    for (const angles of [[NaN, 0, 0], [1, 2], [1, "2", 3], undefined]) {
      expect(() => euler({ order: "XYZ", frame: "intrinsic", angles })).toThrow("euler: angles must be three finite numbers");
    }
  });
  it("rotation errors are SpecError", () => {
    expect(() => euler({ order: "Q", frame: "intrinsic", angles: [0, 0, 0] })).toThrow(SpecError);
  });
});
