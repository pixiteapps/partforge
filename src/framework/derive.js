import { recorder } from "./read-recorder.js";
import { activeDeriveMemo } from "./derive-memo.js";

// Resolve a part's `derive` into the derived-values object `d` that builds receive.
//
// Two authoring forms:
//   derive: (p) => d                      — one function, computed in a single pass.
//   derive: { name: (p, d) => {...}, … }  — named GROUPS, run in declaration order;
//     each group gets the params plus the merged outputs of the groups before it.
// The grouped form exists so the relevance layer (param-deps.js) can attribute each
// derived value to just its own group's inputs instead of every param derive touches.
export function resolveDerived(part, p) {
  const derive = part.derive;
  if (!derive) return {};
  const memo = activeDeriveMemo();
  if (memo) return memoized(memo, part, p).d;
  if (typeof derive === "function") return derive(p) ?? {};
  const d = {};
  // Groups read earlier groups' outputs through this guard: a key nothing has
  // produced yet is a wiring mistake (group order / typo), and silently reading
  // undefined would surface as NaN geometry far downstream — throw here instead.
  // (Builds still receive the plain merged object, unguarded.)
  const guard = new Proxy(d, {
    get(t, key) {
      if (typeof key === "string" && key !== "then" && !(key in t)) {
        throw new Error(`derive: group read "${key}" before any earlier group produced it`);
      }
      return Reflect.get(t, key);
    },
  });
  for (const fn of Object.values(derive)) Object.assign(d, fn(p, guard) ?? {});
  return d;
}

// resolveDerived plus attribution: which raw params each derived key came from.
// MUST produce resolveDerived's `d`, throw its errors, and (with through) leave
// its writes on p — tests pin all three; the worker builds with this `d`.
// Grouped form: depsOf maps each key to its own group's raw reads, transitively
// through the earlier groups it read. Single-function form: depsOf is null.
export function resolveDerivedAttributed(part, p, { through = false } = {}) {
  const memo = activeDeriveMemo();
  if (memo && part.derive) return memoized(memo, part, through ? p : { ...p });
  return attributed(part, p, { through });
}

function attributed(part, p, { through }) {
  const allInputs = new Set();
  const derive = part.derive;
  if (!derive) return { d: {}, depsOf: null, allInputs };
  if (typeof derive === "function") {
    return { d: derive(recorder(p, allInputs, { through })) ?? {}, depsOf: null, allInputs };
  }
  const d = {};
  const depsOf = new Map();
  for (const fn of Object.values(derive)) {
    const raw = new Set();
    const fromEarlier = new Set();
    const written = new Set();
    const dProxy = new Proxy(d, {
      get(t, key) {
        if (typeof key === "string" && key !== "then") {
          if (!(key in t)) throw new Error(`derive: group read "${key}" before any earlier group produced it`);
          fromEarlier.add(key);
        }
        return Reflect.get(t, key);
      },
      set(t, key, v) {
        if (typeof key === "string") written.add(key);
        return Reflect.set(t, key, v);
      },
    });
    const out = fn(recorder(p, raw, { through }), dProxy) ?? {};
    const deps = new Set(raw);
    for (const k of fromEarlier) for (const dep of depsOf.get(k) ?? []) deps.add(dep);
    for (const r of raw) allInputs.add(r);
    for (const key of [...Object.keys(out), ...written]) {
      depsOf.set(key, deps);
      if (Object.hasOwn(out, key)) d[key] = out[key];
    }
  }
  return { d, depsOf, allInputs };
}

// ---- the derive memo (derive-memo.js) ----------------------------------------------
/** The attributed result for p (derive's writes land on p, as with `through`), from or into `memo`. */
function memoized(memo, part, p) {
  const hit = memo.find(part, p);
  if (hit) return hit;
  const key = { ...p };
  const result = attributed(part, p, { through: true });
  memo.store(part, key, p, result);
  return result;
}
