import { describe, it, expect } from "vitest";
import { resolveDerived, resolveDerivedAttributed } from "../src/framework/derive.js";
import { withDeriveMemo } from "../src/framework/derive-memo.js";
import { resolveParams, resolveParamsAttributed } from "../src/framework/part-model.js";

function counted(derive) {
  const part = { defaults: { a: 1, b: 2 }, calls: 0 };
  part.derive = typeof derive === "function"
    ? (p) => { part.calls++; return derive(p); }
    : Object.fromEntries(Object.entries(derive).map(([k, fn]) => [k, (p, d) => { part.calls++; return fn(p, d); }]));
  return part;
}

describe("withDeriveMemo", () => {
  it("derives once per distinct params inside, every call outside", () => {
    const part = counted((p) => ({ sum: p.a + p.b }));
    resolveParams(part, { a: 3 });
    resolveParams(part, { a: 3 });
    expect(part.calls).toBe(2);
    part.calls = 0;
    const seen = withDeriveMemo(() => [
      resolveParams(part, { a: 3 }).d,
      resolveDerived(part, { a: 3, b: 2 }),
      resolveParamsAttributed(part, { a: 3 }).d,
      resolveDerivedAttributed(part, { b: 2, a: 3 }).d, // key order does not matter
      resolveParams(part, { a: 4 }).d,
    ]);
    expect(part.calls).toBe(2);
    expect(seen.map((d) => d.sum)).toEqual([5, 5, 5, 5, 6]);
    // the scope is gone afterwards
    resolveParams(part, { a: 3 });
    expect(part.calls).toBe(3);
  });

  it("hands back the attribution the unmemoized call computes", () => {
    const part = counted({ first: (p) => ({ x: p.a * 2 }), second: (p, d) => ({ y: d.x + p.b }) });
    const plain = resolveDerivedAttributed(part, { a: 5, b: 2 });
    const memo = withDeriveMemo(() => { resolveDerived(part, { a: 5, b: 2 }); return resolveDerivedAttributed(part, { a: 5, b: 2 }); });
    expect(memo.d).toEqual(plain.d);
    expect([...memo.depsOf]).toEqual([...plain.depsOf]);
    expect([...memo.allInputs].sort()).toEqual([...plain.allInputs].sort());
  });

  it("never memoizes a derive that writes its params, and its writes still land", () => {
    const part = counted((p) => { p.c = p.a * 10; return { c: p.c }; });
    withDeriveMemo(() => {
      const p1 = { a: 1, b: 2 };
      expect(resolveDerivedAttributed(part, p1, { through: true }).d.c).toBe(10);
      expect(p1.c).toBe(10);
      const p2 = { a: 1, b: 2 };
      resolveDerived(part, p2);
      expect(p2.c).toBe(10);
      // without `through` the caller's params stay untouched, as outside the memo
      const p3 = { a: 1, b: 2 };
      resolveDerivedAttributed(part, p3);
      expect(p3.c).toBeUndefined();
    });
    expect(part.calls).toBe(3);
  });

  it("does not memoize a throw", () => {
    const part = counted((p) => { if (p.a > 1) throw new Error("too big"); return {}; });
    withDeriveMemo(() => {
      expect(() => resolveDerived(part, { a: 2 })).toThrow("too big");
      expect(() => resolveDerived(part, { a: 2 })).toThrow("too big");
    });
    expect(part.calls).toBe(2);
  });

  it("is re-entrant and returns fn's value", () => {
    const part = counted((p) => ({ v: p.a }));
    const v = withDeriveMemo(() => withDeriveMemo(() => resolveDerived(part, { a: 7 }).v) + resolveDerived(part, { a: 7 }).v);
    expect(v).toBe(14);
    expect(part.calls).toBe(1);
  });
});
