// The derive memo: a scope inside which derive runs once per distinct params.
//
// A pose drag frame resolves the SAME params several times over — the solve's last
// evaluation, the fast path's pose repair, the panel's relevance (twice), and the pose
// overlay's re-read of every handle's limb — and a derive that solves its own goals (the
// robot arm's) costs milliseconds each. Inside withDeriveMemo(fn), resolveDerived and
// resolveDerivedAttributed (derive.js) hand a call whose params equal (key for key,
// Object.is) one of the last MEMO_SIZE calls' that call's result. Outside it nothing is
// memoized, so every other path is unchanged.
//
// Sound because derive is pure (it must be: the preview kernel memoizes builds by content
// hash on the same assumption). A derive that WRITES its params (allowed: with `through`
// its writes land on p) is never stored. A hit hands back the same `d`, depsOf and
// allInputs objects as the call that computed them; every reader treats them as
// read-only. A throw is never stored (each call throws afresh).
//
// Internal: deliberately not exported from derive.js, which is the public
// `partforge/derive` entry.
const MEMO_SIZE = 4;
let active = null; // the memo while withDeriveMemo runs, else null

function sameParams(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (!Object.hasOwn(b, k) || !Object.is(a[k], b[k])) return false;
  return true;
}

function createMemo() {
  const entries = []; // [{ part, key, result }], newest first
  return {
    find(part, p) {
      for (const e of entries) if (e.part === part && sameParams(e.key, p)) return e.result;
      return null;
    },
    /** `key`: p as it was before derive ran; stored only if derive left p unchanged. */
    store(part, key, p, result) {
      if (!sameParams(key, p)) return;
      entries.unshift({ part, key, result });
      if (entries.length > MEMO_SIZE) entries.length = MEMO_SIZE;
    },
  };
}

/** The memo in force, or null outside withDeriveMemo. */
export const activeDeriveMemo = () => active;

/** Run fn with derive memoized per distinct params. Re-entrant: an inner call shares the outer memo. */
export function withDeriveMemo(fn) {
  if (active) return fn();
  active = createMemo();
  try {
    return fn();
  } finally {
    active = null;
  }
}
