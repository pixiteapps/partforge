// A params-shaped view INTO a custom control's owned value, so the built-in
// control factories — which read and write `params[node.key]` and nothing
// else — can edit `tiles[3].height` without knowing they are inside a JSON
// value. Every read clones the owned value (read()) and every write hands a
// whole new value back (write(next)): the stored value is never mutated in
// place, which is what keeps the worker's cache keys and the relevance
// recorder honest.
//
// `path` is dotted from the owned value's root: "" (the root itself), "3"
// (the fourth array element), "walls.north". A write whose parent does not
// exist is refused and reported through onError, never thrown — a throwing
// params write inside a slider's input handler would take the panel down.
export function scopedParams({ read, write, path = "", onError }) {
  const segs = path === "" ? [] : String(path).split(".");
  const parentOf = (root) => {
    let cur = root;
    for (const s of segs) {
      if (cur === null || typeof cur !== "object") return null;
      cur = cur[s];
    }
    return cur !== null && typeof cur === "object" ? cur : null;
  };
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== "string") return undefined;
      const p = parentOf(read());
      return p ? p[key] : undefined;
    },
    has(_, key) {
      const p = parentOf(read());
      return typeof key === "string" && !!p && Object.hasOwn(p, key);
    },
    ownKeys() {
      const p = parentOf(read());
      return p ? Object.keys(p) : [];
    },
    getOwnPropertyDescriptor(_, key) {
      const p = parentOf(read());
      if (!p || typeof key !== "string" || !Object.hasOwn(p, key)) return undefined;
      return { value: p[key], enumerable: true, configurable: true, writable: true };
    },
    set(_, key, value) {
      if (typeof key !== "string") return false;
      const root = read();
      const p = parentOf(root);
      if (!p) { onError?.(`no value at path "${path}" to write "${key}" into`); return true; }
      p[key] = value;
      write(root);
      return true;
    },
  });
}
