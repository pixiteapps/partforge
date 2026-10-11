// Whether a cached preview (mount's `preview` option) is on screen, and the
// chrome it holds off meanwhile. A preview mesh has no feature ids and no live
// solid behind it, so the modes that read those — cutaway, measure, sketch —
// wait for the live build; picking and hover ask isActive() per event. Each
// button gets back exactly the `disabled` it had (a host may disable one for its
// own reasons, and that must survive the round trip).
export function createPreviewGate({ buttons = [] } = {}) {
  let active = false;
  const held = []; // { el, wasDisabled }
  const listeners = new Set();
  const announce = () => {
    for (const cb of [...listeners]) cb(active);
  };
  return {
    isActive: () => active,
    start() {
      if (active) return;
      active = true;
      for (const el of buttons) {
        if (!el) continue;
        held.push({ el, wasDisabled: el.disabled });
        el.disabled = true;
      }
      announce();
    },
    end() {
      if (!active) return;
      active = false;
      for (const { el, wasDisabled } of held.splice(0)) el.disabled = wasDisabled;
      announce();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
