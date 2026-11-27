import { describe, expect, it } from "vitest";
import { tubeMesh, LINE_COLOR, LINE_TUBE_SIDES } from "../src/framework/lines/tube.js";
import { lineMeshes } from "../src/framework/lines/meshes.js";
import { measureLines } from "../src/framework/oracle/lines.js";
import { resolveParams } from "../src/framework/part-model.js";
import { normalizeLines } from "../src/framework/lines/read.js";
import { concentricCapstan } from "./fixtures/capstan-fixtures.js";

const edgeUse = (m) => {
  const use = new Map();
  for (let i = 0; i < m.indices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[i + e], b = m.indices[i + (e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
};
const allFinite = (m) => [...m.positions, ...m.normals].every(Number.isFinite);

describe("tubeMesh", () => {
  it("a straight line is a closed cylinder of the radius", () => {
    const m = tubeMesh([[0, 0, 0], [10, 0, 0]], { radius: 1 });
    expect(LINE_TUBE_SIDES).toBe(12);
    expect(m.indices.length % 3).toBe(0);
    const n = m.positions.length / 3;
    expect(m.normals.length).toBe(m.positions.length);
    let onAxis = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(m.positions[3 * i + 1], m.positions[3 * i + 2]);
      if (r < 1e-9) onAxis++; else expect(Math.abs(r - 1)).toBeLessThan(1e-6);
      expect(Math.hypot(m.normals[3 * i], m.normals[3 * i + 1], m.normals[3 * i + 2])).toBeCloseTo(1, 5);
    }
    expect(onAxis).toBe(2);
    for (const i of m.indices) expect(i).toBeLessThan(n);
  });
  it("a straight line is a closed surface (each edge used twice, by position)", () => {
    const m = tubeMesh([[0, 0, 0], [10, 0, 0]], { radius: 1 });
    // caps have their own vertices, so weld by position before counting edge use
    const id = new Map();
    const w = (i) => {
      const k = [0, 1, 2].map((c) => m.positions[3 * i + c].toFixed(5)).join(",");
      if (!id.has(k)) id.set(k, id.size);
      return id.get(k);
    };
    const use = new Map();
    for (let i = 0; i < m.indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = w(m.indices[i + e]), b = w(m.indices[i + (e + 1) % 3]);
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        use.set(key, (use.get(key) ?? 0) + 1);
      }
    }
    for (const c of use.values()) expect(c).toBe(2);
  });
  it("a duplicate point changes nothing", () => {
    const a = tubeMesh([[0, 0, 0], [5, 0, 0], [5, 0, 0], [5, 5, 0]], { radius: 1 });
    const b = tubeMesh([[0, 0, 0], [5, 0, 0], [5, 5, 0]], { radius: 1 });
    expect(allFinite(a)).toBe(true);
    expect(a.indices.length).toBe(b.indices.length);
  });
  it("fewer than two distinct points is empty", () => {
    for (const pts of [[[1, 1, 1], [1, 1, 1]], []]) {
      const m = tubeMesh(pts, { radius: 1 });
      expect(m.positions.length).toBe(0);
      expect(m.indices.length).toBe(0);
    }
  });
  it("a closed loop has no caps and no seam", () => {
    const sq = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]];
    const m = tubeMesh(sq, { radius: 0.5, closed: true });
    expect(allFinite(m)).toBe(true);
    expect(m.positions.length / 3).toBe(4 * LINE_TUBE_SIDES);
    for (const c of edgeUse(m).values()) expect(c).toBe(2);
  });
  it("a quarter circle keeps its ring orientation continuous", () => {
    const pts = [];
    for (let i = 0; i < 46; i++) { const t = (i / 45) * Math.PI / 2; pts.push([20 * Math.cos(t), 20 * Math.sin(t), 0]); }
    const m = tubeMesh(pts, { radius: 1 });
    const S = LINE_TUBE_SIDES;
    // rings come first, one block of S vertices per point
    const ringVec = (r) => {
      const o = 3 * (r * S);
      const c = pts[r];
      return [m.positions[o] - c[0], m.positions[o + 1] - c[1], m.positions[o + 2] - c[2]];
    };
    for (let r = 0; r + 1 < pts.length; r++) {
      const a = ringVec(r), b = ringVec(r + 1);
      const t = [pts[r + 1][0] - pts[r][0], pts[r + 1][1] - pts[r][1], 0];
      const tl = Math.hypot(...t);
      const proj = (v) => { const d = (v[0] * t[0] + v[1] * t[1]) / (tl * tl); return [v[0] - d * t[0], v[1] - d * t[1], v[2]]; };
      const pa = proj(a), pb = proj(b);
      const cos = (pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2]) / (Math.hypot(...pa) * Math.hypot(...pb));
      expect(Math.acos(Math.min(1, cos)) * 180 / Math.PI).toBeLessThan(30);
    }
  });
});

describe("lineMeshes", () => {
  const { d } = resolveParams(concentricCapstan, {});
  it("meshes the capstan rope", () => {
    const out = lineMeshes(concentricCapstan, "assembly", d);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("line:rope");
    expect(out[0].line).toBe("rope");
    expect(out[0].display.color).toBe(LINE_COLOR);
    expect(out[0].error).toBeNull();
    expect(out[0].reading.length).toBeCloseTo(measureLines(concentricCapstan, "assembly", d)[0].length, 9);
    expect(out[0].mesh.indices.length).toBeGreaterThan(0);
  });
  it("passes a display colour through", () => {
    const part = { ...concentricCapstan, lines: { rope: { on: "drive", display: { color: 0xff0000 } } } };
    expect(normalizeLines(part)[0].display).toEqual({ color: 0xff0000 });
    expect(lineMeshes(part, "assembly", d)[0].display.color).toBe(0xff0000);
  });
  it("an unreadable line is an error entry", () => {
    const out = lineMeshes(concentricCapstan, "assembly", { drive: { lineInfo() { throw new Error("boom\nmore"); } } });
    expect(out[0].mesh).toBeNull();
    expect(out[0].reading).toBeNull();
    expect(out[0].error).toContain("boom");
    expect(out[0].error).not.toContain("more");
  });
  it("a line with no finite diameter has no mesh and says so; its reading stands", () => {
    for (const bad of [NaN, undefined, 0, -1]) {
      const info = d.drive.lineInfo();
      const drive = { lineInfo: () => ({ ...info, lines: { rope: { ...info.lines.rope, d: bad } } }) };
      const [entry] = lineMeshes(concentricCapstan, "assembly", { drive });
      expect(entry.mesh).toBeNull();
      expect(entry.error).toBe('line "rope" has no diameter');
      expect(entry.reading.length).toBeGreaterThan(0);
    }
  });
});

describe("tubeMesh with no radius", () => {
  it("radius <= 0 (or not a number) gives an empty payload, never NaN", () => {
    for (const radius of [0, -1, NaN, undefined]) {
      const m = tubeMesh([[0, 0, 0], [10, 0, 0], [10, 5, 0]], { radius });
      expect(m.positions.length).toBe(0);
      expect(m.normals.length).toBe(0);
      expect(m.indices.length).toBe(0);
      expect(allFinite(m)).toBe(true);
    }
  });
});
