// Filled in by the sub-controls task. See custom.js's host.controls.
export function scopedParams({ read }) {
  return new Proxy({}, { get: (_, key) => (typeof key === "string" ? read()?.[key] : undefined) });
}
